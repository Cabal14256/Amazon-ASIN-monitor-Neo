import type { Env } from '@asin-monitor/config';
import {
  PgSpApiConfigurationRepository,
  type SpApiConfigurationRow,
} from '@asin-monitor/db';
import {
  DelayedError,
  Queue,
  Worker,
  type ConnectionOptions,
  type Job,
} from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from './logger';
import { getNeoQueuePrefix } from './queue-policy';
import {
  buildScheduledMonitorDispatches,
  parseScheduledMonitorConfig,
  SCHEDULED_MONITOR_INTERVALS,
  SCHEDULED_MONITOR_JOB_OPTIONS,
  SCHEDULED_MONITOR_SCHEDULER_ID,
  SCHEDULED_MONITOR_TICK_EVERY_MS,
  SCHEDULED_MONITOR_TICK_JOB,
  SCHEDULED_MONITOR_TICK_QUEUE,
  type ScheduledMonitorConfig,
  type ScheduledMonitorInterval,
} from './scheduled-monitor-schedules';
import { SchedulerLease } from './scheduler-lease';

interface SchedulerQueue
  extends Pick<
    Queue,
    | 'add'
    | 'close'
    | 'waitUntilReady'
    | 'upsertJobScheduler'
    | 'removeJobScheduler'
  > {}

export interface ScheduledMonitorSchedulerRuntime {
  queue: SchedulerQueue;
  worker: Worker;
  close(): Promise<void>;
}

export interface ScheduledMonitorSchedulerOptions {
  env: Env;
  connection: ConnectionOptions;
  control: Redis;
  scheduledQueue: Pick<Queue, 'add'>;
  configRepository: Pick<PgSpApiConfigurationRepository, 'readConfiguration'>;
  competitorEnabled: { value: boolean };
  onFatal: () => void;
}

function initialConfig(env: Env): ScheduledMonitorConfig {
  return {
    enabled: true,
    competitorEnabled: env.COMPETITOR_MONITOR_ENABLED,
    usIntervalMinutes: env.MONITOR_US_SCHEDULE_MINUTES,
    euIntervalMinutes: env.MONITOR_EU_SCHEDULE_MINUTES,
    totalBatches: env.MONITOR_BATCH_COUNT,
  };
}

function rowsToConfig(
  rows: readonly SpApiConfigurationRow[],
  env: Env,
): ScheduledMonitorConfig {
  return parseScheduledMonitorConfig(rows, initialConfig(env));
}

export async function dispatchScheduledMonitorTick(
  options: ScheduledMonitorTickProducerOptions,
): Promise<number> {
  const rows = options.configSnapshot
    ? undefined
    : await options.configRepository.readConfiguration();
  const config = options.configSnapshot ?? rowsToConfig(rows!, options.env);
  options.competitorEnabled.value = config.competitorEnabled;
  const dispatches = buildScheduledMonitorDispatches(
    options.nowMs ?? Date.now(),
    config,
  );
  let admitted = 0;
  let leaseConfirmed = options.leaseConfirmed ?? false;
  for (const item of dispatches) {
    if (!(await options.assertLease())) {
      if (admitted > 0 || leaseConfirmed)
        throw new Error('SCHEDULED_MONITOR_LEASE_LOST_DURING_DISPATCH');
      return 0;
    }
    leaseConfirmed = true;
    await options.scheduledQueue.add('scheduled-monitor', item.job, {
      jobId: item.job.jobId,
      delay: item.delayMs,
      ...SCHEDULED_MONITOR_JOB_OPTIONS,
    });
    admitted++;
  }
  return admitted;
}

export interface ScheduledMonitorTickProducerOptions {
  env: Env;
  scheduledQueue: Pick<Queue, 'add'>;
  configRepository: Pick<PgSpApiConfigurationRepository, 'readConfiguration'>;
  competitorEnabled: { value: boolean };
  assertLease: () => Promise<boolean>;
  leaseConfirmed?: boolean;
  configSnapshot?: ScheduledMonitorConfig;
  nowMs?: number;
}

export interface ScheduledMonitorTickSnapshot {
  version: 1;
  tickJobId: string;
  plannedAt: string;
  config: ScheduledMonitorConfig;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function parseTickSnapshot(
  value: unknown,
  jobId: string,
  plannedAt: string,
): ScheduledMonitorTickSnapshot {
  const snapshot = record(value);
  const config = record(snapshot.config);
  if (
    Object.keys(snapshot).sort().join(',') !==
      'config,plannedAt,tickJobId,version' ||
    Object.keys(config).sort().join(',') !==
      'competitorEnabled,enabled,euIntervalMinutes,totalBatches,usIntervalMinutes' ||
    snapshot.version !== 1 ||
    snapshot.tickJobId !== jobId ||
    snapshot.plannedAt !== plannedAt ||
    typeof snapshot.plannedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.plannedAt)) ||
    new Date(Date.parse(snapshot.plannedAt)).toISOString() !==
      snapshot.plannedAt ||
    typeof config.enabled !== 'boolean' ||
    typeof config.competitorEnabled !== 'boolean' ||
    !SCHEDULED_MONITOR_INTERVALS.includes(
      config.usIntervalMinutes as ScheduledMonitorInterval,
    ) ||
    !SCHEDULED_MONITOR_INTERVALS.includes(
      config.euIntervalMinutes as ScheduledMonitorInterval,
    ) ||
    !Number.isSafeInteger(config.totalBatches) ||
    Number(config.totalBatches) < 1 ||
    Number(config.totalBatches) > 1000
  )
    throw new Error('SCHEDULED_MONITOR_TICK_SNAPSHOT_INVALID');
  return {
    version: 1,
    tickJobId: jobId,
    plannedAt,
    config: {
      enabled: config.enabled,
      competitorEnabled: config.competitorEnabled,
      usIntervalMinutes: config.usIntervalMinutes as ScheduledMonitorInterval,
      euIntervalMinutes: config.euIntervalMinutes as ScheduledMonitorInterval,
      totalBatches: Number(config.totalBatches),
    },
  };
}

