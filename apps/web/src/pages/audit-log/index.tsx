import type {
  NeoAuditLog,
  NeoAuditLogListQuery,
} from '@asin-monitor/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ScrollText,
  Search,
} from 'lucide-react';
import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import { Field, Input } from '../../components/ui/field';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { ApiError } from '../../lib/http';
import { getAuditLogDetail, getAuditLogs } from '../../services/audit-log';
import { historyWallTime } from '../monitor-history/history-data';
import {
  auditAccessError,
  auditAccessReducer,
  auditAction,
  auditDeletedDetailError,
  auditError,
  auditResource,
  auditResponseStatus,
  auditTime,
  auditVisibleDetail,
  auditVisibleList,
} from './audit-data';

const INITIAL_QUERY: NeoAuditLogListQuery = { current: 1, pageSize: 10 };
const PAGE_SIZES = [10, 20, 50, 100] as const;
const TEXT_FILTERS = [
  { key: 'userId', label: '用户 ID', max: 50 },
  { key: 'username', label: '用户名', max: 50 },
  { key: 'action', label: '操作类型', max: 50 },
  { key: 'resource', label: '资源类型', max: 100 },
  { key: 'resourceId', label: '资源 ID', max: 50 },
] as const;
type FilterKey = (typeof TEXT_FILTERS)[number]['key'];
type Filters = Record<FilterKey, string> & {
  startTime: string;
  endTime: string;
};
const EMPTY_FILTERS: Filters = {
  userId: '',
  username: '',
  action: '',
  resource: '',
  resourceId: '',
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
      <p className="mt-2 text-sm">{auditError(error)}</p>
      <Button variant="secondary" size="small" className="mt-4" onClick={retry}>
        重试加载
      </Button>
    </div>
  );
}

function AuditIdentity({ row }: { row: NeoAuditLog }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-semibold">{row.username || '未知用户'}</p>
      <p className="neo-mono mt-1 break-all text-xs text-muted-foreground">
        {row.userId || '未记录用户 ID'}
      </p>
    </div>
  );
}

