import type { Env } from '@asin-monitor/config';
import { createPgPool, PgAuthMaintenanceRepository } from '@asin-monitor/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createAuthMaintenanceProcessor } from './auth-maintenance-processor';
import {
  AUTH_MAINTENANCE_JOB_OPTIONS,
  AUTH_MAINTENANCE_QUEUE,
  installAuthMaintenanceSchedules,
} from './auth-maintenance-schedules';
import { logger } from './logger';
import { getNeoQueuePrefix } from './queue-policy';
import { getWatchdogRedisOptions, parseRedisUrl } from './redis-options';
import { SchedulerLease } from './scheduler-lease';

export async function startAuthMaintenanceRuntime(
  env: Env,
  onFatal: () => void,
) {
  if (env.AUTH_DATA_AUTHORITY !== 'postgresql')
    throw new Error('Authentication maintenance requires PostgreSQL authority');
  const connection = parseRedisUrl(env.REDIS_URL);
  const control = new Redis({
    ...getWatchdogRedisOptions(connection),
    lazyConnect: true,
    connectTimeout: 2000,
  });
  control.on('error', () =>
    logger.warn('认证维护Redis连接异常', { reason: 'maintenance_redis_error' }),
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
    logger.error('认证维护数据库连接异常', {
      reason: 'maintenance_database_error',
    }),
  );
  let queue: Queue | undefined;
  let worker: Worker | undefined;
  let lease: SchedulerLease | undefined;
  let aborted = false;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ensureOpen = () => {
    if (aborted) throw new Error('Maintenance startup was aborted');
  };
  try {
    await Promise.race([
      (async () => {
        await control.connect();
        ensureOpen();
        const schema = await pool.query(
          "SELECT to_regclass('sessions') IS NOT NULL AND to_regclass('audit_logs_archive') IS NOT NULL AND to_regclass('audit_logs_all') IS NOT NULL AS ready",
        );
        if (schema.rows[0]?.ready !== true)
          throw new Error('Authentication maintenance migration is missing');
        ensureOpen();
        queue = new Queue(AUTH_MAINTENANCE_QUEUE, {
          connection: {
            ...getWatchdogRedisOptions(connection),
            connectTimeout: 2000,
          },
          prefix: getNeoQueuePrefix(env),
          defaultJobOptions: AUTH_MAINTENANCE_JOB_OPTIONS,
        });
        queue.on('error', () =>
          logger.warn('认证维护队列连接异常', {
            reason: 'maintenance_queue_error',
          }),
        );
        await queue.waitUntilReady();
        ensureOpen();
        worker = new Worker(
          AUTH_MAINTENANCE_QUEUE,
          createAuthMaintenanceProcessor(
            env,
            new PgAuthMaintenanceRepository(pool),
            queue,
          ),
          {
            connection,
            prefix: getNeoQueuePrefix(env),
            concurrency: 1,
            autorun: false,
          },
        );
        worker.on('error', () =>
          logger.warn('认证维护消费者连接异常', {
            reason: 'maintenance_worker_error',
          }),
        );
        await worker.waitUntilReady();
        ensureOpen();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Authentication maintenance startup timed out')),
          5000,
        );
      }),
    ]);
    if (timer) clearTimeout(timer);
    const activeQueue = queue!;
    const activeWorker = worker!;
    if (env.SCHEDULER_ENABLED) {
      lease = new SchedulerLease(
        control,
        `${getNeoQueuePrefix(env)}:scheduler:leader`,
        () => installAuthMaintenanceSchedules(activeQueue),
      );
      await lease.start();
    }
    void activeWorker.run().catch(() => {
      if (!closing) {
        logger.error('认证维护消费者停止运行', {
          reason: 'maintenance_worker_stopped',
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
              logger.warn('部分认证维护资源关闭失败', {
                reason: 'maintenance_close_failed',
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
    await lease?.stop();
    control.disconnect();
    await Promise.allSettled([worker?.close(true), queue?.close(), pool.end()]);
    throw new Error('Authentication maintenance initialization failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
