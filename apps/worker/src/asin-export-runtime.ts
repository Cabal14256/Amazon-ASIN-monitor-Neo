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
import {
  ASIN_EXPORT_TASK_TIMEOUT_MS,
  createAsinExportProcessor,
} from './asin-export-processor';
import { logger } from './logger';
import { getQueueOptions, getWorkerOptions } from './queue-policy';
import { parseRedisUrl } from './redis-options';
import { taskNotificationWarning } from './task-notification-warning';

export async function startAsinExportRuntime(env: Env, onFatal: () => void) {
  if (env.AUTH_DATA_AUTHORITY !== 'postgresql')
    throw new Error('ASIN export requires PostgreSQL authority');
  if (env.TASK_META_TTL_SECONDS < ASIN_EXPORT_MIN_TASK_TTL_SECONDS)
    throw new Error(
      'ASIN export requires at least 6 days of task metadata TTL',
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
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupActive = false;
  const shutdown = new AbortController();
  const ensureStarting = () => {
    if (closing) throw new Error('EXPORT_STARTUP_STOPPED');
  };
  try {
    await Promise.race([
      (async () => {
        await control.connect();
        ensureStarting();
        await queue.waitUntilReady();
        ensureStarting();
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
          logger.warn('ASIN 导出消费者连接异常', {
            reason: 'export_worker_error',
          }),
        );
        await worker.waitUntilReady();
        ensureStarting();
      })(),
      new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error('EXPORT_STARTUP_TIMEOUT')),
          5000,
        );
      }),
    ]);
    const activeWorker = worker!;
    const cleanup = async () => {
      // A stalled filesystem operation cannot be cancelled by the callback
      // deadline. Retain one sweep until it settles instead of accumulating
      // another blocked readdir/lstat/unlink on each interval tick.
      if (closing || cleanupActive) return;
      cleanupActive = true;
      const deadline = performance.now() + 2000;
      try {
        await artifacts.reconcileRejectedSubmissions(100, async (proof) => {
          if (closing || performance.now() >= deadline) return false;
          const task = await store.read(proof.taskId);
          if (!task) return true;
          // An expired UUID may identify a replacement. Remove only the stale
          // journal, never mutate that task or touch its artifact.
          if (
            Object.entries(proof).some(
              ([key, value]) => task[key as keyof typeof task] !== value,
            )
          )
            return true;
          if (['completed', 'failed', 'cancelled'].includes(task.status))
            return true;
          if (closing || performance.now() >= deadline) return false;
          const next = await store.mutate(
            proof.taskId,
            { kind: 'failed', message: 'ASIN 导出未入队，请重试' },
            proof,
          );
          return (
            !next || ['completed', 'failed', 'cancelled'].includes(next.status)
          );
        });
        // A retry owns a new random partial. Never retain a crashed attempt's
        // unreachable file for the lifetime of downloadable task metadata.
        const partials = await artifacts.cleanup(
          Date.now() - ASIN_EXPORT_TASK_TIMEOUT_MS - 15 * 60_000,
          100,
          async (_taskId, kind) =>
            !closing && performance.now() < deadline && kind === 'partial',
        );
        const removed = await artifacts.cleanup(
          Date.now() - Math.max(86_400, env.TASK_META_TTL_SECONDS) * 1000,
          100,
          async (taskId, kind) => {
            if (closing || performance.now() >= deadline || kind !== 'final')
              return false;
            const task = await store.read(taskId);
            if (task || closing || performance.now() >= deadline) return false;
            return !(await queue.getJob(taskId));
          },
        );
        const abandoned = await artifacts.cleanup(
          Date.now() - 60_000,
          100,
          async (taskId, kind) => {
            if (closing || performance.now() >= deadline || kind !== 'final')
              return false;
            const task = await store.read(taskId);
            return task?.status === 'cancelled' || task?.status === 'failed';
          },
        );
        if (partials || removed || abandoned)
          logger.info('过期 ASIN 导出文件已清理', {
            removed: partials + removed + abandoned,
          });
      } catch {
        if (!closing)
          logger.warn('ASIN 导出文件清理暂不可用', {
            reason: 'export_cleanup_failed',
          });
      } finally {
        cleanupActive = false;
      }
    };
    cleanupTimer = setInterval(() => void cleanup(), 60_000);
    cleanupTimer.unref();
    void cleanup();
    void activeWorker.run().catch(() => {
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
      worker: activeWorker,
      close(): Promise<void> {
        closing = true;
        shutdown.abort();
        if (cleanupTimer) clearInterval(cleanupTimer);
        closed ??= (async () => {
          await activeWorker.close();
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
    control.disconnect(false);
    await Promise.allSettled([worker?.close(true), queue.close(), pool.end()]);
    throw new Error('ASIN export runtime initialization failed');
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
  }
}
