import type { Env } from '@asin-monitor/config';
import { describe, expect, it, vi } from 'vitest';
import {
  dispatchScheduledMonitorTick,
  startScheduledMonitorScheduler,
} from '../src/scheduled-monitor-scheduler-runtime';

const schedulerRuntimeFixture = vi.hoisted(() => ({
  processor: undefined as
    | ((
        job: {
          id: string;
          name: string;
          timestamp: number;
          opts: { prevMillis?: number };
          data: Record<string, unknown>;
          updateData(data: Record<string, unknown>): Promise<void>;
          moveToDelayed(timestamp: number, token?: string): Promise<void>;
        },
        token?: string,
      ) => Promise<void>)
    | undefined,
  queueClosed: 0,
  workerClosed: 0,
  readinessFailure: false,
  added: [] as {
    data: Record<string, unknown>;
    options: Record<string, unknown>;
  }[],
  repeatInstalled: 0,
  repeatRemoved: 0,
}));

vi.mock('bullmq', () => ({
  DelayedError: class extends Error {
    constructor() {
      super('bullmq:movedToDelayed');
    }
  },
  Queue: class {
    constructor(readonly name: string) {}
    async waitUntilReady() {}
    async close() {
      schedulerRuntimeFixture.queueClosed++;
    }
    async upsertJobScheduler() {
      schedulerRuntimeFixture.repeatInstalled++;
    }
    async removeJobScheduler() {
      schedulerRuntimeFixture.repeatRemoved++;
    }
  },
  Worker: class {
    constructor(
      _name: string,
      processor: typeof schedulerRuntimeFixture.processor,
    ) {
      schedulerRuntimeFixture.processor = processor;
    }
    on() {}
    async waitUntilReady() {
      if (schedulerRuntimeFixture.readinessFailure)
        throw new Error('fixture worker readiness failed');
    }
    run() {
      return Promise.resolve();
    }
    async close() {
      schedulerRuntimeFixture.workerClosed++;
    }
  },
}));

const env = {
  SCHEDULER_ENABLED: true,
  COMPETITOR_MONITOR_ENABLED: true,
  MONITOR_US_SCHEDULE_MINUTES: 30,
  MONITOR_EU_SCHEDULE_MINUTES: 60,
  MONITOR_BATCH_COUNT: 3,
} as Env;

function tick(plannedAt: number) {
  const value = {
    id: `repeat:neo-scheduled-monitor-dispatch-v1:${plannedAt}`,
    name: 'scheduled-monitor-scheduler-tick',
    timestamp: plannedAt + 59_900,
    opts: { prevMillis: plannedAt },
    data: { schemaVersion: 1 } as Record<string, unknown>,
    updateData: vi.fn(async (data: Record<string, unknown>) => {
      value.data = data;
    }),
    moveToDelayed: vi.fn(async () => undefined),
  };
  return value;
}

