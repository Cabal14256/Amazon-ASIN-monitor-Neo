import { skipToken, useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Clock3,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import { EmptyState, FilterChip, Skeleton } from '../../components/ui/feedback';
import { Field, Input } from '../../components/ui/field';
import {
  Card,
  CardContent,
  CardHeader,
  ModuleLabel,
} from '../../components/ui/surfaces';
import {
  getAbnormalDurationStatistics,
  getAllCountriesSummary,
  getAsinStatisticsByCountry,
  getAsinStatisticsByVariantGroup,
  getMonitorStatistics,
  getMonthlyBreakdown,
  getPeakHoursStatistics,
  getPeakMarkAreas,
  getPeriodSummary,
  getPeriodSummaryDetails,
  getRegionSummary,
  getStatisticsByCountry,
  getStatisticsByTime,
  getStatisticsByVariantGroup,
} from '../../services/monitor-analytics';
import { trendTimeLabel } from './analytics-chart-data';
import {
  AnalyticsCountryCharts,
  AnalyticsPeakIntervals,
  AnalyticsRankingChart,
  AnalyticsTrendChart,
} from './analytics-charts';
import {
  abnormalSummaryPageRows,
  analyticsCountryQuery,
  analyticsError,
  applyAnalyticsFilters,
  count,
  COUNTRIES,
  dateLabel,
  durationSummaryQuery,
  hours,
  initialAnalyticsFilters,
  integerMetric,
  loadMonthlyRows,
  monthlyIntersectionQuery,
  monthlyRowsInRange,
  monthsInRange,
  overviewAsinMetric,
  overviewStatisticsQuery,
  peakHoursQuery,
  percent,
  periodDetailPageRows,
  periodDetailsQuery,
  periodPageCount,
  periodSummaryQuery,
  rowText,
  selectOverviewSummary,
  sumAbnormalSeriesByPeriod,
  variantGroupHistoryHref,
  type AnalyticsFilters,
  type DurationSummaryGranularity,
  type PeriodFilters,
  type PeriodIdentity,
} from './analytics-data';
import { useAnalyticsScope } from './analytics-scope';

type Tab = 'overview' | 'rankings' | 'peak';
const TABS: { id: Tab; label: string; description: string }[] = [
  { id: 'overview', label: '趋势总览', description: '时段变化与国家分布' },
  { id: 'rankings', label: 'ASIN 与周期', description: '异常排名与时间槽' },
  { id: 'peak', label: '高峰与时长', description: '高峰区域和异常时长' },
];

function QueryPanel({
  title,
  description,
  pending,
  error,
  retry,
  control,
  children,
}: {
  title: string;
  description?: string;
  pending: boolean;
  error: unknown;
  retry: () => void;
  control?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        action={
          <div className="flex flex-wrap items-end gap-3">
            {control}
            <Button
              variant="ghost"
              size="small"
              pending={pending}
              onClick={retry}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
          </div>
        }
      />
      <CardContent>
        {pending ? (
          <div aria-label={`正在加载${title}`} className="space-y-3">
            <Skeleton className="h-8" />
            <Skeleton className="h-28" />
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-control border border-status-danger/25 bg-status-danger-soft p-4 text-sm text-status-danger"
          >
            <p>{analyticsError(error)}</p>
            <Button
              variant="secondary"
              size="small"
              className="mt-3"
              onClick={retry}
            >
              重试
            </Button>
          </div>
        ) : children ? (
          children
        ) : (
          <EmptyState title="暂无数据" description="调整筛选范围后重新查询。" />
        )}
      </CardContent>
    </Card>
  );
}

function MetricCards({
  values,
}: {
  values: { label: string; value: string; hint: string }[];
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {values.map((item) => (
        <Card key={item.label} className="border-t-4 border-t-module-analytics">
          <CardContent>
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="neo-mono mt-3 text-2xl font-black">{item.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  if (!rows.length)
    return <EmptyState title="暂无明细" description="当前筛选条件没有记录。" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[38rem] text-left text-sm">
        <thead className="border-b border-border text-xs text-muted-foreground">
          <tr>
            {headers.map((header) => (
              <th key={header} className="p-3 font-semibold">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-border last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="p-3 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VariantGroupCell({
  row,
  canReadMonitor,
}: {
  row: Record<string, unknown>;
  canReadMonitor: boolean;
}) {
  const label = rowText(row, 'variant_group_name', 'variant_group_id');
  const href = variantGroupHistoryHref(row.variant_group_id, canReadMonitor);
  return href ? (
    <a
      href={href}
      className="font-medium text-module-analytics underline underline-offset-4 hover:opacity-75"
    >
      {label}
    </a>
  ) : (
    label
  );
}

function Overview({ filters }: { filters: AnalyticsFilters }) {
  const { runtime } = useAuth();
  const scope = useAnalyticsScope();
  const [globalDurationGranularity, setGlobalDurationGranularity] =
    useState<DurationSummaryGranularity>('hour');
  const [regionDurationGranularity, setRegionDurationGranularity] =
    useState<DurationSummaryGranularity>('hour');
  const range = {
    startTime: filters.startTime,
    endTime: filters.endTime,
  };
  const globalDurationQuery = durationSummaryQuery(
    filters,
    globalDurationGranularity,
  );
  const regionDurationQuery = durationSummaryQuery(
    filters,
    regionDurationGranularity,
  );
  const query = analyticsCountryQuery(filters);
  const statisticsQuery = overviewStatisticsQuery(filters);
  const stats = useQuery({
    queryKey: ['analytics', scope, 'statistics', statisticsQuery],
    queryFn: ({ signal }) =>
      getMonitorStatistics(runtime.http, statisticsQuery, signal),
  });
  const byTime = useQuery({
    queryKey: ['analytics', scope, 'by-time', filters],
    queryFn: ({ signal }) =>
      getStatisticsByTime(
        runtime.http,
        { ...query, groupBy: filters.groupBy },
        signal,
      ),
  });
  const byCountry = useQuery({
    queryKey: ['analytics', scope, 'by-country', range],
    queryFn: ({ signal }) =>
      getStatisticsByCountry(runtime.http, range, signal),
  });
  const allCountries = useQuery({
    queryKey: [
      'analytics',
      scope,
      'all-countries-summary',
      globalDurationQuery,
    ],
    queryFn: ({ signal }) =>
      getAllCountriesSummary(runtime.http, globalDurationQuery, signal),
  });
  const regions = useQuery({
    queryKey: ['analytics', scope, 'region-summary', regionDurationQuery],
    queryFn: ({ signal }) =>
      getRegionSummary(runtime.http, regionDurationQuery, signal),
  });
  const countryDurations = useQuery({
    queryKey: ['analytics', scope, 'asin-by-country', filters],
    queryFn: ({ signal }) =>
      getAsinStatisticsByCountry(runtime.http, query, signal),
  });
  const areas = useQuery({
    queryKey: ['analytics', scope, 'peak-mark-areas', filters],
    queryFn: ({ signal }) =>
      getPeakMarkAreas(
        runtime.http,
        { ...query, groupBy: filters.groupBy },
        signal,
      ),
    enabled: filters.groupBy === 'hour',
  });
  const summary = selectOverviewSummary(
    filters.country,
    stats.data,
    allCountries.data,
  );
  const summaryPending = filters.country
    ? stats.isPending
    : allCountries.isPending && stats.isPending;
  const summaryError = filters.country
    ? stats.error
    : allCountries.error && stats.error;
  return (
    <div className="space-y-5">
      <QueryPanel
        title="范围指标"
        description={
          filters.country ? `${filters.country} 站点统计` : '全部国家统计'
        }
        pending={summaryPending}
        error={summaryError}
        retry={() => {
          if (filters.country) void stats.refetch();
          else {
            void allCountries.refetch();
            void stats.refetch();
          }
        }}
      >
        {summary ? (
          <MetricCards
            values={[
              {
                label: '总检查次数',
                value: count(summary.totalChecks),
                hint: '当前时间范围',
              },
              {
                label: '异常次数',
                value: count(summary.brokenCount),
                hint: `${percent(summary.ratioAllTime)} 时长异常率`,
              },
              {
                label: '异常时长',
                value: hours(summary.abnormalDurationHours),
                hint: `总时长 ${hours(summary.totalDurationHours)}`,
              },
              overviewAsinMetric(summary),
            ]}
          />
        ) : (
          <EmptyState
            title="暂无范围指标"
            description="当前范围尚无统计结果。"
          />
        )}
      </QueryPanel>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
        <QueryPanel
          title="异常时长趋势"
          description="展示所选范围的全部时间槽，支持缩放和时长/占比切换；小时粒度可叠加高峰区域。"
          pending={byTime.isPending}
          error={byTime.error}
          retry={() => void byTime.refetch()}
        >
          <AnalyticsTrendChart
            rows={byTime.data ?? []}
            label="监控异常趋势"
            rowLabel={(row) =>
              trendTimeLabel(row.time_period ?? row.timePeriod)
            }
            peaks={
              filters.groupBy === 'hour' && !areas.isError
                ? areas.data ?? []
                : []
            }
          />
          {filters.groupBy === 'hour' && areas.isError && (
            <p role="alert" className="mt-3 text-sm text-status-danger">
              高峰区域未能加载，异常趋势仍可查看。{analyticsError(areas.error)}
              <Button
                variant="ghost"
                size="small"
                onClick={() => void areas.refetch()}
              >
                重试高峰区域
              </Button>
            </p>
          )}
        </QueryPanel>
        <QueryPanel
          title="全球国家分布"
          description="按全部国家聚合检查与异常数量，不受国家筛选影响。"
          pending={byCountry.isPending}
          error={byCountry.error}
          retry={() => void byCountry.refetch()}
        >
          <Table
            headers={['国家', '检查', '异常', '异常率']}
            rows={(byCountry.data ?? []).map((row) => {
              const total = integerMetric(row.total_checks ?? row.totalChecks);
              const broken = integerMetric(row.broken_count ?? row.brokenCount);
              return [
                rowText(row, 'country'),
                count(total),
                count(broken),
                percent(total ? (broken / total) * 100 : 0),
              ];
            })}
          />
        </QueryPanel>
      </div>
      <QueryPanel
        title="国家时长分布"
        description="按当前国家和时间范围展示正常/异常时长；饼图百分比使用各国异常时长之和作为分母。"
        pending={countryDurations.isPending}
        error={countryDurations.error}
        retry={() => void countryDurations.refetch()}
      >
        <AnalyticsCountryCharts rows={countryDurations.data ?? []} />
      </QueryPanel>
      <div className="grid gap-5 xl:grid-cols-2">
        <QueryPanel
          title="全局时长摘要"
          description="来自缓存或最新聚合结果，展示数据来源由服务端决定。"
          pending={allCountries.isPending}
          error={allCountries.error}
          retry={() => void allCountries.refetch()}
          control={
            <Field label="全局时长粒度">
              {(field) => (
                <select
                  {...field}
                  className="rounded-input border border-input bg-card px-3 py-2 text-sm"
                  value={globalDurationGranularity}
                  onChange={(event) =>
                    setGlobalDurationGranularity(
                      event.target.value as DurationSummaryGranularity,
                    )
                  }
                >
                  <option value="hour">小时</option>
                  <option value="day">天</option>
                </select>
              )}
            </Field>
          }
        >
          {allCountries.data ? (
            <dl className="grid gap-4 sm:grid-cols-2">
              {[
                ['高峰时长', hours(allCountries.data.peakDurationHours)],
                ['低峰时长', hours(allCountries.data.lowDurationHours)],
                ['高峰异常时长占比', percent(allCountries.data.globalPeakRate)],
                ['低峰异常时长占比', percent(allCountries.data.globalLowRate)],
                ['ASIN 平均异常率', percent(allCountries.data.ratioAllAsin)],
                ['异常时长占比', percent(allCountries.data.ratioAllTime)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="neo-mono mt-1 text-lg font-bold">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </QueryPanel>
        <QueryPanel
          title="全球区域摘要"
          description="七个业务区域的时长与异常表现，不受国家筛选影响。"
          pending={regions.isPending}
          error={regions.error}
          retry={() => void regions.refetch()}
          control={
            <Field label="区域时长粒度">
              {(field) => (
                <select
                  {...field}
                  className="rounded-input border border-input bg-card px-3 py-2 text-sm"
                  value={regionDurationGranularity}
                  onChange={(event) =>
                    setRegionDurationGranularity(
                      event.target.value as DurationSummaryGranularity,
                    )
                  }
                >
                  <option value="hour">小时</option>
                  <option value="day">天</option>
                </select>
              )}
            </Field>
          }
        >
          <Table
            headers={['区域', '总时长', '异常时长', '异常率']}
            rows={(regions.data ?? []).map((row) => [
              rowText(row, 'region', 'regionCode'),
              hours(row.totalDurationHours),
              hours(row.abnormalDurationHours),
              percent(row.ratioAllTime),
            ])}
          />
        </QueryPanel>
      </div>
    </div>
  );
}

function Rankings({ filters }: { filters: AnalyticsFilters }) {
  const { runtime } = useAuth();
  const scope = useAnalyticsScope();
  const identity = useIdentity();
  const canReadMonitor =
    identity.status === 'authenticated' &&
    createAccess(identity.identity).canReadMonitor;
  const query = analyticsCountryQuery(filters);
  const [periodGranularity, setPeriodGranularity] =
    useState<DurationSummaryGranularity>('hour');
  const [periodFilterDraft, setPeriodFilterDraft] = useState<PeriodFilters>({
    site: '',
    brand: '',
  });
  const [periodFilters, setPeriodFilters] = useState<PeriodFilters>({
    site: '',
    brand: '',
  });
  const [pageSelection, setPageSelection] = useState<{
    filters: AnalyticsFilters;
    page: number;
  } | null>(null);
  const page = pageSelection?.filters === filters ? pageSelection.page : 1;
  const [selection, setSelection] = useState<{
    filters: AnalyticsFilters;
    page: number;
    period: PeriodIdentity;
  } | null>(null);
  const [detailPageSelection, setDetailPageSelection] = useState<{
    selection: typeof selection;
    page: number;
  } | null>(null);
  const selectedPeriod =
    selection?.filters === filters && selection.page === page
      ? selection.period
      : null;
  const detailParams = selectedPeriod
    ? periodDetailsQuery(filters, selectedPeriod, periodGranularity)
    : null;
  const asinCountry = useQuery({
    queryKey: ['analytics', scope, 'asin-by-country', filters],
    queryFn: ({ signal }) =>
      getAsinStatisticsByCountry(runtime.http, query, signal),
  });
  const asinGroup = useQuery({
    queryKey: ['analytics', scope, 'asin-by-variant-group', filters],
    queryFn: ({ signal }) =>
      getAsinStatisticsByVariantGroup(
        runtime.http,
        { ...query, limit: 50 },
        signal,
      ),
  });
  const groups = useQuery({
    queryKey: ['analytics', scope, 'by-variant-group', filters],
    queryFn: ({ signal }) =>
      getStatisticsByVariantGroup(
        runtime.http,
        { ...query, limit: 50 },
        signal,
      ),
  });
  const periods = useQuery({
    queryKey: [
      'analytics',
      scope,
      'period-summary',
      filters,
      periodFilters,
      page,
      periodGranularity,
    ],
    queryFn: ({ signal }) =>
      getPeriodSummary(
        runtime.http,
        periodSummaryQuery(filters, periodFilters, page, periodGranularity),
        signal,
      ),
  });
  const details = useQuery({
    queryKey: ['analytics', scope, 'period-summary-details', detailParams],
    queryFn: detailParams
      ? ({ signal }) =>
          getPeriodSummaryDetails(runtime.http, detailParams, signal)
      : skipToken,
  });
  const totalPages = periodPageCount(
    periods.data?.total ?? 0,
    periods.data?.pageSize ?? 20,
  );
  const detailTotalPages = periodPageCount(details.data?.length ?? 0, 50);
  const detailPage = Math.min(
    detailPageSelection?.selection === selection ? detailPageSelection.page : 1,
    detailTotalPages,
  );
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <QueryPanel
          title="国家 ASIN 时长汇总"
          description="展示各站点覆盖的 ASIN 数量、异常时长和异常率。"
          pending={asinCountry.isPending}
          error={asinCountry.error}
          retry={() => void asinCountry.refetch()}
        >
          <Table
            headers={['国家', '覆盖 ASIN', '异常 ASIN', '异常时长', '异常率']}
            rows={(asinCountry.data ?? []).map((row) => [
              rowText(row, 'country'),
              count(row.totalAsinsDedup),
              count(row.brokenAsinsDedup),
              hours(row.abnormalDurationHours),
              percent(row.ratioAllTime),
            ])}
          />
        </QueryPanel>
        <QueryPanel
          title="ASIN 变体组排名"
          description="最多展示前 50 个变体组。"
          pending={asinGroup.isPending}
          error={asinGroup.error}
          retry={() => void asinGroup.refetch()}
        >
          <AnalyticsRankingChart rows={asinGroup.data ?? []} />
          <Table
            headers={['变体组', '国家', '异常 ASIN', '异常时长', '异常率']}
            rows={(asinGroup.data ?? []).map((row) => [
              <VariantGroupCell row={row} canReadMonitor={canReadMonitor} />,
              rowText(row, 'country'),
              count(row.brokenAsinsDedup),
              hours(row.abnormalDurationHours),
              percent(row.ratioAllTime),
            ])}
          />
        </QueryPanel>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <QueryPanel
          title="变体组检查排行"
          description="使用统计端点的分组结果，保留服务端排序。"
          pending={groups.isPending}
          error={groups.error}
          retry={() => void groups.refetch()}
        >
          <Table
            headers={['变体组', '检查', '异常']}
            rows={(groups.data ?? []).map((row) => [
              <VariantGroupCell row={row} canReadMonitor={canReadMonitor} />,
              count(row.total_checks),
              count(row.broken_count),
            ])}
          />
        </QueryPanel>
        <QueryPanel
          title="周期摘要"
          description="每个周期保留详情标记，可继续按独立时间槽粒度追踪。"
          pending={periods.isPending}
          error={periods.error}
          retry={() => void periods.refetch()}
        >
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <Field label="周期粒度">
              {(control) => (
                <select
                  {...control}
                  className="w-full rounded-input border border-input bg-card px-4 py-3 text-sm"
                  value={periodGranularity}
                  onChange={(event) => {
                    setPeriodGranularity(
                      event.target.value as DurationSummaryGranularity,
                    );
                    setPageSelection(null);
                    setSelection(null);
                    setDetailPageSelection(null);
                  }}
                >
                  <option value="hour">小时</option>
                  <option value="day">天</option>
                </select>
              )}
            </Field>
            <Field label="站点">
              {(control) => (
                <Input
                  {...control}
                  value={periodFilterDraft.site}
                  onChange={(event) =>
                    setPeriodFilterDraft((previous) => ({
                      ...previous,
                      site: event.target.value,
                    }))
                  }
                />
              )}
            </Field>
            <Field label="品牌">
              {(control) => (
                <Input
                  {...control}
                  value={periodFilterDraft.brand}
                  onChange={(event) =>
                    setPeriodFilterDraft((previous) => ({
                      ...previous,
                      brand: event.target.value,
                    }))
                  }
                />
              )}
            </Field>
            <Button
              variant="secondary"
              onClick={() => {
                setPeriodFilters(periodFilterDraft);
                setPageSelection(null);
                setSelection(null);
              }}
            >
              筛选周期
            </Button>
          </div>
          <Table
            headers={['国家', '站点', '品牌', '异常时长', '时间槽']}
            rows={(periods.data?.list ?? []).map((row) => [
              rowText(row, 'country'),
              rowText(row, 'site'),
              rowText(row, 'brand'),
              hours(row.abnormalDurationHours),
              <Button
                key="details"
                variant="secondary"
                size="small"
                onClick={() => setSelection({ filters, page, period: row })}
              >
                查看明细
              </Button>,
            ])}
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              第 {page} / {totalPages} 页 · 共 {periods.data?.total ?? 0} 组
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={periods.isPending || page <= 1}
                onClick={() => setPageSelection({ filters, page: page - 1 })}
              >
                上一页
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={periods.isPending || page >= totalPages}
                onClick={() => setPageSelection({ filters, page: page + 1 })}
              >
                下一页
              </Button>
            </div>
          </div>
        </QueryPanel>
      </div>
      {selectedPeriod ? (
        <QueryPanel
          title="周期时间槽明细"
          description={`${selectedPeriod.country} / ${
            selectedPeriod.site || '无站点'
          } / ${selectedPeriod.brand || '无品牌'} · ${periodGranularity} 粒度`}
          pending={details.isPending}
          error={details.error}
          retry={() => void details.refetch()}
        >
          <Table
            headers={['时间槽', '总时长', '异常时长', '异常率']}
            rows={periodDetailPageRows(details.data ?? [], detailPage).map(
              (row) => [
                rowText(row, 'timeSlot', 'time_slot'),
                hours(row.totalDurationHours),
                hours(row.abnormalDurationHours),
                percent(row.ratioAllTime),
              ],
            )}
          />
          {detailTotalPages > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>
                第 {detailPage} / {detailTotalPages} 页 · 共{' '}
                {details.data?.length ?? 0} 个时间槽
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  disabled={details.isPending || detailPage <= 1}
                  onClick={() =>
                    setDetailPageSelection({ selection, page: detailPage - 1 })
                  }
                >
                  上一页
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={details.isPending || detailPage >= detailTotalPages}
                  onClick={() =>
                    setDetailPageSelection({ selection, page: detailPage + 1 })
                  }
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </QueryPanel>
      ) : (
        <Card>
          <CardHeader title="周期时间槽明细" />
          <CardContent>
            <EmptyState
              title="选择一条周期摘要"
              description="点击上表中的“查看明细”，按该国家、站点和品牌读取时间槽。"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PeakAndDuration({ filters }: { filters: AnalyticsFilters }) {
  const { runtime } = useAuth();
  const scope = useAnalyticsScope();
  const [summaryPageSelection, setSummaryPageSelection] = useState<{
    filters: AnalyticsFilters;
    page: number;
  } | null>(null);
  const summaryPage =
    summaryPageSelection?.filters === filters ? summaryPageSelection.page : 1;
  const query = analyticsCountryQuery(filters);
  const peakQuery = peakHoursQuery(filters);
  const peak = useQuery({
    queryKey: ['analytics', scope, 'peak-hours', peakQuery],
    queryFn: ({ signal }) =>
      getPeakHoursStatistics(runtime.http, peakQuery, signal),
  });
  const month = useQuery({
    queryKey: ['analytics', scope, 'monthly', filters],
    queryFn: async ({ signal }) => {
      const months = monthsInRange(filters.startTime, filters.endTime);
      return loadMonthlyRows(
        months,
        async (token, siblingSignal) =>
          (
            await getMonthlyBreakdown(
              runtime.http,
              monthlyIntersectionQuery(filters, token),
              siblingSignal,
            )
          ).rows,
        signal,
      );
    },
  });
  const areas = useQuery({
    queryKey: ['analytics', scope, 'peak-mark-areas', filters],
    queryFn: ({ signal }) =>
      getPeakMarkAreas(
        runtime.http,
        { ...query, groupBy: filters.groupBy },
        signal,
      ),
    enabled: filters.groupBy === 'hour',
  });
  const abnormal = useQuery({
    queryKey: ['analytics', scope, 'abnormal-duration', filters],
    queryFn: ({ signal }) =>
      getAbnormalDurationStatistics(
        runtime.http,
        { ...query, includeSeries: '1' },
        signal,
      ),
  });
  const peakData = peak.data;
  const monthlyRows = useMemo(
    () =>
      monthlyRowsInRange(month.data ?? [], filters.startTime, filters.endTime),
    [month.data, filters.startTime, filters.endTime],
  );
  const abnormalRows = useMemo(
    () => sumAbnormalSeriesByPeriod(abnormal.data?.data ?? []),
    [abnormal.data?.data],
  );
  const abnormalSummary = abnormal.data?.summary ?? [];
  const summaryTotalPages = periodPageCount(abnormalSummary.length, 50);
  const visibleSummaryPage = Math.min(summaryPage, summaryTotalPages);
  const peakMetrics: { label: string; value: string; Icon: typeof Clock3 }[] =
    peakData
      ? [
          {
            label: '高峰异常率',
            value: percent(peakData.peakRate),
            Icon: TrendingUp,
          },
          {
            label: '低峰异常率',
            value: percent(peakData.offPeakRate),
            Icon: TrendingDown,
          },
          {
            label: '高峰异常时长',
            value: hours(peakData.peakAbnormalDurationHours),
            Icon: Clock3,
          },
          {
            label: '低峰异常时长',
            value: hours(peakData.offPeakAbnormalDurationHours),
            Icon: Clock3,
          },
        ]
      : [];
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <QueryPanel
          title={`${peakQuery.country} 高峰与低峰`}
          description="按国家和上海本地时间计算高峰差异。"
          pending={peak.isPending}
          error={peak.error}
          retry={() => void peak.refetch()}
        >
          {peakData ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {peakMetrics.map(({ label, value, Icon }) => (
                <div key={label} className="rounded-control bg-muted p-4">
                  <Icon
                    className="size-4 text-module-analytics"
                    aria-hidden="true"
                  />
                  <p className="mt-3 text-xs text-muted-foreground">{label}</p>
                  <p className="neo-mono mt-1 text-lg font-bold">{value}</p>
                </div>
              ))}
            </div>
          ) : null}
        </QueryPanel>
        <QueryPanel
          title="异常时长曲线"
          description="异常时长按所选时间范围自动选择小时、日或周粒度，与上方趋势粒度筛选独立。"
          pending={abnormal.isPending}
          error={abnormal.error}
          retry={() => void abnormal.refetch()}
        >
          <AnalyticsTrendChart
            rows={abnormalRows}
            label="异常时长曲线"
            rowLabel={(row) => trendTimeLabel(row.timePeriod)}
            initialMode="hours"
          />
        </QueryPanel>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <QueryPanel
          title="月度异常拆分"
          description="按日展开所选范围内每个自然月的异常时长。"
          pending={month.isPending}
          error={month.error}
          retry={() => void month.refetch()}
        >
          <AnalyticsTrendChart
            rows={monthlyRows}
            label="月度异常拆分"
            rowLabel={(row) => rowText(row, 'date')}
            initialMode="hours"
          />
        </QueryPanel>
        <QueryPanel
          title="高峰标记区域"
          description="显示美国、英国与欧洲站点的小时高峰时间段。"
          pending={filters.groupBy === 'hour' && areas.isPending}
          error={areas.error}
          retry={() => void areas.refetch()}
        >
          {filters.groupBy !== 'hour' ? (
            <EmptyState
              title="高峰标记按小时展示"
              description="将趋势粒度切换为小时以查看各站点的高峰时间区域。"
            />
          ) : areas.data?.length ? (
            <div className="space-y-4">
              {areas.data.map((area) => (
                <div
                  key={area.name}
                  className="rounded-control border border-border p-4"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="size-3 rounded-full"
                      style={{ backgroundColor: area.color }}
                    />
                    <span className="font-semibold">{area.name}</span>
                    <span className="ml-auto text-sm text-muted-foreground">
                      {area.areas.length} 个时间区段
                    </span>
                  </div>
                  <AnalyticsPeakIntervals area={area} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="暂无高峰标记"
              description="当前范围没有形成连续高峰区域。"
            />
          )}
        </QueryPanel>
      </div>
      {abnormal.data?.summary?.length ? (
        <QueryPanel
          title="异常时长摘要"
          description="按 ASIN 汇总异常次数及最大异常时间。"
          pending={false}
          error={undefined}
          retry={() => void abnormal.refetch()}
        >
          <Table
            headers={[
              'ASIN',
              '国家',
              '异常次数',
              '平均异常时长',
              '最大异常时间',
            ]}
            rows={abnormalSummaryPageRows(
              abnormalSummary,
              visibleSummaryPage,
            ).map((row) => [
              rowText(row, 'asin'),
              rowText(row, 'country'),
              count(row.abnormalCount),
              hours(row.averageAbnormalDuration),
              dateLabel(row.maxAbnormalTime),
            ])}
          />
          {summaryTotalPages > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                第 {visibleSummaryPage} / {summaryTotalPages} 页 · 共{' '}
                {abnormalSummary.length} 个 ASIN
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  disabled={visibleSummaryPage <= 1}
                  onClick={() =>
                    setSummaryPageSelection({
                      filters,
                      page: visibleSummaryPage - 1,
                    })
                  }
                >
                  上一页
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={visibleSummaryPage >= summaryTotalPages}
                  onClick={() =>
                    setSummaryPageSelection({
                      filters,
                      page: visibleSummaryPage + 1,
                    })
                  }
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </QueryPanel>
      ) : null}
    </div>
  );
}

function normalizedInitialFilters(): AnalyticsFilters {
  const filters = initialAnalyticsFilters();
  const result = applyAnalyticsFilters(filters);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export default function AnalyticsPage() {
  const scope = useAnalyticsScope();
  const [filters, setFilters] = useState<AnalyticsFilters>(() =>
    initialAnalyticsFilters(),
  );
  const [applied, setApplied] = useState<AnalyticsFilters>(() =>
    normalizedInitialFilters(),
  );
  const [tab, setTab] = useState<Tab>('overview');
  const [filterError, setFilterError] = useState<string | null>(null);
  function apply() {
    const result = applyAnalyticsFilters(filters);
    if (!result.ok) {
      setFilterError(result.error);
      return;
    }
    setFilterError(null);
    setApplied(result.value);
  }
  if (!scope)
    return (
      <AppShell title="数据分析">
        <EmptyState
          title="分析数据暂不可读"
          description="请完成登录验证并确认当前账号具备数据分析读取权限。"
        />
      </AppShell>
    );
  const readerKey = JSON.stringify(scope);
  return (
    <AppShell title="数据分析">
      <div className="space-y-6 lg:space-y-7">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8 sm:py-9">
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div>
              <ModuleLabel module="analytics">ANALYTICS / 数据分析</ModuleLabel>
              <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-4xl">
                把趋势变成判断
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/65">
                从监控趋势、国家分布到 ASIN 排名，集中定位异常发生的时间和范围。
              </p>
            </div>
            <BarChart3 aria-hidden="true" className="size-10 text-signal" />
          </div>
        </section>
        <Card>
          <CardHeader
            title="分析范围"
            description="时间按上海时区解释；统计接口均受服务端结果大小限制。"
          />
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="国家">
                {(control) => (
                  <select
                    {...control}
                    className="w-full rounded-input border border-input bg-card px-4 py-3 text-sm"
                    value={filters.country}
                    onChange={(event) =>
                      setFilters((previous) => ({
                        ...previous,
                        country: event.target.value,
                      }))
                    }
                  >
                    {COUNTRIES.map((country) => (
                      <option key={country.value} value={country.value}>
                        {country.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="开始时间（上海）">
                {(control) => (
                  <Input
                    {...control}
                    type="datetime-local"
                    step="60"
                    value={filters.startTime}
                    onChange={(event) =>
                      setFilters((previous) => ({
                        ...previous,
                        startTime: event.target.value,
                      }))
                    }
                  />
                )}
              </Field>
              <Field label="结束时间（上海）">
                {(control) => (
                  <Input
                    {...control}
                    type="datetime-local"
                    step="60"
                    value={filters.endTime}
                    onChange={(event) =>
                      setFilters((previous) => ({
                        ...previous,
                        endTime: event.target.value,
                      }))
                    }
                  />
                )}
              </Field>
              <Field label="趋势粒度">
                {(control) => (
                  <select
                    {...control}
                    className="w-full rounded-input border border-input bg-card px-4 py-3 text-sm"
                    value={filters.groupBy}
                    onChange={(event) =>
                      setFilters((previous) => ({
                        ...previous,
                        groupBy: event.target
                          .value as AnalyticsFilters['groupBy'],
                      }))
                    }
                  >
                    <option value="hour">小时</option>
                    <option value="day">天</option>
                    <option value="week">周</option>
                    <option value="month">月</option>
                  </select>
                )}
              </Field>
            </div>
            {filterError && (
              <p role="alert" className="text-sm text-status-danger">
                {filterError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={apply}>
                <Search aria-hidden="true" />
                查询分析
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  const next = initialAnalyticsFilters();
                  setFilters(next);
                  const result = applyAnalyticsFilters(next);
                  if (result.ok) setApplied(result.value);
                  setFilterError(null);
                }}
              >
                恢复最近 30 天
              </Button>
            </div>
          </CardContent>
        </Card>
        <div
          className="flex flex-wrap items-center gap-2"
          role="tablist"
          aria-label="分析视图"
        >
          {TABS.map((item) => (
            <FilterChip
              key={item.id}
              selected={tab === item.id}
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              <span className="hidden text-muted-foreground sm:inline">
                · {item.description}
              </span>
            </FilterChip>
          ))}
        </div>
        {tab === 'overview' ? (
          <Overview key={readerKey} filters={applied} />
        ) : tab === 'rankings' ? (
          <Rankings key={readerKey} filters={applied} />
        ) : (
          <PeakAndDuration key={readerKey} filters={applied} />
        )}
        <p className="text-xs text-muted-foreground">
          统计服务返回的数据会按权限和结果大小限制过滤；页面不会展示未验证的零值。
        </p>
      </div>
    </AppShell>
  );
}
