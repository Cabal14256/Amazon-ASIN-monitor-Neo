import type {
  MonitorStatisticsData,
  MonitorStatisticsQuery,
  PeakHoursStatistics,
  PeakHoursStatisticsQuery,
} from '@asin-monitor/contracts';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { historyError } from './history-data';
import { HISTORY_STATISTICS_SCOPES } from './history-statistics-query';

interface StatisticsRead<T> {
  data?: T;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
}

function Scope({
  query,
}: {
  query: MonitorStatisticsQuery | PeakHoursStatisticsQuery;
}) {
  const scope = [
    `国家：${query.country || '全部'}`,
    `检查类型：${query.checkType || '全部'}`,
    `上海时间：${query.startTime || '不限起点'} 至 ${
      query.endTime || '不限终点'
    }`,
    ...('variantGroupId' in query && query.variantGroupId
      ? [`变体组 ID：${query.variantGroupId}`]
      : []),
    ...('asinId' in query && query.asinId ? [`ASIN ID：${query.asinId}`] : []),
  ];
  return (
    <p className="break-words text-xs leading-6 text-muted-foreground">
      {scope.join(' · ')}
    </p>
  );
}

function ReadError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="space-y-3 text-sm text-status-danger">
      <p>{historyError(error, '监控统计')}</p>
      <Button variant="secondary" size="small" onClick={retry}>
        重试统计
      </Button>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  danger = false,
}: {
  label: string;
  value: string;
  detail?: string;
  danger?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-control bg-muted/50 p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd
        className={`neo-mono mt-2 text-2xl font-semibold ${
          danger ? 'text-status-danger' : ''
        }`}
      >
        {value}
      </dd>
      {detail && (
        <dd className="mt-2 text-xs text-muted-foreground">{detail}</dd>
      )}
    </div>
  );
}

const count = (value: string | number) =>
  new Intl.NumberFormat('zh-CN').format(Number(value));

export function HistoryStatistics({
  statistics,
  peakHours,
  queries,
  retryStatistics,
  retryPeakHours,
}: {
  statistics: StatisticsRead<MonitorStatisticsData>;
  peakHours: StatisticsRead<PeakHoursStatistics>;
  queries: {
    statistics: MonitorStatisticsQuery;
    peakHours: PeakHoursStatisticsQuery | null;
  };
  retryStatistics: () => void;
  retryPeakHours: () => void;
}) {
  return (
    <Card aria-label="监控检查统计">
      <CardHeader
        title="检查统计"
        description={HISTORY_STATISTICS_SCOPES.statistics}
      />
      <CardContent className="space-y-5">
        <Scope query={queries.statistics} />
        {statistics.isError ? (
          <ReadError error={statistics.error} retry={retryStatistics} />
        ) : statistics.isPending ? (
          <div
            aria-label="正在加载检查统计"
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
          >
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-24" />
            ))}
          </div>
        ) : statistics.data ? (
          <div aria-busy={statistics.isFetching}>
            {statistics.isFetching && (
              <p role="status" className="mb-3 text-xs text-muted-foreground">
                正在刷新检查统计。
              </p>
            )}
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                label="总检查次数"
                value={count(statistics.data.totalChecks)}
              />
              <Metric
                label="正常次数"
                value={count(statistics.data.normalCount)}
              />
              <Metric
                label="异常次数"
                value={count(statistics.data.brokenCount)}
                danger
              />
              <Metric
                label="监控对象数"
                value={count(
                  statistics.data.groupCount + statistics.data.asinCount,
                )}
              />
            </dl>
          </div>
        ) : null}
        <div className="space-y-3 border-t border-border pt-5">
          <h3 className="text-sm font-semibold">高低峰异常率</h3>
          <p className="text-xs leading-6 text-muted-foreground">
            {HISTORY_STATISTICS_SCOPES.peakHours}
          </p>
          {queries.peakHours === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              应用国家筛选后显示高低峰统计。
            </p>
          ) : (
            <>
              <Scope query={queries.peakHours} />
              {peakHours.isError ? (
                <ReadError error={peakHours.error} retry={retryPeakHours} />
              ) : peakHours.isPending ? (
                <Skeleton aria-label="正在加载高低峰统计" className="h-24" />
              ) : peakHours.data ? (
                <div aria-busy={peakHours.isFetching}>
                  {peakHours.isFetching && (
                    <p
                      role="status"
                      className="mb-3 text-xs text-muted-foreground"
                    >
                      正在刷新高低峰统计。
                    </p>
                  )}
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <Metric
                      label="高峰期异常率"
                      value={`${peakHours.data.peakRate.toFixed(2)}%`}
                      detail={`异常 / 检查：${count(
                        peakHours.data.peakBroken,
                      )} / ${count(peakHours.data.peakTotal)}`}
                    />
                    <Metric
                      label="低峰期异常率"
                      value={`${peakHours.data.offPeakRate.toFixed(2)}%`}
                      detail={`异常 / 检查：${count(
                        peakHours.data.offPeakBroken,
                      )} / ${count(peakHours.data.offPeakTotal)}`}
                    />
                  </dl>
                </div>
              ) : null}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
