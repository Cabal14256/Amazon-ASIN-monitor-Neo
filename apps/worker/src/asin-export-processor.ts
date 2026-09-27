import {
  asinExportJobDataSchema,
  type AsinExportJobData,
} from '@asin-monitor/contracts';
import {
  MAX_ASIN_QUERY_CHILDREN,
  isTerminalTaskStatus,
  type AsinExportCursor,
  type AsinExportQueryRepositoryPort,
  type RedisTaskRepository,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
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

const GROUP_PAGE_SIZE = 50;
const MAX_GROUPS = 10_000;
const MAX_ROWS = 100_000;
const TASK_TIMEOUT_MS = 30 * 60_000;
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
}
class TaskStopped extends Error {
  constructor(readonly state: TaskState) {
    super('Export task stopped');
  }
}
class ExportCapacityError extends Error {}

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
      TASK_TIMEOUT_MS,
    );
    deadline.unref();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    let partial: string | undefined;
    let outputStream: WriteStream | undefined;
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
        filename: asinExportFilename(new Date(data.createdAt)),
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
      if (previous) return await complete(previous);
      await mutate({ kind: 'processing', message: 'ASIN 导出任务开始处理' });
      await progress(2, '正在查询 ASIN');
      const output = await artifacts.temporary(data.taskId);
      partial = output.path;
      outputStream = output.stream;
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
      const appendRows = async (
        group: ReturnType<typeof mapAsinQueryGroups>[number],
      ) => {
        for (const row of asinExportRows([group])) {
          if (++rowCount > MAX_ROWS)
            throw new ExportCapacityError('EXPORT_LIMIT_EXCEEDED');
          sheet.addRow(row).commit();
          if (rowCount % 500 === 0) await check();
        }
      };
      for (let page = 1; ; page++) {
        await check();
        const result = await repository.read((unit) =>
          unit.listExportGroups(
            {
              keyword: data.params.keyword || undefined,
              country: data.params.country || undefined,
              variantStatus: data.params.variantStatus || undefined,
              current: 1,
              pageSize: GROUP_PAGE_SIZE,
            },
            groupCursor,
            page === 1,
          ),
        );
        if (page === 1) {
          total = result.total;
          if (total > MAX_GROUPS)
            throw new ExportCapacityError('EXPORT_LIMIT_EXCEEDED');
        }
        for (const group of result.groups) {
          const effectiveGroup = {
            ...group,
            isBroken: group.exportIsBroken ?? group.isBroken,
          };
          let childCursor: AsinExportCursor | undefined;
          for (;;) {
            await check();
            const children = await repository.read((unit) =>
              unit.listExportChildren(group.id, childCursor),
            );
            if (children.length === 0) {
              if (!childCursor)
                await appendRows(
                  mapAsinQueryGroups({
                    groups: [effectiveGroup],
                    asins: [],
                    total: 0,
                    totalASINs: 0,
                  })[0]!,
                );
              break;
            }
            await appendRows(
              mapAsinQueryGroups({
                groups: [effectiveGroup],
                asins: children,
                total: 0,
                totalASINs: 0,
              })[0]!,
            );
            const lastChild = children[children.length - 1]!;
            childCursor = {
              id: lastChild.id,
              createTime: lastChild.exportCursorTime,
            };
            if (children.length < MAX_ASIN_QUERY_CHILDREN) break;
          }
        }
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
        if (result.groups.length === 0) break;
      }
      await check();
      await workbook.commit();
      await finished(output.stream);
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
        if (error.state.status === 'cancelled') return cancelledResult;
        if (
          error.state.cancelRequestedAt ||
          error.state.status === 'cancelling'
        ) {
          await mutate({ kind: 'cancelled', message: cancelledResult.message });
          return cancelledResult;
        }
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
          await mutate({ kind: 'cancelled', message: cancelledResult.message });
          return cancelledResult;
        }
        if (
          error instanceof ExportCapacityError ||
          job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
        )
          await mutate({ kind: 'failed', message: 'ASIN 导出失败，请重试' });
      } catch {
        log.warn('ASIN 导出失败状态写入未确认', {
          reason: 'export_status_unconfirmed',
        });
      }
      log.warn('ASIN 导出尝试失败', {
        reason:
          error instanceof ExportCapacityError
            ? 'export_limit_exceeded'
            : 'export_failed',
      });
      throw error instanceof ExportCapacityError
        ? new UnrecoverableError('ASIN 导出超过上限，请缩小筛选范围')
        : new Error('ASIN_EXPORT_ATTEMPT_FAILED');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(deadline);
      options.shutdownSignal.removeEventListener('abort', shutdown);
      if (outputStream && !outputStream.closed) {
        const closed = new Promise<void>((resolve) =>
          outputStream!.once('close', resolve),
        );
        if (!outputStream.destroyed) outputStream.destroy();
        await closed;
      }
      if (partial)
        await artifacts.discard(partial).catch(() =>
          log.warn('ASIN 导出临时文件清理失败', {
            reason: 'export_partial_cleanup_failed',
          }),
        );
    }
  };
}
