import {
  isTerminalTaskStatus,
  VariantCheckError,
  type RedisTaskRepository,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
  variantCheckResultOperation,
  type VariantCheckExecutor,
} from '@asin-monitor/variant-check';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { logger } from './logger';

interface VariantProcessorOptions {
  taskType: 'variant-check' | 'batch-check';
  shutdownSignal: AbortSignal;
  assertJobLock(job: Job, token: string | undefined): Promise<void>;
  updateProgress(job: Job, progress: number): Promise<void>;
}
class CheckStopped extends Error {
  constructor(readonly state: TaskState) {
    super('Check task stopped');
  }
}
const cancelled = {
  cancelled: true,
  message: '检查任务已取消，已提交的检查结果保留',
};
const failureMessage = '检查任务失败，请核实最新检查状态后重试';

/** Accepted API authorization survives logout. Every database checkpoint still
 * verifies the immutable task owner/incarnation, lease, expiry and cancellation. */
export function createVariantCheckProcessor(
  executor: Pick<VariantCheckExecutor, 'execute'>,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  options: VariantProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, unknown, string> {
  return async (job, token) => {
    let data: ReturnType<typeof parseVariantCheckJob>;
    try {
      data = parseVariantCheckJob(job.data);
      if (
        job.id !== data.taskId ||
        job.name !== data.taskType ||
        data.taskType !== options.taskType
      )
        throw new Error();
    } catch {
      throw new UnrecoverableError('检查任务数据无效');
    }
    const expectedOperation = variantCheckJobOperation(data);
    const controller = new AbortController();
    const shutdown = () => controller.abort(new Error('CHECK_WORKER_SHUTDOWN'));
    options.shutdownSignal.addEventListener('abort', shutdown, { once: true });
    if (options.shutdownSignal.aborted) shutdown();
    let heartbeat: ReturnType<typeof setTimeout> | undefined,
      checking: Promise<void> | undefined;
    let stopped = false,
      published = false;
    const verify = (state: TaskState | null): TaskState => {
      if (
        !state ||
        state.taskId !== data.taskId ||
        state.userId !== data.userId ||
        state.createdAt !== data.createdAt ||
        state.taskType !== data.taskType ||
        state.taskSubType !== data.taskSubType
      )
        throw new Error('CHECK_TASK_IDENTITY_INVALID');
      return state;
    };
    const mutate = async (change: TaskMutation) =>
      verify(await store.mutate(data.taskId, change, data));
    const inspect = async (state: TaskState) => {
      if (isTerminalTaskStatus(state.status)) throw new CheckStopped(state);
      if (state.cancelRequestedAt || state.status === 'cancelling')
        throw new CheckStopped(
          await mutate({ kind: 'cancelled', message: cancelled.message }),
        );
      return state;
    };
    const check = async () => {
      controller.signal.throwIfAborted();
      await options.assertJobLock(job, token);
      const state = await inspect(verify(await store.read(data.taskId)));
      if (Date.parse(data.expiresAt) <= Date.now())
        throw new VariantCheckError('operation-expired');
      controller.signal.throwIfAborted();
      return state;
    };
    const scheduleHeartbeat = () => {
      if (stopped || controller.signal.aborted) return;
      heartbeat = setTimeout(() => {
        checking = check()
          .then(() => undefined)
          .catch((error: unknown) => {
            controller.abort(error);
          });
        void checking.then(scheduleHeartbeat);
      }, 1000);
      heartbeat.unref();
    };
    const terminalResult = (state: TaskState) => {
      if (state.status === 'completed') {
        const operation = variantCheckResultOperation(state, state.result);
        if (JSON.stringify(operation) !== JSON.stringify(expectedOperation))
          throw new UnrecoverableError('检查任务结果身份无效');
        return state.result;
      }
      if (state.status === 'cancelled') return cancelled;
      throw new UnrecoverableError(failureMessage);
    };
    try {
      await check();
      scheduleHeartbeat();
      await inspect(
        await mutate({ kind: 'processing', message: '检查任务开始处理' }),
      );
      log.info('变体检查任务开始', { taskType: data.taskType });
      const result = await executor.execute(data, {
        signal: controller.signal,
        checkpoint: async () => {
          await check();
        },
        authorize: async () => {
          await check();
        },
        onProgress: async (completed, total) => {
          await check();
          const progress = Math.min(
            95,
            5 + Math.floor((completed / Math.max(total, 1)) * 90),
          );
          await inspect(
            await mutate({
              kind: 'progress',
              progress,
              message: `正在检查 ${completed}/${total}`,
            }),
          );
          await options.updateProgress(job, progress);
        },
      });
      if (
        JSON.stringify(variantCheckResultOperation(data, result)) !==
        JSON.stringify(expectedOperation)
      )
        throw new VariantCheckError('operation-mismatch');
      published = true;
      await check();
      const state = await mutate({
        kind: 'completed',
        result,
        message: '检查完成',
      });
      log.info('变体检查任务完成', { taskType: data.taskType });
      return terminalResult(state);
    } catch (caught) {
      const error: unknown = controller.signal.aborted
        ? controller.signal.reason
        : caught;
      if (error instanceof CheckStopped) return terminalResult(error.state);
      // Keep retryable metadata nonterminal; the next attempt reads PG receipts
      // before upstream calls or writes. BullMQ retains its configured two attempts.
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const permanent =
        error instanceof VariantCheckError &&
        [
          'invalid-input',
          'invalid-result',
          'operation-expired',
          'operation-mismatch',
        ].includes(error.code);
      let terminal: TaskState | undefined;
      try {
        await options.assertJobLock(job, token);
        const current = verify(await store.read(data.taskId));
        if (isTerminalTaskStatus(current.status)) terminal = current;
        else if (current.cancelRequestedAt || current.status === 'cancelling')
          terminal = await mutate({
            kind: 'cancelled',
            message: cancelled.message,
          });
        else if (
          !options.shutdownSignal.aborted &&
          (finalAttempt || permanent) &&
          !published
        )
          terminal = await mutate({ kind: 'failed', message: failureMessage });
      } catch {
        log.warn('检查任务状态写入未确认', {
          reason: 'variant_check_status_unconfirmed',
        });
      }
      if (terminal) return terminalResult(terminal);
      log.warn('变体检查等待任务重试或对账', {
        reason: published
          ? 'variant_check_completion_unconfirmed'
          : 'variant_check_attempt_interrupted',
      });
      if (permanent) throw new UnrecoverableError(failureMessage);
      throw new Error(
        published ? '检查结果已保存，完成状态等待恢复' : failureMessage,
      );
    } finally {
      stopped = true;
      if (heartbeat) clearTimeout(heartbeat);
      await checking;
      options.shutdownSignal.removeEventListener('abort', shutdown);
    }
  };
}
