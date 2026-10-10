import type {
  MonitorHistoryListQuery,
  MonitorHistoryRecord,
  MonitorStatusIntervalData,
} from '@asin-monitor/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import { Field, Input, Textarea } from '../../components/ui/field';
import {
  Card,
  CardContent,
  CardHeader,
  ModuleLabel,
} from '../../components/ui/surfaces';
import { ApiError, type HttpClient } from '../../lib/http';
import {
  abnormalDurationPath,
  type AbnormalDurationScope,
} from '../../services/monitor-abnormal';
import { HistoryAbnormal } from './history-abnormal';
import { historyAbnormalScope } from './history-abnormal-data';
import {
  createHistoryReadAccess,
  type HistoryReadAccess,
} from './history-access';
import { historyAnalyticsAdmission } from './history-analytics-admission';
import {
  historyError,
  historyHasIntervalWindow,
  historyIntervalPosition,
  historyLinkFilter,
  historyNotification,
  historyPageInfo,
  historyResultPreview,
  historyStatus,
  historyTime,
  historyWallTime,
} from './history-data';
import type { HistorySource, TextKey } from './history-sources';
import { HistoryStatistics } from './history-statistics';
import { historyStatisticsQueries } from './history-statistics-query';

const INITIAL_QUERY: MonitorHistoryListQuery = { current: 1, pageSize: 10 };
const PAGE_SIZES = [10, 20, 50] as const;
type Filters = Record<TextKey, string> & {
  asin: string;
  isBroken: string;
  startTime: string;
  endTime: string;
};
const EMPTY_FILTERS: Filters = {
  variantGroupId: '',
  variantGroupName: '',
  asinId: '',
  asinName: '',
  asinType: '',
  country: '',
  checkType: '',
  asin: '',
  isBroken: '',
  startTime: '',
  endTime: '',
};

function historyLinkState(search: string): {
  filters: Filters;
  query: MonitorHistoryListQuery;
} {
  const link = historyLinkFilter(search);
  const scope = link ? { [link.key]: link.id } : {};
  return {
    filters: { ...EMPTY_FILTERS, ...scope },
    query: { ...INITIAL_QUERY, ...scope },
  };
}

function ErrorNotice({
  title,
  error,
  retry,
  subject,
}: {
  title: string;
  error: unknown;
  retry: () => void;
  subject: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-control border border-status-danger/25 bg-status-danger-soft p-5 text-status-danger"
    >
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm">{historyError(error, subject)}</p>
      <Button variant="secondary" size="small" className="mt-4" onClick={retry}>
        重试加载
      </Button>
    </div>
  );
}

