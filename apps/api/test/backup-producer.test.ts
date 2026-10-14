import { loadEnv } from '@asin-monitor/config';
import type { BackupJobData } from '@asin-monitor/contracts';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../src/logger/app-logger.service';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';

const queues = vi.hoisted(() => ({
  constructors: vi.fn(),
  additions: vi.fn(),
}));
vi.mock('ioredis', () => ({
  Redis: class extends EventEmitter {
    status = 'ready';
    disconnect = vi.fn();
  },
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Queue: class extends EventEmitter {
    constructor(name: string, readonly options: { defaultJobOptions: object }) {
      super();
      queues.constructors(name, options);
    }
    waitUntilReady = async () => undefined;
    close = async () => undefined;
    add = async (name: string, data: BackupJobData, options: object) => {
      queues.additions(name, data, {
        ...this.options.defaultJobOptions,
        ...options,
      });
    };
  },
}));

describe('manual backup producer delivery policy', () => {
  it('keeps creation retry/backoff while overrides restores to one attempt', async () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://localhost/primary',
      COMPETITOR_DATABASE_URL: 'postgresql://localhost/competitor',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_DATA_AUTHORITY: 'postgresql',
      JWT_SECRET: 'fixture',
    });
    const runtime = new TaskQueryRuntime(env, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as AppLogger);
    const identity = {
      taskId: '10000000-0000-4000-8000-000000000161',
      taskType: 'backup' as const,
      target: 'primary' as const,
      userId: 'backup-owner',
      createdAt: '2026-10-02T00:00:00.000Z',
    };
    try {
      const port = runtime.openBackup(() => undefined);
      await port.enqueue({
        ...identity,
        taskSubType: 'create',
        operation: 'create',
        params: {},
      });
      await port.enqueue({
        ...identity,
        taskSubType: 'restore',
        operation: 'restore',
        params: { filename: 'backup_20261002-020000-abcdef01-primary.dump' },
      });
      expect(queues.constructors).toHaveBeenCalledTimes(1);
      expect(queues.additions).toHaveBeenNthCalledWith(
        1,
        'create',
        expect.objectContaining({ operation: 'create' }),
        expect.objectContaining({
          jobId: identity.taskId,
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
        }),
      );
      expect(queues.additions).toHaveBeenNthCalledWith(
        2,
        'restore',
        expect.objectContaining({ operation: 'restore' }),
        expect.objectContaining({
          jobId: identity.taskId,
          attempts: 1,
        }),
      );
      for (const [, , options] of queues.additions.mock.calls) {
        expect(options.removeOnComplete.age).toBeGreaterThanOrEqual(
          7 * 24 * 60 * 60,
        );
        expect(options.removeOnComplete).not.toHaveProperty('count');
      }
    } finally {
      await runtime.onModuleDestroy();
    }
  });
});
