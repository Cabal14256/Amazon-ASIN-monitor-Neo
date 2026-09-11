import { getPhysicalQueueName, type Env } from '@asin-monitor/config';
import {
  createPgPool,
  PgAsinBatchDeleteRepository,
  RedisTaskRepository,
} from '@asin-monitor/db';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { createAsinBatchDeleteProcessor } from './asin-batch-delete-processor';
import { logger } from './logger';
import { getQueueOptions, getWorkerOptions } from './queue-policy';
import { parseRedisUrl } from './redis-options';
import { taskNotificationWarning } from './task-notification-warning';

export async function startAsinBatchDeleteRuntime(
  env: Env,
  onFatal: () => void,
) {
  if (env.AUTH_DATA_AUTHORITY !== 'postgresql')
    throw new Error('ASIN batch deletion requires PostgreSQL authority');
  const connection = parseRedisUrl(env.REDIS_URL);
  const control = new Redis({
    ...connection,
    lazyConnect: true,
    connectTimeout: 1000,
    commandTimeout: 1000,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 1,
    // Reconnect for later jobs while every command still fails promptly and is
    // never queued/replayed. Otherwise one outage would disable this port forever.
    retryStrategy: (attempt) => Math.min(attempt * 200, 1000),
  });
  control.on('error', () =>
    logger.warn('批量删除 Redis 连接异常', {
      reason: 'batch_delete_redis_error',
    }),
  );
  const pool = createPgPool(env.DATABASE_URL, {
    max: Math.min(env.BATCH_DELETE_QUEUE_WORKER_CONCURRENCY, 16),
    connectionTimeoutMillis: Math.min(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      2000,
    ),
    statement_timeout: 1500,
  });
  pool.on('error', () =>
    logger.error('批量删除数据库连接异常', {
      reason: 'batch_delete_database_error',
    }),
  );
  let queue: Queue | undefined;
  let worker: Worker | undefined;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ensureOpen = () => {
    if (closing) throw new Error('Batch deletion startup aborted');
  };
  try {
    await Promise.race([
      (async () => {
        await control.connect();
        ensureOpen();
        const repository = new PgAsinBatchDeleteRepository(pool);
        // Execute the same migration/transaction preflight used for writes.
        await repository.transaction(async () => undefined);
        ensureOpen();
        queue = new Queue(
          getPhysicalQueueName('batch-delete'),
          getQueueOptions(
            'batch-delete',
            env,
            control as unknown as ConnectionOptions,
          ),
        );
        queue.on('error', () =>
          logger.warn('批量删除队列连接异常', {
            reason: 'batch_delete_queue_error',
          }),
        );
        await queue.waitUntilReady();
        ensureOpen();
        const activeQueue = queue;
        worker = new Worker(
          getPhysicalQueueName('batch-delete'),
          createAsinBatchDeleteProcessor(
            repository,
            new RedisTaskRepository(
              control,
              env,
              undefined,
              taskNotificationWarning(),
            ),
            {
              chunkSize: env.BATCH_DELETE_CHUNK_SIZE,
              isClosing: () => closing,
              assertJobLock: async (job, token) => {
                if (
                  !token ||
                  !job.id ||
                  (await control.get(`${activeQueue.toKey(job.id)}:lock`)) !==
                    token
                )
                  throw new Error('BATCH_DELETE_JOB_LOCK_LOST');
              },
              updateProgress: async (job, value) => {
                const current = await activeQueue.getJob(job.id!);
                if (!current) throw new Error('BATCH_DELETE_JOB_MISSING');
                await current.updateProgress(value);
              },
            },
          ),
          {
            ...getWorkerOptions('batch-delete', env, connection),
            autorun: false,
          },
        );
        worker.on('error', () =>
          logger.warn('批量删除消费者连接异常', {
            reason: 'batch_delete_worker_error',
          }),
        );
        await worker.waitUntilReady();
        ensureOpen();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Batch deletion startup timed out')),
          5000,
        );
      }),
    ]);
    const activeQueue = queue!,
      activeWorker = worker!;
    void activeWorker.run().catch(() => {
      if (!closing) {
        logger.error('批量删除消费者停止运行', {
          reason: 'batch_delete_worker_stopped',
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
            await activeWorker.close();
          } finally {
            await Promise.allSettled([activeQueue.close(), pool.end()]);
            control.disconnect(false);
          }
        })();
        return closed;
      },
    };
  } catch {
    closing = true;
    control.disconnect(false);
    await Promise.allSettled([worker?.close(true), queue?.close(), pool.end()]);
    throw new Error('ASIN batch deletion initialization failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
