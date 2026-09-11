import {
  getImportStorageDirectory,
  getPhysicalQueueName,
  type Env,
} from '@asin-monitor/config';
import {
  createPgPool,
  isTerminalTaskStatus,
  PgAsinImportRepository,
  RedisTaskRepository,
} from '@asin-monitor/db';
import { ImportFileStore, ImportResultStore } from '@asin-monitor/import';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { createAsinImportProcessor } from './asin-import-processor';
import { logger } from './logger';
import { getQueueOptions, getWorkerOptions } from './queue-policy';
import { parseRedisUrl } from './redis-options';
import { taskNotificationWarning } from './task-notification-warning';

export async function startAsinImportRuntime(env: Env, onFatal: () => void) {
  if (env.AUTH_DATA_AUTHORITY !== 'postgresql')
    throw new Error('ASIN import requires PostgreSQL authority');
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
    logger.warn('导入 Redis 连接异常', { reason: 'import_redis_error' }),
  );
  const pool = createPgPool(env.DATABASE_URL, {
    max: 1,
    connectionTimeoutMillis: Math.min(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      2000,
    ),
    statement_timeout: 1500,
  });
  pool.on('error', () =>
    logger.error('导入数据库连接异常', { reason: 'import_database_error' }),
  );
  const directory = getImportStorageDirectory(env);
  const files = new ImportFileStore(directory);
  const reports = new ImportResultStore(directory);
  const shutdown = new AbortController();
  const store = new RedisTaskRepository(
    control,
    env,
    undefined,
    taskNotificationWarning(),
  );
  let queue: Queue | undefined, worker: Worker | undefined;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const ensureOpen = () => {
    if (closing) throw new Error('Import startup aborted');
  };
  try {
    await Promise.race([
      (async () => {
        await control.connect();
        ensureOpen();
        const repository = new PgAsinImportRepository(pool);
        await repository.transaction(async () => undefined);
        ensureOpen();
        queue = new Queue(
          getPhysicalQueueName('import'),
          getQueueOptions(
            'import',
            env,
            control as unknown as ConnectionOptions,
          ),
        );
        queue.on('error', () =>
          logger.warn('导入队列连接异常', { reason: 'import_queue_error' }),
        );
        await queue.waitUntilReady();
        ensureOpen();
        const activeQueue = queue;
        worker = new Worker(
          getPhysicalQueueName('import'),
          createAsinImportProcessor(repository, store, files, reports, {
            shutdownSignal: shutdown.signal,
            assertJobLock: async (job, token) => {
              if (
                !token ||
                !job.id ||
                (await control.get(`${activeQueue.toKey(job.id)}:lock`)) !==
                  token
              )
                throw new Error('IMPORT_JOB_LOCK_LOST');
            },
            updateProgress: async (job, value) => {
              const current = await activeQueue.getJob(job.id!);
              if (!current) throw new Error('IMPORT_JOB_MISSING');
              await current.updateProgress(value);
            },
          }),
          { ...getWorkerOptions('import', env, connection), autorun: false },
        );
        worker.on('error', () =>
          logger.warn('导入消费者连接异常', { reason: 'import_worker_error' }),
        );
        await worker.waitUntilReady();
        ensureOpen();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Import startup timed out')),
          5000,
        );
      }),
    ]);
    const activeQueue = queue!,
      activeWorker = worker!;
    void activeWorker.run().catch(() => {
      if (!closing) {
        logger.error('导入消费者停止运行', { reason: 'import_worker_stopped' });
        onFatal();
      }
    });
    const cleanup = async () => {
      const deadline = performance.now() + 2000;
      try {
        const result = await files.cleanup({
          // Retain uncertain API handoffs and crashed partial uploads for at
          // least a day and the full configured registry lifetime.
          olderThan:
            Date.now() - Math.max(86_400, env.TASK_META_TTL_SECONDS) * 1000,
          limit: 100,
          mayRemove: async (taskId, kind) => {
            if (closing || performance.now() >= deadline) return false;
            const task = await store.read(taskId);
            if (task)
              return kind === 'upload' && isTerminalTaskStatus(task.status);
            if (closing || performance.now() >= deadline) return false;
            // Missing metadata is not proof that a pending queue handoff failed.
            // Retain result files while the queue fallback can still find them.
            const job = await activeQueue.getJob(taskId);
            if (!job) return true;
            if (kind === 'result' || closing || performance.now() >= deadline)
              return false;
            return ['completed', 'failed'].includes(await job.getState());
          },
        });
        if (result.removed)
          logger.info('导入过期文件已清理', { removed: result.removed });
      } catch {
        if (!closing)
          logger.warn('导入文件清理暂不可用', {
            reason: 'import_cleanup_failed',
          });
      }
    };
    cleanupTimer = setInterval(() => {
      void cleanup();
    }, 60_000);
    cleanupTimer.unref();
    void cleanup();
    let closed: Promise<void> | undefined;
    return {
      queue: activeQueue,
      worker: activeWorker,
      close(): Promise<void> {
        closing = true;
        shutdown.abort();
        if (cleanupTimer) clearInterval(cleanupTimer);
        closed ??= (async () => {
          try {
            await activeWorker.close();
          } finally {
            await files.close();
            await Promise.allSettled([activeQueue.close(), pool.end()]);
            control.disconnect(false);
          }
        })();
        return closed;
      },
    };
  } catch {
    closing = true;
    shutdown.abort();
    if (cleanupTimer) clearInterval(cleanupTimer);
    control.disconnect(false);
    await Promise.allSettled([
      worker?.close(true),
      queue?.close(),
      pool.end(),
      files.close(),
    ]);
    throw new Error('ASIN import initialization failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
