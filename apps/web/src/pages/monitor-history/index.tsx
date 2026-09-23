import type {
  MonitorHistoryListQuery,
  MonitorHistoryRecord,
} from '@asin-monitor/contracts';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/context';
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
import { ApiError } from '../../lib/http';
import {
  getMonitorHistory,
  getMonitorHistoryDetail,
} from '../../services/monitor-history';
import {
  historyError,
  historyNotification,
  historyPageInfo,
  historyResultPreview,
  historyStatus,
  historyTime,
  historyWallTime,
} from './history-data';

const INITIAL_QUERY: MonitorHistoryListQuery = { current: 1, pageSize: 10 };
const PAGE_SIZES = [10, 20, 50] as const;
const TEXT_FILTERS = [
  { key: 'variantGroupId', label: '变体组 ID', max: 50 },
  { key: 'variantGroupName', label: '变体组名称', max: 255 },
  { key: 'asinId', label: 'ASIN ID', max: 50 },
  { key: 'asinName', label: 'ASIN 名称', max: 500 },
  { key: 'asinType', label: 'ASIN 类型', max: 50 },
  { key: 'country', label: '国家代码', max: 10 },
  { key: 'checkType', label: '检查类型', max: 50 },
] as const;
type TextKey = (typeof TEXT_FILTERS)[number]['key'];
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

function ErrorNotice({
  title,
  error,
  retry,
}: {
  title: string;
  error: unknown;
  retry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-control border border-status-danger/25 bg-status-danger-soft p-5 text-status-danger"
    >
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm">{historyError(error)}</p>
      <Button variant="secondary" size="small" className="mt-4" onClick={retry}>
        重试加载
      </Button>
    </div>
  );
}

function RecordTitle({ record }: { record: MonitorHistoryRecord }) {
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
    </div>
  );
}

function HistoryRows({
  rows,
  selectedId,
  select,
}: {
  rows: MonitorHistoryRecord[];
  selectedId: number | null;
  select: (id: number) => void;
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
                <RecordTitle record={record} />
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
                    <RecordTitle record={record} />
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

function HistoryDetail({ id, close }: { id: number; close: () => void }) {
  const { runtime } = useAuth();
  const detail = useQuery({
    queryKey: ['monitor-history', 'detail', id],
    queryFn: ({ signal }) => getMonitorHistoryDetail(runtime.http, id, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  const permissionDenied =
    detail.isError &&
    detail.error instanceof ApiError &&
    detail.error.status === 403;
  const record = permissionDenied ? undefined : detail.data;
  const result = record ? historyResultPreview(record) : null;
  return (
    <Card aria-label="监控历史详情">
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

export default function MonitorHistoryPage() {
  const { runtime } = useAuth();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [query, setQuery] = useState<MonitorHistoryListQuery>(INITIAL_QUERY);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const history = useQuery({
    queryKey: ['monitor-history', 'list', query],
    queryFn: ({ signal }) => getMonitorHistory(runtime.http, query, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  const permissionDenied =
    history.isError &&
    history.error instanceof ApiError &&
    history.error.status === 403;
  const data = permissionDenied ? undefined : history.data;
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
    setFilterError(null);
    setSelectedId(null);
    setQuery({
      ...Object.fromEntries(
        TEXT_FILTERS.map(({ key }) => [key, filters[key].trim() || undefined]),
      ),
      country: filters.country.trim().toUpperCase() || undefined,
      asin: filters.asin.trim() || undefined,
      isBroken: filters.isBroken || undefined,
      startTime,
      endTime,
      current: 1,
      pageSize: query.pageSize,
    });
  }
  function changePage(next: number) {
    setSelectedId(null);
    setQuery((previous) => ({ ...previous, current: next }));
  }
  return (
    <AppShell title="监控历史">
      <div className="space-y-6">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
          <ModuleLabel module="monitor">MONITOR / 主营历史</ModuleLabel>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-black tracking-tight">监控历史</h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-white/65">
                按
                ASIN、快照名称、状态与上海时间查找主营检查记录。详情按当前权限实时读取。
              </p>
            </div>
            <Button
              variant="secondary"
              size="small"
              pending={history.isFetching}
              onClick={() => {
                void history.refetch();
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
            description="筛选由服务器执行；多个 ASIN 可用逗号、空格或换行分隔。"
          />
          <CardContent>
            <form onSubmit={applyFilters} className="space-y-5">
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
                    onChange={(event) => setFilter('asin', event.target.value)}
                    placeholder="B012345678, B087654321"
                  />
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {TEXT_FILTERS.map(({ key, label, max }) => (
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
                    setSelectedId(null);
                    setFilterError(null);
                  }}
                >
                  清空筛选
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader
            title="检查记录"
            description={
              data
                ? `第 ${current} 页 · ${page?.count} · 当前页 ${data.list.length} 条`
                : '只读取当前权限可见的主营历史'
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
              <div aria-label="正在加载监控历史" className="space-y-3">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            )}
            {!data && history.isError && (
              <ErrorNotice
                title="监控历史暂不可用"
                error={history.error}
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
        {visibleSelectedId !== null && (
          <HistoryDetail
            id={visibleSelectedId}
            close={() => setSelectedId(null)}
          />
        )}
      </div>
    </AppShell>
  );
}
