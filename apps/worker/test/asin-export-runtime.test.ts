import type { Env } from '@asin-monitor/config';
import { ExportArtifactStore } from '@asin-monitor/export';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  stalled: 'queue' as 'queue' | 'worker' | 'none',
  directory: '',
  tasks: new Map<string, { status: string; [key: string]: unknown }>(),
  rejectMutation: false,
  queueClosed: 0,
  workerClosed: 0,
  redisDisconnected: 0,
  poolEnded: 0,
}));

vi.mock('@asin-monitor/config', () => ({
  getExportStorageDirectory: () => fixture.directory,
  getPhysicalQueueName: () => 'export',
}));
vi.mock('@asin-monitor/db', () => ({
  ASIN_EXPORT_MIN_TASK_TTL_SECONDS: 6 * 24 * 60 * 60,
  ASIN_EXPORT_QUERY_TIMEOUT_MS: 60_000,
  createPgPool: () => ({
    on: () => undefined,
    end: async () => {
      fixture.poolEnded++;
    },
  }),
  PgAsinExportQueryRepository: class {},
  RedisTaskRepository: class {
    async read(taskId: string) {
      return fixture.tasks.get(taskId) ?? null;
    }
    async mutate(
      taskId: string,
      _transition: unknown,
      identity: Record<string, unknown>,
    ) {
      if (fixture.rejectMutation) throw new Error('fixture Redis unavailable');
      const current = fixture.tasks.get(taskId);
      if (
        !current ||
        Object.entries(identity).some(([key, value]) => current[key] !== value)
      )
        return null;
      const next = { ...current, status: 'failed' };
      fixture.tasks.set(taskId, next);
      return next;
    }
  },
}));
vi.mock('ioredis', () => ({
  Redis: class {
    on() {
      return this;
    }
    async connect() {}
    disconnect() {
      fixture.redisDisconnected++;
    }
  },
}));
vi.mock('bullmq', () => ({
  Queue: class {
    on() {
      return this;
    }
    waitUntilReady() {
      return fixture.stalled === 'queue'
        ? new Promise<never>(() => undefined)
        : Promise.resolve();
    }
    async close() {
      fixture.queueClosed++;
    }
    async getJob() {
      return null;
    }
  },
  Worker: class {
    on() {
      return this;
    }
    waitUntilReady() {
      return fixture.stalled === 'worker'
        ? new Promise<never>(() => undefined)
        : Promise.resolve();
    }
    run() {
      return new Promise<void>(() => undefined);
    }
    async close() {
      fixture.workerClosed++;
    }
  },
}));
vi.mock('../src/asin-export-processor', () => ({
  ASIN_EXPORT_TASK_TIMEOUT_MS: 30 * 60_000,
  createAsinExportProcessor: () => async () => undefined,
}));
vi.mock('../src/queue-policy', () => ({
  getQueueOptions: () => ({}),
  getWorkerOptions: () => ({}),
}));
vi.mock('../src/redis-options', () => ({ parseRedisUrl: () => ({}) }));
vi.mock('../src/task-notification-warning', () => ({
  taskNotificationWarning: () => () => undefined,
}));
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { startAsinExportRuntime } from '../src/asin-export-runtime';

