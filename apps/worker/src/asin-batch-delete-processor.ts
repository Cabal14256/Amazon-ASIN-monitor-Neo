import {
  addBatchDeleteResult,
  asinBatchDeleteTaskDataSchema,
  batchDeleteTaskResult,
  competitorBatchDeleteTaskDataSchema,
  createBatchDeleteAggregate,
  isTerminalTaskStatus,
  splitBatchDeletePlan,
  type BatchDeleteExecutionRepositoryPort,
  type RedisTaskRepository,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { logger } from './logger';

interface ProcessorOptions {
  chunkSize: number;
  isClosing(): boolean;
  assertJobLock(job: Job, token: string | undefined): Promise<void>;
  updateProgress(job: Job, progress: number): Promise<void>;
}
class TaskStopped extends Error {
  constructor(readonly state: TaskState) {
    super('Task already stopped');
  }
}
class WorkerStopping extends Error {}
const cancelledResult = { cancelled: true, message: '批量删除任务已取消' };

/** Authorization is captured by the API. Workers verify immutable task identity
 * and cancellation, rather than requiring the accepting session to remain active. */
export function createAsinBatchDeleteProcessor(
  repository: BatchDeleteExecutionRepositoryPort,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  options: ProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, unknown, string> {
  return createDomainProcessor('asin', repository, store, options, log);
}

/** One physical queue has one dispatcher: every job validates its matching
 * immutable domain/subtype/name before touching either business database. */
export function createBatchDeleteProcessor(
  repositories: Record<
    'asin' | 'competitor',
    BatchDeleteExecutionRepositoryPort
  >,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  options: ProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, unknown, string> {
  const processors = {
    asin: createDomainProcessor('asin', repositories.asin, store, options, log),
    competitor: createDomainProcessor(
      'competitor',
      repositories.competitor,
      store,
      options,
      log,
    ),
  };
  return async (job, token) => {
    const domain = (job.data as { domain?: unknown } | null)?.domain;
    if (domain !== 'asin' && domain !== 'competitor')
      throw new UnrecoverableError('批量删除任务数据无效');
    return processors[domain](job, token);
  };
}

function createDomainProcessor(
  domain: 'asin' | 'competitor',
  repository: BatchDeleteExecutionRepositoryPort,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  options: ProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>,
): Processor<unknown, unknown, string> {
  const schema =
    domain === 'asin'
      ? asinBatchDeleteTaskDataSchema
      : competitorBatchDeleteTaskDataSchema;
  const label = domain === 'asin' ? 'ASIN' : '竞品';
  return async (job, token) => {
    const parsed = schema.safeParse(job.data);
    if (
      !parsed.success ||
      job.id !== parsed.data.taskId ||
      job.name !== `${domain}-batch-delete`
    )
      throw new UnrecoverableError('批量删除任务数据无效');
    const data = parsed.data;
    const verify = (state: TaskState | null): TaskState => {
      if (
        !state ||
        state.userId !== data.userId ||
        state.taskType !== data.taskType ||
        state.createdAt !== data.createdAt ||
        state.taskSubType !== data.taskSubType
      )
        throw new Error('BATCH_DELETE_TASK_IDENTITY_INVALID');
      return state;
    };
    const mutate = async (change: TaskMutation) =>
      verify(await store.mutate(data.taskId, change, data));
    const inspect = async (state: TaskState) => {
      if (isTerminalTaskStatus(state.status)) throw new TaskStopped(state);
      if (state.cancelRequestedAt || state.status === 'cancelling')
        throw new TaskStopped(
          await mutate({ kind: 'cancelled', message: cancelledResult.message }),
        );
      if (options.isClosing()) throw new WorkerStopping();
    };
    const check = async () => {
      await options.assertJobLock(job, token);
      await inspect(verify(await store.read(data.taskId)));
    };
    const progress = async (value: number, message: string) => {
      await check();
      await inspect(
        await mutate({ kind: 'progress', progress: value, message }),
      );
      await options.updateProgress(job, value);
    };
    try {
      await check();
      await inspect(
        await mutate({ kind: 'processing', message: '批量删除任务开始处理' }),
      );
      log.info(`${label} 批量删除任务开始`);
      await progress(5, '正在分析删除目标...');
      const analysis = await repository.transaction((unit) =>
        unit.analyze({ groupIds: data.groupIds, asinIds: data.asinIds }),
      );
      const chunks = splitBatchDeletePlan(analysis, options.chunkSize);
      const aggregate = createBatchDeleteAggregate(analysis.totalRequested);
      addBatchDeleteResult(aggregate, {
        totalRequested: 0,
        deletedGroupCount: 0,
        deletedDirectAsinCount: 0,
        deletedNestedAsinCount: 0,
        skipped: analysis.skipped,
      });
      for (let index = 0; index < chunks.length; index++) {
        await check();
        const chunk = chunks[index];
        try {
          addBatchDeleteResult(
            aggregate,
            await repository.transaction((unit) => unit.execute(chunk)),
          );
        } catch {
          aggregate.failedCount++;
          aggregate.failedSamples.push({
            index: index + 1,
            groupCount: chunk.groupIds.length,
            asinCount: chunk.asinIds.length,
            error: '删除分块失败，请刷新后核实剩余目标',
          });
          log.error(`${label} 批量删除分块失败`, {
            chunkIndex: index + 1,
            reason: 'batch_delete_chunk_failed',
          });
        }
        await progress(
          Math.min(Math.floor(((index + 1) / chunks.length) * 90) + 5, 95),
          `正在删除 ${index + 1}/${chunks.length}...`,
        );
      }
      await progress(100, '批量删除完成');
      const result = batchDeleteTaskResult(aggregate);
      const completed = await mutate({
        kind: 'completed',
        result,
        message: '批量删除完成',
      });
      if (completed.status !== 'completed') throw new TaskStopped(completed);
      log.info(`${label} 批量删除任务完成`, {
        failedChunks: aggregate.failedCount,
      });
      // Durable metadata precedes BullMQ completion. A lost completion ACK is
      // reconciled from the preserved terminal record without deleting again.
      return completed.result;
    } catch (error) {
      if (error instanceof TaskStopped) {
        if (error.state.status === 'cancelled') return cancelledResult;
        if (error.state.status === 'completed') return error.state.result;
        throw new UnrecoverableError('批量删除任务已失败');
      }
      const message =
        error instanceof WorkerStopping
          ? 'Worker 正在停止，已完成的删除保留，请刷新后核实剩余目标'
          : '批量删除失败，请刷新后核实剩余目标';
      // Redis failure / lock loss stops further DB work. Do not alter another
      // consumer's metadata if we no longer hold the BullMQ lock.
      try {
        await options.assertJobLock(job, token);
        const state = verify(await store.read(data.taskId));
        if (state.cancelRequestedAt && !isTerminalTaskStatus(state.status)) {
          const cancelled = await mutate({
            kind: 'cancelled',
            message: cancelledResult.message,
          });
          if (cancelled.status === 'cancelled') return cancelledResult;
        } else await mutate({ kind: 'failed', message });
      } catch {
        log.warn(`${label} 批量删除任务状态写入未确认`, {
          reason: 'batch_delete_status_unconfirmed',
        });
      }
      log.error(`${label} 批量删除任务停止`, {
        reason:
          error instanceof WorkerStopping
            ? 'worker_shutdown'
            : 'batch_delete_failed',
      });
      throw new UnrecoverableError(message);
    }
  };
}
