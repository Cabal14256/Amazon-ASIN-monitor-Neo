import {
  variantGroupExportJobDataSchema,
  type VariantGroupExportJobData,
} from '@asin-monitor/contracts';
import {
  MAX_ASIN_QUERY_CHILDREN,
  resolveAsinVariantStatus,
  type AsinExportChildrenCursor,
  type AsinExportQueryRepositoryPort,
  type RedisTaskRepository,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactError, ExportArtifactStore } from '@asin-monitor/export';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { finished } from 'node:stream/promises';
import { createBoundedExportWorkbook } from './bounded-export-workbook';
import { logger } from './logger';
import {
  VARIANT_GROUP_EXPORT_HEADER,
  VARIANT_GROUP_EXPORT_SHEET,
  VARIANT_GROUP_EXPORT_WIDTHS,
  variantGroupExportRow,
} from './variant-group-export-rows';

const GROUP_PAGE_SIZE = 50;
const MAX_GROUPS = 10_000;
const MAX_ROWS = 100_000;
const TASK_TIMEOUT_MS = 30 * 60_000;
const WRITER_CLOSE_TIMEOUT_MS = 5000;
const MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const cancelledResult = { cancelled: true, message: '导出任务已取消' };
const identity = (data: VariantGroupExportJobData) => ({
  userId: data.userId,
  taskType: data.taskType,
  taskSubType: data.taskSubType,
  createdAt: data.createdAt,
});

export interface VariantGroupExportProcessorOptions {
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

function filename(at: Date) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return `变体组数据_${day}.xlsx`;
}