const env = {
  AUTH_DATA_AUTHORITY: 'postgresql',
  TASK_META_TTL_SECONDS: 604_800,
  EXPORT_QUEUE_WORKER_CONCURRENCY: 1,
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: 1000,
} as Env;

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fixture.queueClosed = 0;
  fixture.workerClosed = 0;
  fixture.redisDisconnected = 0;
  fixture.poolEnded = 0;
  fixture.tasks.clear();
  fixture.rejectMutation = false;
  fixture.directory = '';
  for (const directory of directories.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('neo-export-runtime-')
    )
      throw new Error('Unexpected fixture cleanup target');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('ASIN export startup deadline', () => {
  it('retains proof for initially absent metadata and reconciles a late create on the next sweep', async () => {
    fixture.stalled = 'none';
    fixture.directory = await mkdtemp(join(tmpdir(), 'neo-export-runtime-'));
    directories.push(fixture.directory);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
    const artifacts = new ExportArtifactStore(fixture.directory);
    const proof = {
      taskId: '10000000-0000-4000-8000-000000000167',
      userId: '20000000-0000-4000-8000-000000000166',
      createdAt: new Date().toISOString(),
      taskType: 'export' as const,
      taskSubType: 'asin' as const,
    };
    await artifacts.recordRejectedSubmission(proof);
    let completedSweep!: () => void;
    const firstSweep = new Promise<void>((resolve) => {
      completedSweep = resolve;
    });
    const reconcile =
      ExportArtifactStore.prototype.reconcileRejectedSubmissions;
    vi.spyOn(
      ExportArtifactStore.prototype,
      'reconcileRejectedSubmissions',
    ).mockImplementationOnce(async function (
      this: ExportArtifactStore,
      ...args
    ) {
      await reconcile.apply(this, args);
      completedSweep();
    });
    const runtime = await startAsinExportRuntime(env, vi.fn());
    try {
      await firstSweep;
      expect(await artifacts.readRejectedSubmission(proof.taskId)).toEqual(
        proof,
      );
      fixture.tasks.set(proof.taskId, { ...proof, status: 'pending' });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () => {
        expect(await artifacts.readRejectedSubmission(proof.taskId)).toBeNull();
      });
      expect(fixture.tasks.get(proof.taskId)?.status).toBe('failed');
    } finally {
      await runtime.close();
    }
  });

  it('retains a durable rejection during a Redis failure and recovers it on the next Worker start', async () => {
    fixture.stalled = 'none';
    fixture.directory = await mkdtemp(join(tmpdir(), 'neo-export-runtime-'));
    directories.push(fixture.directory);
    const artifacts = new ExportArtifactStore(fixture.directory);
    const proof = {
      taskId: '10000000-0000-4000-8000-000000000166',
      userId: '20000000-0000-4000-8000-000000000166',
      createdAt: '2026-10-07T00:00:00.000Z',
      taskType: 'export' as const,
      taskSubType: 'asin' as const,
    };
    await artifacts.recordRejectedSubmission(proof);
    fixture.tasks.set(proof.taskId, { ...proof, status: 'pending' });
    fixture.rejectMutation = true;
    const first = await startAsinExportRuntime(env, vi.fn());
    try {
      await vi.waitFor(async () => {
        const { logger } = await import('../src/logger');
        expect(logger.warn).toHaveBeenCalledWith('ASIN 导出文件清理暂不可用', {
          reason: 'export_cleanup_failed',
        });
      });
      expect(await artifacts.readRejectedSubmission(proof.taskId)).toEqual(
        proof,
      );
      expect(fixture.tasks.get(proof.taskId)?.status).toBe('pending');
    } finally {
      await first.close();
    }
    fixture.rejectMutation = false;
    const restarted = await startAsinExportRuntime(env, vi.fn());
    try {
      await vi.waitFor(async () => {
        expect(await artifacts.readRejectedSubmission(proof.taskId)).toBeNull();
      });
      expect(fixture.tasks.get(proof.taskId)?.status).toBe('failed');
    } finally {
      await restarted.close();
    }
  });
  it('keeps one blocked cleanup sweep across interval ticks and releases the gate only after it settles', async () => {
    fixture.stalled = 'none';
    fixture.directory = await mkdtemp(join(tmpdir(), 'neo-export-runtime-'));
    directories.push(fixture.directory);
    vi.useFakeTimers();
    let release!: (value: number) => void;
    const blocked = new Promise<number>((resolve) => {
      release = resolve;
    });
    vi.spyOn(
      ExportArtifactStore.prototype,
      'reconcileRejectedSubmissions',
    ).mockResolvedValue(undefined);
    const cleanup = vi
      .spyOn(ExportArtifactStore.prototype, 'cleanup')
      .mockImplementationOnce(() => blocked)
      .mockResolvedValue(0);
    const runtime = await startAsinExportRuntime(env, vi.fn());
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(cleanup).toHaveBeenCalledTimes(1);
      release(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanup).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cleanup).toHaveBeenCalledTimes(6);
      await runtime.close();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(cleanup).toHaveBeenCalledTimes(6);
    } finally {
      release(0);
      await runtime.close();
    }
  });
  it('reclaims real crash-orphaned partials after 45 minutes while respecting active writes and final retention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T18:00:00Z'));
    const now = Date.now();
    fixture.stalled = 'none';
    fixture.directory = await mkdtemp(join(tmpdir(), 'neo-export-runtime-'));
    directories.push(fixture.directory);
    const taskId = '10000000-0000-4000-8000-000000000166';
    const finalId = '20000000-0000-4000-8000-000000000166';
    const expiredId = '30000000-0000-4000-8000-000000000166';
    const cancelledId = '40000000-0000-4000-8000-000000000166';
    fixture.tasks.set(taskId, { status: 'processing' });
    fixture.tasks.set(cancelledId, { status: 'cancelled' });
    const seed = async (name: string, age: number) => {
      const path = join(fixture.directory, name);
      await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const at = new Date(now - age);
      await utimes(path, at, at);
      return path;
    };
    const orphan = await seed(
      `export-${taskId}.10000000-0000-4000-8000-000000000001.part`,
      46 * 60_000,
    );
    const grace = await seed(
      `export-${taskId}.10000000-0000-4000-8000-000000000002.part`,
      44 * 60_000,
    );
    const active = await seed(
      `export-${taskId}.10000000-0000-4000-8000-000000000003.part`,
      29 * 60_000,
    );
    const retained = await seed(`export-${finalId}.xlsx`, 8 * 86_400_000);
    const expired = await seed(`export-${expiredId}.xlsx`, 15 * 86_400_000);
    const cancelled = await seed(`export-${cancelledId}.xlsx`, 2 * 60_000);
    const runtime = await startAsinExportRuntime(
      { ...env, TASK_META_TTL_SECONDS: 14 * 86_400 },
      vi.fn(),
    );
    try {
      await vi.waitFor(async () => {
        await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(cancelled)).rejects.toMatchObject({ code: 'ENOENT' });
      });
      await expect(stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const path of [active, grace, retained])
        expect((await stat(path)).isFile()).toBe(true);
    } finally {
      await runtime.close();
    }
  });
  it.each(['queue', 'worker'] as const)(
    'closes every owned connection when %s readiness stalls',
    async (stalled) => {
      fixture.stalled = stalled;
      fixture.directory = await mkdtemp(join(tmpdir(), 'neo-export-runtime-'));
      directories.push(fixture.directory);
      vi.useFakeTimers();
      const start = startAsinExportRuntime(env, vi.fn());
      const failed = expect(start).rejects.toThrow(
        'ASIN export runtime initialization failed',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await failed;
      expect(fixture.queueClosed).toBe(1);
      expect(fixture.workerClosed).toBe(stalled === 'worker' ? 1 : 0);
      expect(fixture.redisDisconnected).toBe(1);
      expect(fixture.poolEnded).toBe(1);
    },
  );
});
