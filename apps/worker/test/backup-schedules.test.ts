import { getQueuePolicy, loadEnv } from '@asin-monitor/config';
import { TaskRegistryError, type TaskState } from '@asin-monitor/db';
import { describe, expect, it, vi } from 'vitest';
import {
  enqueueScheduledBackups,
  scheduledBackupTaskId,
  startBackupRuntime,
} from '../src/backup-runtime';
import { backupScheduleKey } from '../src/backup-schedules';

describe('backup scheduler', () => {
  it('rejects a short retention before opening worker or scheduler connections', async () => {
    await expect(
      startBackupRuntime(
        {
          AUTH_DATA_AUTHORITY: 'postgresql',
          TASK_META_TTL_SECONDS: 1,
        } as never,
        vi.fn(),
      ),
    ).rejects.toThrow('BACKUP_TASK_RETENTION_TOO_SHORT');
  });
  const at = (value: string) => new Date(value);

  it.each([
    { scheduleType: 'daily' as const, scheduleValue: null },
    { scheduleType: 'weekly' as const, scheduleValue: 7 },
    { scheduleType: 'monthly' as const, scheduleValue: 27 },
  ])(
    'matches real Intl midnight for $scheduleType and keeps the five-minute limit',
    (config) => {
      const midnight = { ...config, backupTime: '00:00' };
      expect(backupScheduleKey(midnight, at('2026-09-26T16:00:00.000Z'))).toBe(
        '2026-09-27T00:00',
      );
      expect(backupScheduleKey(midnight, at('2026-09-26T16:04:59.999Z'))).toBe(
        '2026-09-27T00:00',
      );
      expect(
        backupScheduleKey(midnight, at('2026-09-26T16:05:00.000Z')),
      ).toBeNull();
    },
  );
  it('normalizes an ICU h24 midnight without moving its calendar day', () => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockImplementation(function (this: Intl.DateTimeFormat, date) {
        return original
          .call(this, date)
          .map((part) =>
            part.type === 'hour' && part.value === '00'
              ? { ...part, value: '24' }
              : part,
          );
      });
    try {
      expect(
        backupScheduleKey(
          { scheduleType: 'monthly', scheduleValue: 27, backupTime: '00:00' },
          at('2026-09-26T16:00:00.000Z'),
        ),
      ).toBe('2026-09-27T00:00');
    } finally {
      spy.mockRestore();
    }
  });

  it('matches daily schedules in Shanghai time', () => {
    expect(
      backupScheduleKey(
        { scheduleType: 'daily', scheduleValue: null, backupTime: '02:00' },
        at('2026-09-26T18:00:00.000Z'),
      ),
    ).toBe('2026-09-27T02:00');
    expect(
      backupScheduleKey(
        { scheduleType: 'daily', scheduleValue: null, backupTime: '02:00' },
        at('2026-09-26T17:59:00.000Z'),
      ),
    ).toBeNull();
  });

  it('retries within five minutes using the original scheduled key', () => {
    const config = {
      scheduleType: 'daily' as const,
      scheduleValue: null,
      backupTime: '02:00',
    };
    expect(backupScheduleKey(config, at('2026-09-26T18:04:59.000Z'))).toBe(
      '2026-09-27T02:00',
    );
    expect(
      backupScheduleKey(config, at('2026-09-26T18:05:00.000Z')),
    ).toBeNull();
  });

  it('retries across midnight against the scheduled day', () => {
    expect(
      backupScheduleKey(
        { scheduleType: 'weekly', scheduleValue: 7, backupTime: '23:59' },
        at('2026-09-27T16:02:00.000Z'),
      ),
    ).toBe('2026-09-27T23:59');
    expect(
      backupScheduleKey(
        { scheduleType: 'monthly', scheduleValue: 27, backupTime: '23:59' },
        at('2026-09-27T16:02:00.000Z'),
      ),
    ).toBe('2026-09-27T23:59');
  });

  it('matches weekly and monthly values without using host timezone', () => {
    expect(
      backupScheduleKey(
        { scheduleType: 'weekly', scheduleValue: 7, backupTime: '02:00' },
        at('2026-09-26T18:00:00.000Z'),
      ),
    ).toBe('2026-09-27T02:00');
    expect(
      backupScheduleKey(
        { scheduleType: 'monthly', scheduleValue: 27, backupTime: '02:00' },
        at('2026-09-26T18:00:00.000Z'),
      ),
    ).toBe('2026-09-27T02:00');
  });

  it('uses a stable task identity for each scheduled target', () => {
    const primary = scheduledBackupTaskId(
      'test-prefix',
      '2026-09-27T02:00',
      'primary',
    );
    expect(primary).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      scheduledBackupTaskId('test-prefix', '2026-09-27T02:00', 'primary'),
    ).toBe(primary);
    expect(
      scheduledBackupTaskId('test-prefix', '2026-09-27T02:00', 'competitor'),
    ).not.toBe(primary);
  });

  it('retries the missing target after a partial enqueue failure', async () => {
    const tasks = new Map<string, TaskState>();
    const accepted = new Set<string>();
    let competitorAttempts = 0;
    const store = {
      create: vi.fn(async (input: { taskId: string }) => {
        if (tasks.has(input.taskId)) throw new TaskRegistryError('TASK_EXISTS');
        const task = {
          ...input,
          userId: 'system:backup-scheduler',
          taskType: 'backup',
          taskSubType: 'create',
          createdAt: '2026-09-27T00:00:00.000Z',
        } as TaskState;
        tasks.set(input.taskId, task);
        return task;
      }),
      read: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
    };
    const queue = {
      add: vi.fn(
        async (
          _name: string,
          data: { target: string },
          input: { jobId: string },
        ) => {
          if (data.target === 'competitor' && competitorAttempts++ === 0)
            throw new Error('REDIS_WRITE_FAILED');
          accepted.add(input.jobId);
        },
      ),
    };
    const run = () =>
      enqueueScheduledBackups(
        'test-prefix',
        '2026-09-27T02:00',
        store as never,
        queue as never,
      );
    await expect(run()).rejects.toThrow('REDIS_WRITE_FAILED');
    expect(accepted.size).toBe(1);
    await run();
    expect(accepted.size).toBe(2);
    expect(tasks.size).toBe(2);
  });
  it('inherits creation retry and backoff for both scheduled targets', async () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://localhost/primary',
      COMPETITOR_DATABASE_URL: 'postgresql://localhost/competitor',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_DATA_AUTHORITY: 'postgresql',
      JWT_SECRET: 'fixture',
    });
    const policy = getQueuePolicy('backup', env).defaultJobOptions;
    const accepted: unknown[] = [];
    const store = {
      create: async (input: object) => ({
        ...input,
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
      read: vi.fn(),
    };
    const queue = {
      add: async (name: string, data: unknown, options: object) =>
        accepted.push({ name, data, options: { ...policy, ...options } }),
    };
    await enqueueScheduledBackups(
      'fixture-prefix',
      '2026-10-02T02:00',
      store as never,
      queue as never,
    );
    expect(accepted).toHaveLength(2);
    for (const target of ['primary', 'competitor'])
      expect(accepted).toContainEqual(
        expect.objectContaining({
          name: 'create',
          data: expect.objectContaining({
            operation: 'create',
            target,
            createdAt: '2026-10-02T00:00:00.000Z',
          }),
          options: expect.objectContaining({
            attempts: 2,
            backoff: { type: 'exponential', delay: 5000 },
          }),
        }),
      );
  });
});
