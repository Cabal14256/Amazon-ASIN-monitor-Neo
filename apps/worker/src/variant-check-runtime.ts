import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  type Env,
} from '@asin-monitor/config';
import {
  createPgPool,
  PgPrimaryMonitorRepository,
  PgSpApiConfigurationRepository,
  PgVariantCheckRepository,
  RedisTaskRepository,
} from '@asin-monitor/db';
import {
  createFeishuNotifications,
  type FeishuNotifications,
} from '@asin-monitor/notify';
import {
  DatabaseConfigSource,
  NodeHttpTransport,
  SpApiRuntime,
} from '@asin-monitor/sp-api';
import { VariantCheckRuntime } from '@asin-monitor/variant-check';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from './logger';
import { MonitorConsumerHeartbeat } from './monitor-consumer-heartbeat';
import { createPrimaryMonitorProcessor } from './primary-monitor-processor';
import { getQueueOptions, getWorkerOptions } from './queue-policy';
import { parseRedisUrl } from './redis-options';
import { taskNotificationWarning } from './task-notification-warning';
import { createVariantCheckProcessor } from './variant-check-processor';

type CheckQueue = 'variant-check' | 'batch-check' | 'monitor';
/** Actual BullMQ consumers. All catalog/quota/task commands use a fail-fast
 * non-replaying connection; BullMQ alone owns its blocking/retry connections. */