function AuditRows({
  rows,
  selectedId,
  select,
}: {
  rows: NeoAuditLog[];
  selectedId: number | null;
  select: (id: number) => void;
}) {
  return (
    <>
      <div className="space-y-3 lg:hidden">
        {rows.map((row) => {
          const status = auditResponseStatus(row.responseStatus);
          return (
            <article
              key={row.id}
              className="rounded-control border border-border p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <AuditIdentity row={row} />
                <StatusBadge status={status.badge}>{status.label}</StatusBadge>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">操作时间</dt>
                  <dd>{auditTime(row.createTime)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">操作</dt>
                  <dd>{auditAction(row.action)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">资源</dt>
                  <dd>{auditResource(row.resource)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">HTTP 方法</dt>
                  <dd>{row.method || '未记录'}</dd>
                </div>
              </dl>
              <div className="mt-3 space-y-1 break-all text-xs text-muted-foreground">
                <p>
                  资源名称：{row.resourceName || row.resourceId || '未记录'}
                </p>
                <p>请求路径：{row.path || '未记录'}</p>
              </div>
              <Button
                variant="secondary"
                size="small"
                className="mt-4"
                aria-expanded={selectedId === row.id}
                onClick={() => select(row.id)}
              >
                {selectedId === row.id ? '收起详情' : '查看详情'}
              </Button>
            </article>
          );
        })}
      </div>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="p-3">操作时间</th>
              <th className="p-3">用户</th>
              <th className="p-3">操作 / 资源</th>
              <th className="p-3">路径 / 方法</th>
              <th className="p-3">响应</th>
              <th className="p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const status = auditResponseStatus(row.responseStatus);
              return (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="neo-mono whitespace-nowrap p-3 text-xs">
                    {auditTime(row.createTime)}
                  </td>
                  <td className="max-w-48 p-3">
                    <AuditIdentity row={row} />
                  </td>
                  <td className="max-w-48 p-3">
                    {auditAction(row.action)}
                    <span className="block truncate text-xs text-muted-foreground">
                      {auditResource(row.resource)} ·{' '}
                      {row.resourceName || row.resourceId || '未记录'}
                    </span>
                  </td>
                  <td className="max-w-64 p-3">
                    <span
                      className="block truncate"
                      title={row.path || undefined}
                    >
                      {row.path || '未记录'}
                    </span>
                    <span className="neo-mono text-xs text-muted-foreground">
                      {row.method || '未记录'}
                    </span>
                  </td>
                  <td className="p-3">
                    <StatusBadge status={status.badge}>
                      {status.label}
                    </StatusBadge>
                  </td>
                  <td className="p-3">
                    <Button
                      variant="secondary"
                      size="small"
                      aria-expanded={selectedId === row.id}
                      onClick={() => select(row.id)}
                    >
                      {selectedId === row.id ? '收起' : '详情'}
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

function useAuditDetail(id: number | null) {
  const { runtime } = useAuth();
  return useQuery({
    queryKey: ['audit-log', 'detail', id],
    queryFn: ({ signal }) => {
      if (id === null) throw new ApiError('INVALID_INPUT', '审计记录标识无效');
      return getAuditLogDetail(runtime.http, id, signal);
    },
    enabled: id !== null,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
}

function AuditDetail({
  id,
  close,
  detail,
}: {
  id: number;
  close: () => void;
  detail: ReturnType<typeof useAuditDetail>;
}) {
  const [missingError, setMissingError] = useState<ApiError | null>(null);
  const currentMissingError = detail.isError
    ? auditDeletedDetailError(detail.error)
    : null;
  useEffect(() => {
    if (currentMissingError) setMissingError(currentMissingError);
  }, [currentMissingError]);
  useEffect(() => {
    if (detail.isSuccess && missingError) setMissingError(null);
  }, [detail.isSuccess, missingError]);
  const row = auditVisibleDetail(
    detail.data,
    missingError,
    detail.isError ? detail.error : null,
  );
  const status = row ? auditResponseStatus(row.responseStatus) : null;
  return (
    <Card aria-label="审计记录详情">
      <CardHeader
        title={`审计详情 #${id}`}
        description="按当前登录身份实时读取的操作记录。"
        action={
          <Button variant="ghost" size="small" onClick={close}>
            关闭
          </Button>
        }
      />
      <CardContent className="space-y-5">
        {detail.isPending && (
          <div aria-label="正在加载审计详情" className="space-y-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-32" />
          </div>
        )}
        {!row && (detail.isError || missingError) && (
          <ErrorNotice
            title="详情暂不可用"
            error={missingError ?? detail.error}
            retry={() => {
              void detail.refetch();
            }}
          />
        )}
        {row && (
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
                {auditAction(row.action)} · {auditResource(row.resource)}
              </h3>
              {status && (
                <StatusBadge status={status.badge}>{status.label}</StatusBadge>
              )}
            </div>
            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {(
                [
                  ['操作时间', auditTime(row.createTime)],
                  ['用户', row.username || '未记录'],
                  ['用户 ID', row.userId || '未记录'],
                  ['操作类型', row.action],
                  ['资源类型', auditResource(row.resource)],
                  ['资源 ID', row.resourceId || '未记录'],
                  ['资源名称', row.resourceName || '未记录'],
                  ['请求路径', row.path || '未记录'],
                  ['HTTP 方法', row.method || '未记录'],
                  ['IP 地址', row.ipAddress || '未记录'],
                  ['User-Agent', row.userAgent || '未记录'],
                  ['错误信息', row.errorMessage || '未记录'],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-all">{value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function AuditLogPage() {
  const { runtime } = useAuth();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [query, setQuery] = useState<NeoAuditLogListQuery>(INITIAL_QUERY);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const accessGeneration = useRef(0);
  const [access, dispatchAccess] = useReducer(auditAccessReducer, {
    error: null,
    generation: 0,
  });
  const audit = useQuery({
    queryKey: ['audit-log', 'list', query],
    queryFn: async ({ signal }) => {
      const generation = accessGeneration.current;
      try {
        const result = await getAuditLogs(runtime.http, query, signal);
        return { result, generation };
      } catch (error) {
        const revoked = auditAccessError(error);
        if (revoked && !signal.aborted) {
          const nextGeneration = ++accessGeneration.current;
          dispatchAccess({
            type: 'list-revoked',
            error: revoked,
            generation: nextGeneration,
          });
        }
        throw error;
      }
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
  });
  const refetchList = audit.refetch;
  const listAccessError = audit.isError ? auditAccessError(audit.error) : null;
  const selectedInList =
    selectedId !== null &&
    !listAccessError &&
    audit.data?.result.list.some((row) => row.id === selectedId)
      ? selectedId
      : null;
  const detail = useAuditDetail(selectedInList);
  const detailAccessError = detail.isError
    ? auditAccessError(detail.error)
    : null;
  useEffect(() => {
    if (detailAccessError) {
      setSelectedId(null);
      const generation = ++accessGeneration.current;
      dispatchAccess({
        type: 'detail-revoked',
        error: detailAccessError,
        generation,
      });
      // Only a request started after revocation may clear the latch.
      void refetchList();
    }
  }, [detailAccessError, refetchList]);
  useEffect(() => {
    if (
      access.error &&
      audit.isSuccess &&
      audit.data?.generation === access.generation
    ) {
      dispatchAccess({ type: 'list-succeeded', generation: access.generation });
    }
  }, [access.error, access.generation, audit.isSuccess, audit.data]);
  const data = auditVisibleList(
    audit.data?.result,
    access.error,
    listAccessError,
    detailAccessError,
  );
  const current = data?.current ?? query.current;
  const visibleSelectedId = data ? selectedInList : null;

  function retryList() {
    void audit.refetch();
  }

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
    const nextQuery: NeoAuditLogListQuery = {
      ...Object.fromEntries(
        TEXT_FILTERS.map(({ key }) => [key, filters[key].trim() || undefined]),
      ),
      startTime,
      endTime,
      current: 1,
      pageSize: query.pageSize,
    };
    try {
      runtime.http.url('/api/v1/audit-logs', nextQuery);
    } catch {
      setFilterError('筛选条件无法组成有效请求地址，请减少输入。');
      return;
    }
    setFilterError(null);
    setSelectedId(null);
    setQuery(nextQuery);
  }
  return (
    <AppShell title="操作审计">
      <div className="space-y-6">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
          <span className="inline-flex items-center gap-2.5 text-xs font-semibold">
            <ScrollText aria-hidden="true" className="size-4 text-signal" />{' '}
            GOVERNANCE / 操作审计
          </span>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-black tracking-tight">操作审计</h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-white/65">
                追查谁在何时对什么资源执行了操作。记录按时间与 ID 从新到旧排列。
              </p>
            </div>
            <Button
              variant="secondary"
              size="small"
              pending={audit.isFetching}
              onClick={() => {
                void audit.refetch();
              }}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
          </div>
        </section>
        <Card>
          <CardHeader
            title="筛选审计记录"
            description="筛选由服务器执行；时间按上海时区解释。"
          />
          <CardContent>
            <form onSubmit={applyFilters} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
            title="审计记录"
            description={
              data
                ? `第 ${current} 页 · 共 ${data.total} 条 · 当前页 ${data.list.length} 条`
                : '只读取当前权限可见的审计记录'
            }
            action={
              <label className="flex items-center gap-2 text-xs">
                每页{' '}
                <select
                  aria-label="每页数量"
                  className="rounded-control border border-input bg-card px-3 py-2"
                  value={query.pageSize}
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
            {audit.isPending && (
              <div aria-label="正在加载审计记录" className="space-y-3">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            )}
            {!data && (audit.isError || access.error || detailAccessError) && (
              <ErrorNotice
                title="审计记录暂不可用"
                error={access.error ?? detailAccessError ?? audit.error}
                retry={retryList}
              />
            )}
            {data && (
              <>
                {audit.isError && (
                  <p
                    role="status"
                    className="rounded-control bg-status-warning-soft p-3 text-sm text-status-warning"
                  >
                    刷新失败，当前展示上一次成功读取的记录。
                  </p>
                )}
                {data.list.length === 0 ? (
                  <EmptyState
                    title="暂无匹配记录"
                    description="请调整用户、资源或时间筛选后重试。"
                  />
                ) : (
                  <AuditRows
                    rows={data.list}
                    selectedId={selectedId}
                    select={(id) =>
                      setSelectedId(selectedId === id ? null : id)
                    }
                  />
                )}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm">
                  <span className="text-muted-foreground">
                    第 {current} 页 · 共 {data.total} 条
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={current <= 1}
                      onClick={() => {
                        setSelectedId(null);
                        setQuery((previous) => ({
                          ...previous,
                          current: previous.current - 1,
                        }));
                      }}
                    >
                      <ChevronLeft aria-hidden="true" />
                      上一页
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={
                        current >= Math.ceil(data.total / data.pageSize)
                      }
                      onClick={() => {
                        setSelectedId(null);
                        setQuery((previous) => ({
                          ...previous,
                          current: previous.current + 1,
                        }));
                      }}
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
          <AuditDetail
            id={visibleSelectedId}
            detail={detail}
            close={() => setSelectedId(null)}
          />
        )}
      </div>
    </AppShell>
  );
}
