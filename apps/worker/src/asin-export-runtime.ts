import {
  getExportStorageDirectory,
  getPhysicalQueueName,
  type Env,
} from '@asin-monitor/config';
import {
  ASIN_EXPORT_MIN_TASK_TTL_SECONDS,
  ASIN_EXPORT_QUERY_TIMEOUT_MS,
  createPgPool,
  PgAsinExportQueryRepository,
  RedisTaskRepository,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createAsinExportProcessor } from './asin-export-processor';
import { logger } from './logger';
import { getQueueOptions, getWorkerOptions } from './queue-policy';
import { parseRedisUrl } from './redis-options';
import { taskNotificationWarning } from './task-notification-warning';

export async function startAsinExportRuntime(env: Env, onFatal: () => void) {
  if (env.AUTH_DATA_AUTHORITY !== 'postgresql')
    throw new Error('ASIN export requires PostgreSQL authority');
  if (env.TASK_META_TTL_SECONDS < ASIN_EXPORT_MIN_TASK_TTL_SECONDS)
    throw new Error(
      'ASIN export requires at least 72 hours of task metadata TTL',
    );
  const connection = parseRedisUrl(env.REDIS_URL);
  const control = new Redis({
    ...connection,
    lazyConnect: true,
    connectTimeout: 1000,
    commandTimeout: 1000,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 1000),
  });
  control.on('error', () =>
    logger.warn('ASIN 导出 Redis 连接异常', { reason: 'export_redis_error' }),
  );
  const pool = createPgPool(env.DATABASE_URL, {
    max: 2,
    connectionTimeoutMillis: Math.min(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      2000,
    ),
    statement_timeout: ASIN_EXPORT_QUERY_TIMEOUT_MS,
  });
  pool.on('error', () =>
    logger.error('ASIN 导出数据库连接异常', {
      reason: 'export_database_error',
    }),
  );
  const repository = new PgAsinExportQueryRepository(pool);
  const store = new RedisTaskRepository(
    control,
    env,
    undefined,
    taskNotificationWarning(),
  );
  const artifacts = new ExportArtifactStore(getExportStorageDirectory(env));
  const queue = new Queue(
    getPhysicalQueueName('export'),
    getQueueOptions('export', env, connection),
  );
  queue.on('error', () =>
    logger.warn('ASIN 导出队列连接异常', { reason: 'export_queue_error' }),
  );
  let closing = false;
  let worker: Worker | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const shutdown = new AbortController();
  try {
    await control.connect();
    await queue.waitUntilReady();
    worker = new Worker(
      getPhysicalQueueName('export'),
      createAsinExportProcessor(repository, store, artifacts, {
        shutdownSignal: shutdown.signal,
        isClosing: () => closing,
        assertJobLock: async (job, token) => {
          if (
            !token ||
            !job.id ||
            (await control.get(`${queue.toKey(job.id)}:lock`)) !== token
          )
            throw new Error('EXPORT_JOB_LOCK_LOST');
        },
        updateProgress: async (job, value) => {
          const current = await queue.getJob(job.id!);
          if (!current) throw new Error('EXPORT_JOB_MISSING');
          await current.updateProgress(value);
        },
      }),
      {
        ...getWorkerOptions('export', env, connection),
        concurrency: Math.min(2, env.EXPORT_QUEUE_WORKER_CONCURRENCY),
        autorun: false,
      },
    );
    worker.on('error', () =>
      logger.warn('ASIN 导出消费者连接异常', { reason: 'export_worker_error' }),
    );
    await worker.waitUntilReady();
    const cleanup = async () => {
      const deadline = performance.now() + 2000;
      try {
        const removed = await artifacts.cleanup(
          Date.now() - Math.max(86_400, env.TASK_META_TTL_SECONDS) * 1000,
          100,
          async (taskId, kind) => {
            if (closing || performance.now() >= deadline) return false;
            if (kind === 'partial') return true;
            const task = await store.read(taskId);
            if (task || closing || performance.now() >= deadline) return false;
            return !(await queue.getJob(taskId));
          },
        );
        if (removed) logger.info('过期 ASIN 导出文件已清理', { removed });
      } catch {
        if (!closing)
          logger.warn('ASIN 导出文件清理暂不可用', {
            reason: 'export_cleanup_failed',
          });
      }
    };
    cleanupTimer = setInterval(() => void cleanup(), 60_000);
    cleanupTimer.unref();
    void cleanup();
    void worker.run().catch(() => {
      if (!closing) {
        logger.error('ASIN 导出消费者停止运行', {
          reason: 'export_worker_stopped',
        });
        onFatal();
      }
    });
    let closed: Promise<void> | undefined;
    return {
      queue,
      worker,
      close(): Promise<void> {
        closing = true;
        shutdown.abort();
        if (cleanupTimer) clearInterval(cleanupTimer);
        closed ??= (async () => {
          await worker!.close();
          await Promise.allSettled([queue.close(), pool.end()]);
          control.disconnect(false);
        })();
        return closed;
      },
    };
  } catch {
    closing = true;
    shutdown.abort();
    if (cleanupTimer) clearInterval(cleanupTimer);
    await Promise.allSettled([worker?.close(true), queue.close(), pool.end()]);
    control.disconnect(false);
    throw new Error('ASIN export runtime initialization failed');
  }
}
