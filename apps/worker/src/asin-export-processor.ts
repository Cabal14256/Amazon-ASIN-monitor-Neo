import {
  asinExportJobDataSchema,
  type AsinExportJobData,
} from '@asin-monitor/contracts';
import {
  MAX_ASIN_EXPORT_GROUP_PAGE_SIZE,
  MAX_ASIN_QUERY_CHILDREN,
  effectiveVariantStatus,
  isTerminalTaskStatus,
  type AsinExportChildrenCursor,
  type AsinExportCursor,
  type AsinExportQueryRepositoryPort,
  type RedisTaskRepository,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactError, ExportArtifactStore } from '@asin-monitor/export';
import { mapAsinQueryGroups } from '@asin-monitor/variant-check';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import ExcelJS from 'exceljs';
import type { WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import {
  ASIN_EXPORT_HEADER,
  ASIN_EXPORT_WIDTHS,
  asinExportFilename,
  asinExportRows,
} from './asin-export-rows';
import { logger } from './logger';

const GROUP_PAGE_SIZE = MAX_ASIN_EXPORT_GROUP_PAGE_SIZE;
const MAX_GROUPS = 10_000;
const MAX_ROWS = 100_000;
export const ASIN_EXPORT_TASK_TIMEOUT_MS = 30 * 60_000;
const WRITER_CLOSE_TIMEOUT_MS = 5000;
const cancelledResult = { cancelled: true, message: '导出任务已取消' };
const identity = (data: AsinExportJobData) => ({
  userId: data.userId,
  taskType: data.taskType,
  taskSubType: data.taskSubType,
  createdAt: data.createdAt,
});

export interface AsinExportProcessorOptions {
  shutdownSignal: AbortSignal;
  isClosing(): boolean;
  assertJobLock(job: Job, token: string | undefined): Promise<void>;
  updateProgress(job: Job, progress: number): Promise<void>;
  now?(): Date;
}
class TaskStopped extends Error {
  constructor(readonly state: TaskState) {
    super('Export task stopped');
  }
}
class ExportCapacityError extends Error {}

function abortable<T>(signal: AbortSignal, operation: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
  });
}

