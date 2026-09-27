import type { Env } from '@asin-monitor/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  stalled: 'queue' as 'queue' | 'worker',
  queueClosed: 0,
  workerClosed: 0,
  redisDisconnected: 0,
  poolEnded: 0,
}));

vi.mock('@asin-monitor/config', () => ({
  getExportStorageDirectory: () => 'C:\\fixture-exports',
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
  RedisTaskRepository: class {},
}));
vi.mock('@asin-monitor/export', () => ({
  ExportArtifactStore: class {},
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
  },
  Worker: class {
    on() {
      return this;
    }
    waitUntilReady() {
      return new Promise<never>(() => undefined);
    }
    async close() {
      fixture.workerClosed++;
    }
  },
}));
vi.mock('../src/asin-export-processor', () => ({
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

afterEach(() => {
  vi.useRealTimers();
  fixture.queueClosed = 0;
  fixture.workerClosed = 0;
  fixture.redisDisconnected = 0;
  fixture.poolEnded = 0;
});

describe('ASIN export startup deadline', () => {
  it.each(['queue', 'worker'] as const)(
    'closes every owned connection when %s readiness stalls',
    async (stalled) => {
      fixture.stalled = stalled;
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
