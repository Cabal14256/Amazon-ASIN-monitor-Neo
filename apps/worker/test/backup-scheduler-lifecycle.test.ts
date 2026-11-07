import { loadEnv } from '@asin-monitor/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackupRuntime } from '../src/backup-runtime';

const controls = vi.hoisted(() => ({
  config: vi.fn(),
  create: vi.fn(),
  add: vi.fn(),
  queueClose: vi.fn(),
  poolEnd: vi.fn(),
  disconnect: vi.fn(),
  owner: true,
}));
vi.mock('@asin-monitor/db', async (original) => ({
  ...(await original<typeof import('@asin-monitor/db')>()),
  createPgPool: () => ({ on() {}, end: controls.poolEnd }),
  PgBackupConfigRepository: class {
    transaction(action: (unit: { get: typeof controls.config }) => unknown) {
      return action({ get: controls.config });
    }
  },
  RedisTaskRepository: class {
    create = controls.create;
  },
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Queue: class {
    on() {}
    async waitUntilReady() {}
    add = controls.add;
    close = controls.queueClose;
  },
  Worker: class {
    on() {}
    async waitUntilReady() {}
    async run() {}
    async close() {}
  },
}));
vi.mock('ioredis', () => ({
  Redis: class {
    on() {}
    async connect() {}
    disconnect = controls.disconnect;
  },
}));
vi.mock('../src/backup-processor', () => ({
  createBackupProcessor: () => vi.fn(),
}));
vi.mock('../src/scheduler-lease', () => ({
  SchedulerLease: class {
    constructor(
      _redis: unknown,
      _key: string,
      private readonly install: () => Promise<void>,
    ) {}
    isOwner() {
      return controls.owner;
    }
    async assertCurrentOwner() {
      return controls.owner;
    }
    start() {
      return this.install();
    }
    async stop() {
      controls.owner = false;
    }
  },
}));

const config = {
  enabled: true,
  scheduleType: 'daily',
  scheduleValue: null,
  backupTime: '02:00',
};
let runtime: Awaited<ReturnType<typeof startBackupRuntime>> | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T18:00:00.000Z'));
  controls.owner = true;
  controls.config.mockResolvedValue({ ...config, enabled: false });
  controls.create.mockImplementation(async (input: object) => ({
    ...input,
    createdAt: new Date().toISOString(),
  }));
  controls.add.mockResolvedValue(undefined);
  controls.queueClose.mockResolvedValue(undefined);
  controls.poolEnd.mockResolvedValue(undefined);
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  vi.useRealTimers();
});
async function start() {
  runtime = await startBackupRuntime(
    loadEnv({
      DATABASE_URL: 'postgresql://localhost/fixture',
      COMPETITOR_DATABASE_URL: 'postgresql://localhost/competitor_fixture',
      REDIS_URL: 'redis://localhost:6399',
      JWT_SECRET: 'fixture',
      AUTH_DATA_AUTHORITY: 'postgresql',
      TASK_META_TTL_SECONDS: '604800',
      SCHEDULER_ENABLED: 'true',
    }),
    vi.fn(),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('backup scheduler owns and drains each physical poll', () => {
  it('does not enqueue after losing its lease during the configuration read', async () => {
    await start();
    const read = deferred<typeof config>();
    controls.config.mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    controls.owner = false;
    read.resolve(config);
    await vi.advanceTimersByTimeAsync(0);
    expect(controls.create).not.toHaveBeenCalled();
    expect(controls.add).not.toHaveBeenCalled();
  });
  it('joins a pending poll before closing its database and queue and prevents late dispatch', async () => {
    await start();
    const read = deferred<typeof config>();
    controls.config.mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    const closed = runtime!.close();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(controls.queueClose).not.toHaveBeenCalled();
      expect(controls.poolEnd).not.toHaveBeenCalled();
    } finally {
      read.resolve(config);
    }
    await closed;
    expect(controls.create).not.toHaveBeenCalled();
    expect(controls.add).not.toHaveBeenCalled();
    expect(controls.queueClose).toHaveBeenCalledOnce();
    expect(controls.poolEnd).toHaveBeenCalledOnce();
  });
  it('stops between targets after a lease switch while preserving the accepted primary task', async () => {
    await start();
    controls.config.mockResolvedValue(config);
    controls.add.mockImplementationOnce(async () => {
      controls.owner = false;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(controls.add).toHaveBeenCalledTimes(1);
    expect(controls.add.mock.calls[0]?.[1]).toMatchObject({
      target: 'primary',
    });
    expect(controls.create).toHaveBeenCalledTimes(1);
  });
});
