import {
  parentAsinExportJobDataSchema,
  parentAsinQueryItemSchema,
  type ParentAsinExportJobData,
} from '@asin-monitor/contracts';
import {
  isTerminalTaskStatus,
  type RedisTaskRepository,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactError, ExportArtifactStore } from '@asin-monitor/export';
import {
  createWorkSettlement,
  type CatalogParentQuery,
} from '@asin-monitor/sp-api';
import { UnrecoverableError, type Processor } from 'bullmq';
import type { WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { abortableExport } from './abortable-export';
import {
  ASIN_EXPORT_TASK_TIMEOUT_MS,
  type AsinExportProcessorOptions,
} from './asin-export-processor';
import { createBoundedExportWorkbook } from './bounded-export-workbook';
import { logger } from './logger';
import {
  PARENT_ASIN_EXPORT_HEADER,
  PARENT_ASIN_EXPORT_WIDTHS,
  parentAsinExportFilename,
  parentAsinExportRows,
} from './parent-asin-export-rows';
const WRITER_CLOSE_TIMEOUT_MS = 5000;
const cancelledResult = { cancelled: true, message: '导出任务已取消' };
const identity = (data: ParentAsinExportJobData) => ({
  userId: data.userId,
  taskType: data.taskType,
  taskSubType: data.taskSubType,
  createdAt: data.createdAt,
});
export type ParentAsinExportProcessorOptions = Omit<
  AsinExportProcessorOptions,
  'competitor' | 'authorize'
> & { authorize(userId: string): Promise<void> };
class TaskStopped extends Error {
  constructor(readonly state: TaskState) {
    super('Export task stopped');
  }
}
class ExportCapacityError extends Error {}

export function createParentAsinExportProcessor(
  parents: Pick<CatalogParentQuery, 'query'>,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  artifacts: ExportArtifactStore,
  options: ParentAsinExportProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, unknown, string> {
  return async (job, token) => {
    const parsed = parentAsinExportJobDataSchema.safeParse(job.data);
    if (
      !parsed.success ||
      job.id !== parsed.data.taskId ||
      job.name !== 'parent-asin-query'
    )
      throw new UnrecoverableError('导出任务数据无效');
    const data = parsed.data;
    const controller = new AbortController();
    const settlement = createWorkSettlement(controller.signal);
    const shutdown = () =>
      controller.abort(new Error('EXPORT_WORKER_SHUTDOWN'));
    options.shutdownSignal.addEventListener('abort', shutdown, { once: true });
    if (options.shutdownSignal.aborted) shutdown();
    const deadline = setTimeout(
      () => controller.abort(new Error('EXPORT_TASK_TIMEOUT')),
      ASIN_EXPORT_TASK_TIMEOUT_MS,
    );
    deadline.unref();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    let partial: string | undefined;
    let outputStream: WriteStream | undefined;
    let boundedWorkbook:
      | ReturnType<typeof createBoundedExportWorkbook>
      | undefined;
    const abortWriter = () => {
      boundedWorkbook?.stop(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('EXPORT_WRITER_ABORTED'),
      );
      if (outputStream && !outputStream.destroyed)
        outputStream.destroy(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('EXPORT_WRITER_ABORTED'),
        );
    };
    let published = false;
    const verify = (state: TaskState | null): TaskState => {
      if (
        !state ||
        state.taskId !== data.taskId ||
        state.userId !== data.userId ||
        state.taskType !== data.taskType ||
        state.taskSubType !== data.taskSubType ||
        state.createdAt !== data.createdAt
      )
        throw new Error('EXPORT_TASK_IDENTITY_INVALID');
      return state;
    };
    const mutate = async (change: TaskMutation) =>
      verify(await store.mutate(data.taskId, change, identity(data)));
    const discardCancelledFinal = async () => {
      // An earlier attempt may have published before its completion ACK was
      // lost. Cancellation can be observed before this attempt reads that file.
      await artifacts.discardFinal(data.taskId).catch(() =>
        log.warn('已取消 父变体查询导出文件清理失败', {
          reason: 'export_cancelled_artifact_cleanup_failed',
        }),
      );
    };
    const finishCancellation = async () => {
      const next = await mutate({
        kind: 'cancelled',
        message: cancelledResult.message,
      });
      if (next.status === 'completed') return next.result;
      if (next.status !== 'cancelled')
        throw new UnrecoverableError('导出任务已停止');
      await discardCancelledFinal();
      return cancelledResult;
    };
    const check = async () => {
      controller.signal.throwIfAborted();
      if (options.isClosing()) throw new Error('EXPORT_WORKER_STOPPING');
      await options.assertJobLock(job, token);
      await options.authorize(data.userId);
      const state = verify(await store.read(data.taskId));
      if (isTerminalTaskStatus(state.status)) throw new TaskStopped(state);
      if (state.cancelRequestedAt || state.status === 'cancelling')
        throw new TaskStopped(state);
      controller.signal.throwIfAborted();
      return state;
    };
    const progress = async (value: number, message: string) => {
      await check();
      await mutate({ kind: 'progress', progress: value, message });
      await options.updateProgress(job, value);
    };
    const complete = async (
      artifact: NonNullable<Awaited<ReturnType<typeof artifacts.read>>>,
      rowCount?: number,
    ) => {
      await check();
      const result = {
        exportType: data.exportType,
        filename: parentAsinExportFilename(options.now?.() ?? new Date()),
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSizeBytes: artifact.bytes,
        ...(rowCount === undefined ? {} : { rowCount }),
        downloadUrl: `/api/v1/tasks/${data.taskId}/download`,
        artifact,
      };
      const state = await mutate({
        kind: 'completed',
        result,
        message: '导出完成',
      });
      if (state.status !== 'completed') throw new TaskStopped(state);
      return state.result;
    };
    try {
      await check();
      heartbeat = setInterval(() => {
        if (checking || controller.signal.aborted) return;
        checking = true;
        void check()
          .catch((error: unknown) => controller.abort(error))
          .finally(() => {
            checking = false;
          });
      }, 1000);
      heartbeat.unref();
      const previous = await artifacts.read(data.taskId, controller.signal);
      if (previous) {
        published = true;
        return await complete(previous);
      }
      await mutate({ kind: 'processing', message: '父变体查询导出开始处理' });
      await progress(2, '正在查询父变体');
      const results = await parents.query(
        data.params.asins,
        data.params.country,
        {
          signal: controller.signal,
          onProgress: async (completed, total) =>
            progress(
              Math.min(
                75,
                5 + Math.floor((completed / Math.max(total, 1)) * 70),
              ),
              '正在查询父变体（' + completed + '/' + total + '）',
            ),
        },
      );
      await check();
      if (
        results.length !== data.params.asins.length ||
        Buffer.byteLength(JSON.stringify(results)) > 32 * 1024 * 1024
      )
        throw new ExportCapacityError('EXPORT_RESULT_LIMIT_EXCEEDED');
      results.forEach((value, index) => {
        if (
          !parentAsinQueryItemSchema.safeParse(value).success ||
          value.asin !== data.params.asins[index]
        )
          throw new Error('EXPORT_QUERY_RESULT_INVALID');
      });
      const output = await artifacts.temporary(data.taskId);
      partial = output.path;
      outputStream = output.stream;
      // Observe native output failures before commit() installs its listener.
      output.stream.once('error', (error) => controller.abort(error));
      controller.signal.addEventListener('abort', abortWriter, { once: true });
      if (controller.signal.aborted) {
        abortWriter();
        controller.signal.throwIfAborted();
      }
      boundedWorkbook = createBoundedExportWorkbook(output.stream, (error) =>
        controller.abort(error),
      );
      const workbook = boundedWorkbook.workbook;
      const sheet = workbook.addWorksheet('父变体查询结果');
      sheet.columns = PARENT_ASIN_EXPORT_WIDTHS.map((width) => ({ width }));
      boundedWorkbook.commitRow(sheet, PARENT_ASIN_EXPORT_HEADER);
      await boundedWorkbook.drain(controller.signal);
      let rowCount = 0;
      for (const row of parentAsinExportRows(
        results,
        data.params.country,
        options.now?.() ?? new Date(),
      )) {
        if (
          ++rowCount > 1000 ||
          row.some((value) => typeof value === 'string' && value.length > 32767)
        )
          throw new ExportCapacityError('EXPORT_CELL_LIMIT_EXCEEDED');
        boundedWorkbook.commitRow(sheet, row);
        await boundedWorkbook.drain(controller.signal);
        if (rowCount % 50 === 0) await check();
      }
      await progress(90, '正在生成父变体查询结果工作簿');
      // Never publish a workbook after cancellation or a lost job lock.
      await check();
      await abortableExport(controller.signal, async () => {
        await workbook.commit();
        await finished(output.stream);
      });
      await check();
      const artifact = await artifacts.publish(
        data.taskId,
        output.path,
        controller.signal,
      );
      published = true;
      const result = await complete(artifact, rowCount);
      log.info('父变体查询导出完成', { rows: rowCount });
      return result;
    } catch (caught) {
      const error: unknown = controller.signal.aborted
        ? controller.signal.reason
        : caught;
      if (error instanceof TaskStopped) {
        if (error.state.status === 'completed') return error.state.result;
        if (error.state.status === 'cancelled') {
          await discardCancelledFinal();
          return cancelledResult;
        }
        if (
          error.state.cancelRequestedAt ||
          error.state.status === 'cancelling'
        )
          return finishCancellation();
        throw new UnrecoverableError('导出任务已停止');
      }
      if (published) {
        log.warn('父变体查询导出产物已保存，完成状态等待对账', {
          reason: 'export_completion_unconfirmed',
        });
        throw new Error('EXPORT_COMPLETION_UNCONFIRMED');
      }
      try {
        await options.assertJobLock(job, token);
        const state = verify(await store.read(data.taskId));
        if (state.cancelRequestedAt || state.status === 'cancelling') {
          return finishCancellation();
        }
        const capacity =
          error instanceof ExportCapacityError ||
          (error instanceof ExportArtifactError &&
            error.reason === 'too-large');
        if (capacity || job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          const next = await mutate({
            kind: 'failed',
            message: capacity
              ? '父变体查询导出超过上限，请缩小筛选范围'
              : '父变体查询导出失败，请重试',
          });
          if (next.status === 'cancelled') return cancelledResult;
          if (capacity && error instanceof ExportArtifactError)
            await artifacts.discardFinal(data.taskId);
        }
      } catch {
        log.warn('父变体查询导出失败状态写入未确认', {
          reason: 'export_status_unconfirmed',
        });
      }
      log.warn('父变体查询导出尝试失败', {
        reason:
          error instanceof ExportCapacityError ||
          (error instanceof ExportArtifactError && error.reason === 'too-large')
            ? 'export_limit_exceeded'
            : 'export_failed',
      });
      throw error instanceof ExportCapacityError ||
        (error instanceof ExportArtifactError && error.reason === 'too-large')
        ? new UnrecoverableError('父变体查询导出超过上限，请缩小筛选范围')
        : new Error('PARENT_ASIN_EXPORT_ATTEMPT_FAILED');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(deadline);
      options.shutdownSignal.removeEventListener('abort', shutdown);
      controller.signal.removeEventListener('abort', abortWriter);
      if (outputStream && !outputStream.writableFinished)
        boundedWorkbook?.stop();
      let canDiscard = true;
      if (outputStream && !outputStream.closed) {
        let onClose!: () => void;
        const closed = new Promise<boolean>((resolve) => {
          onClose = () => resolve(true);
          outputStream!.once('close', onClose);
        });
        let closeTimeout!: ReturnType<typeof setTimeout>;
        const closeDeadline = new Promise<boolean>((resolve) => {
          closeTimeout = setTimeout(
            () => resolve(false),
            WRITER_CLOSE_TIMEOUT_MS,
          );
        });
        if (!outputStream.destroyed) outputStream.destroy();
        canDiscard = await Promise.race([closed, closeDeadline]);
        clearTimeout(closeTimeout);
        outputStream.removeListener('close', onClose);
        if (!canDiscard && partial) {
          const deferredPath = partial;
          const discard = () => {
            void artifacts.discard(deferredPath).catch(() =>
              log.warn('父变体查询导出临时文件清理失败', {
                reason: 'export_partial_cleanup_failed',
              }),
            );
          };
          log.warn('父变体查询导出写入关闭超时，临时文件将在关闭后清理', {
            reason: 'export_writer_cleanup_deferred',
          });
          if (outputStream.closed) discard();
          else outputStream.once('close', discard);
        }
      }
      if (partial && canDiscard)
        await artifacts.discard(partial).catch(() =>
          log.warn('父变体查询导出临时文件清理失败', {
            reason: 'export_partial_cleanup_failed',
          }),
        );
      await settlement.drain();
    }
  };
}
