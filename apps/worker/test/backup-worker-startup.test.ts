import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootstrap } from '../src/main';
import { getPhysicalQueueName, type QueueName } from '../src/queues';

const dependencies = vi.hoisted(() => ({
  loadEnvironmentFiles: vi.fn(),
  startAuthMaintenance: vi.fn(),
  startMonitorIntervals: vi.fn(),
  startBatchDelete: vi.fn(),
  startImport: vi.fn(),
  startVariantChecks: vi.fn(),
  startBackup: vi.fn(),
  createQueue: vi.fn(),
  createRedis: vi.fn(),
  createWatchdog: vi.fn(),
  startWatchdog: vi.fn(),
  singleFlightCheck: vi.fn(),
  waitForShutdownSignal: vi.fn(),
  shutdownWorker: vi.fn(),
  runWorker: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Only prevent dotenv filesystem discovery. The production schema, loadEnv,
// shared queue catalog and resolveWorkerSelection remain real.
vi.mock('@asin-monitor/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@asin-monitor/config')>()),
  loadEnvironmentFiles: dependencies.loadEnvironmentFiles,
}));
vi.mock('../src/auth-maintenance-runtime', () => ({
  startAuthMaintenanceRuntime: dependencies.startAuthMaintenance,
}));
vi.mock('../src/monitor-interval-runtime', () => ({
  startMonitorIntervalRuntime: dependencies.startMonitorIntervals,
}));
vi.mock('../src/asin-batch-delete-runtime', () => ({
  startAsinBatchDeleteRuntime: dependencies.startBatchDelete,
}));
vi.mock('../src/asin-import-runtime', () => ({
  startAsinImportRuntime: dependencies.startImport,
}));
vi.mock('../src/variant-check-runtime', () => ({
  startVariantCheckRuntime: dependencies.startVariantChecks,
}));
vi.mock('../src/backup-runtime', () => ({
  startBackupRuntime: dependencies.startBackup,
}));
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string, options: unknown) {
      dependencies.createQueue(name, options);
    }

    getJobCounts = vi.fn(async () => ({}));
    close = vi.fn(async () => undefined);
  },
}));
vi.mock('ioredis', () => ({
  Redis: class {
    constructor(options: unknown) {
      dependencies.createRedis(options);
    }
  },
}));
vi.mock('../src/watchdog', () => ({
  createSingleFlightCheck: dependencies.singleFlightCheck,
  RedisWatchdog: class {
    constructor(redis: unknown, options: unknown) {
      dependencies.createWatchdog(redis, options);
    }

    start(callback: () => void) {
      dependencies.startWatchdog(callback);
    }
  },
}));
vi.mock('../src/queue-events', () => ({
  attachQueueErrorLogger: vi.fn(),
  attachRedisErrorLogger: vi.fn(),
}));
vi.mock('../src/idle', () => ({
  waitForShutdownSignal: dependencies.waitForShutdownSignal,
}));
vi.mock('../src/shutdown', () => ({
  shutdownWorker: dependencies.shutdownWorker,
}));
vi.mock('../src/runner', () => ({ runWorker: dependencies.runWorker }));
vi.mock('../src/logger', () => ({ logger: dependencies.logger }));

