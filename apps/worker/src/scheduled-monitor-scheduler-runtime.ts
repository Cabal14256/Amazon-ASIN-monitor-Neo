import type { Env } from '@asin-monitor/config';
import {
  PgSpApiConfigurationRepository,
  type SpApiConfigurationRow,
} from '@asin-monitor/db';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from './logger';
import { getNeoQueuePrefix } from './queue-policy';
import {
  buildScheduledMonitorDispatches,
  parseScheduledMonitorConfig,
  SCHEDULED_MONITOR_JOB_OPTIONS,
  SCHEDULED_MONITOR_SCHEDULER_ID,
  SCHEDULED_MONITOR_TICK_EVERY_MS,
  SCHEDULED_MONITOR_TICK_JOB,
  SCHEDULED_MONITOR_TICK_QUEUE,
  type ScheduledMonitorConfig,
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
  const rows = await options.configRepository.readConfiguration();
  const config = rowsToConfig(rows, options.env);
  options.competitorEnabled.value = config.competitorEnabled;
  const dispatches = buildScheduledMonitorDispatches(
    options.nowMs ?? Date.now(),
    config,
  );
  let admitted = 0;
  for (const item of dispatches) {
    if (!(await options.assertLease())) break;
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
  nowMs?: number;
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
  const worker = new Worker(
    SCHEDULED_MONITOR_TICK_QUEUE,
    async (job: Job) => {
      if (job.name !== SCHEDULED_MONITOR_TICK_JOB)
        throw new Error('SCHEDULED_MONITOR_SCHEDULER_JOB_INVALID');
      await dispatchScheduledMonitorTick({
        env,
        scheduledQueue,
        configRepository,
        competitorEnabled: options.competitorEnabled,
        assertLease: () =>
          lease?.assertCurrentOwner() ?? Promise.resolve(false),
      });
    },
    {
      connection,
      prefix: getNeoQueuePrefix(env),
      concurrency: 1,
      autorun: false,
    },
  );
  await schedulerQueue.waitUntilReady();
  await worker.waitUntilReady();
  let closing = false;
  lease = new SchedulerLease(
    control,
    `${getNeoQueuePrefix(env)}:scheduler:scheduled-monitor`,
    () =>
      schedulerQueue
        .upsertJobScheduler(
          SCHEDULED_MONITOR_SCHEDULER_ID,
          { every: SCHEDULED_MONITOR_TICK_EVERY_MS },
          {
            name: SCHEDULED_MONITOR_TICK_JOB,
            data: { schemaVersion: 1 },
            opts: SCHEDULED_MONITOR_JOB_OPTIONS,
          },
        )
        .then(() => undefined),
    logger,
    () =>
      schedulerQueue
        .removeJobScheduler(SCHEDULED_MONITOR_SCHEDULER_ID)
        .then(() => undefined),
  );
  if (env.SCHEDULER_ENABLED) await lease.start();
  void worker.run().catch(() => {
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
    worker,
    close() {
      closing = true;
      closed ??= (async () => {
        await lease!.stop();
        await worker.close();
        await schedulerQueue.close();
      })();
      return closed;
    },
  };
}