export function createAsinExportProcessor(
  repository: AsinExportQueryRepositoryPort,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  artifacts: ExportArtifactStore,
  options: AsinExportProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, unknown, string> {
  return async (job, token) => {
    const parsed = asinExportJobDataSchema.safeParse(job.data);
    if (!parsed.success || job.id !== parsed.data.taskId || job.name !== 'asin')
      throw new UnrecoverableError('导出任务数据无效');
    const data = parsed.data;
    const controller = new AbortController();
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
    const abortWriter = () => {
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
      if (!published) return;
      await artifacts.discardFinal(data.taskId).catch(() =>
        log.warn('已取消 ASIN 导出文件清理失败', {
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
        exportType: 'asin' as const,
        filename: asinExportFilename(options.now?.() ?? new Date()),
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
      await mutate({ kind: 'processing', message: 'ASIN 导出任务开始处理' });
      await progress(2, '正在查询 ASIN');
      const output = await artifacts.temporary(data.taskId);
      partial = output.path;
      outputStream = output.stream;
      // Errors can occur while rows are being streamed, before commit() installs
      // its listener. Stop the live database read and retain the capacity reason.
      output.stream.once('error', (error) => controller.abort(error));
      controller.signal.addEventListener('abort', abortWriter, { once: true });
      if (controller.signal.aborted) {
        abortWriter();
        controller.signal.throwIfAborted();
      }
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: output.stream,
        useSharedStrings: false,
        useStyles: false,
      });
      const sheet = workbook.addWorksheet('ASIN数据');
      sheet.columns = ASIN_EXPORT_WIDTHS.map((width) => ({ width }));
      sheet.addRow([...ASIN_EXPORT_HEADER]).commit();
      let total = 0;
      let processed = 0;
      let rowCount = 0;
      let groupCursor: AsinExportCursor | undefined;
      // All group membership, filters and status projections belong to one
      // bounded MVCC snapshot. Redis cancellation/lease checks remain live.
      await repository.read(async (unit, ensureSnapshotOpen) => {
        const snapshotCheck = async () => {
          ensureSnapshotOpen();
          await check();
          ensureSnapshotOpen();
        };
        const appendRows = async (
          group: ReturnType<typeof mapAsinQueryGroups>[number],
        ) => {
          for (const row of asinExportRows([group])) {
            if (++rowCount > MAX_ROWS)
              throw new ExportCapacityError('EXPORT_LIMIT_EXCEEDED');
            sheet.addRow(row).commit();
            if (rowCount % 500 === 0) await snapshotCheck();
          }
        };
        for (let page = 1; ; page++) {
          await snapshotCheck();
          const result = await unit.listExportGroups(
            {
              keyword: data.params.keyword || undefined,
              country: data.params.country || undefined,
              variantStatus: data.params.variantStatus || undefined,
              current: 1,
              pageSize: GROUP_PAGE_SIZE,
            },
            groupCursor,
            page === 1,
          );
          if (page === 1) {
            total = result.total;
            if (total > MAX_GROUPS)
              throw new ExportCapacityError('EXPORT_LIMIT_EXCEEDED');
          }
          const groupIds = result.groups.map((group) => group.id);
          let children: Awaited<
            ReturnType<typeof unit.listExportChildrenPage>
          > = [];
          let childIndex = 0;
          let childrenExhausted = !groupIds.length;
          let childCursor: AsinExportChildrenCursor | undefined;
          const readChildren = async () => {
            await snapshotCheck();
            children = await unit.listExportChildrenPage(groupIds, childCursor);
            childIndex = 0;
            childrenExhausted = children.length < MAX_ASIN_QUERY_CHILDREN;
            const last = children[children.length - 1];
            if (last)
              childCursor = {
                groupId: last.variantGroupId!,
                id: last.id,
                createTime: last.exportCursorTime,
              };
          };
          if (groupIds.length) await readChildren();
          for (const group of result.groups) {
            if (
              group.exportHasAutoBroken === undefined ||
              group.exportHasManualBroken === undefined
            )
              throw new Error('EXPORT_GROUP_STATUS_INVALID');
            const groupStatusSource = effectiveVariantStatus(
              group.exportHasAutoBroken,
              group.exportHasManualBroken,
            ).statusSource;
            const effectiveGroup = {
              ...group,
              isBroken: group.exportIsBroken ?? group.isBroken,
            };
            let hasChildren = false;
            for (;;) {
              const groupChildren: typeof children = [];
              while (
                childIndex < children.length &&
                children[childIndex]!.variantGroupId === group.id
              ) {
                groupChildren.push(children[childIndex++]!);
              }
              if (groupChildren.length) {
                hasChildren = true;
                await appendRows({
                  ...mapAsinQueryGroups({
                    groups: [effectiveGroup],
                    asins: groupChildren,
                    total: 0,
                    totalASINs: 0,
                  })[0]!,
                  statusSource: groupStatusSource,
                });
              }
              if (childIndex < children.length || childrenExhausted) break;
              await readChildren();
            }
            if (!hasChildren)
              await appendRows({
                ...mapAsinQueryGroups({
                  groups: [effectiveGroup],
                  asins: [],
                  total: 0,
                  totalASINs: 0,
                })[0]!,
                statusSource: groupStatusSource,
              });
          }
          if (childIndex !== children.length)
            throw new Error('EXPORT_CHILD_PAGE_INVALID');
          processed += result.groups.length;
          if (processed > MAX_GROUPS)
            throw new ExportCapacityError('EXPORT_LIMIT_EXCEEDED');
          const lastGroup = result.groups[result.groups.length - 1];
          if (lastGroup) {
            if (lastGroup.exportCursorTime === undefined)
              throw new Error('EXPORT_CURSOR_INVALID');
            groupCursor = {
              id: lastGroup.id,
              createTime: lastGroup.exportCursorTime,
            };
          }
          await progress(
            Math.min(90, 5 + Math.floor((processed / Math.max(total, 1)) * 85)),
            `正在生成 ASIN 导出（${processed}/${total} 组）`,
          );
          ensureSnapshotOpen();
          if (result.groups.length === 0) break;
        }
      }, controller.signal);
      // Never commit the writer or publish a file from a timed-out/aborted
      // snapshot callback that may finish after its connection was destroyed.
      await check();
      await abortable(controller.signal, async () => {
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
      log.info('ASIN 导出任务完成', { groups: processed, rows: rowCount });
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
        log.warn('ASIN 导出产物已保存，完成状态等待对账', {
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
            message: 'ASIN 导出失败，请重试',
          });
          if (next.status === 'cancelled') return cancelledResult;
          if (capacity && error instanceof ExportArtifactError)
            await artifacts.discardFinal(data.taskId);
        }
      } catch {
        log.warn('ASIN 导出失败状态写入未确认', {
          reason: 'export_status_unconfirmed',
        });
      }
      log.warn('ASIN 导出尝试失败', {
        reason:
          error instanceof ExportCapacityError ||
          (error instanceof ExportArtifactError && error.reason === 'too-large')
            ? 'export_limit_exceeded'
            : 'export_failed',
      });
      throw error instanceof ExportCapacityError ||
        (error instanceof ExportArtifactError && error.reason === 'too-large')
        ? new UnrecoverableError('ASIN 导出超过上限，请缩小筛选范围')
        : new Error('ASIN_EXPORT_ATTEMPT_FAILED');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(deadline);
      options.shutdownSignal.removeEventListener('abort', shutdown);
      controller.signal.removeEventListener('abort', abortWriter);
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
              log.warn('ASIN 导出临时文件清理失败', {
                reason: 'export_partial_cleanup_failed',
              }),
            );
          };
          log.warn('ASIN 导出写入关闭超时，临时文件将在关闭后清理', {
            reason: 'export_writer_cleanup_deferred',
          });
          if (outputStream.closed) discard();
          else outputStream.once('close', discard);
        }
      }
      if (partial && canDiscard)
        await artifacts.discard(partial).catch(() =>
          log.warn('ASIN 导出临时文件清理失败', {
            reason: 'export_partial_cleanup_failed',
          }),
        );
    }
  };
}