function runtime(name: string) {
  return {
    queue: { name, getJobCounts: vi.fn(async () => ({})) },
    close: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // No connection can escape this fixture: every runtime and Redis/Queue
  // constructor is mocked, and production dotenv loading is suppressed.
  for (const [key, value] of Object.entries({
    NODE_ENV: 'test',
    PROCESS_ROLE: 'worker',
    LOG_LEVEL: 'ERROR',
    DATABASE_URL: 'postgresql://localhost/worker_startup_primary',
    COMPETITOR_DATABASE_URL: 'postgresql://localhost/worker_startup_competitor',
    REDIS_URL: 'redis://localhost:6399',
    JWT_SECRET: 'worker-startup-fixture-secret',
    AUTH_DATA_AUTHORITY: 'postgresql',
    BULL_PREFIX: 'worker-startup-fixture',
    TASK_META_TTL_SECONDS: '86400',
    SCHEDULER_ENABLED: 'true',
    ANALYTICS_STATUS_INTERVAL_ENABLED: 'true',
  })) {
    vi.stubEnv(key, value);
  }
  for (const key of [
    'WORKER_ENABLED_QUEUES',
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'BACKUP_STORAGE_DIRECTORY',
    'PG_DUMP_PATH',
    'PG_RESTORE_PATH',
    'BACKUP_COMMAND_TIMEOUT_MS',
    'BACKUP_MAX_BYTES',
  ]) {
    vi.stubEnv(key, undefined);
  }
  dependencies.startAuthMaintenance.mockResolvedValue(
    runtime('auth-maintenance-queue'),
  );
  dependencies.startMonitorIntervals.mockResolvedValue(
    runtime('monitor-interval-maintenance-queue'),
  );
  dependencies.startBatchDelete.mockResolvedValue(
    runtime(getPhysicalQueueName('batch-delete')),
  );
  dependencies.startImport.mockResolvedValue(
    runtime(getPhysicalQueueName('import')),
  );
  dependencies.startVariantChecks.mockImplementation(
    async (_env: unknown, names: readonly QueueName[]) => ({
      queues: names.map((name) => runtime(getPhysicalQueueName(name)).queue),
      workers: names.map(() => ({})),
      close: vi.fn(async () => undefined),
    }),
  );
  // This boundary intentionally succeeds if called. An invalid startup must
  // exclude backup before invoking it, rather than rely on a mocked guard.
  dependencies.startBackup.mockResolvedValue(
    runtime(getPhysicalQueueName('backup')),
  );
  dependencies.waitForShutdownSignal.mockResolvedValue('SIGTERM');
  dependencies.singleFlightCheck.mockImplementation((check) => check);
  dependencies.shutdownWorker.mockResolvedValue(undefined);
  vi.spyOn(process, 'on').mockImplementation(() => process);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('Unexpected process.exit during worker startup');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function expectNoBackupResources() {
  expect(dependencies.startBackup).not.toHaveBeenCalled();
  expect(
    dependencies.createQueue.mock.calls.map(([name]) => name),
  ).not.toContain(getPhysicalQueueName('backup'));
  expect(process.exit).not.toHaveBeenCalled();
  expect(dependencies.runWorker).not.toHaveBeenCalled();
}

function expectDefaultRuntimes() {
  expect(dependencies.startAuthMaintenance).toHaveBeenCalledOnce();
  expect(dependencies.startMonitorIntervals).toHaveBeenCalledOnce();
  expect(dependencies.startBatchDelete).toHaveBeenCalledOnce();
  expect(dependencies.startImport).toHaveBeenCalledOnce();
  expect(dependencies.startVariantChecks).toHaveBeenCalledOnce();
  expect(dependencies.startVariantChecks.mock.calls[0]?.[1]).toEqual([
    'monitor',
    'competitor-monitor',
    'batch-check',
    'variant-check',
  ]);
  expect(dependencies.createQueue.mock.calls.map(([name]) => name)).toEqual([
    getPhysicalQueueName('export'),
  ]);
  expect(dependencies.createRedis).toHaveBeenCalledOnce();
  expect(dependencies.startWatchdog).toHaveBeenCalledOnce();
}

describe('production worker bootstrap isolates backup retention admission', () => {
  it('starts the other default runtimes with a valid one-day task TTL', async () => {
    await expect(bootstrap()).resolves.toBeUndefined();

    expect(dependencies.loadEnvironmentFiles).toHaveBeenCalledOnce();
    expectDefaultRuntimes();
    expectNoBackupResources();
    expect(dependencies.startVariantChecks.mock.calls[0]?.[0]).toMatchObject({
      AUTH_DATA_AUTHORITY: 'postgresql',
      TASK_META_TTL_SECONDS: 86400,
    });
    expect(
      dependencies.startVariantChecks.mock.calls[0]?.[0].WORKER_ENABLED_QUEUES,
    ).toBeUndefined();
  });

  it('starts backup together with the default runtimes at seven days', async () => {
    vi.stubEnv('TASK_META_TTL_SECONDS', '604800');

    await expect(bootstrap()).resolves.toBeUndefined();

    expectDefaultRuntimes();
    expect(dependencies.startBackup).toHaveBeenCalledOnce();
    expect(dependencies.startBackup.mock.calls[0]?.[0]).toMatchObject({
      AUTH_DATA_AUTHORITY: 'postgresql',
      TASK_META_TTL_SECONDS: 604800,
    });
    expect(process.exit).not.toHaveBeenCalled();
    expect(dependencies.waitForShutdownSignal).not.toHaveBeenCalled();
    expect(dependencies.runWorker).not.toHaveBeenCalled();
  });

  it('idles without Redis when only backup is requested with one-day TTL', async () => {
    vi.stubEnv('WORKER_ENABLED_QUEUES', 'backup');

    await expect(bootstrap()).resolves.toBeUndefined();

    expectNoBackupResources();
    expect(dependencies.waitForShutdownSignal).toHaveBeenCalledOnce();
    expect(dependencies.createQueue).not.toHaveBeenCalled();
    expect(dependencies.createRedis).not.toHaveBeenCalled();
    expect(dependencies.createWatchdog).not.toHaveBeenCalled();
    expect(dependencies.startAuthMaintenance).not.toHaveBeenCalled();
    expect(dependencies.startMonitorIntervals).not.toHaveBeenCalled();
    expect(dependencies.startBatchDelete).not.toHaveBeenCalled();
    expect(dependencies.startImport).not.toHaveBeenCalled();
    expect(dependencies.startVariantChecks).not.toHaveBeenCalled();
    expect(process.on).not.toHaveBeenCalled();
  });

  it('keeps monitor running when backup and monitor share one-day TTL', async () => {
    vi.stubEnv('WORKER_ENABLED_QUEUES', 'backup,monitor');

    await expect(bootstrap()).resolves.toBeUndefined();

    expectNoBackupResources();
    expect(dependencies.startVariantChecks).toHaveBeenCalledOnce();
    expect(dependencies.startVariantChecks.mock.calls[0]?.[1]).toEqual([
      'monitor',
    ]);
    expect(dependencies.createRedis).toHaveBeenCalledOnce();
    expect(dependencies.startWatchdog).toHaveBeenCalledOnce();
    expect(dependencies.createQueue).not.toHaveBeenCalled();
    expect(dependencies.waitForShutdownSignal).not.toHaveBeenCalled();
    expect(dependencies.startAuthMaintenance).not.toHaveBeenCalled();
    expect(dependencies.startMonitorIntervals).not.toHaveBeenCalled();
    expect(dependencies.startBatchDelete).not.toHaveBeenCalled();
    expect(dependencies.startImport).not.toHaveBeenCalled();
  });
});
