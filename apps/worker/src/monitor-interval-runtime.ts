import type { Env } from '@asin-monitor/config';
import {
  createPgPool,
  PgMonitorIntervalMaintenanceRepository,
} from '@asin-monitor/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from './logger';
import { createMonitorIntervalProcessor } from './monitor-interval-processor';
import {
  installMonitorIntervalSchedule,
  MONITOR_INTERVAL_JOB_OPTIONS,
  MONITOR_INTERVAL_QUEUE,
} from './monitor-interval-schedules';
import { getNeoQueuePrefix } from './queue-policy';
import { getWatchdogRedisOptions, parseRedisUrl } from './redis-options';
import { SchedulerLease } from './scheduler-lease';

export async function startMonitorIntervalRuntime(
  env: Env,
  onFatal: () => void,
) {
  if (
    env.AUTH_DATA_AUTHORITY !== 'postgresql' ||
    !env.ANALYTICS_STATUS_INTERVAL_ENABLED
  )
    throw new Error(
      'Monitor interval maintenance requires enabled PostgreSQL authority',
    );
  const connection = parseRedisUrl(env.REDIS_URL);
  const control = new Redis({
    ...getWatchdogRedisOptions(connection),
    lazyConnect: true,
    connectTimeout: 2000,
  });
  control.on('error', () =>
    logger.warn('状态区间维护 Redis 连接异常', {
      reason: 'interval_redis_error',
    }),
  );
  const pool = createPgPool(env.DATABASE_URL, {
    max: 2,
    connectionTimeoutMillis: Math.min(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      2000,
    ),
    statement_timeout: 1500,
  });
  pool.on('error', () =>
    logger.error('状态区间维护数据库连接异常', {
      reason: 'interval_database_error',
    }),
  );
  const repository = new PgMonitorIntervalMaintenanceRepository(pool);
  let queue: Queue | undefined,
    worker: Worker | undefined,
    lease: SchedulerLease | undefined;
  let aborted = false,
    closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ensureOpen = () => {
    if (aborted) throw new Error('Monitor interval startup was aborted');
  };
  try {
    await Promise.race([
      (async () => {
        await control.connect();
        ensureOpen();
        const schema = await pool.query(`SELECT
          EXISTS (SELECT 1 FROM public.monitor_interval_projection WHERE singleton AND version = 1)
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = 'public.monitor_interval_dirty'::regclass
            AND attname = 'retry_after' AND NOT attisdropped) AS ready`);
        ensureOpen();
        if (schema.rows[0]?.ready !== true)
          throw new Error('Monitor interval migration is missing');
        queue = new Queue(MONITOR_INTERVAL_QUEUE, {
          connection: {
            ...getWatchdogRedisOptions(connection),
            connectTimeout: 2000,
          },
          prefix: getNeoQueuePrefix(env),
          defaultJobOptions: MONITOR_INTERVAL_JOB_OPTIONS,
        });
        queue.on('error', () =>
          logger.warn('状态区间维护队列连接异常', {
            reason: 'interval_queue_error',
          }),
        );
        await queue.waitUntilReady();
        ensureOpen();
        await queue.setGlobalConcurrency(2);
        ensureOpen();
        worker = new Worker(
          MONITOR_INTERVAL_QUEUE,
          createMonitorIntervalProcessor(env, repository, queue, () => closing),
          {
            connection,
            prefix: getNeoQueuePrefix(env),
            concurrency: 1,
            autorun: false,
          },
        );
        worker.on('error', () =>
          logger.warn('状态区间维护消费者连接异常', {
            reason: 'interval_worker_error',
          }),
        );
        await worker.waitUntilReady();
        ensureOpen();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Monitor interval startup timed out')),
          5000,
        );
      }),
    ]);
    if (timer) clearTimeout(timer);
    const activeQueue = queue!,
      activeWorker = worker!;
    if (env.SCHEDULER_ENABLED) {
      lease = new SchedulerLease(
        control,
        `${getNeoQueuePrefix(env)}:scheduler:monitor-intervals`,
        () => installMonitorIntervalSchedule(activeQueue),
      );
      await lease.start();
    }
    void activeWorker.run().catch(() => {
      if (!closing) {
        logger.error('状态区间维护消费者停止运行', {
          reason: 'interval_worker_stopped',
        });
        onFatal();
      }
    });
    let closed: Promise<void> | undefined;
    return {
      queue: activeQueue,
      worker: activeWorker,
      close(): Promise<void> {
        closing = true;
        repository.close();
        closed ??= (async () => {
          try {
            await lease?.stop();
            await activeWorker.close();
          } finally {
            const results = await Promise.allSettled([
              activeQueue.close(),
              pool.end(),
              control.quit(),
            ]);
            if (results.some((result) => result.status === 'rejected')) {
              control.disconnect();
              logger.warn('部分状态区间维护资源关闭失败', {
                reason: 'interval_close_failed',
              });
            }
          }
        })();
        return closed;
      },
    };
  } catch {
    aborted = true;
    closing = true;
    repository.close();
    await lease?.stop();
    control.disconnect();
    await Promise.allSettled([worker?.close(true), queue?.close(), pool.end()]);
    throw new Error('Monitor interval maintenance initialization failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
