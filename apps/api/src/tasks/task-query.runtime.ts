import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  getQueuePolicy,
  type Env,
  type QueueName,
} from '@asin-monitor/config';
import type { VariantCheckJobData } from '@asin-monitor/contracts';
import {
  RedisTaskRepository,
  batchDeleteTaskDataSchema,
  type BatchDeleteTaskData,
  type TaskRedisPort,
  type TaskState,
} from '@asin-monitor/db';
import { isImportTaskData, type ImportTaskData } from '@asin-monitor/import';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
} from '@asin-monitor/variant-check';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, QueueGetters, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import {
  cancelQueuedTask,
  type CancellationOutcome,
} from './task-cancellation-script';
import type { QueueTaskSnapshot } from './task-query-values';

export const TASK_QUERY_QUEUES = [
  'export',
  'batch-check',
  'batch-delete',
  'import',
  'backup',
  'variant-check',
] as const satisfies readonly QueueName[];
export interface TaskQueryPort {
  store: Pick<RedisTaskRepository, 'read' | 'listUser' | 'mutate'>;
  findJob(taskId: string, taskType?: string): Promise<QueueTaskSnapshot | null>;
}
export interface TaskCancellationPort {
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>;
  cancelJob(task: TaskState): Promise<CancellationOutcome>;
}
export interface BatchDeleteProducerPort {
  store: Pick<RedisTaskRepository, 'create'>;
  enqueue(data: BatchDeleteTaskData): Promise<void>;
}
export interface ImportProducerPort {
  store: Pick<RedisTaskRepository, 'create'>;
  enqueue(data: ImportTaskData): Promise<void>;
}
export interface CheckProducerPort {
  store: Pick<RedisTaskRepository, 'create'>;
  enqueue(data: VariantCheckJobData): Promise<void>;
}
const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.slice(0, max) : null;
function snapshot(job: Job, state: string, type: string): QueueTaskSnapshot {
  const result: unknown = job.returnvalue ?? null;
  const resultObject =
    result && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : {};
  const status =
    state === 'completed' &&
    ['variant-check', 'batch-check'].includes(type) &&
    resultObject.cancelled === true
      ? 'cancelled'
      : state === 'completed' || state === 'failed'
      ? state
      : state === 'active'
      ? 'processing'
      : 'pending';
  const failure = status === 'failed' ? '任务执行失败' : null;
  const owner = job.data?.userId;
  let checkOperation: QueueTaskSnapshot['checkOperation'];
  if (['variant-check', 'batch-check'].includes(type)) {
    const data = parseVariantCheckJob(job.data);
    if (data.taskId !== job.id || data.taskType !== type || job.name !== type)
      throw new Error('TASK_QUEUE_IDENTITY_MISMATCH');
    checkOperation = variantCheckJobOperation(data);
  }
  return {
    ...(checkOperation ? { checkOperation } : {}),
    taskId: job.id!,
    taskType: type,
    userId:
      typeof owner === 'string' && owner.length > 0 && owner.length <= 200
        ? owner
        : null,
    taskSubType: text(job.data?.taskSubType || job.data?.exportType, 200),
    title: text(job.data?.title || job.data?.exportType, 500) || type,
    status,
    progress:
      typeof job.progress === 'number' && Number.isFinite(job.progress)
        ? Math.min(100, Math.max(0, job.progress))
        : 0,
    message:
      failure ||
      text(
        resultObject.summary || resultObject.message || job.data?.message,
        2000,
      ) ||
      '任务处理中',
    error: failure,
    result,
    createdAt: text(job.data?.createdAt, 100),
    updatedAt: null,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
  };
}
/** Dedicated request connection: no Worker blocking/retry policy or Legacy Bull4 keys. */
@Injectable()
export class TaskQueryRuntime implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queues = new Map<string, QueueGetters>();
  private batchDeleteQueue?: Queue;
  private importQueue?: Queue;
  private readonly checkQueues = new Map<
    'variant-check' | 'batch-check',
    Queue
  >();
  private connecting?: Promise<void>;
  private closed = false;
  private lastNotificationWarning = -Infinity;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 1000,
      commandTimeout: 1000,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    this.redis.on('error', () =>
      this.logger.debug('任务查询连接事件', 'TaskQueryRuntime', {
        reason: 'redis_connection_error',
      }),
    );
  }
  private async ready() {
    if (this.closed) throw new Error('TASK_RUNTIME_CLOSED');
    if (this.connecting) return this.connecting;
    if (this.redis.status === 'ready') return;
    if (!['wait', 'end'].includes(this.redis.status))
      throw new Error('TASK_REDIS_NOT_READY');
    // ioredis may issue several handshake commands sequentially; its individual
    // command timeouts do not bound the whole ready transition.
    const attempt = this.redis.connect();
    let timer: ReturnType<typeof setTimeout>;
    const connecting = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        this.redis.disconnect(false);
        reject(new Error('TASK_REDIS_CONNECT_TIMEOUT'));
      }, 1000);
      attempt.then(() => resolve(), reject);
    });
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      clearTimeout(timer!);
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }
  private command(ensureOpen: () => void) {
    return async <T>(action: () => Promise<T>): Promise<T> => {
      ensureOpen();
      await this.ready();
      ensureOpen();
      const result = await action();
      ensureOpen();
      return result;
    };
  }
  openCancellation(ensureOpen: () => void): TaskCancellationPort {
    const command = this.command(ensureOpen);
    return {
      store: this.open(ensureOpen).store,
      cancelJob: (task) =>
        command(() => cancelQueuedTask(this.redis, this.env, task)),
    };
  }
  private createStore(ensureOpen: () => void): RedisTaskRepository {
    const command = this.command(ensureOpen);
    // This is the exact four-command subset used by RedisTaskRepository, never an unrestricted client.
    const redis: TaskRedisPort = {
      get: (key: string) => command(() => this.redis.get(key)),
      eval: (script: string, keyCount: number, ...args: (string | number)[]) =>
        command(() => this.redis.eval(script, keyCount, ...args)),
      zrevrange: (key: string, start: number, end: number) =>
        command(() => this.redis.zrevrange(key, start, end)),
      mget: (...keys: string[]) => command(() => this.redis.mget(...keys)),
    } as TaskRedisPort;
    return new RedisTaskRepository(redis, this.env, undefined, () => {
      if (Date.now() - this.lastNotificationWarning < 60_000) return;
      this.lastNotificationWarning = Date.now();
      this.logger.warn('任务已保存，实时通知发布失败', 'TaskQueryRuntime', {
        reason: 'task_notification_publish_failed',
      });
    });
  }
  openBatchDelete(ensureOpen: () => void): BatchDeleteProducerPort {
    const command = this.command(ensureOpen);
    return {
      store: this.createStore(ensureOpen),
      enqueue: (data) =>
        command(async () => {
          const accepted = batchDeleteTaskDataSchema.parse(data);
          const queue = (this.batchDeleteQueue ??= new Queue(
            getPhysicalQueueName('batch-delete'),
            {
              connection: this.redis as unknown as ConnectionOptions,
              prefix: getNeoQueuePrefix(this.env),
              defaultJobOptions: getQueuePolicy('batch-delete', this.env)
                .defaultJobOptions,
            },
          ));
          if (queue.listenerCount('error') === 0)
            queue.on('error', () =>
              this.logger.warn('批量删除队列连接异常', 'TaskQueryRuntime', {
                reason: 'batch_delete_queue_error',
              }),
            );
          try {
            await queue.waitUntilReady();
          } catch (error) {
            if (this.batchDeleteQueue === queue)
              this.batchDeleteQueue = undefined;
            await queue.close().catch(() => undefined);
            throw error;
          }
          ensureOpen();
          await queue.add(`${accepted.domain}-batch-delete`, accepted, {
            jobId: accepted.taskId,
          });
        }),
    };
  }
  open(ensureOpen: () => void): TaskQueryPort {
    const command = this.command(ensureOpen);
    return {
      store: this.createStore(ensureOpen),
      findJob: async (id, type) => {
        const names = TASK_QUERY_QUEUES.filter(
          (name) => type === undefined || name === type,
        );
        for (const name of names) {
          const job = await command(async () => {
            let queue = this.queues.get(name);
            if (!queue) {
              queue = new QueueGetters(getPhysicalQueueName(name), {
                // BullMQ resolves a newer ioredis minor with private type members;
                // the shared public command interface is verified on real Redis.
                connection: this.redis as unknown as ConnectionOptions,
                prefix: getNeoQueuePrefix(this.env),
              });
              queue.on('error', () =>
                this.logger.debug('任务查询队列事件', 'TaskQueryRuntime', {
                  reason: 'queue_connection_error',
                }),
              );
              this.queues.set(name, queue);
            }
            // Queue metadata/state keys are not job hashes. A valid task path
            // such as /tasks/completed must not be passed to HGETALL on a zset.
            if (Object.values(queue.keys).includes(queue.toKey(id)))
              return undefined;
            try {
              return await queue.getJob(id);
            } catch (error) {
              // Failed BullMQ initialization promises cannot recover with the Redis socket.
              if (this.queues.get(name) === queue) this.queues.delete(name);
              await queue.close().catch(() => undefined);
              throw error;
            }
          });
          if (!job) continue;
          const state = await command(() => job.getState());
          if (state === 'unknown') continue;
          // The first hash read can precede completion; reload the result after observing a terminal state.
          const current = ['completed', 'failed'].includes(state)
            ? await command(() => this.queues.get(name)!.getJob(id))
            : job;
          if (current) return snapshot(current, state, name);
        }
        return null;
      },
    };
  }
  openImport(ensureOpen: () => void): ImportProducerPort {
    const command = this.command(ensureOpen);
    return {
      store: this.createStore(ensureOpen),
      enqueue: (data) =>
        command(async () => {
          if (!isImportTaskData(data)) throw new Error('IMPORT_TASK_INVALID');
          const queue = (this.importQueue ??= new Queue(
            getPhysicalQueueName('import'),
            {
              connection: this.redis as unknown as ConnectionOptions,
              prefix: getNeoQueuePrefix(this.env),
              defaultJobOptions: getQueuePolicy('import', this.env)
                .defaultJobOptions,
            },
          ));
          if (queue.listenerCount('error') === 0)
            queue.on('error', () =>
              this.logger.warn('导入队列连接异常', 'TaskQueryRuntime', {
                reason: 'import_queue_error',
              }),
            );
          try {
            await queue.waitUntilReady();
          } catch (error) {
            if (this.importQueue === queue) this.importQueue = undefined;
            await queue.close().catch(() => undefined);
            throw error;
          }
          ensureOpen();
          await queue.add(
            data.taskSubType === 'asin' ? 'asin-import' : 'competitor-import',
            data,
            { jobId: data.taskId },
          );
        }),
    };
  }
  openCheck(ensureOpen: () => void): CheckProducerPort {
    const command = this.command(ensureOpen);
    return {
      store: this.createStore(ensureOpen),
      enqueue: async (input) => {
        const data = parseVariantCheckJob(input);
        await command(async () => {
          const type = data.taskType;
          let queue = this.checkQueues.get(type);
          if (!queue) {
            queue = new Queue(getPhysicalQueueName(type), {
              connection: this.redis as unknown as ConnectionOptions,
              prefix: getNeoQueuePrefix(this.env),
              defaultJobOptions: getQueuePolicy(type, this.env)
                .defaultJobOptions,
            });
            queue.on('error', () =>
              this.logger.warn('检查队列连接异常', 'TaskQueryRuntime', {
                reason: 'variant_check_queue_error',
              }),
            );
            this.checkQueues.set(type, queue);
          }
          try {
            await queue.waitUntilReady();
          } catch (error) {
            if (this.checkQueues.get(type) === queue)
              this.checkQueues.delete(type);
            await queue.close().catch(() => undefined);
            throw error;
          }
          ensureOpen();
          await queue.add(type, data, { jobId: data.taskId });
        });
      },
    };
  }
  async onModuleDestroy() {
    this.closed = true;
    await Promise.allSettled(
      [
        ...this.queues.values(),
        ...(this.batchDeleteQueue ? [this.batchDeleteQueue] : []),
        ...(this.importQueue ? [this.importQueue] : []),
        ...this.checkQueues.values(),
      ].map((queue) => queue.close()),
    );
    this.redis.disconnect(false);
  }
}
