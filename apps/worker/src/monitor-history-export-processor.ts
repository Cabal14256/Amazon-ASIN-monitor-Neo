import {
  monitorHistoryExportJobDataSchema,
  type MonitorHistoryExportJobData,
} from '@asin-monitor/contracts';
import {
  formatShanghaiTimestamp,
  MONITOR_HISTORY_EXPORT_PAGE_SIZE,
  MonitorHistoryQueryError,
  type MonitorHistoryExportCursor,
  type MonitorHistoryExportRepositoryPort,
  type RedisTaskRepository,
} from '@asin-monitor/db';
import type { ExportArtifactStore } from '@asin-monitor/export';
import { logger } from './logger';
import {
  MONITOR_HISTORY_EXPORT_HEADER,
  MONITOR_HISTORY_EXPORT_WIDTHS,
  monitorHistoryExportFilename,
  monitorHistoryExportRow,
} from './monitor-history-export-rows';
import {
  createStreamingExportProcessor,
  type WorkbookExportProcessorOptions,
} from './streaming-export-processor';

export function createMonitorHistoryExportProcessor(
  repository: MonitorHistoryExportRepositoryPort,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  artifacts: ExportArtifactStore,
  options: WorkbookExportProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
) {
  return createStreamingExportProcessor<MonitorHistoryExportJobData>(
    {
      name: 'monitor-history',
      label: '监控历史导出',
      schema: monitorHistoryExportJobDataSchema,
      sheet: '监控历史',
      header: MONITOR_HISTORY_EXPORT_HEADER,
      widths: MONITOR_HISTORY_EXPORT_WIDTHS,
      maxRows: 100_000,
      headerStyle: {
        font: { bold: true },
        fill: {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE0E0E0' },
        },
      },
      filename: monitorHistoryExportFilename,
      attemptError: 'MONITOR_HISTORY_EXPORT_ATTEMPT_FAILED',
      isCapacity: (error) =>
        error instanceof MonitorHistoryQueryError && error.code === 'too-large',
      async write(data, emit, context) {
        const params = {
          ...data.params,
          endTime:
            data.params.endTime ||
            formatShanghaiTimestamp(context.now()).slice(0, 19),
        };
        await repository.read(async (unit, ensureOpen) => {
          let cursor: MonitorHistoryExportCursor | undefined,
            count = 0;
          for (;;) {
            ensureOpen();
            await context.check();
            ensureOpen();
            const page = await unit.page(params, cursor);
            ensureOpen();
            for (const row of page) {
              await emit(monitorHistoryExportRow(row.record));
              count++;
            }
            const last = page.at(-1);
            if (last) cursor = last.cursor;
            await context.progress(
              Math.min(85, 5 + Math.floor(count / 1250)),
              `正在导出监控历史（${count} 条）`,
            );
            ensureOpen();
            if (page.length < MONITOR_HISTORY_EXPORT_PAGE_SIZE) break;
          }
        }, context.signal);
      },
    },
    store,
    artifacts,
    options,
    log,
  );
}