describe('scheduled monitor tick producer', () => {
  it('reads current DB config and enqueues stable primary/competitor jobs with persisted delays', async () => {
    const competitorEnabled = { value: true };
    const configRepository = {
      readConfiguration: vi.fn(async () => [
        { configKey: 'COMPETITOR_MONITOR_ENABLED', configValue: 'false' },
        { configKey: 'MONITOR_US_SCHEDULE_MINUTES', configValue: '15' },
        { configKey: 'MONITOR_EU_SCHEDULE_MINUTES', configValue: '30' },
      ]),
    };
    const scheduledQueue = { add: vi.fn(async () => ({ id: 'job' })) };
    const count = await dispatchScheduledMonitorTick({
      env,
      configRepository,
      competitorEnabled,
      scheduledQueue,
      assertLease: async () => true,
      nowMs: Date.parse('2026-10-25T10:30:00.000Z'),
    });
    expect(count).toBe(6);
    expect(competitorEnabled.value).toBe(false);
    expect(configRepository.readConfiguration).toHaveBeenCalledOnce();
    const jobs = scheduledQueue.add.mock.calls.map(
      (call) =>
        call[1] as {
          domain: string;
          country: string;
          jobId: string;
        },
    );
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: 'primary', country: 'US' }),
        expect.objectContaining({ domain: 'primary', country: 'UK' }),
        expect.objectContaining({ domain: 'primary', country: 'DE' }),
        expect.objectContaining({ domain: 'primary', country: 'FR' }),
        expect.objectContaining({ domain: 'primary', country: 'ES' }),
        expect.objectContaining({ domain: 'primary', country: 'IT' }),
      ]),
    );
    expect(scheduledQueue.add.mock.calls.map((call) => call[2]?.delay)).toEqual(
      [0, 0, 1000, 2000, 3000, 4000],
    );
    expect(
      scheduledQueue.add.mock.calls.every(
        (call) =>
          (call[2] as { jobId?: string }).jobId ===
          (call[1] as { jobId: string }).jobId,
      ),
    ).toBe(true);
  });

  it('dispatches from the persisted tick timestamp after delayed processing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T10:00:00.001Z'));
    schedulerRuntimeFixture.added = [];
    schedulerRuntimeFixture.queueClosed = 0;
    schedulerRuntimeFixture.workerClosed = 0;
    schedulerRuntimeFixture.repeatInstalled = 0;
    schedulerRuntimeFixture.repeatRemoved = 0;
    schedulerRuntimeFixture.readinessFailure = false;
    const owner = { token: null as string | null };
    const control = {
      get: vi.fn(async () => owner.token),
      set: vi.fn(async (_key: string, value: string) => {
        owner.token = value;
        return 'OK';
      }),
      eval: vi.fn(
        async (_script: string, _count: number, key: string, value: string) => {
          if (
            key === 'test:neo:scheduler:scheduled-monitor' &&
            value === owner.token
          )
            return 1;
          return 0;
        },
      ),
    };
    const scheduledQueue = {
      add: vi.fn(
        async (
          _name: string,
          data: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => {
          schedulerRuntimeFixture.added.push({ data, options });
        },
      ),
    };
    const runtime = await startScheduledMonitorScheduler({
      env: {
        ...env,
        AUTH_DATA_AUTHORITY: 'postgresql',
        DATABASE_URL: 'postgresql://fixture/db',
        BULL_PREFIX: 'test',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: 1000,
        SCHEDULER_ENABLED: true,
        REDIS_URL: 'redis://127.0.0.1:6379/15',
      } as Env,
      connection: {},
      control: control as never,
      scheduledQueue,
      configRepository: { readConfiguration: vi.fn(async () => []) },
      competitorEnabled: { value: true },
      onFatal: vi.fn(),
    });
    try {
      await schedulerRuntimeFixture.processor!(
        tick(Date.parse('2026-10-25T10:00:00.000Z')),
      );
      expect(schedulerRuntimeFixture.added).toHaveLength(11);
      expect(schedulerRuntimeFixture.repeatInstalled).toBe(1);
    } finally {
      await runtime.close();
      expect(schedulerRuntimeFixture.repeatRemoved).toBe(1);
      vi.useRealTimers();
    }
  });

  it('reuses the config snapshot after a partial enqueue acknowledgement loss', async () => {
    schedulerRuntimeFixture.readinessFailure = false;
    schedulerRuntimeFixture.repeatInstalled = 0;
    const owner = { token: null as string | null };
    const control = {
      get: vi.fn(async () => owner.token),
      set: vi.fn(async (_key: string, value: string) => {
        owner.token = value;
        return 'OK';
      }),
      eval: vi.fn(async () => 1),
    };
    const configRepository = {
      readConfiguration: vi
        .fn()
        .mockResolvedValueOnce([
          { configKey: 'MONITOR_BATCH_COUNT', configValue: '3' },
          { configKey: 'MONITOR_EU_SCHEDULE_MINUTES', configValue: '30' },
        ])
        .mockResolvedValueOnce([
          { configKey: 'MONITOR_BATCH_COUNT', configValue: '4' },
          { configKey: 'MONITOR_EU_SCHEDULE_MINUTES', configValue: '30' },
        ]),
    };
    const submissions: string[] = [];
    let loseFirstAck = true;
    const scheduledQueue = {
      add: vi.fn(async (_name: string, data: { jobId: string }) => {
        submissions.push(data.jobId);
        if (loseFirstAck) {
          loseFirstAck = false;
          throw new Error('queue admission acknowledgement lost');
        }
      }),
    };
    const runtime = await startScheduledMonitorScheduler({
      env: {
        ...env,
        AUTH_DATA_AUTHORITY: 'postgresql',
        DATABASE_URL: 'postgresql://fixture/db',
        BULL_PREFIX: 'test',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: 1000,
        REDIS_URL: 'redis://127.0.0.1:6379/15',
      } as Env,
      connection: {},
      control: control as never,
      scheduledQueue,
      configRepository,
      competitorEnabled: { value: true },
      onFatal: vi.fn(),
    });
    const scheduledTick = tick(Date.parse('2026-10-25T10:30:00.000Z'));
    try {
      await expect(
        schedulerRuntimeFixture.processor!(scheduledTick),
      ).rejects.toThrow('queue admission acknowledgement lost');
      expect(scheduledTick.data.dispatchSnapshot).toMatchObject({
        version: 1,
        config: { totalBatches: 3 },
      });
      await schedulerRuntimeFixture.processor!(scheduledTick);
      expect(configRepository.readConfiguration).toHaveBeenCalledOnce();
      expect(submissions[0]).toBe(submissions[1]);
      expect(new Set(submissions).size).toBe(11);
      const admittedCount = submissions.length;
      scheduledTick.data.dispatchSnapshot = { version: 2 };
      await expect(
        schedulerRuntimeFixture.processor!(scheduledTick),
      ).rejects.toThrow('SCHEDULED_MONITOR_TICK_SNAPSHOT_INVALID');
      expect(submissions).toHaveLength(admittedCount);
    } finally {
      await runtime.close();
    }
  });

  it('fails closed when a scheduler tick has no persisted planned time', async () => {
    schedulerRuntimeFixture.readinessFailure = false;
    schedulerRuntimeFixture.added = [];
    const owner = { token: null as string | null };
    const scheduledQueue = { add: vi.fn(async () => undefined) };
    const runtime = await startScheduledMonitorScheduler({
      env: {
        ...env,
        AUTH_DATA_AUTHORITY: 'postgresql',
        DATABASE_URL: 'postgresql://fixture/db',
        BULL_PREFIX: 'test',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: 1000,
        REDIS_URL: 'redis://127.0.0.1:6379/15',
      } as Env,
      connection: {},
      control: {
        get: vi.fn(async () => owner.token),
        set: vi.fn(async (_key: string, token: string) => {
          owner.token = token;
          return 'OK';
        }),
        eval: vi.fn(async () => 1),
      } as never,
      scheduledQueue,
      configRepository: { readConfiguration: vi.fn(async () => []) },
      competitorEnabled: { value: true },
      onFatal: vi.fn(),
    });
    try {
      await expect(
        schedulerRuntimeFixture.processor!({
          ...tick(Date.parse('2026-10-25T10:00:00.000Z')),
          opts: {},
        }),
      ).rejects.toThrow('SCHEDULED_MONITOR_TICK_TIMESTAMP_INVALID');
      expect(schedulerRuntimeFixture.added).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it('does not remove a shared repeat scheduler when a former lease owner closes', async () => {
    schedulerRuntimeFixture.repeatRemoved = 0;
    schedulerRuntimeFixture.readinessFailure = false;
    const owner = { token: null as string | null };
    const scheduledQueue = { add: vi.fn(async () => undefined) };
    const control = {
      get: vi.fn(async () => owner.token),
      set: vi.fn(async (_key: string, value: string) => {
        owner.token = value;
        return 'OK';
      }),
      eval: vi.fn(
        async (_script: string, _count: number, key: string, value: string) => {
          if (
            key === 'test:neo:scheduler:scheduled-monitor' &&
            value === owner.token
          ) {
            owner.token = null;
            return 1;
          }
          return 0;
        },
      ),
    };
    const runtime = await startScheduledMonitorScheduler({
      env: {
        ...env,
        AUTH_DATA_AUTHORITY: 'postgresql',
        DATABASE_URL: 'postgresql://fixture/db',
        BULL_PREFIX: 'test',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: 1000,
        SCHEDULER_ENABLED: true,
        REDIS_URL: 'redis://127.0.0.1:6379/15',
      } as Env,
      connection: {},
      control: control as never,
      scheduledQueue,
      configRepository: { readConfiguration: vi.fn(async () => []) },
      competitorEnabled: { value: true },
      onFatal: vi.fn(),
    });
    owner.token = 'successor-owner';
    const tickJob = tick(Date.parse('2026-10-25T10:00:00.000Z'));
    await expect(
      schedulerRuntimeFixture.processor!(tickJob, 'bull-lock'),
    ).rejects.toThrow('bullmq:movedToDelayed');
    expect(tickJob.moveToDelayed).toHaveBeenCalledWith(
      expect.any(Number),
      'bull-lock',
    );
    expect(scheduledQueue.add).not.toHaveBeenCalled();
    await runtime.close();
    expect(owner.token).toBe('successor-owner');
    expect(schedulerRuntimeFixture.repeatRemoved).toBe(0);
  });

  it('removes the stable persisted scheduler when the scheduler switch is disabled', async () => {
    schedulerRuntimeFixture.repeatRemoved = 0;
    schedulerRuntimeFixture.readinessFailure = false;
    const owner = { token: null as string | null };
    const runtime = await startScheduledMonitorScheduler({
      env: {
        ...env,
        AUTH_DATA_AUTHORITY: 'postgresql',
        DATABASE_URL: 'postgresql://fixture/db',
        BULL_PREFIX: 'test',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: 1000,
        SCHEDULER_ENABLED: false,
        REDIS_URL: 'redis://127.0.0.1:6379/15',
      } as Env,
      connection: {},
      control: {
        get: vi.fn(async () => owner.token),
        set: vi.fn(async (_key: string, value: string) => {
          owner.token = value;
          return 'OK';
        }),
        eval: vi.fn(async () => 1),
      } as never,
      scheduledQueue: { add: vi.fn(async () => undefined) },
      configRepository: { readConfiguration: vi.fn(async () => []) },
      competitorEnabled: { value: true },
      onFatal: vi.fn(),
    });
    expect(schedulerRuntimeFixture.repeatRemoved).toBe(1);
    await runtime.close();
    expect(schedulerRuntimeFixture.repeatRemoved).toBe(2);
  });

  it('closes owned scheduler resources when Worker readiness fails', async () => {
    schedulerRuntimeFixture.queueClosed = 0;
    schedulerRuntimeFixture.workerClosed = 0;
    schedulerRuntimeFixture.readinessFailure = true;
    try {
      await expect(
        startScheduledMonitorScheduler({
          env: {
            ...env,
            AUTH_DATA_AUTHORITY: 'postgresql',
            DATABASE_URL: 'postgresql://fixture/db',
            BULL_PREFIX: 'test',
            DATABASE_POOL_CONNECTION_TIMEOUT_MS: 1000,
            SCHEDULER_ENABLED: true,
            REDIS_URL: 'redis://127.0.0.1:6379/15',
          } as Env,
          connection: {},
          control: {
            get: vi.fn(async () => null),
            set: vi.fn(async () => 'OK'),
            eval: vi.fn(async () => 1),
          } as never,
          scheduledQueue: { add: vi.fn(async () => undefined) },
          configRepository: { readConfiguration: vi.fn(async () => []) },
          competitorEnabled: { value: true },
          onFatal: vi.fn(),
        }),
      ).rejects.toThrow('Scheduled monitor scheduler initialization failed');
      expect(schedulerRuntimeFixture.workerClosed).toBe(1);
      expect(schedulerRuntimeFixture.queueClosed).toBe(1);
    } finally {
      schedulerRuntimeFixture.readinessFailure = false;
    }
  });

  it('does not acknowledge the tick when queue admission is uncertain', async () => {
    const scheduledQueue = {
      add: vi.fn(async () => {
        throw new Error('ACK lost');
      }),
    };
    await expect(
      dispatchScheduledMonitorTick({
        env,
        configRepository: {
          readConfiguration: vi.fn(async () => [
            { configKey: 'MONITOR_EU_SCHEDULE_MINUTES', configValue: '30' },
          ]),
        },
        competitorEnabled: { value: true },
        scheduledQueue,
        assertLease: async () => true,
        nowMs: Date.parse('2026-10-25T10:30:00.000Z'),
      }),
    ).rejects.toThrow('ACK lost');
    expect(scheduledQueue.add).toHaveBeenCalledOnce();
  });

  it('stops admitting jobs immediately when the scheduler lease is lost', async () => {
    const scheduledQueue = { add: vi.fn(async () => ({ id: 'job' })) };
    const count = await dispatchScheduledMonitorTick({
      env,
      configRepository: { readConfiguration: vi.fn(async () => []) },
      competitorEnabled: { value: true },
      scheduledQueue,
      assertLease: async () => false,
      nowMs: Date.parse('2026-10-25T10:30:00.000Z'),
    });
    expect(count).toBe(0);
    expect(scheduledQueue.add).not.toHaveBeenCalled();
  });

  it('fails a partially dispatched tick after lease loss so BullMQ retries its persisted slot', async () => {
    const scheduledQueue = { add: vi.fn(async () => ({ id: 'job' })) };
    const assertLease = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    await expect(
      dispatchScheduledMonitorTick({
        env,
        configRepository: {
          readConfiguration: vi.fn(async () => [
            { configKey: 'MONITOR_EU_SCHEDULE_MINUTES', configValue: '30' },
          ]),
        },
        competitorEnabled: { value: true },
        scheduledQueue,
        assertLease,
        nowMs: Date.parse('2026-10-25T10:30:00.000Z'),
      }),
    ).rejects.toThrow('SCHEDULED_MONITOR_LEASE_LOST_DURING_DISPATCH');
    expect(scheduledQueue.add).toHaveBeenCalledOnce();
  });
});
