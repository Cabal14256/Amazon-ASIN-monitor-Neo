import {
  parentAsinExportJobDataSchema,
  parentAsinQueryItemSchema,
  type ParentAsinExportJobData,
} from '@asin-monitor/contracts';
import type { RedisTaskRepository } from '@asin-monitor/db';
import type { ExportArtifactStore } from '@asin-monitor/export';
import type { CatalogParentQuery } from '@asin-monitor/sp-api';
import { logger } from './logger';
import {
  PARENT_ASIN_EXPORT_HEADER,
  PARENT_ASIN_EXPORT_WIDTHS,
  parentAsinExportFilename,
  parentAsinExportRows,
} from './parent-asin-export-rows';
import {
  createStreamingExportProcessor,
  WorkbookExportCapacityError,
  type WorkbookExportProcessorOptions,
} from './streaming-export-processor';
export type ParentAsinExportProcessorOptions = WorkbookExportProcessorOptions;
export function createParentAsinExportProcessor(
  parents: Pick<CatalogParentQuery, 'query'>,
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  artifacts: ExportArtifactStore,
  options: ParentAsinExportProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
) {
  return createStreamingExportProcessor<ParentAsinExportJobData>(
    {
      name: 'parent-asin-query',
      label: '父变体查询导出',
      sheet: '父变体查询结果',
      schema: parentAsinExportJobDataSchema,
      header: PARENT_ASIN_EXPORT_HEADER,
      widths: PARENT_ASIN_EXPORT_WIDTHS,
      maxRows: 1000,
      filename: parentAsinExportFilename,
      attemptError: 'PARENT_ASIN_EXPORT_ATTEMPT_FAILED',
      async write(data, emit, context) {
        const results = await parents.query(
          data.params.asins,
          data.params.country,
          {
            signal: context.signal,
            onProgress: (completed, total) =>
              context.progress(
                Math.min(
                  75,
                  5 + Math.floor((completed / Math.max(total, 1)) * 70),
                ),
                '正在查询父变体（' + completed + '/' + total + '）',
              ),
          },
        );
        await context.check();
        if (
          results.length !== data.params.asins.length ||
          Buffer.byteLength(JSON.stringify(results)) > 32 * 1024 * 1024
        )
          throw new WorkbookExportCapacityError('EXPORT_RESULT_LIMIT_EXCEEDED');
        results.forEach((value, index) => {
          if (
            !parentAsinQueryItemSchema.safeParse(value).success ||
            value.asin !== data.params.asins[index]
          )
            throw new Error('EXPORT_QUERY_RESULT_INVALID');
        });
        for (const row of parentAsinExportRows(
          results,
          data.params.country,
          context.now(),
        ))
          await emit(row);
      },
    },
    store,
    artifacts,
    options,
    log,
  );
}