export async function startVariantCheckRuntime(
  env: Env,
  selected: readonly CheckQueue[],
  onFatal: () => void,
  environment: Readonly<Record<string, unknown>> = process.env,
) {
  if (
    env.AUTH_DATA_AUTHORITY !== 'postgresql' ||
    !selected.length ||
    selected.some(
      (name) => !['variant-check', 'batch-check', 'monitor'].includes(name),
    )
  )
    throw new Error(
      'Variant checks require PostgreSQL authority and selected queues',
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
    logger.warn('检查 Redis 连接异常', { reason: 'variant_check_redis_error' }),
  );
  const pool = createPgPool(env.DATABASE_URL, {
    max: 8,
    connectionTimeoutMillis: Math.min(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      2000,
    ),
    statement_timeout: 1500,
  });
  const competitorPool = selected.includes('monitor')
    ? createPgPool(env.COMPETITOR_DATABASE_URL, {
        max: 2,
        connectionTimeoutMillis: 2000,
        statement_timeout: 1500,
      })
    : undefined;
  pool.on('error', () =>
    logger.error('检查数据库连接异常', {
      reason: 'variant_check_database_error',
    }),
  );
  competitorPool?.on('error', () =>
    logger.error('竞品通知配置数据库连接异常', {
      reason: 'monitor_notification_database_error',
    }),
  );
  const shutdown = new AbortController();
  const queues: Queue[] = [],
    workers: Worker[] = [];
  let source: DatabaseConfigSource | undefined,
    spApi: SpApiRuntime | undefined,
    runtime: VariantCheckRuntime | undefined;
  let notifications: FeishuNotifications | undefined;
  let monitorHeartbeat: MonitorConsumerHeartbeat | undefined;
  let transport: NodeHttpTransport | undefined,
    htmlTransport: NodeHttpTransport | undefined;
  let closing = false,
    cleanupRunning = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined,
    cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const ensureOpen = () => {
    if (closing) throw new Error('Variant check startup stopped');
  };
  const stopBusiness = () => {
    closing = true;
    shutdown.abort();
    if (cleanupTimer) clearInterval(cleanupTimer);
    void monitorHeartbeat?.stop();
    runtime?.close();
    notifications?.close();
    spApi?.close();
    source?.close();
    transport?.close();
    htmlTransport?.close();
  };
  try {
    const repository = new PgVariantCheckRepository(pool);
    const monitorRepository = selected.includes('monitor')
      ? new PgPrimaryMonitorRepository(pool)
      : undefined;
    if (competitorPool)
      notifications = createFeishuNotifications({
        primaryPool: pool,
        competitorPool,
        authority: () => env.AUTH_DATA_AUTHORITY,
        logger,
      });
    const configRepository = new PgSpApiConfigurationRepository(pool);
    source = new DatabaseConfigSource(environment, async (signal) =>
      Object.fromEntries(
        (await configRepository.readConfiguration(signal)).map((row) => [
          row.configKey.toUpperCase(),
          row.configValue,
        ]),
      ),
    );
    transport = new NodeHttpTransport({
      timeoutMs: 30_000,
      maxResponseBytes: 8 * 1024 * 1024,
      maxInFlight: 64,
    });
    htmlTransport = new NodeHttpTransport({
      timeoutMs: 15_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxInFlight: 2,
    });
    spApi = new SpApiRuntime({
      env,
      configEnv: environment,
      quotaEnv: {
        ...environment,
        RATE_LIMITER_KEY_PREFIX: env.RATE_LIMITER_KEY_PREFIX,
      },
      repository: configRepository,
      source,
      logger,
      transport,
      htmlTransport,
      redis: {
        client: control,
        ping: async () => {
          await control.ping();
        },
      },
    });
    runtime = new VariantCheckRuntime({
      spApi,
      redis: control,
      repository,
      logger,
      prefix: getNeoQueuePrefix(env),
      batchThreshold: env.MONITOR_BATCH_ASIN_THRESHOLD,
      batchConcurrency: env.BATCH_CHECK_GROUP_CONCURRENCY,
    });
    const business = runtime;
    const store = new RedisTaskRepository(
      control,
      env,
      undefined,
      taskNotificationWarning(),
    );
    const initialize = async () => {
      await control.connect();
      ensureOpen();
      await spApi!.initialize();
      ensureOpen();
      // Require the primary completion-table upgrade before registering consumers.
      await repository.transaction((unit) => unit.purgeExpiredReceipts());
      if (monitorRepository) await monitorRepository.assertReady();
      ensureOpen();
      for (const name of new Set(selected)) {
        const queue = new Queue(
          getPhysicalQueueName(name),
          getQueueOptions(name, env, control as unknown as ConnectionOptions),
        );
        queues.push(queue);
        queue.on('error', () =>
          logger.warn('检查队列连接异常', {
            reason: 'variant_check_queue_error',
          }),
        );
        await queue.waitUntilReady();
        ensureOpen();
        const assertJobLock = async (job: { id?: string }, token?: string) => {
          if (
            !token ||
            !job.id ||
            (await control.get(`${queue.toKey(job.id)}:lock`)) !== token
          )
            throw new Error('CHECK_JOB_LOCK_LOST');
        };
        const updateProgress = async (
          job: { id?: string; data: unknown },
          value: number,
        ) => {
          const current = await queue.getJob(job.id!);
          if (
            !current ||
            current.data?.createdAt !==
              (job.data as { createdAt?: string }).createdAt ||
            current.data?.userId !== (job.data as { userId?: string }).userId
          )
            throw new Error('CHECK_JOB_IDENTITY_CHANGED');
          await current.updateProgress(value);
        };
        const processor =
          name === 'monitor'
            ? createPrimaryMonitorProcessor({
                pipeline: business.pipeline,
                repository: monitorRepository!,
                store,
                notifications: notifications!,
                shutdownSignal: shutdown.signal,
                assertJobLock,
                updateProgress,
              })
            : createVariantCheckProcessor(business.executor, store, {
                taskType: name,
                shutdownSignal: shutdown.signal,
                assertJobLock,
                updateProgress,
              });
        const worker = new Worker(getPhysicalQueueName(name), processor, {
          ...getWorkerOptions(name, env, connection),
          autorun: false,
        });
        workers.push(worker);
        worker.on('error', () =>
          logger.warn('检查消费者连接异常', {
            reason: 'variant_check_worker_error',
          }),
        );
        await worker.waitUntilReady();
        ensureOpen();
      }
    };
    await Promise.race([
      initialize(),
      new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error('Variant check startup timeout')),
          10_000,
        );
      }),
    ]);
    for (const worker of workers)
      void worker.run().catch(() => {
        if (!closing) {
          logger.error('检查消费者停止运行', {
            reason: 'variant_check_worker_stopped',
          });
          onFatal();
        }
      });
    if (selected.includes('monitor')) {
      monitorHeartbeat = new MonitorConsumerHeartbeat(
        control,
        `${getNeoQueuePrefix(env)}:monitor:consumer:ready`,
      );
      await monitorHeartbeat.start();
      ensureOpen();
    }
    const cleanup = async () => {
      if (closing || cleanupRunning) return;
      cleanupRunning = true;
      try {
        const removed = await repository.transaction((unit) =>
          unit.purgeExpiredReceipts(),
        );
        if (removed) logger.info('过期检查结果已清理', { removed });
        if (monitorRepository) {
          const runs = await monitorRepository.purgeExpiredRuns();
          if (runs) logger.info('过期监控快照已清理', { runs });
        }
      } catch {
        if (!closing)
          logger.warn('检查结果清理暂不可用', {
            reason: 'variant_check_cleanup_failed',
          });
      } finally {
        cleanupRunning = false;
      }
    };
    cleanupTimer = setInterval(() => {
      void cleanup();
    }, 60_000);
    cleanupTimer.unref();
    let closed: Promise<void> | undefined;
    return {
      queues,
      workers,
      close(): Promise<void> {
        stopBusiness();
        closed ??= (async () => {
          try {
            await monitorHeartbeat?.stop();
            await Promise.all(workers.map((worker) => worker.close()));
          } finally {
            await Promise.allSettled([
              ...queues.map((queue) => queue.close()),
              pool.end(),
              competitorPool?.end(),
            ]);
            control.disconnect(false);
          }
        })();
        return closed;
      },
    };
  } catch {
    stopBusiness();
    await monitorHeartbeat?.stop();
    control.disconnect(false);
    await Promise.allSettled([
      ...workers.map((worker) => worker.close(true)),
      ...queues.map((queue) => queue.close()),
      pool.end(),
      competitorPool?.end(),
    ]);
    throw new Error('Variant check initialization failed');
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
  }
}
