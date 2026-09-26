import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  DatabaseZap,
  RefreshCw,
  ServerCog,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import {
  Card,
  CardContent,
  CardHeader,
  ModuleLabel,
} from '../../components/ui/surfaces';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import {
  clearAnalyticsCache,
  getOpsOverview,
  refreshAnalytics,
} from '../../services/ops';

const errorText = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : '暂时无法读取运维观测，请稍后重试。';

type RecordValue = Record<string, unknown>;
type Notice = { tone: 'success' | 'error'; message: string };
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const numberValue = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : '-';
const textValue = (value: unknown) =>
  typeof value === 'string' && value ? value : '-';

function ErrorNotice({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-control bg-status-danger-soft p-5 text-status-danger"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <div>
          <p className="font-semibold">运维概览不可用</p>
          <p className="mt-1 text-sm">{message}</p>
          <Button
            variant="secondary"
            size="small"
            className="mt-4"
            onClick={retry}
          >
            <RefreshCw aria-hidden="true" />
            重试加载
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function OpsPage() {
  const { runtime, announce } = useAuth();
  const identity = useIdentity();
  const current =
    identity.status === 'authenticated' ? identity.identity : undefined;
  const access = createAccess(current);
  const [action, setAction] = useState<'cache' | 'refresh' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const overview = useQuery({
    queryKey: ['ops-overview'],
    queryFn: ({ signal }) => getOpsOverview(runtime.http, signal),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const data = overview.data;
  const cache = record(data?.cache);
  const aggregate = record(data?.analyticsAgg);
  const monitorQueue = record(data?.queues.monitor);
  const competitorQueue = record(data?.queues.competitor);
  const prefixes = data?.analyticsCache.prefixes ?? [];

  async function runAction(kind: 'cache' | 'refresh') {
    if (!access.canWriteSettings || action) return;
    if (kind === 'cache' && !window.confirm('确认清理分析结果缓存？')) return;
    setAction(kind);
    setNotice(null);
    try {
      if (kind === 'cache') {
        await clearAnalyticsCache(runtime.http);
        setNotice({ tone: 'success', message: '分析缓存已清理。' });
        announce('分析缓存已清理');
      } else {
        if (
          !window.confirm(
            '确认刷新最近 2 天的小时分析聚合？执行期间可能影响聚合查询性能。',
          )
        ) {
          setAction(null);
          return;
        }
        await refreshAnalytics(runtime.http, { granularity: 'hour' });
        setNotice({ tone: 'success', message: '分析聚合刷新已完成。' });
        announce('分析聚合刷新已完成');
      }
      await overview.refetch();
    } catch (error) {
      setNotice({
        tone: 'error',
        message:
          error instanceof ApiError
            ? error.message
            : kind === 'cache'
            ? '清理分析缓存失败，请稍后重试。'
            : '刷新分析聚合失败，请稍后重试。',
      });
    } finally {
      setAction(null);
    }
  }

  return (
    <AppShell title="运维观测">
      <div className="space-y-6">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
          <ModuleLabel module="analytics">OPERATIONS / 运维观测</ModuleLabel>
          <h1 className="mt-4 text-3xl font-black tracking-tight">运行状态</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-white/65">
            查看 Neo API、队列、缓存和 Timescale 聚合状态，管理维护操作。
          </p>
        </section>
        {notice && (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={
              notice.tone === 'error'
                ? 'rounded-control bg-status-danger-soft p-4 text-sm text-status-danger'
                : 'rounded-control bg-status-success-soft p-4 text-sm text-status-success'
            }
          >
            {notice.message}
          </p>
        )}
        {overview.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-32 rounded-card" />
            ))}
          </div>
        ) : overview.isError ? (
          <ErrorNotice
            message={errorText(overview.error)}
            retry={() => void overview.refetch()}
          />
        ) : data ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Card>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      进程角色
                    </span>
                    <ServerCog className="size-5 text-module-analytics" />
                  </div>
                  <p className="mt-4 text-2xl font-black">{data.processRole}</p>
                  <StatusBadge
                    status={data.schedulerEnabled ? 'success' : 'warning'}
                  >
                    {data.schedulerEnabled ? '调度已启用' : '调度未启用'}
                  </StatusBadge>
                </CardContent>
              </Card>
              <Card>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      分析缓存
                    </span>
                    <DatabaseZap className="size-5 text-module-analytics" />
                  </div>
                  <p className="neo-mono mt-4 text-2xl font-black">
                    {numberValue(cache.activeEntries)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">活动条目</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      监控队列等待
                    </span>
                    <Activity className="size-5 text-module-monitor" />
                  </div>
                  <p className="neo-mono mt-4 text-2xl font-black">
                    {numberValue(record(monitorQueue.counts).waiting)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    BullMQ 等待任务
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      聚合刷新
                    </span>
                    <Workflow className="size-5 text-module-analytics" />
                  </div>
                  <p className="mt-4 text-2xl font-black">
                    {aggregate.isRefreshing === true ? '执行中' : '空闲'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {aggregate.enabled === true ? '聚合已启用' : '聚合未启用'}
                  </p>
                </CardContent>
              </Card>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card>
                <CardHeader
                  title="缓存与聚合"
                  description="状态数据每 30 秒自动刷新。"
                  action={
                    <Button
                      variant="ghost"
                      size="small"
                      pending={overview.isFetching}
                      onClick={() => void overview.refetch()}
                    >
                      <RefreshCw aria-hidden="true" />
                      刷新概览
                    </Button>
                  }
                />
                <CardContent className="space-y-4 text-sm">
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        缓存前缀
                      </dt>
                      <dd className="mt-1 break-words">
                        {prefixes.join(', ') || '-'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        上次清理
                      </dt>
                      <dd className="mt-1">
                        {textValue(data.analyticsCache.lastClearedAt) === '-'
                          ? '-'
                          : formatBeijing(data.analyticsCache.lastClearedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        监控队列总数
                      </dt>
                      <dd className="neo-mono mt-1">
                        {numberValue(record(monitorQueue.counts).total)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        竞品队列等待
                      </dt>
                      <dd className="neo-mono mt-1">
                        {numberValue(record(competitorQueue.counts).waiting)}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-3 border-t border-border pt-4">
                    <Button
                      variant="secondary"
                      pending={action === 'cache'}
                      disabled={!access.canWriteSettings || Boolean(action)}
                      onClick={() => void runAction('cache')}
                    >
                      <Trash2 aria-hidden="true" />
                      清理分析缓存
                    </Button>
                    <Button
                      pending={action === 'refresh'}
                      disabled={
                        !access.canWriteSettings ||
                        Boolean(action) ||
                        aggregate.enabled === false
                      }
                      onClick={() => void runAction('refresh')}
                    >
                      <RefreshCw aria-hidden="true" />
                      刷新聚合
                    </Button>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader
                  title="Worker 配置与队列"
                  description="当前启用配置和队列状态。"
                />
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {data.workerRegisteredQueues.map((queue) => (
                      <span
                        key={queue}
                        className="rounded-pill bg-muted px-3 py-1.5 text-xs font-medium"
                      >
                        {queue}
                      </span>
                    ))}
                  </div>
                  <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        监控队列状态
                      </dt>
                      <dd className="mt-1">
                        {monitorQueue.isPaused === true ? '已暂停' : '运行中'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        竞品队列状态
                      </dt>
                      <dd className="mt-1">
                        {competitorQueue.isPaused === true
                          ? '已暂停'
                          : '运行中'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">调度器</dt>
                      <dd className="mt-1">
                        {data.schedulerEnabled ? '已启用' : '未启用'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        缓存总条目
                      </dt>
                      <dd className="neo-mono mt-1">
                        {numberValue(cache.totalEntries)}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </div>
          </>
        ) : (
          <EmptyState
            title="暂无运维状态"
            description="刷新后重新读取 Neo 运行状态。"
          />
        )}
      </div>
    </AppShell>
  );
}
