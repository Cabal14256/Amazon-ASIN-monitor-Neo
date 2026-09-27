import { getPhysicalQueueName, type Env } from '@asin-monitor/config';
import {
  BACKUP_SCHEDULER_USER_ID,
  backupJobDataSchema,
  type BackupTarget,
} from '@asin-monitor/contracts';
import {
  createPgPool,
  PgBackupConfigRepository,
  RedisTaskRepository,
  TaskRegistryError,
} from '@asin-monitor/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { createBackupProcessor } from './backup-processor';
import { backupScheduleKey } from './backup-schedules';
import { logger } from './logger';
import { getQueueOptions, getWorkerOptions } from './queue-policy';
import { parseRedisUrl } from './redis-options';
import { SchedulerLease } from './scheduler-lease';

export function scheduledBackupTaskId(
  prefix: string,
  scheduleKey: string,
  target: BackupTarget,
): string {
  const hash = createHash('sha256')
    .update(`${prefix}:backup:${scheduleKey}:${target}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(
    13,
    16,
  )}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function enqueueScheduledBackups(
  prefix: string,
  key: string,
  store: Pick<RedisTaskRepository, 'create' | 'read'>,
  queue: Pick<Queue, 'add'>,
): Promise<void> {
  const targets: BackupTarget[] = ['primary', 'competitor'];
  for (const target of targets) {
    const taskId = scheduledBackupTaskId(prefix, key, target);
    let task;
    try {
      task = await store.create({
        taskId,
        userId: BACKUP_SCHEDULER_USER_ID,
        taskType: 'backup',
        taskSubType: 'create',
        title: `自动备份（${target}）`,
        message: '自动备份任务已创建，等待处理',
      });
    } catch (error) {
      if (!(error instanceof TaskRegistryError) || error.code !== 'TASK_EXISTS')
        throw error;
      task = await store.read(taskId);
      if (
        !task ||
        task.userId !== BACKUP_SCHEDULER_USER_ID ||
        task.taskType !== 'backup' ||
        task.taskSubType !== 'create'
      )
        throw new Error('BACKUP_SCHEDULE_TASK_IDENTITY_INVALID');
    }
    const data = backupJobDataSchema.parse({
      taskId,
      taskType: 'backup',
      taskSubType: 'create',
      operation: 'create',
      target,
      userId: BACKUP_SCHEDULER_USER_ID,
      createdAt: task.createdAt,
      params: {},
    });
    await queue.add('create', data, { jobId: taskId });
  }
}

export async function startBackupRuntime(env: Env, onFatal: () => void) {
  if (env.AUTH_DATA_AUTHORITY !== 'postgresql')
    throw new Error('Backup worker requires PostgreSQL authority');
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
    logger.warn('备份 Redis 连接异常', { reason: 'backup_redis_error' }),
  );
  const pool = createPgPool(env.DATABASE_URL, {
    max: 1,
    connectionTimeoutMillis: Math.min(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      2000,
    ),
    statement_timeout: 2000,
  });
  pool.on('error', () =>
    logger.error('备份配置数据库连接异常', { reason: 'backup_database_error' }),
  );
  const configRepository = new PgBackupConfigRepository(pool);
  const store = new RedisTaskRepository(control, env);
  const queue = new Queue(
    getPhysicalQueueName('backup'),
    getQueueOptions('backup', env, connection),
  );
  queue.on('error', () =>
    logger.warn('备份队列连接异常', { reason: 'backup_queue_error' }),
  );
  let closing = false;
  let worker: Worker | undefined;
  let scheduler: SchedulerLease | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let scheduleRunning = false;
  let lastScheduleKey: string | undefined;
  const shutdown = new AbortController();
  const schedule = async () => {
    if (closing || scheduleRunning || !scheduler?.isOwner()) return;
    scheduleRunning = true;
    try {
      const config = await configRepository.transaction((unit) => unit.get());
      if (!config.enabled) return;
      const key = backupScheduleKey(config);
      if (!key || key === lastScheduleKey) return;
      await enqueueScheduledBackups(env.BULL_PREFIX, key, store, queue);
      lastScheduleKey = key;
      logger.info('自动备份任务已创建', { schedule: key });
    } catch {
      logger.warn('自动备份计划同步失败，将在下一分钟重试', {
        reason: 'backup_schedule_failed',
      });
    } finally {
      scheduleRunning = false;
    }
  };
  try {
    await control.connect();
    await queue.waitUntilReady();
    worker = new Worker(
      getPhysicalQueueName('backup'),
      createBackupProcessor(store, {
        env,
        shutdownSignal: shutdown.signal,
        isClosing: () => closing,
        assertJobLock: async (job, token) => {
          if (
            !token ||
            !job.id ||
            (await control.get(`${queue.toKey(job.id)}:lock`)) !== token
          )
            throw new Error('BACKUP_JOB_LOCK_LOST');
        },
        updateProgress: async (job, value) => {
          const current = await queue.getJob(job.id!);
          if (!current) throw new Error('BACKUP_JOB_MISSING');
          await current.updateProgress(value);
        },
      }),
      { ...getWorkerOptions('backup', env, connection), autorun: false },
    );
    worker.on('error', () =>
      logger.warn('备份消费者连接异常', { reason: 'backup_worker_error' }),
    );
    await worker.waitUntilReady();
    if (env.SCHEDULER_ENABLED) {
      scheduler = new SchedulerLease(
        control,
        `${env.BULL_PREFIX}:neo:scheduler:backup`,
        async () => {
          if (timer) clearInterval(timer);
          timer = setInterval(() => void schedule(), 30_000);
          timer.unref();
          await schedule();
        },
      );
      await scheduler.start();
    }
    void worker.run().catch(() => {
      if (!closing) {
        logger.error('备份消费者停止运行', { reason: 'backup_worker_stopped' });
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
        if (timer) clearInterval(timer);
        closed ??= (async () => {
          await scheduler?.stop();
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
    if (timer) clearInterval(timer);
    await scheduler?.stop();
    await Promise.allSettled([worker?.close(true), queue.close(), pool.end()]);
    control.disconnect(false);
    throw new Error('Backup runtime initialization failed');
  }
}
