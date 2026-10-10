import { ChevronLeft, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { EmptyState, Skeleton } from '../../components/ui/feedback';
import type {
  AbnormalDurationRead,
  AbnormalDurationScope,
} from '../../services/monitor-abnormal';
import {
  ABNORMAL_HEADERS,
  abnormalSummaryCells,
  downloadAbnormalCsv,
} from './history-abnormal-data';
import { historyError } from './history-data';

export function HistoryAbnormal({
  scope,
  query,
  retry,
}: {
  scope: AbnormalDurationScope;
  query: {
    data?: AbnormalDurationRead;
    isPending: boolean;
    isFetching: boolean;
    isError: boolean;
    error: unknown;
  };
  retry: () => void;
}) {
  const [page, setPage] = useState(1);
  const [exportError, setExportError] = useState<string | null>(null);
  const summary = query.isError ? undefined : query.data?.summary;
  const total = summary?.length ?? 0;
  const current = Math.min(page, Math.max(1, Math.ceil(total / 20)));
  const scopeText = [
    `上海时间：${scope.startTime} 至 ${scope.endTime}`,
    `国家：${scope.country || '全部'}`,
    ...(['variantGroupId', 'variantGroupName', 'asinName', 'asinType'] as const)
      .filter((key) => scope[key])
      .map(
        (key) =>
          `${
            {
              variantGroupId: '变体组 ID',
              variantGroupName: '变体组名称',
              asinName: 'ASIN 名称',
              asinType: 'ASIN 类型',
            }[key]
          }：${scope[key]}`,
      ),
    ...(scope.asinIds ? [`ASIN ID：${scope.asinIds.join('、')}`] : []),
    ...(scope.asinCodes ? [`ASIN：${scope.asinCodes.join('、')}`] : []),
  ].join(' · ');
  return (
    <section
      aria-label="异常时长统计"
      className="min-w-0 border-t border-border pt-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">异常时长统计</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            按已应用的
            ASIN、变体组、名称、类型、国家和时间范围计算；检查类型、异常状态及分页不参与统计。
          </p>
        </div>
        {summary && summary.length > 0 ? (
          <Button
            variant="secondary"
            size="small"
            disabled={query.isFetching}
            onClick={() => {
              setExportError(null);
              try {
                downloadAbnormalCsv(summary, scope);
              } catch {
                setExportError('导出失败，请重试。');
              }
            }}
          >
            <Download aria-hidden="true" />
            导出 CSV
          </Button>
        ) : undefined}
      </div>
      <div className="mt-5 space-y-4">
        <p className="whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">
          {scopeText}
        </p>
        {exportError && (
          <p role="alert" className="text-sm text-status-danger">
            {exportError}
          </p>
        )}
        {query.isError ? (
          <div role="alert" className="space-y-3 text-sm text-status-danger">
            <p>{historyError(query.error, '异常时长统计')}</p>
            <Button variant="secondary" size="small" onClick={retry}>
              <RefreshCw aria-hidden="true" />
              重试异常时长统计
            </Button>
          </div>
        ) : query.isPending ? (
          <Skeleton aria-label="正在加载异常时长统计" className="h-24" />
        ) : summary && total === 0 ? (
          <EmptyState
            title="暂无异常时长统计"
            description="当前范围没有返回异常时长摘要。"
          />
        ) : summary ? (
          <>
            {query.isFetching && (
              <p role="status" className="text-xs text-muted-foreground">
                正在刷新异常时长统计。
              </p>
            )}
            <div
              className="max-w-full overflow-x-auto"
              tabIndex={0}
              aria-label="异常时长统计表"
              aria-busy={query.isFetching}
            >
              <table className="w-full min-w-[1100px] table-fixed text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    {ABNORMAL_HEADERS.map((header, index) => (
                      <th
                        key={header}
                        scope="col"
                        className={`whitespace-nowrap px-3 py-3 font-medium ${
                          index === 2
                            ? 'w-72'
                            : index === 0 || index === 7
                            ? 'w-44'
                            : 'w-32'
                        }`}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summary
                    .slice((current - 1) * 20, current * 20)
                    .map((row, index) => (
                      <tr key={`${row.key}:${index}`} className="neo-row">
                        {abnormalSummaryCells(row).map((cell, column) => (
                          <td
                            key={column}
                            className="whitespace-pre-wrap break-words px-3 py-3 align-top"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm">
              <span className="text-muted-foreground">
                第 {current} / {Math.ceil(total / 20)} 页 · 共 {total} 条
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  aria-label="上一页统计"
                  disabled={current <= 1}
                  onClick={() => setPage(current - 1)}
                >
                  <ChevronLeft aria-hidden="true" />
                  上一页
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  aria-label="下一页统计"
                  disabled={current * 20 >= total}
                  onClick={() => setPage(current + 1)}
                >
                  下一页
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
