import {
  getExportStorageDirectory,
  getNeoQueuePrefix,
  getPhysicalQueueName,
  getQueuePolicy,
  type Env,
  type QueueName,
} from '@asin-monitor/config';
import {
  asinExportJobDataSchema,
  competitorMonitorJobSchema,
  primaryMonitorJobSchema,
  type AsinExportJobData,
  type CompetitorMonitorJob,
  type PrimaryMonitorJob,
  type VariantCheckJobData,
} from '@asin-monitor/contracts';
import {
  RedisTaskRepository,
  batchDeleteTaskDataSchema,
  parseCompetitorMonitorCompletion,
  type BatchDeleteTaskData,
  type TaskRedisPort,
  type TaskState,
} from '@asin-monitor/db';
import {
  ExportArtifactStore,
  type ExportRejectionIdentity,
} from '@asin-monitor/export';
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
import { withMonitorAdmission } from './monitor-admission';
import {
  cancelQueuedTask,
  type CancellationOutcome,
} from './task-cancellation-script';
import type { QueueTaskSnapshot } from './task-query-values';

export const TASK_QUERY_QUEUES = [
  'monitor',
  'competitor-monitor',
  'export',
  'batch-check',
  'batch-delete',
  'import',
  'backup',
  'variant-check',
] as const satisfies readonly QueueName[];
const MONITOR_QUEUE_MAX_IN_FLIGHT = 50;
class TaskQueryFileError extends Error {}
export interface TaskQueryPort {
  store: Pick<RedisTaskRepository, 'read' | 'listUser' | 'mutate'>;
  findJob(taskId: string, taskType?: string): Promise<QueueTaskSnapshot | null>;
  reconcileRejectedExport?(task: TaskState): Promise<TaskState | null>;
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
export interface ExportProducerPort {
  store: Pick<RedisTaskRepository, 'createLimitedExport' | 'mutate'>;
  enqueue(data: AsinExportJobData): Promise<void>;
  recordRejected?(
    identity: ExportRejectionIdentity,
    deadline?: number,
  ): Promise<void>;
}
export class ExportEnqueueRejected extends Error {
  constructor(readonly reason: 'unavailable' | 'invalid') {
    super(`EXPORT_ENQUEUE_${reason.toUpperCase().replace('-', '_')}`);
  }
}
export interface MonitorProducerPort {
  store: Pick<RedisTaskRepository, 'create' | 'mutate'>;
  assertConsumer(): Promise<void>;
  enqueue(data: PrimaryMonitorJob): Promise<void>;
}
export interface CompetitorMonitorProducerPort
  extends Omit<MonitorProducerPort, 'enqueue'> {
  enqueue(data: CompetitorMonitorJob): Promise<void>;
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
    (['variant-check', 'batch-check', 'monitor', 'competitor-monitor'].includes(
      type,
    ) ||
      (type === 'export' && job.name === 'asin')) &&
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
  if (type === 'export' && job.name === 'asin') {
    const data = asinExportJobDataSchema.parse(job.data);
    if (data.taskId !== job.id || data.taskType !== type)
      throw new Error('TASK_QUEUE_IDENTITY_MISMATCH');
  }
  if (type === 'monitor') {
    const parsed = primaryMonitorJobSchema.safeParse(job.data);
    if (
      !parsed.success ||
      parsed.data.taskId !== job.id ||
      job.name !== 'primary-monitor'
    )
      throw new Error('TASK_QUEUE_IDENTITY_MISMATCH');
  }
  if (type === 'competitor-monitor') {
    const parsed = competitorMonitorJobSchema.safeParse(job.data);
    if (
      !parsed.success ||
      parsed.data.taskId !== job.id ||
      job.name !== 'competitor-monitor'
    )
      throw new Error('TASK_QUEUE_IDENTITY_MISMATCH');
    if (state === 'completed' && resultObject.cancelled !== true)
      parseCompetitorMonitorCompletion(parsed.data, result);
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
  private readonly exportArtifacts: ExportArtifactStore;
  private readonly redis: Redis;
  private readonly queues = new Map<string, QueueGetters>();
  private batchDeleteQueue?: Queue;
  private importQueue?: Queue;
  private exportQueue?: Queue;
  private monitorQueue?: Queue;
  private competitorMonitorQueue?: Queue;
  private readonly checkQueues = new Map<
    'variant-check' | 'batch-check',
    Queue
  >();
  private connecting?: Promise<void>;
  private closed = false;
  private lastNotificationWarning = -Infinity;
  private readonly exportFileOperations = new Map<string, Promise<unknown>>();
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.exportArtifacts = new ExportArtifactStore(
      getExportStorageDirectory(env),
    );
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
  private createStore(
    ensureOpen: () => void,
    beforeEval?: () => void,
  ): RedisTaskRepository {
    const command = this.command(ensureOpen);
    // This is the exact four-command subset used by RedisTaskRepository, never an unrestricted client.
    const redis: TaskRedisPort = {
      get: (key: string) => command(() => this.redis.get(key)),
      eval: (script: string, keyCount: number, ...args: (string | number)[]) =>
        command(() => {
          beforeEval?.();
          return this.redis.eval(script, keyCount, ...args);
        }),
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
  private async exportFile<T>(
    key: string,
    operation: () => Promise<T>,
    deadline: number,
    retainAfterDeadline = false,
  ): Promise<T> {
    const remaining = deadline - performance.now();
    if (remaining <= 0 && !retainAfterDeadline)
      throw new TaskQueryFileError('TASK_QUERY_FILE_DEADLINE');
    let pending = this.exportFileOperations.get(key) as Promise<T> | undefined;
    if (!pending) {
      if (this.exportFileOperations.size >= 8)
        throw new TaskQueryFileError('TASK_QUERY_FILE_CAPACITY');
      // Request expiry cannot cancel lstat/open/unlink in the kernel. Retain
      // their budget until actual settlement, and share an in-flight same-key
      // read so repeated requests cannot accumulate orphaned filesystem work.
      const actual = Promise.resolve().then(() => operation());
      pending = actual.finally(() => {
        if (this.exportFileOperations.get(key) === pending)
          this.exportFileOperations.delete(key);
      });
      this.exportFileOperations.set(key, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new TaskQueryFileError('TASK_QUERY_FILE_DEADLINE')),
            Math.max(0, remaining),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** Cancellation shares query/journal capacity until the native unlink ends. */
  async discardExport(
    taskId: string,
    deadline: number,
    operation: () => Promise<void> = () =>
      this.exportArtifacts.discardFinal(taskId),
  ): Promise<void> {
    await this.exportFile(`discard-final:${taskId}`, operation, deadline);
  }
  open(
    ensureOpen: () => void,
    deadline = performance.now() + 3000,
  ): TaskQueryPort {
    const command = this.command(ensureOpen);
    return {
      store: this.createStore(ensureOpen),
      reconcileRejectedExport: async (task) => {
        if (
          task.taskType !== 'export' ||
          task.taskSubType !== 'asin' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            task.taskId,
          )
        )
          return null;
        ensureOpen();
        let proof: ExportRejectionIdentity | null;
        try {
          proof = await this.exportFile(
            `read:${task.taskId}`,
            () => this.exportArtifacts.readRejectedSubmission(task.taskId),
            deadline,
          );
        } catch (error) {
          if (error instanceof TaskQueryFileError) throw error;
          this.logger.warn('导出拒绝回执读取暂不可用', 'TaskQueryRuntime', {
            reason: 'export_rejection_read_failed',
          });
          return null;
        }
        ensureOpen();
        if (
          !proof ||
          Object.entries(proof).some(
            ([key, value]) => task[key as keyof TaskState] !== value,
          )
        )
          return null;
        const next = await this.createStore(ensureOpen).mutate(
          task.taskId,
          { kind: 'failed', message: 'ASIN 导出未入队，请重试' },
          proof,
        );
        if (next && ['failed', 'cancelled', 'completed'].includes(next.status))
          await this.exportFile(
            `discard-rejection:${task.taskId}`,
            () => this.exportArtifacts.discardRejectedSubmission(task.taskId),
            deadline,
          ).catch(() =>
            this.logger.warn('导出拒绝回执清理暂不可用', 'TaskQueryRuntime', {
              reason: 'export_rejection_cleanup_failed',
            }),
          );
        return next;
      },
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
  openExport(
    ensureOpen: () => void,
    onCreateWriteStarted?: () => void,
  ): ExportProducerPort {
    return {
      store: this.createStore(ensureOpen, onCreateWriteStarted),
      recordRejected: (identity, deadline = performance.now() + 3000) =>
        this.exportFile(
          `reject:${identity.taskId}:${identity.createdAt}`,
          () => this.exportArtifacts.recordRejectedSubmission(identity),
          deadline,
          // The known pre-enqueue rejection must survive a Redis deadline.
          // Start only within the shared budget; expiry ends the caller's wait,
          // while the same identity's one native journal operation is retained.
          true,
        ),
      enqueue: async (input) => {
        const parsed = asinExportJobDataSchema.safeParse(input);
        if (!parsed.success) throw new ExportEnqueueRejected('invalid');
        let queue: Queue;
        try {
          ensureOpen();
          await this.ready();
          ensureOpen();
          queue = this.exportQueue ??= new Queue(
            getPhysicalQueueName('export'),
            {
              connection: this.redis as unknown as ConnectionOptions,
              prefix: getNeoQueuePrefix(this.env),
              defaultJobOptions: getQueuePolicy('export', this.env)
                .defaultJobOptions,
            },
          );
          if (queue.listenerCount('error') === 0)
            queue.on('error', () =>
              this.logger.warn('导出队列连接异常', 'TaskQueryRuntime', {
                reason: 'export_queue_error',
              }),
            );
          try {
            await queue.waitUntilReady();
          } catch (error) {
            if (this.exportQueue === queue) this.exportQueue = undefined;
            await queue.close().catch(() => undefined);
            throw error;
          }
          ensureOpen();
        } catch (error) {
          if (error instanceof ExportEnqueueRejected) throw error;
          throw new ExportEnqueueRejected('unavailable');
        }
        // An error from add may follow a committed Redis write. Keep its task
        // ID for reconciliation instead of claiming the request was rejected.
        await queue.add('asin', parsed.data, { jobId: parsed.data.taskId });
        ensureOpen();
      },
    };
  }
  openMonitor(ensureOpen: () => void): MonitorProducerPort {
    return this.openMonitoring(ensureOpen, false);
  }
  openCompetitorMonitor(ensureOpen: () => void): CompetitorMonitorProducerPort {
    return this.openMonitoring(ensureOpen, true);
  }
  private openMonitoring(ensureOpen: () => void, competitor: boolean) {
    const type = competitor ? 'competitor-monitor' : 'monitor';
    const name = competitor ? 'competitor-monitor' : 'primary-monitor';
    const command = this.command(ensureOpen);
    const readyQueue = async () => {
      let queue = competitor ? this.competitorMonitorQueue : this.monitorQueue;
      if (!queue) {
        queue = new Queue(getPhysicalQueueName(type), {
          connection: this.redis as unknown as ConnectionOptions,
          prefix: getNeoQueuePrefix(this.env),
          defaultJobOptions: getQueuePolicy(type, this.env).defaultJobOptions,
        });
        queue.on('error', () =>
          this.logger.warn('监控队列连接异常', 'TaskQueryRuntime', {
            reason: 'monitor_queue_error',
          }),
        );
        if (competitor) this.competitorMonitorQueue = queue;
        else this.monitorQueue = queue;
      }
      try {
        await queue.waitUntilReady();
      } catch (error) {
        if (competitor && this.competitorMonitorQueue === queue)
          this.competitorMonitorQueue = undefined;
        else if (!competitor && this.monitorQueue === queue)
          this.monitorQueue = undefined;
        await queue.close().catch(() => undefined);
        throw error;
      }
      ensureOpen();
      return queue;
    };
    const assertAvailable = async (queue: Queue) => {
      const ready = await this.redis.get(
        `${getNeoQueuePrefix(this.env)}:${type}:consumer:ready`,
      );
      if (ready !== '1') throw new Error('MONITOR_CONSUMER_NOT_READY');
      const counts = await queue.getJobCounts(
        'waiting',
        'delayed',
        'active',
        'paused',
        'prioritized',
      );
      if (
        Object.values(counts).reduce((sum, count) => sum + count, 0) >=
        MONITOR_QUEUE_MAX_IN_FLIGHT
      )
        throw new Error('MONITOR_QUEUE_FULL');
      ensureOpen();
    };
    const assertConsumer = async () =>
      command(async () => assertAvailable(await readyQueue()));
    return {
      store: this.createStore(ensureOpen),
      assertConsumer,
      enqueue: async (raw: PrimaryMonitorJob | CompetitorMonitorJob) => {
        const data = competitor
          ? competitorMonitorJobSchema.parse(raw)
          : primaryMonitorJobSchema.parse(raw);
        await command(async () => {
          const queue = await readyQueue();
          await withMonitorAdmission(
            {
              redis: this.redis,
              key: `${getNeoQueuePrefix(this.env)}:${type}:admission-lock`,
              ensureOpen,
              onReleaseFailure: () =>
                this.logger.warn(
                  '监控队列准入锁释放未确认',
                  'TaskQueryRuntime',
                  {
                    reason: 'monitor_admission_release_unconfirmed',
                  },
                ),
            },
            async (assertOwned) => {
              await assertAvailable(queue);
              await assertOwned();
              await queue.add(name, data, { jobId: data.taskId });
              try {
                await assertOwned();
              } catch {
                throw new Error('MONITOR_ADMISSION_UNCONFIRMED');
              }
            },
          );
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
        ...(this.exportQueue ? [this.exportQueue] : []),
        ...(this.monitorQueue ? [this.monitorQueue] : []),
        ...(this.competitorMonitorQueue ? [this.competitorMonitorQueue] : []),
        ...this.checkQueues.values(),
      ].map((queue) => queue.close()),
    );
    this.redis.disconnect(false);
  }
}
