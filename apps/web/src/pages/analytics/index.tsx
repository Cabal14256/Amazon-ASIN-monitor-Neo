import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Clock3,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../../auth/context';
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
import {
  analyticsError,
  applyAnalyticsFilters,
  count,
  COUNTRIES,
  dateLabel,
  hours,
  initialAnalyticsFilters,
  integerMetric,
  metric,
  percent,
  rowText,
  type AnalyticsFilters,
} from './analytics-data';

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
  children,
}: {
  title: string;
  description?: string;
  pending: boolean;
  error: unknown;
  retry: () => void;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        action={
          <Button
            variant="ghost"
            size="small"
            pending={pending}
            onClick={retry}
          >
            <RefreshCw aria-hidden="true" />
            刷新
          </Button>
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

function Bars({
  rows,
  label,
  value,
  valueLabel,
}: {
  rows: readonly Record<string, unknown>[];
  label: (...args: Record<string, unknown>[]) => string;
  value: (row: Record<string, unknown>) => number;
  valueLabel?: (row: Record<string, unknown>) => string;
}) {
  if (!rows.length)
    return (
      <EmptyState
        title="暂无趋势数据"
        description="当前时间范围没有可展示的记录。"
      />
    );
  const visible = rows.slice(-14);
  const max = Math.max(1, ...visible.map(value));
  return (
    <div className="space-y-3" aria-label="趋势柱状图">
      {visible.map((row, index) => {
        const amount = value(row);
        return (
          <div
            key={`${label(row)}-${index}`}
            className="grid grid-cols-[6rem_minmax(0,1fr)_4rem] items-center gap-3 text-xs"
          >
            <span className="truncate text-muted-foreground" title={label(row)}>
              {label(row)}
            </span>
            <div className="h-3 overflow-hidden rounded-pill bg-muted">
              <div
                className="h-full rounded-pill bg-module-analytics"
                style={{ width: `${Math.max(3, (amount / max) * 100)}%` }}
              />
            </div>
            <span className="neo-mono text-right">
              {valueLabel ? valueLabel(row) : amount.toFixed(1)}
            </span>
          </div>
        );
      })}
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

function Overview({ filters }: { filters: AnalyticsFilters }) {
  const { runtime } = useAuth();
  const query = {
    country: filters.country || undefined,
    startTime: filters.startTime,
    endTime: filters.endTime,
  };
  const stats = useQuery({
    queryKey: ['analytics', 'statistics', query],
    queryFn: ({ signal }) => getMonitorStatistics(runtime.http, query, signal),
  });
  const byTime = useQuery({
    queryKey: ['analytics', 'by-time', filters],
    queryFn: ({ signal }) =>
      getStatisticsByTime(
        runtime.http,
        { ...query, groupBy: filters.groupBy },
        signal,
      ),
  });
  const byCountry = useQuery({
    queryKey: ['analytics', 'by-country', filters],
    queryFn: ({ signal }) =>
      getStatisticsByCountry(runtime.http, query, signal),
  });
  const allCountries = useQuery({
    queryKey: ['analytics', 'all-countries-summary', filters],
    queryFn: ({ signal }) =>
      getAllCountriesSummary(runtime.http, query, signal),
  });
  const regions = useQuery({
    queryKey: ['analytics', 'region-summary', filters],
    queryFn: ({ signal }) => getRegionSummary(runtime.http, query, signal),
  });
  const summary = allCountries.data ?? stats.data;
  return (
    <div className="space-y-5">
      {summary && (
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
            {
              label: '受影响 ASIN',
              value: count(summary.brokenAsinsDedup ?? summary.asinCount),
              hint: `监控 ASIN ${count(
                summary.totalAsinsDedup ?? summary.asinCount,
              )}`,
            },
          ]}
        />
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
        <QueryPanel
          title="异常时长趋势"
          description="按上海时间分组，展示最近 14 个时间槽。"
          pending={byTime.isPending}
          error={byTime.error}
          retry={() => void byTime.refetch()}
        >
          <Bars
            rows={byTime.data ?? []}
            label={(row) => dateLabel(row.time_period ?? row.timePeriod)}
            value={(row) => metric(row.abnormalDurationHours)}
            valueLabel={(row) => hours(row.abnormalDurationHours)}
          />
        </QueryPanel>
        <QueryPanel
          title="国家分布"
          description="按国家聚合检查与异常数量。"
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
      <div className="grid gap-5 xl:grid-cols-2">
        <QueryPanel
          title="全局时长摘要"
          description="来自缓存或最新聚合结果，展示数据来源由服务端决定。"
          pending={allCountries.isPending}
          error={allCountries.error}
          retry={() => void allCountries.refetch()}
        >
          {allCountries.data ? (
            <dl className="grid gap-4 sm:grid-cols-2">
              {[
                ['高峰时长', hours(allCountries.data.peakDurationHours)],
                ['低峰时长', hours(allCountries.data.lowDurationHours)],
                ['高峰异常率', percent(allCountries.data.globalPeakRate)],
                ['低峰异常率', percent(allCountries.data.globalLowRate)],
                ['ASIN 覆盖率', percent(allCountries.data.ratioAllAsin)],
                ['时间覆盖率', percent(allCountries.data.ratioAllTime)],
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
          title="区域摘要"
          description="七个业务区域的时长与异常表现。"
          pending={regions.isPending}
          error={regions.error}
          retry={() => void regions.refetch()}
        >
          <Table
            headers={['区域', '总时长', '异常时长', '异常率']}
            rows={(regions.data ?? []).map((row) => [
              rowText(row, 'region', 'regionCode'),
              hours(row.totalDurationHours),
              hours(row.abnormalDurationHours),
              percent(row.globalPeakRate ?? row.ratioAllTime),
            ])}
          />
        </QueryPanel>
      </div>
    </div>
  );
}

function Rankings({ filters }: { filters: AnalyticsFilters }) {
  const { runtime } = useAuth();
  const query = {
    country: filters.country || undefined,
    startTime: filters.startTime,
    endTime: filters.endTime,
  };
  const asinCountry = useQuery({
    queryKey: ['analytics', 'asin-by-country', filters],
    queryFn: ({ signal }) =>
      getAsinStatisticsByCountry(runtime.http, query, signal),
  });
  const asinGroup = useQuery({
    queryKey: ['analytics', 'asin-by-variant-group', filters],
    queryFn: ({ signal }) =>
      getAsinStatisticsByVariantGroup(
        runtime.http,
        { ...query, limit: 50 },
        signal,
      ),
  });
  const groups = useQuery({
    queryKey: ['analytics', 'by-variant-group', filters],
    queryFn: ({ signal }) =>
      getStatisticsByVariantGroup(
        runtime.http,
        { ...query, limit: 50 },
        signal,
      ),
  });
  const periods = useQuery({
    queryKey: ['analytics', 'period-summary', filters],
    queryFn: ({ signal }) =>
      getPeriodSummary(
        runtime.http,
        { ...query, current: 1, pageSize: 20 },
        signal,
      ),
  });
  const details = useQuery({
    queryKey: ['analytics', 'period-summary-details', filters],
    queryFn: ({ signal }) =>
      getPeriodSummaryDetails(runtime.http, query, signal),
  });
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
            rows={(asinCountry.data ?? [])
              .slice(0, 30)
              .map((row) => [
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
          <Table
            headers={['变体组', '国家', '异常 ASIN', '异常时长', '异常率']}
            rows={(asinGroup.data ?? []).map((row) => [
              rowText(row, 'variant_group_name', 'variant_group_id'),
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
            rows={(groups.data ?? [])
              .slice(0, 30)
              .map((row) => [
                rowText(row, 'variant_group_name', 'variant_group_id'),
                count(row.total_checks),
                count(row.broken_count),
              ])}
          />
        </QueryPanel>
        <QueryPanel
          title="周期摘要"
          description="每个周期保留详情标记，可继续按时间槽追踪。"
          pending={periods.isPending}
          error={periods.error}
          retry={() => void periods.refetch()}
        >
          <Table
            headers={['国家', '站点', '品牌', '异常时长']}
            rows={(periods.data?.list ?? []).map((row) => [
              rowText(row, 'country'),
              rowText(row, 'site'),
              rowText(row, 'brand'),
              hours(row.abnormalDurationHours),
            ])}
          />
        </QueryPanel>
      </div>
      <QueryPanel
        title="周期时间槽明细"
        description="用于定位周期内异常集中出现的时段。"
        pending={details.isPending}
        error={details.error}
        retry={() => void details.refetch()}
      >
        <Table
          headers={['时间槽', '总时长', '异常时长', '异常率']}
          rows={(details.data ?? [])
            .slice(0, 50)
            .map((row) => [
              rowText(row, 'timeSlot', 'time_slot'),
              hours(row.totalDurationHours),
              hours(row.abnormalDurationHours),
              percent(row.ratioAllTime),
            ])}
        />
      </QueryPanel>
    </div>
  );
}

function PeakAndDuration({ filters }: { filters: AnalyticsFilters }) {
  const { runtime } = useAuth();
  const country = filters.country || 'US';
  const query = {
    country,
    startTime: filters.startTime,
    endTime: filters.endTime,
  };
  const peak = useQuery({
    queryKey: ['analytics', 'peak-hours', query],
    queryFn: ({ signal }) =>
      getPeakHoursStatistics(runtime.http, query, signal),
  });
  const month = useQuery({
    queryKey: ['analytics', 'monthly', filters],
    queryFn: ({ signal }) =>
      getMonthlyBreakdown(
        runtime.http,
        { ...query, month: filters.startTime.slice(0, 7) },
        signal,
      ),
  });
  const areas = useQuery({
    queryKey: ['analytics', 'peak-mark-areas', filters],
    queryFn: ({ signal }) =>
      getPeakMarkAreas(
        runtime.http,
        { ...query, groupBy: filters.groupBy },
        signal,
      ),
    enabled: filters.groupBy === 'hour',
  });
  const abnormal = useQuery({
    queryKey: ['analytics', 'abnormal-duration', filters],
    queryFn: ({ signal }) =>
      getAbnormalDurationStatistics(
        runtime.http,
        { ...query, includeSeries: '1' },
        signal,
      ),
  });
  const peakData = peak.data;
  const monthlyRows = month.data?.rows ?? [];
  const abnormalRows = abnormal.data?.data ?? [];
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
          title={`${country} 高峰与低峰`}
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
          description="异常统计同时提供汇总和可选的时间序列。"
          pending={abnormal.isPending}
          error={abnormal.error}
          retry={() => void abnormal.refetch()}
        >
          <Bars
            rows={abnormalRows as Record<string, unknown>[]}
            label={(row) => dateLabel(row.timePeriod)}
            value={(row) => metric(row.abnormalDuration)}
            valueLabel={(row) =>
              `${percent(row.abnormalRatio)} / ${hours(row.abnormalDuration)}`
            }
          />
        </QueryPanel>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <QueryPanel
          title="月度异常拆分"
          description={
            month.data
              ? `${month.data.month} · 平均异常率 ${percent(
                  month.data.summary.averageRatio,
                )}`
              : '按日展开月度异常时长。'
          }
          pending={month.isPending}
          error={month.error}
          retry={() => void month.refetch()}
        >
          <Bars
            rows={monthlyRows as Record<string, unknown>[]}
            label={(row) => rowText(row, 'date')}
            value={(row) => metric(row.abnormalDurationHours)}
            valueLabel={(row) => hours(row.abnormalDurationHours)}
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
                  className="flex items-center justify-between rounded-control border border-border p-4"
                >
                  <span className="font-semibold">{area.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {area.areas.length} 个时间区段
                  </span>
                  <span
                    className="size-3 rounded-full"
                    style={{ backgroundColor: area.color }}
                  />
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
            rows={abnormal.data.summary
              .slice(0, 50)
              .map((row) => [
                rowText(row, 'asin'),
                rowText(row, 'country'),
                count(row.abnormalCount),
                hours(row.averageAbnormalDuration),
                dateLabel(row.maxAbnormalTime),
              ])}
          />
        </QueryPanel>
      ) : null}
    </div>
  );
}

export default function AnalyticsPage() {
  const [filters, setFilters] = useState<AnalyticsFilters>(() =>
    initialAnalyticsFilters(),
  );
  const [applied, setApplied] = useState<AnalyticsFilters>(() =>
    initialAnalyticsFilters(),
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
                  setApplied(next);
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
          <Overview filters={applied} />
        ) : tab === 'rankings' ? (
          <Rankings filters={applied} />
        ) : (
          <PeakAndDuration filters={applied} />
        )}
        <p className="text-xs text-muted-foreground">
          统计服务返回的数据会按权限和结果大小限制过滤；页面不会展示未验证的零值。
        </p>
      </div>
    </AppShell>
  );
}
