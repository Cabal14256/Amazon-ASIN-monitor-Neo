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
  vi.useRealTimers();
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
  it('retains the shared eight-operation budget after cancellation unlink deadlines expire', async () => {
    const f = await fixture();
    const runtime = f.recreate();
    const finish: Array<() => void> = [];
    const unlink = vi.fn(
      () => new Promise<void>((resolve) => finish.push(resolve)),
    );
    const read = vi.spyOn(
      ExportArtifactStore.prototype,
      'readRejectedSubmission',
    );
    vi.useFakeTimers();
    const pending = Array.from({ length: 8 }, (_, index) =>
      runtime
        .discardExport(`cancelled-${index}`, performance.now() + 10, unlink)
        .catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(10);
    for (const error of await Promise.all(pending))
      expect(error).toMatchObject({ message: 'TASK_QUERY_FILE_DEADLINE' });
    expect(unlink).toHaveBeenCalledTimes(8);
    await expect(
      runtime.discardExport('ninth', performance.now() + 10, unlink),
    ).rejects.toThrow('TASK_QUERY_FILE_CAPACITY');
    await expect(
      runtime.open(() => {}).reconcileRejectedExport!(f.initial),
    ).rejects.toThrow('TASK_QUERY_FILE_CAPACITY');
    expect(read).not.toHaveBeenCalled();
    finish.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    const recovered = runtime
      .discardExport('ninth', performance.now() + 10, unlink)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await recovered).toMatchObject({
      message: 'TASK_QUERY_FILE_DEADLINE',
    });
    expect(unlink).toHaveBeenCalledTimes(9);
    for (const resolve of finish) resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('ends the journal caller wait at its original deadline while retaining the native write', async () => {
    const f = await fixture();
    const runtime = f.recreate();
    let finish!: () => void;
    const writes = vi
      .spyOn(ExportArtifactStore.prototype, 'recordRejectedSubmission')
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    vi.useFakeTimers();
    const port = runtime.openExport(() => {});
    const deadline = performance.now() + 10;
    const first = port.recordRejected!(f.proof, deadline).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toMatchObject({ message: 'TASK_QUERY_FILE_DEADLINE' });
    const repeated = port.recordRejected!(
      f.proof,
      performance.now() + 10,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await repeated).toMatchObject({
      message: 'TASK_QUERY_FILE_DEADLINE',
    });
    expect(writes).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('starts one bounded durable journal write after an already-expired Redis deadline without extending the wait', async () => {
    const f = await fixture();
    const runtime = f.recreate();
    let finish!: () => void;
    const writes = vi
      .spyOn(ExportArtifactStore.prototype, 'recordRejectedSubmission')
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    vi.useFakeTimers();
    const pending = runtime.openExport(() => {}).recordRejected!(
      f.proof,
      performance.now() - 1,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({
      message: 'TASK_QUERY_FILE_DEADLINE',
    });
    expect(writes).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('does not merge final-artifact deletion with rejection-proof deletion for the same task', async () => {
    const f = await fixture();
    const runtime = f.recreate();
    let finish!: () => void;
    const final = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(
      ExportArtifactStore.prototype,
      'readRejectedSubmission',
    ).mockResolvedValue(f.proof);
    const proof = vi
      .spyOn(ExportArtifactStore.prototype, 'discardRejectedSubmission')
      .mockResolvedValue();
    const pending = runtime.discardExport(
      taskId,
      performance.now() + 3000,
      final,
    );
    expect(
      await runtime.open(() => {}).reconcileRejectedExport!(f.initial),
    ).toMatchObject({ status: 'failed' });
    expect(final).toHaveBeenCalledExactlyOnceWith();
    expect(proof).toHaveBeenCalledExactlyOnceWith(taskId);
    finish();
    await pending;
  });

  it('releases all eight service query slots at the deadline even while a shared proof read remains stalled', async () => {
    const f = await fixture();
    const runtime = f.recreate();
    let finish!: (value: typeof f.proof) => void;
    const reads = vi
      .spyOn(ExportArtifactStore.prototype, 'readRejectedSubmission')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const service = new TaskQueryService(
      f.env,
      runtime,
      f.logger as unknown as AppLogger,
      { isReference: () => false } as never,
    );
    vi.useFakeTimers();
    const pending = Array.from({ length: 8 }, () =>
      service
        .detail({ userId: f.initial.userId } as never, taskId)
        .catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(3000);
    for (const error of await Promise.all(pending))
      expect(error).toMatchObject({ status: 500 });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(f.evalRedis).not.toHaveBeenCalled();
    f.replace({ ...f.initial, status: 'completed', progress: 100 });
    expect(
      await service.detail({ userId: f.initial.userId } as never, taskId),
    ).toMatchObject({ status: 'completed' });
    finish(f.proof);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.evalRedis).not.toHaveBeenCalled();
    expect(f.current()?.status).toBe('completed');
  });
  it('bounds a stalled proof read by the remaining request deadline and never mutates from its late reply', async () => {
    const f = await fixture();
    const runtime = f.recreate();
    let finish!: (value: typeof f.proof) => void;
    vi.spyOn(
      ExportArtifactStore.prototype,
      'readRejectedSubmission',
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.useFakeTimers();
    const deadline = performance.now() + 100;
    let closed = false;
    const port = runtime.open(() => {
      if (closed || performance.now() >= deadline)
        throw new Error('TASK_QUERY_DEADLINE');
    }, deadline);
    const pending = port.reconcileRejectedExport!(f.initial);
    const rejected = expect(pending).rejects.toThrow(
      'TASK_QUERY_FILE_DEADLINE',
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    closed = true;
    finish(f.proof);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.evalRedis).not.toHaveBeenCalled();
    expect(f.current()?.status).toBe('pending');
  });

  it('keeps stalled filesystem work bounded after requests expire and reuses a same-task read', async () => {
    const f = await fixture();
    const runtime = f.recreate();
    const releases: ((value: null) => void)[] = [];
    const reads = vi
      .spyOn(ExportArtifactStore.prototype, 'readRejectedSubmission')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(resolve);
          }),
      );
    vi.useFakeTimers();
    const deadline = performance.now() + 100;
    const port = runtime.open(() => {}, deadline);
    const tasks = Array.from({ length: 8 }, (_, index) => ({
      ...f.initial,
      taskId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    }));
    const outcomes = tasks.map((task) =>
      port.reconcileRejectedExport!(task).catch((error: unknown) => error),
    );
    const duplicate = port.reconcileRejectedExport!(tasks[0]!).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    for (const error of await Promise.all([...outcomes, duplicate]))
      expect(error).toMatchObject({ message: 'TASK_QUERY_FILE_DEADLINE' });
    expect(reads).toHaveBeenCalledTimes(8);
    const next = runtime.open(() => {}, performance.now() + 100);
    await expect(next.reconcileRejectedExport!(f.initial)).rejects.toThrow(
      'TASK_QUERY_FILE_CAPACITY',
    );
    expect(reads).toHaveBeenCalledTimes(8);
    releases[0]!(null);
    await vi.advanceTimersByTimeAsync(0);
    const retry = next.reconcileRejectedExport!(f.initial);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveBeenCalledTimes(9);
    releases.splice(1).forEach((release) => release(null));
    expect(await retry).toBeNull();
    expect(f.evalRedis).not.toHaveBeenCalled();
  });
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
