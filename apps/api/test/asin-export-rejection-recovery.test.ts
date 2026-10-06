import { loadEnv } from '@asin-monitor/config';
import type { TaskState } from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../src/logger/app-logger.service';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { TaskQueryService } from '../src/tasks/task-query.service';
import { taskFixture } from './helpers/task-query-fixtures';

const taskId = '10000000-0000-4000-8000-000000000166';
const directories: string[] = [];
const runtimes: TaskQueryRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.onModuleDestroy();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (
      dirname(directory) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('neo-api-rejection-166-')
    )
      throw new Error('Invalid API rejection fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-api-rejection-166-'));
  directories.push(directory);
  const env = loadEnv({
    DATABASE_URL: 'postgresql://localhost/rejection_fixture',
    COMPETITOR_DATABASE_URL:
      'postgresql://localhost/rejection_competitor_fixture',
    REDIS_URL: 'redis://localhost:6379/15',
    AUTH_DATA_AUTHORITY: 'postgresql',
    JWT_SECRET: 'unused-export-rejection-fixture-key-166',
    EXPORT_STORAGE_DIRECTORY: directory,
  });
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const artifacts = new ExportArtifactStore(directory);
  const initial = taskFixture({ taskId });
  const proof = {
    taskId,
    userId: initial.userId,
    createdAt: initial.createdAt,
    taskType: 'export' as const,
    taskSubType: 'asin' as const,
  };
  let current: TaskState | null = initial;
  const rows = new Map([
    [`${env.BULL_PREFIX}:neo:task:meta:${taskId}`, JSON.stringify(initial)],
  ]);
  const evalRedis = vi.fn(
    async (_script: string, keys: number, ...args: (string | number)[]) => {
      const key = String(args[0]);
      if ((rows.get(key) ?? '') !== String(args[keys])) return 0;
      const raw = String(args[keys + 1]);
      rows.set(key, raw);
      current = JSON.parse(raw) as TaskState;
      return 1;
    },
  );
  const recreate = () => {
    const runtime = new TaskQueryRuntime(env, logger as unknown as AppLogger);
    runtimes.push(runtime);
    const internals = runtime as unknown as {
      ready(): Promise<void>;
      redis: unknown;
    };
    vi.spyOn(internals, 'ready').mockResolvedValue();
    internals.redis = {
      get: vi.fn(async (key: string) => rows.get(key) ?? null),
      eval: evalRedis,
      disconnect: vi.fn(),
    };
    return runtime;
  };
  const replace = (next: TaskState) => {
    current = next;
    rows.set(
      `${env.BULL_PREFIX}:neo:task:meta:${taskId}`,
      JSON.stringify(next),
    );
  };
  return {
    artifacts,
    proof,
    initial,
    recreate,
    evalRedis,
    replace,
    current: () => current,
    env,
    logger,
  };
}

describe('definitive export rejection is recoverable independently of API process and queue absence', () => {
  it('releases a pending task using a durable immutable producer proof after recreating the API runtime', async () => {
    const f = await fixture();
    const old = f.recreate();
    await old.openExport(() => {}).recordRejected!(f.proof);
    await old.onModuleDestroy();
    const restarted = f.recreate();
    const port = restarted.open(() => {});
    const queue = vi.spyOn(port, 'findJob').mockResolvedValue(null);
    const service = new TaskQueryService(
      f.env,
      { open: () => port } as unknown as TaskQueryRuntime,
      f.logger as unknown as AppLogger,
      { isReference: () => false } as never,
    );
    const result = await service.detail(
      { userId: f.initial.userId } as never,
      taskId,
    );
    expect(result).toMatchObject({
      status: 'failed',
      message: 'ASIN 导出未入队，请重试',
      canCancel: false,
    });
    expect(f.current()?.status).toBe('failed');
    expect(f.evalRedis).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
    expect(await f.artifacts.readRejectedSubmission(taskId)).toBeNull();
  });

  it.each(['owner', 'createdAt', 'subtype'] as const)(
    'cannot fail a replacement %s identity from an older journal',
    async (changed) => {
      const f = await fixture();
      await f.artifacts.recordRejectedSubmission(f.proof);
      const replacement = {
        ...f.initial,
        ...(changed === 'owner' ? { userId: 'replacement-owner' } : {}),
        ...(changed === 'createdAt'
          ? { createdAt: '2026-10-07T00:00:00.000Z' }
          : {}),
        ...(changed === 'subtype' ? { taskSubType: 'competitor-asin' } : {}),
      };
      f.replace(replacement);
      expect(
        await f.recreate().open(() => {}).reconcileRejectedExport!(replacement),
      ).toBeNull();
      expect(f.evalRedis).not.toHaveBeenCalled();
      expect(f.current()).toEqual(replacement);
    },
  );

  it('never interprets queue absence without a journal as a definitive rejection', async () => {
    const f = await fixture();
    expect(
      await f.recreate().open(() => {}).reconcileRejectedExport!(f.initial),
    ).toBeNull();
    expect(f.evalRedis).not.toHaveBeenCalled();
    expect(f.current()?.status).toBe('pending');
  });

  it('retains a journal when Redis remains unavailable and honours cancellation when recovery resumes', async () => {
    const f = await fixture();
    await f.artifacts.recordRejectedSubmission(f.proof);
    const port = f.recreate().open(() => {});
    f.evalRedis.mockRejectedValueOnce(new Error('fixture Redis unavailable'));
    await expect(port.reconcileRejectedExport!(f.initial)).rejects.toThrow(
      'fixture Redis unavailable',
    );
    expect(await f.artifacts.readRejectedSubmission(taskId)).toEqual(f.proof);
    f.replace({
      ...f.initial,
      status: 'cancelling',
      cancelRequestedAt: '2026-10-07T00:00:00.000Z',
    });
    expect(await port.reconcileRejectedExport!(f.current()!)).toMatchObject({
      status: 'cancelled',
    });
    expect(await f.artifacts.readRejectedSubmission(taskId)).toBeNull();
  });
});
