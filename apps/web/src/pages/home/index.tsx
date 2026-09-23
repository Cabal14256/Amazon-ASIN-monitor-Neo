import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowUpRight, CircleAlert, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import { AnimatedNumber } from '../../components/ui/motion';
import { ModuleLabel } from '../../components/ui/surfaces';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import { getDashboard } from '../../services/dashboard';
import {
  COUNTRIES,
  activitiesForCountry,
  alertText,
  alertsForCountry,
  countryLabel,
  countryOverview,
  type DashboardCountry,
} from './dashboard-data';

const QUERY_KEY = ['dashboard', 'home'] as const;
const percent = (broken: number, total: number) =>
  total > 0 ? Math.min(100, Math.round((broken / total) * 100)) : 0;
const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : '暂时无法读取仪表盘，请稍后重试';

function LoadingDashboard() {
  return (
    <div aria-label="正在加载仪表盘" className="space-y-6">
      <Skeleton className="h-40 rounded-card" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-32 rounded-card" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[208px_minmax(0,1fr)_320px]">
        <Skeleton className="h-80 rounded-card" />
        <Skeleton className="h-80 rounded-card" />
        <Skeleton className="h-80 rounded-card" />
      </div>
    </div>
  );
}

export default function HomePage() {
  const { runtime } = useAuth();
  const [country, setCountry] = useState<DashboardCountry>('ALL');
  const dashboard = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => getDashboard(runtime.http, signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  useEffect(
    () =>
      runtime.ws.onMessage((message) => {
        if (
          message.type === 'stats_update' ||
          (message.type === 'monitor_complete' && !message.isCompetitor)
        )
          void runtime.queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      }),
    [runtime],
  );
  const data = dashboard.data;
  const overview = data && countryOverview(data, country);
  const alerts = data ? alertsForCountry(data, country) : [];
  const activities = data ? activitiesForCountry(data, country) : [];
  const countryRows = data
    ? data.distribution.byCountry.filter(
        (row) => country === 'ALL' || row.country === country,
      )
    : [];
  return (
    <AppShell title="监控总览">
      <div className="space-y-6 lg:space-y-7">
        <section className="relative overflow-hidden rounded-card bg-ink px-6 py-7 text-white sm:px-8 sm:py-9">
          <div
            aria-hidden="true"
            className="absolute -top-20 right-0 size-72 rounded-full border border-white/10"
          />
          <div
            aria-hidden="true"
            className="absolute -right-20 -bottom-32 size-96 rounded-full border border-white/10"
          />
          <div className="relative flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="neo-mono mb-4 text-xs tracking-[.2em] text-signal">
                OVERVIEW / 监控工作台
              </p>
              <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
                把每一次
                <span className="mx-1 inline-block -rotate-2 rounded-chip bg-signal px-2 py-0.5 text-ink">
                  异常
                </span>
                看清楚
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-7 text-white/65">
                从站点概况到最新检查，集中查看正在记录的业务状态。
              </p>
            </div>
            <div className="flex items-center gap-3">
              {data && (
                <span className="neo-mono text-xs text-white/65">
                  更新于 {formatBeijing(dashboard.dataUpdatedAt, 'HH:mm:ss')}
                </span>
              )}
              <Button
                variant="secondary"
                size="small"
                pending={dashboard.isFetching}
                onClick={() => {
                  void dashboard.refetch();
                }}
              >
                <RefreshCw aria-hidden="true" /> 刷新
              </Button>
            </div>
          </div>
        </section>

        {dashboard.isPending && <LoadingDashboard />}
        {!data && dashboard.isError && (
          <section
            role="alert"
            className="rounded-card border border-status-danger/25 bg-status-danger-soft p-6"
          >
            <h2 className="font-bold text-status-danger">仪表盘暂不可用</h2>
            <p className="mt-2 text-sm text-status-danger">
              {errorText(dashboard.error)}
            </p>
            <Button
              variant="secondary"
              className="mt-5"
              onClick={() => {
                void dashboard.refetch();
              }}
            >
              重试加载
            </Button>
          </section>
        )}

        {data && overview && (
          <>
            {dashboard.isError && (
              <p
                role="status"
                className="rounded-control bg-status-warning-soft px-4 py-3 text-sm text-status-warning"
              >
                最新刷新失败，当前显示上一次成功读取的数据。
              </p>
            )}
            <section
              aria-label="关键指标"
              className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            >
              {[
                {
                  label: '监控变体组',
                  value: overview.totalGroups,
                  hint: '当前站点范围',
                  accent: 'bg-module-monitor',
                },
                {
                  label: '异常变体组',
                  value: overview.brokenGroups,
                  hint: '需要关注',
                  accent: 'bg-status-danger',
                },
                {
                  label: '管理中的 ASIN',
                  value: overview.totalASINs,
                  hint: '当前站点范围',
                  accent: 'bg-module-asin',
                },
                {
                  label: '今日检查',
                  value: overview.todayChecks,
                  hint: '按北京时间统计',
                  accent: 'bg-module-tasks',
                },
              ].map((metric) => (
                <div
                  key={metric.label}
                  className="rounded-card border border-border bg-card p-5 sm:p-6"
                >
                  <div className="mb-5 flex items-center justify-between">
                    <p className="text-sm font-medium text-muted-foreground">
                      {metric.label}
                    </p>
                    <span
                      aria-hidden="true"
                      className={'size-2 rounded-full ' + metric.accent}
                    />
                  </div>
                  <AnimatedNumber
                    value={metric.value}
                    className="text-3xl font-black tracking-tight sm:text-4xl"
                  />
                  <p className="mt-3 text-xs text-muted-foreground">
                    {metric.hint}
                  </p>
                </div>
              ))}
            </section>

            <div className="grid items-start gap-5 xl:grid-cols-[208px_minmax(0,1fr)_320px]">
              <section
                aria-label="站点筛选"
                className="rounded-card border border-border bg-card p-4"
              >
                <div className="mb-4 px-2">
                  <ModuleLabel module="monitor">站点筛选</ModuleLabel>
                </div>
                <div className="space-y-1">
                  {COUNTRIES.map(([code, label]) => {
                    const count =
                      code === 'ALL'
                        ? data.overview.totalGroups
                        : data.overview.overviewByCountry[code]?.totalGroups ??
                          0;
                    return (
                      <button
                        type="button"
                        key={code}
                        aria-pressed={country === code}
                        onClick={() => setCountry(code)}
                        className={
                          'flex min-h-11 w-full items-center justify-between rounded-control px-3 text-left text-sm transition-colors ' +
                          (country === code
                            ? 'bg-signal font-semibold text-ink'
                            : 'hover:bg-muted')
                        }
                      >
                        <span>{label}</span>
                        <span className="neo-mono text-xs opacity-65">
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section
                aria-labelledby="country-status-title"
                className="min-w-0 rounded-card border border-border bg-card p-5 sm:p-6"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <ModuleLabel module="monitor">站点态势</ModuleLabel>
                    <h2
                      id="country-status-title"
                      className="mt-3 text-xl font-bold"
                    >
                      变体组状态
                    </h2>
                  </div>
                  <span className="rounded-pill bg-muted px-3 py-1.5 text-xs text-muted-foreground">
                    {countryLabel(country)}
                  </span>
                </div>
                {countryRows.length === 0 ? (
                  <div className="mt-6">
                    <EmptyState
                      title="暂无站点数据"
                      description="当前站点范围没有可展示的变体组状态。"
                    />
                  </div>
                ) : (
                  <div className="mt-6 divide-y divide-border">
                    {countryRows.map((row) => {
                      const broken = Number(row.broken);
                      const ratio = percent(broken, row.total);
                      return (
                        <div
                          key={row.country}
                          className="grid grid-cols-[minmax(90px,1fr)_minmax(100px,2fr)_auto] items-center gap-3 py-4 first:pt-0 last:pb-0 sm:gap-5"
                        >
                          <div>
                            <p className="font-semibold">
                              {countryLabel(row.country)}
                            </p>
                            <p className="neo-mono mt-1 text-xs text-muted-foreground">
                              {row.country}
                            </p>
                          </div>
                          <div>
                            <div
                              className="h-2 overflow-hidden rounded-pill bg-muted"
                              role="meter"
                              aria-label={
                                countryLabel(row.country) + '异常比例'
                              }
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={ratio}
                            >
                              <div
                                className="h-full rounded-pill bg-status-danger"
                                style={{ width: ratio + '%' }}
                              />
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                              正常 {row.normal} · 异常 {broken}
                            </p>
                          </div>
                          <span className="neo-mono text-sm font-semibold">
                            {row.total}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section
                aria-labelledby="alerts-title"
                className="min-w-0 rounded-card border border-border bg-card p-5 sm:p-6"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <ModuleLabel module="monitor">实时告警</ModuleLabel>
                    <h2 id="alerts-title" className="mt-3 text-xl font-bold">
                      异常关注
                    </h2>
                  </div>
                  <span className="neo-mono rounded-pill bg-status-danger-soft px-3 py-1.5 text-xs font-semibold text-status-danger">
                    {alerts.length}
                  </span>
                </div>
                {alerts.length === 0 ? (
                  <div className="mt-5">
                    <EmptyState
                      title="暂无异常项"
                      description="当前站点范围没有出现在最近异常列表中的项目。"
                    />
                  </div>
                ) : (
                  <ul className="mt-5 max-h-[520px] divide-y divide-border overflow-y-auto">
                    {alerts.map(({ kind, row }, index) => (
                      <li
                        key={kind + ':' + alertText(row, 'id') + ':' + index}
                        className="py-4 first:pt-0"
                      >
                        <div className="flex items-center gap-2 text-xs text-status-danger">
                          <CircleAlert
                            aria-hidden="true"
                            className="size-3.5"
                          />
                          {kind}异常 · {countryLabel(alertText(row, 'country'))}
                        </div>
                        <p
                          className="mt-2 truncate text-sm font-semibold"
                          title={alertText(row, 'name')}
                        >
                          {alertText(row, 'name') ||
                            alertText(row, 'asin') ||
                            '未命名项目'}
                        </p>
                        {alertText(row, 'asin') && (
                          <p className="neo-mono mt-1 text-xs text-muted-foreground">
                            {alertText(row, 'asin')}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section
              aria-labelledby="activities-title"
              className="rounded-card border border-border bg-card p-5 sm:p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <ModuleLabel module="tasks">检查记录</ModuleLabel>
                  <h2 id="activities-title" className="mt-3 text-xl font-bold">
                    最近活动
                  </h2>
                </div>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Activity aria-hidden="true" className="size-4" />
                  最近 {activities.length} 条
                </span>
              </div>
              {activities.length === 0 ? (
                <div className="mt-5">
                  <EmptyState
                    title="暂无检查记录"
                    description="当前站点范围没有出现在最近活动列表中的记录。"
                  />
                </div>
              ) : (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[650px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th scope="col" className="pb-3 font-medium">
                          对象
                        </th>
                        <th scope="col" className="pb-3 font-medium">
                          站点
                        </th>
                        <th scope="col" className="pb-3 font-medium">
                          检查时间
                        </th>
                        <th scope="col" className="pb-3 text-right font-medium">
                          结果
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {activities.map((activity) => (
                        <tr key={activity.id} className="neo-row">
                          <td className="py-3.5 pr-4">
                            <p className="max-w-[350px] truncate font-medium">
                              {activity.asinName ||
                                activity.variantGroupName ||
                                activity.asin ||
                                '未知对象'}
                            </p>
                            <p className="neo-mono mt-1 text-xs text-muted-foreground">
                              {activity.asin ||
                                alertText(activity, 'asin_code') ||
                                activity.variant_group_id ||
                                '—'}
                            </p>
                          </td>
                          <td className="py-3.5 pr-4">
                            {activity.country
                              ? countryLabel(activity.country)
                              : '—'}
                          </td>
                          <td className="neo-mono py-3.5 pr-4 text-xs">
                            {activity.check_time
                              ? formatBeijing(
                                  activity.check_time,
                                  'MM-DD HH:mm',
                                )
                              : '—'}
                          </td>
                          <td className="py-3.5 text-right">
                            <StatusBadge
                              status={
                                activity.is_broken === 1 ||
                                activity.is_broken === true
                                  ? 'danger'
                                  : activity.is_broken === 0 ||
                                    activity.is_broken === false
                                  ? 'success'
                                  : 'unknown'
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-5 flex items-center gap-1 text-xs text-muted-foreground">
                列表展示仪表盘接口返回的最近记录；完整历史页面仍在迁移。
                <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </p>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