export async function startScheduledMonitorScheduler(
  options: ScheduledMonitorSchedulerOptions,
): Promise<ScheduledMonitorSchedulerRuntime> {
  const { env, connection, control, scheduledQueue, configRepository } =
    options;
  const schedulerQueue = new Queue(SCHEDULED_MONITOR_TICK_QUEUE, {
    connection,
    prefix: getNeoQueuePrefix(env),
    defaultJobOptions: SCHEDULED_MONITOR_JOB_OPTIONS,
  });
  let lease: SchedulerLease | undefined;
  let closing = false;
  let worker: Worker | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const initialize = async () => {
    await schedulerQueue.waitUntilReady();
    if (closing) throw new Error('SCHEDULED_MONITOR_SCHEDULER_STARTUP_ABORTED');
    worker = new Worker(
      SCHEDULED_MONITOR_TICK_QUEUE,
      async (job: Job, token?: string) => {
        if (job.name !== SCHEDULED_MONITOR_TICK_JOB)
          throw new Error('SCHEDULED_MONITOR_SCHEDULER_JOB_INVALID');
        const plannedAt = job.opts.prevMillis;
        if (!Number.isSafeInteger(plannedAt) || plannedAt! <= 0)
          throw new Error('SCHEDULED_MONITOR_TICK_TIMESTAMP_INVALID');
        if (!(await lease?.assertCurrentOwner())) {
          await job.moveToDelayed(Date.now() + 5000, token);
          throw new DelayedError();
        }
        const plannedSlot = new Date(plannedAt!).toISOString();
        const data = record(job.data);
        let snapshot: ScheduledMonitorTickSnapshot;
        if (data.dispatchSnapshot === undefined) {
          const configRows = await configRepository.readConfiguration();
          snapshot = {
            version: 1,
            tickJobId: String(job.id),
            plannedAt: plannedSlot,
            config: rowsToConfig(configRows, env),
          };
          await job.updateData({ ...data, dispatchSnapshot: snapshot });
        } else {
          snapshot = parseTickSnapshot(
            data.dispatchSnapshot,
            String(job.id),
            plannedSlot,
          );
        }
        await dispatchScheduledMonitorTick({
          env,
          scheduledQueue,
          configRepository,
          competitorEnabled: options.competitorEnabled,
          assertLease: () =>
            lease?.assertCurrentOwner() ?? Promise.resolve(false),
          leaseConfirmed: true,
          configSnapshot: snapshot.config,
          nowMs: plannedAt!,
        });
      },
      {
        connection,
        prefix: getNeoQueuePrefix(env),
        concurrency: 1,
        autorun: false,
      },
    );
    worker.on('error', () =>
      logger.warn('定时监控调度消费者连接异常', {
        reason: 'scheduled_monitor_scheduler_worker_error',
      }),
    );
    await worker.waitUntilReady();
    if (closing) throw new Error('SCHEDULED_MONITOR_SCHEDULER_STARTUP_ABORTED');
    lease = new SchedulerLease(
      control,
      `${getNeoQueuePrefix(env)}:scheduler:scheduled-monitor`,
      async () => {
        if (!env.SCHEDULER_ENABLED) {
          await schedulerQueue.removeJobScheduler(
            SCHEDULED_MONITOR_SCHEDULER_ID,
          );
          return;
        }
        await schedulerQueue.upsertJobScheduler(
          SCHEDULED_MONITOR_SCHEDULER_ID,
          { every: SCHEDULED_MONITOR_TICK_EVERY_MS },
          {
            name: SCHEDULED_MONITOR_TICK_JOB,
            data: { schemaVersion: 1 },
            opts: SCHEDULED_MONITOR_JOB_OPTIONS,
          },
        );
      },
      logger,
      () =>
        schedulerQueue
          .removeJobScheduler(SCHEDULED_MONITOR_SCHEDULER_ID)
          .then(() => undefined),
    );
    await lease.start();
  };
  try {
    await Promise.race([
      initialize(),
      new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(
          () =>
            reject(new Error('SCHEDULED_MONITOR_SCHEDULER_STARTUP_TIMEOUT')),
          5000,
        );
      }),
    ]);
  } catch {
    closing = true;
    await lease?.stop();
    await Promise.allSettled([worker?.close(true), schedulerQueue.close()]);
    throw new Error('Scheduled monitor scheduler initialization failed');
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
  }
  const activeWorker = worker!;
  void activeWorker.run().catch(() => {
    if (!closing) {
      logger.error('定时监控调度消费者停止运行', {
        reason: 'scheduled_monitor_scheduler_stopped',
      });
      options.onFatal();
    }
  });
  let closed: Promise<void> | undefined;
  return {
    queue: schedulerQueue,
    worker: activeWorker,
    close() {
      closing = true;
      closed ??= (async () => {
        await lease?.stop();
        await activeWorker.close();
        await schedulerQueue.close();
      })();
      return closed;
    },
  };
}