export function StatusIntervalTimeline({
  data,
  windowStart,
  windowEnd,
  pending,
  changePage,
}: {
  data: MonitorStatusIntervalData;
  windowStart: string;
  windowEnd: string;
  pending: boolean;
  changePage: (current: number) => void;
}) {
  if (data.coverage === 'stale')
    return (
      <p
        role="status"
        className="rounded-control bg-status-warning-soft p-3 text-sm text-status-warning"
      >
        状态区间尚未覆盖当前时间范围，暂不展示可能不完整的时间轴；检查记录列表仍可用。
      </p>
    );
  return (
    <div className="space-y-3" aria-label="状态区间时间轴">
      {!data.list.length && (
        <EmptyState
          title="暂无状态区间"
          description="当前时间范围没有可展示的区间。"
        />
      )}
      {data.list.map((interval) => (
        <div
          key={`${interval.country}:${interval.asinKey}:${interval.intervalStart}`}
          className="grid gap-2 rounded-control border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,2fr)] sm:items-center"
        >
          <div className="min-w-0 text-xs">
            <p className="truncate font-semibold">
              {interval.asinName ||
                interval.asinCode ||
                interval.asinId ||
                interval.asinKey}
            </p>
            <p className="text-muted-foreground">
              {interval.country} · {historyTime(interval.intervalStart)} 至{' '}
              {interval.intervalEnd
                ? historyTime(interval.intervalEnd)
                : '仍在持续'}
            </p>
            <span>{interval.isBroken ? '异常' : '正常'}</span>
          </div>
          <div
            className="relative h-3 overflow-hidden rounded-full bg-muted"
            aria-hidden="true"
          >
            {(() => {
              const position = historyIntervalPosition(
                interval.intervalStart,
                interval.intervalEnd,
                windowStart,
                windowEnd,
              );
              return position ? (
                <div
                  className={`absolute h-full ${
                    interval.isBroken ? 'bg-status-danger' : 'bg-status-success'
                  }`}
                  style={position}
                />
              ) : null;
            })()}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p role="status">
          第 {data.current} 页 · 共 {data.total} 个区间 · 每页 {data.pageSize}{' '}
          条
        </p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="small"
            disabled={pending || data.current <= 1}
            onClick={() => changePage(data.current - 1)}
          >
            上一页区间
          </Button>
          <Button
            variant="secondary"
            size="small"
            disabled={pending || data.current * data.pageSize >= data.total}
            onClick={() => changePage(data.current + 1)}
          >
            下一页区间
          </Button>
        </div>
      </div>
    </div>
  );
}

function RecordTitle({
  record,
  competitor,
}: {
  record: MonitorHistoryRecord;
  competitor: boolean;
}) {
  const group = record.variantGroupName ?? record.variant_group_name;
  const asinName = record.asinName ?? record.asin_name;
  return (
    <div className="min-w-0">
      <p className="truncate font-semibold">
        {group || asinName || '未命名记录'}
      </p>
      {group && asinName && group !== asinName && (
        <p className="truncate text-xs text-muted-foreground">{asinName}</p>
      )}
      <p className="neo-mono mt-1 break-all text-xs text-muted-foreground">
        {record.asin ||
          record.asin_id ||
          record.variant_group_id ||
          `#${record.id}`}
      </p>
      {competitor && (
        <p className="mt-1 break-all text-xs text-muted-foreground">
          父 ASIN：{parentAsin(record)}
        </p>
      )}
    </div>
  );
}

function parentAsin(record: MonitorHistoryRecord): string {
  return 'parentAsin' in record &&
    typeof record.parentAsin === 'string' &&
    record.parentAsin
    ? record.parentAsin
    : '未记录';
}

function HistoryRows({
  rows,
  selectedId,
  select,
  competitor,
}: {
  rows: MonitorHistoryRecord[];
  selectedId: number | null;
  select: (id: number) => void;
  competitor: boolean;
}) {
  return (
    <>
      <div className="space-y-3 lg:hidden">
        {rows.map((record) => {
          const status = historyStatus(record);
          return (
            <article
              key={record.id}
              className="rounded-control border border-border p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <RecordTitle record={record} competitor={competitor} />
                <StatusBadge status={status.badge}>{status.label}</StatusBadge>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">检查时间</dt>
                  <dd>{historyTime(record.checkTime ?? record.check_time)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">国家</dt>
                  <dd>{record.country || '未记录'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">检查类型</dt>
                  <dd>{record.checkType ?? record.check_type ?? '未记录'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">通知</dt>
                  <dd>{historyNotification(record)}</dd>
                </div>
              </dl>
              <Button
                variant="secondary"
                size="small"
                className="mt-4"
                aria-expanded={selectedId === record.id}
                onClick={() => select(record.id)}
              >
                {selectedId === record.id ? '收起详情' : '查看详情'}
              </Button>
            </article>
          );
        })}
      </div>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="p-3">名称快照 / ASIN</th>
              <th className="p-3">检查时间</th>
              <th className="p-3">类型 / 国家</th>
              <th className="p-3">状态</th>
              <th className="p-3">通知</th>
              <th className="p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((record) => {
              const status = historyStatus(record);
              return (
                <tr
                  key={record.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="max-w-64 p-3">
                    <RecordTitle record={record} competitor={competitor} />
                  </td>
                  <td className="neo-mono whitespace-nowrap p-3 text-xs">
                    {historyTime(record.checkTime ?? record.check_time)}
                  </td>
                  <td className="p-3">
                    {record.checkType ?? record.check_type ?? '未记录'}
                    <span className="block text-xs text-muted-foreground">
                      {record.country || '未记录'}
                    </span>
                  </td>
                  <td className="p-3">
                    <StatusBadge status={status.badge}>
                      {status.label}
                    </StatusBadge>
                  </td>
                  <td className="p-3">{historyNotification(record)}</td>
                  <td className="p-3">
                    <Button
                      variant="secondary"
                      size="small"
                      aria-expanded={selectedId === record.id}
                      onClick={() => select(record.id)}
                    >
                      {selectedId === record.id ? '收起' : '详情'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HistoryDetail({
  id,
  close,
  source,
  readAccess,
  owner,
}: {
  id: number;
  close: () => void;
  source: HistorySource;
  readAccess: HistoryReadAccess;
  owner: string;
}) {
  const { runtime } = useAuth();
  const detail = useQuery({
    queryKey: [source.key, 'detail', id, owner],
    queryFn: ({ signal }) =>
      readAccess.read(() => source.getDetail(runtime.http, id, signal), signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  const inaccessible =
    detail.isError &&
    detail.error instanceof ApiError &&
    [401, 403, 404].includes(detail.error.status ?? 0);
  const record = inaccessible ? undefined : detail.data;
  const result = record ? historyResultPreview(record) : null;
  return (
    <Card aria-label={`${source.title}详情`}>
      <CardHeader
        title={`历史详情 #${id}`}
        description="按当前登录身份读取；这里只展示有限长度的检查结果。"
        action={
          <Button variant="ghost" size="small" onClick={close}>
            关闭
          </Button>
        }
      />
      <CardContent className="space-y-5">
        {detail.isPending && (
          <div aria-label="正在加载历史详情" className="space-y-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-32" />
          </div>
        )}
        {!record && detail.isError && (
          <ErrorNotice
            title="详情暂不可用"
            error={detail.error}
            subject={source.title}
            retry={() => {
              void detail.refetch();
            }}
          />
        )}
        {record && (
          <>
            {detail.isError && (
              <p
                role="status"
                className="rounded-control bg-status-warning-soft p-3 text-sm text-status-warning"
              >
                刷新失败，当前展示上一次成功读取的详情。
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-lg font-bold">
                {record.variantGroupName ??
                  record.variant_group_name ??
                  record.asinName ??
                  record.asin_name ??
                  '未命名记录'}
              </h3>
              <StatusBadge status={historyStatus(record).badge}>
                {historyStatus(record).label}
              </StatusBadge>
            </div>
            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {(
                [
                  [
                    '检查时间',
                    historyTime(record.checkTime ?? record.check_time),
                  ],
                  [
                    '创建时间',
                    historyTime(record.createTime ?? record.create_time),
                  ],
                  ['变体组 ID', record.variant_group_id || '未记录'],
                  [
                    '变体组名称',
                    record.variantGroupName ??
                      record.variant_group_name ??
                      '未记录',
                  ],
                  ['ASIN ID', record.asin_id || '未记录'],
                  ['ASIN', record.asin || '未记录'],
                  ...(source.competitor
                    ? ([['父 ASIN', parentAsin(record)]] as const)
                    : []),
                  [
                    'ASIN 名称',
                    record.asinName ?? record.asin_name ?? '未记录',
                  ],
                  [
                    'ASIN 类型',
                    String(record.asinType ?? record.asin_type ?? '未记录'),
                  ],
                  ['国家', record.country || '未记录'],
                  [
                    '检查类型',
                    record.checkType ?? record.check_type ?? '未记录',
                  ],
                  ['通知', historyNotification(record)],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {result && (
              <section
                aria-label="检查结果预览"
                className="rounded-control bg-muted/55 p-4"
              >
                <h4 className="text-sm font-semibold">检查结果预览</h4>
                <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs leading-5">
                  {result.text}
                </pre>
                {result.truncated && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    结果较长，仅展示前 4000 字符。
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function HistoryBrowser({ source }: { source: HistorySource }) {
  const auth = useIdentity();
  if (
    auth.status !== 'authenticated' ||
    !createAccess(auth.identity).canReadMonitor
  )
    return null;
  const owner = JSON.stringify([
    auth.identity.user.id,
    auth.identity.sessionId ?? null,
  ]);
  return (
    <HistoryBrowserSession
      key={`${source.key}:${owner}`}
      source={source}
      owner={owner}
    />
  );
}

function HistoryBrowserSession({
  source,
  owner,
}: {
  source: HistorySource;
  owner: string;
}) {
  const { runtime } = useAuth();
  const analytics = historyAnalyticsAdmission(runtime.http);
  const [readAccess] = useState(createHistoryReadAccess);
  const readAnalytics = <T,>(
    signal: AbortSignal,
    load: (http: Pick<HttpClient, 'request'>) => Promise<T>,
  ) =>
    analytics.read(signal, (http) => {
      const snapshot = readAccess.getSnapshot();
      if (snapshot.denial && !snapshot.recovering) throw snapshot.denial;
      return readAccess.read(() => load(http), signal);
    });
  const access = useSyncExternalStore(
    readAccess.subscribe,
    readAccess.getSnapshot,
    readAccess.getSnapshot,
  );
  const search = useRouterState({
    select: (state) => state.location.searchStr,
  });
  const [initialState] = useState(() => historyLinkState(search));
  const [filters, setFilters] = useState<Filters>(initialState.filters);
  const [query, setQuery] = useState<MonitorHistoryListQuery>(
    initialState.query,
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [intervalPage, setIntervalPage] = useState(1);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [abnormalScope, setAbnormalScope] =
    useState<AbnormalDurationScope | null>(null);
  const [abnormalScopeError, setAbnormalScopeError] = useState<ApiError | null>(
    null,
  );
  const previousSearch = useRef(search);
  useEffect(() => {
    if (previousSearch.current === search) return;
    previousSearch.current = search;
    const next = historyLinkState(search);
    setFilters(next.filters);
    setQuery(next.query);
    setIntervalPage(1);
    setSelectedId(null);
    setFilterError(null);
    setAbnormalScope(null);
    setAbnormalScopeError(null);
  }, [search]);
  const history = useQuery({
    queryKey: [source.key, 'list', query, owner],
    queryFn: ({ signal }) =>
      readAccess.read(
        () => source.getList(runtime.http, query, signal),
        signal,
      ),
    enabled: !access.denial,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  const intervalQuery =
    source.getIntervals &&
    query.startTime &&
    query.endTime &&
    historyHasIntervalWindow(query.startTime, query.endTime)
      ? {
          country: query.country,
          variantGroupId: query.variantGroupId,
          asinId: query.asinId,
          startTime: query.startTime,
          endTime: query.endTime,
          current: intervalPage,
          pageSize: 50,
        }
      : null;
  const intervals = useQuery({
    queryKey: [source.key, 'status-intervals', intervalQuery, owner],
    queryFn: ({ signal }) =>
      readAccess.read(
        () => source.getIntervals!(runtime.http, intervalQuery!, signal),
        signal,
      ),
    enabled: intervalQuery !== null && !access.denial,
    staleTime: 0,
    gcTime: 0,
  });
  const statisticQueries = historyStatisticsQueries(query);
  const statistics = useQuery({
    queryKey: [source.key, 'statistics', statisticQueries.statistics, owner],
    queryFn: ({ signal }) =>
      readAnalytics(signal, (http) =>
        source.getStatistics!(http, statisticQueries.statistics, signal),
      ),
    enabled: Boolean(source.getStatistics) && !access.denial,
    staleTime: 0,
    gcTime: 0,
  });
  const peakHours = useQuery({
    queryKey: [source.key, 'peak-hours', statisticQueries.peakHours, owner],
    queryFn: ({ signal }) =>
      readAnalytics(signal, (http) =>
        source.getPeakHours!(http, statisticQueries.peakHours!, signal),
      ),
    enabled:
      Boolean(source.getPeakHours && statisticQueries.peakHours) &&
      !access.denial,
    staleTime: 0,
    gcTime: 0,
  });
  const abnormal = useQuery({
    queryKey: [source.key, 'abnormal-duration', abnormalScope, owner],
    queryFn: ({ signal }) =>
      readAnalytics(signal, (http) =>
        source.getAbnormal!(http, abnormalScope!, signal),
      ),
    enabled:
      Boolean(source.getAbnormal && abnormalScope) &&
      !abnormalScopeError &&
      !access.denial,
    staleTime: 0,
    gcTime: 0,
  });
  useEffect(() => {
    if (!access.denial) return;
    setSelectedId(null);
    void runtime.queryClient.cancelQueries({ queryKey: [source.key] });
    runtime.queryClient.removeQueries({ queryKey: [source.key] });
  }, [access.denial, runtime.queryClient, source.key]);
  const data = access.denial ? undefined : history.data;
  const page = data ? historyPageInfo(data) : null;
  const current = data?.current ?? query.current ?? 1;
  const visibleSelectedId =
    selectedId !== null && data?.list.some((record) => record.id === selectedId)
      ? selectedId
      : null;

  function setFilter(key: keyof Filters, value: string) {
    setFilters((previous) => ({ ...previous, [key]: value }));
  }
  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startTime = historyWallTime(filters.startTime);
    const endTime = historyWallTime(filters.endTime);
    if (
      (filters.startTime && !startTime) ||
      (filters.endTime && !endTime) ||
      (startTime && endTime && startTime > endTime)
    ) {
      setFilterError('请输入有效的上海时间范围，结束时间应不早于开始时间。');
      return;
    }
    const nextQuery: MonitorHistoryListQuery = {
      ...Object.fromEntries(
        source.textFilters.map(({ key }) => [
          key,
          filters[key].trim() || undefined,
        ]),
      ),
      country: filters.country.trim().toUpperCase() || undefined,
      asin: filters.asin.trim() || undefined,
      isBroken: filters.isBroken || undefined,
      startTime,
      endTime,
      current: 1,
      pageSize: query.pageSize,
    };
    const nextAbnormalScope = source.getAbnormal
      ? historyAbnormalScope(filters, startTime, endTime)
      : null;
    try {
      runtime.http.url(source.path, nextQuery);
    } catch {
      setFilterError(
        '筛选条件无法组成有效请求地址，请减少 ASIN 或其他筛选项。',
      );
      return;
    }
    setFilterError(null);
    let nextAbnormalError: ApiError | null = null;
    if (nextAbnormalScope) {
      try {
        runtime.http.url(abnormalDurationPath(nextAbnormalScope));
      } catch {
        nextAbnormalError = new ApiError(
          'INVALID_INPUT',
          '异常时长统计请求地址过长或无效，请减少 ASIN 或其他筛选项后查询。',
        );
      }
    }
    setSelectedId(null);
    setQuery(nextQuery);
    setIntervalPage(1);
    setAbnormalScope(nextAbnormalScope);
    setAbnormalScopeError(nextAbnormalError);
  }
  function changePage(next: number) {
    setSelectedId(null);
    setQuery((previous) => ({ ...previous, current: next }));
  }
  if (access.denial)
    return (
      <AppShell title={source.title}>
        <div
          role="alert"
          className="space-y-3 rounded-control border border-status-danger/25 bg-status-danger-soft p-5 text-status-danger"
        >
          <h1 className="font-semibold">读取权限需要重新确认</h1>
          <p className="text-sm">
            历史记录、统计、状态区间和详情已隐藏。请确认当前账号权限后重新读取。
          </p>
          {access.recoveryFailed && (
            <p role="status" className="text-sm">
              重新验证或读取未完成，旧数据继续隐藏，请稍后重试。
            </p>
          )}
          <Button
            variant="secondary"
            pending={access.recovering}
            onClick={() => {
              const readers: (() => Promise<unknown>)[] = [
                async () => {
                  const result = await history.refetch({ throwOnError: true });
                  if (!result.isSuccess) throw result.error;
                  return result.data;
                },
              ];
              if (intervalQuery) {
                readers.push(async () => {
                  try {
                    const result = await intervals.refetch({
                      throwOnError: true,
                    });
                    if (!result.isSuccess) throw result.error;
                    return result.data;
                  } catch (error) {
                    // A deliberate feature-disabled response has no interval
                    // data to authorize; the fresh history read still proves
                    // access. Other failures keep all previous data hidden.
                    if (
                      error instanceof ApiError &&
                      error.status === 503 &&
                      error.message ===
                        '状态区间读取已关闭，请联系管理员启用后再试'
                    )
                      return;
                    throw error;
                  }
                });
              }
              if (source.getStatistics)
                readers.push(async () => {
                  const result = await statistics.refetch({
                    throwOnError: true,
                  });
                  if (!result.isSuccess) throw result.error;
                  return result.data;
                });
              if (source.getPeakHours && statisticQueries.peakHours)
                readers.push(async () => {
                  const result = await peakHours.refetch({
                    throwOnError: true,
                  });
                  if (!result.isSuccess) throw result.error;
                  return result.data;
                });
              if (source.getAbnormal && abnormalScope && !abnormalScopeError)
                readers.push(async () => {
                  const result = await abnormal.refetch({ throwOnError: true });
                  if (!result.isSuccess) throw result.error;
                  return result.data;
                });
              void readAccess.recover(readers);
            }}
          >
            重新验证并读取
          </Button>
        </div>
      </AppShell>
    );
  return (
    <AppShell title={source.title}>
      <div className="space-y-6">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
          <ModuleLabel module={source.module}>{source.eyebrow}</ModuleLabel>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-black tracking-tight">
                {source.title}
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-white/65">
                {source.description}
              </p>
            </div>
            <Button
              variant="secondary"
              size="small"
              pending={
                history.isFetching ||
                statistics.isFetching ||
                peakHours.isFetching ||
                abnormal.isFetching
              }
              onClick={() => {
                void history.refetch();
                if (source.getStatistics) void statistics.refetch();
                if (source.getPeakHours && statisticQueries.peakHours)
                  void peakHours.refetch();
                if (source.getAbnormal && abnormalScope && !abnormalScopeError)
                  void abnormal.refetch();
              }}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
          </div>
        </section>
        <Card>
          <CardHeader
            title="筛选历史"
            description={source.filtersDescription}
          />
          <CardContent>
            <form onSubmit={applyFilters} className="space-y-5">
              {source.competitor ? (
                <Field
                  label="ASIN 匹配模式"
                  hint="单个 LIKE 模式，最多 200 字符；% 和 _ 是通配符。"
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={filters.asin}
                      maxLength={200}
                      onChange={(event) =>
                        setFilter('asin', event.target.value)
                      }
                      placeholder="B012345678 或 B012%"
                    />
                  )}
                </Field>
              ) : (
                <Field
                  label="ASIN（支持多值）"
                  hint="最多 1000 个 ASIN；每个不超过 200 字符。"
                >
                  {(control) => (
                    <Textarea
                      {...control}
                      value={filters.asin}
                      maxLength={21000}
                      rows={2}
                      onChange={(event) =>
                        setFilter('asin', event.target.value)
                      }
                      placeholder="B012345678, B087654321"
                    />
                  )}
                </Field>
              )}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {source.textFilters.map(({ key, label, max }) => (
                  <Field key={key} label={label}>
                    {(control) => (
                      <Input
                        {...control}
                        value={filters[key]}
                        maxLength={max}
                        onChange={(event) => setFilter(key, event.target.value)}
                      />
                    )}
                  </Field>
                ))}
                <Field label="异常状态">
                  {(control) => (
                    <select
                      {...control}
                      className="w-full rounded-input border border-input bg-card px-4 py-3 text-sm"
                      value={filters.isBroken}
                      onChange={(event) =>
                        setFilter('isBroken', event.target.value)
                      }
                    >
                      <option value="">全部</option>
                      <option value="1">异常</option>
                      <option value="0">正常</option>
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
                        setFilter('startTime', event.target.value)
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
                        setFilter('endTime', event.target.value)
                      }
                    />
                  )}
                </Field>
              </div>
              {filterError && (
                <p role="alert" className="text-sm text-status-danger">
                  {filterError}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="submit">
                  <Search aria-hidden="true" />
                  查询
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFilters(EMPTY_FILTERS);
                    setQuery(INITIAL_QUERY);
                    setIntervalPage(1);
                    setSelectedId(null);
                    setFilterError(null);
                    setAbnormalScope(null);
                    setAbnormalScopeError(null);
                  }}
                >
                  清空筛选
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        {source.getStatistics && source.getPeakHours && (
          <HistoryStatistics
            statistics={statistics}
            peakHours={peakHours}
            queries={statisticQueries}
            retryStatistics={() => {
              void statistics.refetch();
            }}
            retryPeakHours={() => {
              void peakHours.refetch();
            }}
          />
        )}
        {source.getAbnormal && abnormalScope && (
          <HistoryAbnormal
            key={JSON.stringify(abnormalScope)}
            scope={abnormalScope}
            query={
              abnormalScopeError
                ? {
                    data: undefined,
                    isPending: false,
                    isFetching: false,
                    isError: true,
                    error: abnormalScopeError,
                  }
                : abnormal
            }
            retry={
              abnormalScopeError
                ? undefined
                : () => {
                    void abnormal.refetch();
                  }
            }
          />
        )}
        <Card>
          <CardHeader
            title="检查记录"
            description={
              data
                ? `第 ${current} 页 · ${page?.count} · 当前页 ${data.list.length} 条`
                : source.listDescription
            }
            action={
              <label className="flex items-center gap-2 text-xs">
                每页{' '}
                <select
                  aria-label="每页数量"
                  className="rounded-control border border-input bg-card px-3 py-2"
                  value={query.pageSize ?? 10}
                  onChange={(event) => {
                    setSelectedId(null);
                    setQuery((previous) => ({
                      ...previous,
                      current: 1,
                      pageSize: Number(event.target.value),
                    }));
                  }}
                >
                  {PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>{' '}
                条
              </label>
            }
          />
          <CardContent className="space-y-5">
            {history.isPending && (
              <div aria-label={`正在加载${source.title}`} className="space-y-3">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            )}
            {!data && history.isError && (
              <ErrorNotice
                title={`${source.title}暂不可用`}
                error={history.error}
                subject={source.title}
                retry={() => {
                  void history.refetch();
                }}
              />
            )}
            {data && (
              <>
                {history.isError && (
                  <p
                    role="status"
                    className="rounded-control bg-status-warning-soft p-3 text-sm text-status-warning"
                  >
                    刷新失败，当前展示上一次成功读取的历史。
                  </p>
                )}
                {data.list.length === 0 ? (
                  <EmptyState
                    title="暂无匹配记录"
                    description="请调整时间、ASIN 或状态筛选后重试。"
                  />
                ) : (
                  <HistoryRows
                    rows={data.list}
                    selectedId={selectedId}
                    competitor={source.competitor}
                    select={(id) =>
                      setSelectedId(selectedId === id ? null : id)
                    }
                  />
                )}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm">
                  <span className="text-muted-foreground">
                    第 {current} 页 · {page?.count}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={current <= 1}
                      onClick={() => changePage(current - 1)}
                    >
                      <ChevronLeft aria-hidden="true" />
                      上一页
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={!page?.canNext}
                      onClick={() => changePage(current + 1)}
                    >
                      下一页
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        {source.getIntervals && (
          <Card>
            <CardHeader
              title="状态区间时间轴"
              description="选择时间范围后，按国家、变体组 ID 和 ASIN ID 显示已完整核对的区间；其他检查记录筛选不应用于时间轴。"
              action={
                <Button
                  variant="secondary"
                  size="small"
                  disabled={intervalQuery === null || intervals.isFetching}
                  pending={intervals.isFetching}
                  onClick={() => {
                    void intervals.refetch();
                  }}
                >
                  <RefreshCw aria-hidden="true" />
                  刷新时间轴
                </Button>
              }
            />
            <CardContent>
              {intervalQuery === null ? (
                <p className="text-sm text-muted-foreground">
                  选择开始和结束时间后读取状态区间；结束时间须晚于开始时间。相同时间仍可查询检查记录。
                </p>
              ) : intervals.isPending ? (
                <Skeleton className="h-20" />
              ) : intervals.isError ? (
                <ErrorNotice
                  title="状态区间暂不可用"
                  error={intervals.error}
                  subject="状态区间"
                  retry={() => {
                    void intervals.refetch();
                  }}
                />
              ) : intervals.data ? (
                <StatusIntervalTimeline
                  data={intervals.data}
                  windowStart={intervalQuery!.startTime}
                  windowEnd={intervalQuery!.endTime}
                  pending={intervals.isFetching}
                  changePage={setIntervalPage}
                />
              ) : null}
            </CardContent>
          </Card>
        )}
        {visibleSelectedId !== null && (
          <HistoryDetail
            id={visibleSelectedId}
            source={source}
            readAccess={readAccess}
            owner={owner}
            close={() => setSelectedId(null)}
          />
        )}
      </div>
    </AppShell>
  );
}
