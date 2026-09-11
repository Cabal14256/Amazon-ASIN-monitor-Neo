import {
  isTerminalTaskStatus,
  type AsinImportRepositoryPort,
  type RedisTaskRepository,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import {
  ImportFileStore,
  ImportResultStore,
  importStoredFile,
  importTaskPreview,
  isAsinImportTaskData,
  normalizeImportTaskResult,
} from '@asin-monitor/import';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { logger } from './logger';

interface ImportProcessorOptions {
  shutdownSignal: AbortSignal;
  assertJobLock(job: Job, token: string | undefined): Promise<void>;
  updateProgress(job: Job, progress: number): Promise<void>;
}
class ImportStopped extends Error {
  constructor(readonly state: TaskState) {
    super('Import already stopped');
  }
}
class InterruptedImport extends Error {}
const cancelledResult = {
  cancelled: true,
  message: '导入任务已取消，已提交的数据保留',
};
const failureMessage = '导入任务中断，请核实已写入的数据后重新导入剩余记录';

/** Accepted authorization survives logout. The job must retain the same owner,
 * metadata incarnation and BullMQ lease before parsing or each database chunk. */
export function createAsinImportProcessor(
  repository: AsinImportRepositoryPort,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  files: ImportFileStore,
  reports: ImportResultStore,
  options: ImportProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, unknown, string> {
  return async (job, token) => {
    if (
      !isAsinImportTaskData(job.data) ||
      job.id !== job.data.taskId ||
      job.name !== 'asin-import'
    )
      throw new UnrecoverableError('导入任务数据无效');
    const data = job.data;
    const controller = new AbortController();
    const shutdown = () =>
      controller.abort(new Error('IMPORT_WORKER_SHUTDOWN'));
    options.shutdownSignal.addEventListener('abort', shutdown, { once: true });
    if (options.shutdownSignal.aborted) shutdown();
    const deadline = setTimeout(
      () => controller.abort(new Error('IMPORT_DEADLINE')),
      30 * 60_000,
    );
    deadline.unref();
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let checking: Promise<void> | undefined;
    let stopped = false;
    let published = false;
    const verify = (state: TaskState | null): TaskState => {
      if (
        !state ||
        state.userId !== data.userId ||
        state.taskType !== data.taskType ||
        state.taskSubType !== data.taskSubType ||
        state.createdAt !== data.createdAt
      )
        throw new Error('IMPORT_TASK_IDENTITY_INVALID');
      return state;
    };
    const mutate = async (change: TaskMutation) =>
      verify(await store.mutate(data.taskId, change, data));
    const inspect = async (state: TaskState) => {
      if (isTerminalTaskStatus(state.status)) throw new ImportStopped(state);
      if (state.cancelRequestedAt || state.status === 'cancelling')
        throw new ImportStopped(
          await mutate({ kind: 'cancelled', message: cancelledResult.message }),
        );
      return state;
    };
    const check = async () => {
      controller.signal.throwIfAborted();
      await options.assertJobLock(job, token);
      const state = await inspect(verify(await store.read(data.taskId)));
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
    const cleanupInput = async () => {
      try {
        await files.remove(data.file);
      } catch {
        log.warn('导入原始文件清理失败', {
          reason: 'import_input_cleanup_failed',
        });
      }
    };
    const terminalResult = async (state: TaskState) => {
      await cleanupInput();
      if (state.status === 'completed') return state.result;
      if (state.status === 'cancelled') return cancelledResult;
      throw new UnrecoverableError('导入任务已失败，请核实已写入的数据');
    };
    const complete = async (result: unknown) => {
      await check();
      const state = await mutate({
        kind: 'completed',
        result,
        message: '导入完成',
      });
      if (state.status !== 'completed') throw new ImportStopped(state);
      await cleanupInput();
      return state.result;
    };
    try {
      const initial = await check();
      scheduleHeartbeat();
      const existing = await reports.read(data, controller.signal);
      if (existing) {
        published = true;
        return await complete(
          importTaskPreview(existing.result, existing.report),
        );
      }
      // A previous consumer can have committed one or more chunks before losing
      // its process/lease. Do not reinterpret these writes as pre-existing ASIN
      // failures by automatically importing the entire source again.
      if (initial.startedAt || initial.status === 'processing')
        throw new InterruptedImport();
      await inspect(
        await mutate({ kind: 'processing', message: '导入任务开始处理' }),
      );
      log.info('ASIN 导入任务开始');
      const result = normalizeImportTaskResult(
        await importStoredFile(data.file, files, repository, {
          signal: controller.signal,
          checkpoint: async () => {
            await check();
          },
          onProgress: async (progress, message) => {
            await check();
            await inspect(
              await mutate({ kind: 'progress', progress, message }),
            );
            await options.updateProgress(job, progress);
          },
        }),
        data.file.originalFilename,
      );
      await check();
      const report = await reports.save(data, result, controller.signal);
      published = true;
      const completed = await complete(importTaskPreview(result, report));
      log.info('ASIN 导入任务完成', {
        successCount: result.successCount,
        failedCount: result.failedCount,
      });
      return completed;
    } catch (caught) {
      const error: unknown = controller.signal.aborted
        ? controller.signal.reason
        : caught;
      if (error instanceof ImportStopped) return terminalResult(error.state);
      // A final report is an immutable completion marker. Keep it and the input
      // when the Redis completion acknowledgement is uncertain; BullMQ may retry.
      if (published) {
        log.warn('导入完成状态写入未确认', {
          reason: 'import_completion_unconfirmed',
        });
        throw new Error('导入结果已保存，完成状态等待恢复');
      }
      let terminal: TaskState | undefined;
      try {
        await options.assertJobLock(job, token);
        const state = verify(await store.read(data.taskId));
        if (isTerminalTaskStatus(state.status)) terminal = state;
        else
          terminal = await mutate(
            state.cancelRequestedAt || state.status === 'cancelling'
              ? { kind: 'cancelled', message: cancelledResult.message }
              : { kind: 'failed', message: failureMessage },
          );
      } catch {
        log.warn('导入任务状态写入未确认', {
          reason: 'import_status_unconfirmed',
        });
      }
      log.error('ASIN 导入任务停止', {
        reason:
          error instanceof InterruptedImport
            ? 'import_previous_attempt_interrupted'
            : options.shutdownSignal.aborted
            ? 'worker_shutdown'
            : 'import_failed',
      });
      if (terminal && isTerminalTaskStatus(terminal.status))
        return terminalResult(terminal);
      // No confirmed terminal state: retain the file and permit the queue's
      // bounded retry policy to reconcile, never mutate a different consumer.
      throw new Error(failureMessage);
    } finally {
      stopped = true;
      clearTimeout(deadline);
      if (heartbeat) clearTimeout(heartbeat);
      await checking;
      options.shutdownSignal.removeEventListener('abort', shutdown);
    }
  };
}