export function createVariantGroupExportProcessor(
  repository: AsinExportQueryRepositoryPort,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  artifacts: ExportArtifactStore,
  options: VariantGroupExportProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, unknown, string> {
  return async (job, token) => {
    const parsed = variantGroupExportJobDataSchema.safeParse(job.data);
    if (
      !parsed.success ||
      job.id !== parsed.data.taskId ||
      job.name !== 'variant-group'
    )
      throw new UnrecoverableError('变体组导出任务数据无效');
    const data = parsed.data;
    const controller = new AbortController();
    const shutdown = () =>
      controller.abort(new Error('EXPORT_WORKER_SHUTDOWN'));
    options.shutdownSignal.addEventListener('abort', shutdown, { once: true });
    if (options.shutdownSignal.aborted) shutdown();
    const deadline = setTimeout(
      () => controller.abort(new Error('EXPORT_TASK_TIMEOUT')),
      TASK_TIMEOUT_MS,
    );
    deadline.unref();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    let partial: string | undefined;
    let outputStream:
      | Awaited<ReturnType<typeof artifacts.temporary>>['stream']
      | undefined;
    let writer: ReturnType<typeof createBoundedExportWorkbook> | undefined;
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
    const check = async () => {
      controller.signal.throwIfAborted();
      if (options.isClosing()) throw new Error('EXPORT_WORKER_STOPPING');
      await options.assertJobLock(job, token);
      const state = verify(await store.read(data.taskId));
      if (isTerminal(state.status)) throw new TaskStopped(state);
      if (state.cancelRequestedAt || state.status === 'cancelling')
        throw new TaskStopped(state);
      controller.signal.throwIfAborted();
      return state;
    };
    const abortWriter = () => {
      writer?.stop(
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
    const discardCancelledFinal = async () => {
      await artifacts.discardFinal(data.taskId).catch(() =>
        log.warn('已取消变体组导出文件清理失败', {
          reason: 'export_cancelled_artifact_cleanup_failed',
        }),
      );
    };
    const finishCancellation = async () => {
      const state = await mutate({
        kind: 'cancelled',
        message: '导出任务已取消',
      });
      if (state.status === 'completed') return state.result;
      if (state.status !== 'cancelled')
        throw new UnrecoverableError('导出任务已停止');
      await discardCancelledFinal();
      return cancelledResult;
    };
    const complete = async (
      artifact: NonNullable<Awaited<ReturnType<typeof artifacts.read>>>,
      rowCount?: number,
    ) => {
      await check();
      const state = await mutate({
        kind: 'completed',
        result: {
          exportType: 'variant-group',
          filename: filename(options.now?.() ?? new Date()),
          mimeType: MIME_TYPE,
          fileSizeBytes: artifact.bytes,
          ...(rowCount === undefined ? {} : { rowCount }),
          downloadUrl: `/api/v1/tasks/${data.taskId}/download`,
          artifact,
        },
        message: '导出完成',
      });
      if (state.status !== 'completed') throw new TaskStopped(state);
      return state.result;
    };

    try {
      const initial = verify(await store.read(data.taskId));
      if (initial.status === 'completed') return initial.result;
      if (initial.status === 'cancelled') {
        await discardCancelledFinal();
        return cancelledResult;
      }
      if (initial.status === 'failed')
        throw new UnrecoverableError('变体组导出任务已失败');
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
      await mutate({ kind: 'processing', message: '变体组导出任务开始处理' });
      const output = await artifacts.temporary(data.taskId);
      partial = output.path;
      outputStream = output.stream;
      outputStream.once('error', (error) => controller.abort(error));
      controller.signal.addEventListener('abort', abortWriter, { once: true });
      writer = createBoundedExportWorkbook(outputStream, (error) =>
        controller.abort(error),
      );
      const sheet = writer.workbook.addWorksheet(VARIANT_GROUP_EXPORT_SHEET);
      sheet.columns = VARIANT_GROUP_EXPORT_WIDTHS.map((width) => ({ width }));
      writer.commitRow(sheet, VARIANT_GROUP_EXPORT_HEADER);
      await writer.drain(controller.signal);

      let groupsProcessed = 0;
      let rowCount = 0;
      let groupCursor: { id: string; createTime: string | null } | undefined;
      await repository.read(async (unit, ensureSnapshotOpen) => {
        const snapshotCheck = async () => {
          ensureSnapshotOpen();
          await check();
          ensureSnapshotOpen();
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
          if (page === 1 && result.total > MAX_GROUPS)
            throw new ExportCapacityError('EXPORT_LIMIT_EXCEEDED');
          if (!result.groups.length) break;
          const groupIds = result.groups.map((group) => group.id);
          let children: Awaited<
            ReturnType<typeof unit.listExportChildrenPage>
          > = [];
          let childCursor: AsinExportChildrenCursor | undefined;
          let childIndex = 0;
          let childrenExhausted = !groupIds.length;
          const readChildren = async () => {
            await snapshotCheck();
            children = await unit.listExportChildrenPage(groupIds, childCursor);
            childIndex = 0;
            childrenExhausted = children.length < MAX_ASIN_QUERY_CHILDREN;
            const last = children.at(-1);
            if (last)
              childCursor = {
                groupId: last.variantGroupId!,
                id: last.id,
                createTime: last.exportCursorTime,
              };
          };
          if (groupIds.length) await readChildren();
          for (const group of result.groups) {
            if (typeof group.exportIsBroken !== 'boolean')
              throw new Error('EXPORT_GROUP_STATUS_INVALID');
            let asinCount = 0;
            let brokenAsinCount = 0;
            for (;;) {
              while (
                childIndex < children.length &&
                children[childIndex]!.variantGroupId === group.id
              ) {
                asinCount++;
                if (
                  resolveAsinVariantStatus(children[childIndex]!, group)
                    .isBroken === 1
                )
                  brokenAsinCount++;
                childIndex++;
              }
              if (childIndex < children.length || childrenExhausted) break;
              await readChildren();
            }
            const row = variantGroupExportRow({
              name: group.name,
              id: group.id,
              country: group.country,
              site: group.site,
              brand: group.brand,
              isBroken: group.exportIsBroken,
              asinCount,
              brokenAsinCount,
              createTime: group.createTime,
              updateTime: group.updateTime,
              lastCheckTime: group.lastCheckTime,
            });
            if (++rowCount > MAX_ROWS)
              throw new ExportCapacityError('EXPORT_LIMIT_EXCEEDED');
            if (
              row.some(
                (value) => typeof value === 'string' && value.length > 32767,
              )
            )
              throw new ExportCapacityError('EXPORT_CELL_LIMIT_EXCEEDED');
            writer!.commitRow(sheet, row);
            await writer!.drain(controller.signal);
            if (rowCount % 500 === 0) await snapshotCheck();
          }
          if (childIndex !== children.length)
            throw new Error('EXPORT_CHILD_PAGE_INVALID');
          const last = result.groups.at(-1);
          if (last) {
            if (last.exportCursorTime === undefined)
              throw new Error('EXPORT_CURSOR_INVALID');
            groupCursor = { id: last.id, createTime: last.exportCursorTime };
          }
          groupsProcessed += result.groups.length;
          if (groupsProcessed > MAX_GROUPS)
            throw new ExportCapacityError('EXPORT_LIMIT_EXCEEDED');
          await mutate({
            kind: 'progress',
            progress: Math.min(
              90,
              5 +
                Math.floor((groupsProcessed / Math.max(result.total, 1)) * 85),
            ),
            message: `正在生成变体组导出（${groupsProcessed}/${result.total} 组）`,
          });
          await options.updateProgress(
            job,
            Math.min(
              90,
              5 +
                Math.floor((groupsProcessed / Math.max(result.total, 1)) * 85),
            ),
          );
        }
      }, controller.signal);
      await check();
      await writer.workbook.commit();
      await finished(outputStream);
      await check();
      const artifact = await artifacts.publish(
        data.taskId,
        output.path,
        controller.signal,
      );
      published = true;
      const result = await complete(artifact, rowCount);
      log.info('变体组导出任务完成', {
        groups: groupsProcessed,
        rows: rowCount,
      });
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
        log.warn('变体组导出产物已保存，完成状态等待对账', {
          reason: 'export_completion_unconfirmed',
        });
        throw new Error('EXPORT_COMPLETION_UNCONFIRMED');
      }
      const capacity =
        error instanceof ExportCapacityError ||
        (error instanceof ExportArtifactError && error.reason === 'too-large');
      if (!options.shutdownSignal.aborted) {
        try {
          await options.assertJobLock(job, token);
          const state = verify(await store.read(data.taskId));
          if (state.cancelRequestedAt || state.status === 'cancelling')
            return finishCancellation();
          if (capacity || job.attemptsMade + 1 >= (job.opts.attempts ?? 1))
            await mutate({
              kind: 'failed',
              message: capacity
                ? '变体组导出超过上限，请缩小导出范围'
                : '变体组导出失败，请重试',
            });
        } catch (statusError) {
          if (statusError instanceof TaskStopped) {
            if (statusError.state.status === 'completed')
              return statusError.state.result;
            if (statusError.state.status === 'cancelled') {
              await discardCancelledFinal();
              return cancelledResult;
            }
          }
          log.warn('变体组导出失败状态写入未确认', {
            reason: 'export_status_unconfirmed',
          });
        }
      }
      log.warn('变体组导出尝试失败', {
        reason: capacity ? 'export_limit_exceeded' : 'export_failed',
      });
      if (capacity)
        throw new UnrecoverableError('变体组导出超过上限，请缩小导出范围');
      throw new Error('VARIANT_GROUP_EXPORT_ATTEMPT_FAILED');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(deadline);
      options.shutdownSignal.removeEventListener('abort', shutdown);
      controller.signal.removeEventListener('abort', abortWriter);
      if (outputStream && !outputStream.writableFinished) writer?.stop();
      if (outputStream && !outputStream.closed) {
        let onClose!: () => void;
        let closeTimeout!: ReturnType<typeof setTimeout>;
        const closed = new Promise<boolean>((resolve) => {
          onClose = () => resolve(true);
          outputStream!.once('close', onClose);
        });
        const closeDeadline = new Promise<boolean>((resolve) => {
          closeTimeout = setTimeout(
            () => resolve(false),
            WRITER_CLOSE_TIMEOUT_MS,
          );
          closeTimeout.unref();
        });
        if (!outputStream.destroyed) outputStream.destroy();
        const canDiscard = await Promise.race([closed, closeDeadline]);
        clearTimeout(closeTimeout);
        outputStream.removeListener('close', onClose);
        if (!canDiscard && partial)
          outputStream.once(
            'close',
            () => void artifacts.discard(partial!).catch(() => undefined),
          );
        if (!canDiscard) partial = undefined;
      }
      if (partial)
        await artifacts.discard(partial).catch(() =>
          log.warn('变体组导出临时文件清理失败', {
            reason: 'export_partial_cleanup_failed',
          }),
        );
    }
  };
}

function isTerminal(status: string) {
  return ['completed', 'failed', 'cancelled'].includes(status);
}
