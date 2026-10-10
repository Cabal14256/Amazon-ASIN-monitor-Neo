import type {
  HomeWorkbenchData,
  HomeWorkbenchQuery,
} from '@asin-monitor/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useAuth, useIdentity } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import type { RouteAuthState } from '../../auth/navigation';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import { Field, Input } from '../../components/ui/field';
import { ModuleLabel } from '../../components/ui/surfaces';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import {
  getHomeWorkbench,
  HOME_WORKBENCH_QUERY_KEY,
} from '../../services/home-workbench';
import {
  subscribeDashboardChanges,
  type DashboardCountry,
} from './dashboard-data';
import { workbenchScope } from './workbench-scope';
import { WorkbenchSparkline } from './workbench-sparkline';

interface Props {
  country: DashboardCountry;
  countryControls: ReactNode;
  statusPanel: ReactNode;
  alertsPanel: ReactNode;
}
const blank = (value: string) => (value === '' ? undefined : value);
type DeniedRead = {
  auth: Extract<RouteAuthState, { status: 'authenticated' }>;
  error: ApiError;
};
// A read denial outlives filter/country/route remounts for this verified identity.
// IdentityStore publishes a new authenticated snapshot after real verification.
const deniedReads = new WeakMap<IdentityStore, DeniedRead>();
const deniedTrends = new WeakMap<IdentityStore, DeniedRead['auth']>();
function withoutTrends(data: HomeWorkbenchData): HomeWorkbenchData {
  return {
    ...data,
    trendsAuthorized: false,
    list: data.list.map((group) => ({ ...group, trend: null })),
  };
}
const isDenied = (error: unknown): error is ApiError =>
  error instanceof ApiError && [401, 403].includes(error.status ?? 0);
function AuthorizedWorkbench({
  scope,
  denial,
  onDenied,
  trendsDenied,
  onTrendsDenied,
  ...props
}: Props & {
  scope: string;
  denial?: ApiError;
  onDenied: (error: ApiError) => void;
  trendsDenied: boolean;
  onTrendsDenied: () => void;
}) {
  const { runtime, identity } = useAuth();
  const [query, setQuery] = useState<HomeWorkbenchQuery>({
    current: 1,
    pageSize: 10,
    facetCurrent: 1,
    country: props.country === 'ALL' ? undefined : props.country,
  });
  const [draft, setDraft] = useState({
    country: query.country ?? '',
    site: '',
    brand: '',
    keyword: '',
    facetKeyword: '',
    status: 'ALL' as 'ALL' | 'BROKEN' | 'NORMAL',
  });
  const live = useRef(true);
  const current = () =>
    live.current &&
    workbenchScope(identity.getSnapshot(), runtime.session.revision) === scope;
  const result = useQuery({
    queryKey: [...HOME_WORKBENCH_QUERY_KEY, scope, query],
    queryFn: async ({ signal }) => {
      if (!current()) throw new ApiError('CANCELLED', '身份或权限已变化');
      try {
        const data = await getHomeWorkbench(runtime.http, query, signal);
        if (!current()) throw new ApiError('CANCELLED', '身份或权限已变化');
        if (!data.trendsAuthorized) onTrendsDenied();
        return deniedTrends.get(identity) === identity.getSnapshot()
          ? withoutTrends(data)
          : data;
      } catch (error) {
        if (current() && isDenied(error)) onDenied(error);
        throw error;
      }
    },
    enabled: !denial,
    staleTime: 15_000,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (state) =>
      state.state.error instanceof ApiError &&
      [401, 403].includes(state.state.error.status ?? 0)
        ? false
        : 30_000,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      void runtime.queryClient.cancelQueries({
        queryKey: [...HOME_WORKBENCH_QUERY_KEY, scope],
      });
      runtime.queryClient.removeQueries({
        queryKey: [...HOME_WORKBENCH_QUERY_KEY, scope],
      });
    };
  }, [runtime, scope]);
  useEffect(
    () =>
      subscribeDashboardChanges(
        runtime.ws.onMessage.bind(runtime.ws),
        async () => {
          if (!live.current || denial) return;
          await runtime.queryClient.cancelQueries({
            queryKey: [...HOME_WORKBENCH_QUERY_KEY, scope],
          });
          if (!live.current) return;
          await runtime.queryClient.invalidateQueries({
            queryKey: [...HOME_WORKBENCH_QUERY_KEY, scope],
            refetchType:
              document.visibilityState === 'visible' ? 'active' : 'none',
          });
        },
      ),
    [runtime, scope, denial],
  );
  const denied = Boolean(denial || isDenied(result.error));
  const error = denial ?? result.error;
  const data = denied
    ? undefined
    : result.data && trendsDenied
    ? withoutTrends(result.data)
    : result.data;
  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (!current()) return;
    setQuery({
      current: 1,
      pageSize: query.pageSize,
      facetCurrent: 1,
      country: blank(draft.country),
      site: blank(draft.site),
      brand: blank(draft.brand),
      keyword: blank(draft.keyword),
      facetKeyword: blank(draft.facetKeyword),
      status: draft.status === 'ALL' ? undefined : draft.status,
    });
  };
  const refresh = async () => {
    if (!current()) return;
    if (denied || trendsDenied) {
      const previous = identity.getSnapshot();
      const verified = await identity.refresh();
      if (verified === previous || verified.status !== 'authenticated') return;
    }
    if (current()) await result.refetch();
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[240px_minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-5">
        {props.countryControls}
        <section
          aria-label="工作台筛选树"
          className="rounded-card border border-border bg-card p-4"
        >
          <ModuleLabel module="asin">工作台目录</ModuleLabel>
          <h2 className="mt-3 text-lg font-bold">国家 / 站点 / 品牌</h2>
          <form onSubmit={apply} className="mt-4 space-y-3">
            {(
              ['country', 'site', 'brand', 'keyword', 'facetKeyword'] as const
            ).map((key, index) => (
              <Field
                key={key}
                label={
                  [
                    '工作台国家',
                    '工作台站点',
                    '工作台品牌',
                    '组名称或编号',
                    '筛选树品牌搜索',
                  ][index]
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    value={draft[key]}
                    maxLength={key === 'country' ? 20 : 200}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        [key]: event.target.value,
                      }))
                    }
                  />
                )}
              </Field>
            ))}
            <Field label="工作台状态">
              {(control) => (
                <select
                  {...control}
                  className="w-full rounded-input border border-input bg-card p-3 text-sm"
                  value={draft.status}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      status: event.target.value as typeof previous.status,
                    }))
                  }
                >
                  <option value="ALL">全部状态</option>
                  <option value="BROKEN">异常</option>
                  <option value="NORMAL">正常</option>
                </select>
              )}
            </Field>
            <Button type="submit" size="small">
              应用工作台筛选
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={() => {
                if (!current()) return;
                setDraft({
                  country: '',
                  site: '',
                  brand: '',
                  keyword: '',
                  facetKeyword: '',
                  status: 'ALL' as 'ALL' | 'BROKEN' | 'NORMAL',
                });
                setQuery({ current: 1, pageSize: 10, facetCurrent: 1 });
              }}
            >
              清除工作台筛选
            </Button>
          </form>
          {data && (
            <>
              <ul
                aria-label="真实目录品牌树"
                className="mt-5 max-h-96 space-y-1 overflow-y-auto"
              >
                {data.facets.map((facet) => (
                  <li
                    key={JSON.stringify([
                      facet.country,
                      facet.site,
                      facet.brand,
                    ])}
                  >
                    <button
                      type="button"
                      className="w-full rounded-control p-2 text-left text-xs hover:bg-muted"
                      aria-pressed={
                        query.country === facet.country &&
                        query.site === facet.site &&
                        query.brand === facet.brand
                      }
                      onClick={() => {
                        if (!current()) return;
                        setDraft((previous) => ({
                          ...previous,
                          country: facet.country,
                          site: facet.site,
                          brand: facet.brand,
                        }));
                        setQuery((previous) => ({
                          ...previous,
                          current: 1,
                          facetCurrent: 1,
                          country: facet.country,
                          site: facet.site,
                          brand: facet.brand,
                        }));
                      }}
                    >
                      <span className="block break-words text-muted-foreground">
                        {facet.country} · {facet.site}
                      </span>
                      <span className="mt-1 block break-words font-semibold">
                        {facet.brand || '空品牌'} · {facet.totalGroups} 组
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {data.facets.length === 0 && (
                <p className="mt-4 text-xs text-muted-foreground">
                  此筛选范围没有品牌分组。
                </p>
              )}
              <div className="mt-4 flex items-center justify-between gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  aria-label="上一页品牌分组"
                  disabled={query.facetCurrent === 1 || result.isFetching}
                  onClick={() =>
                    current() &&
                    setQuery((previous) => ({
                      ...previous,
                      facetCurrent: previous.facetCurrent - 1,
                    }))
                  }
                >
                  <ChevronLeft />
                </Button>
                <span className="text-xs text-muted-foreground">
                  品牌页 {data.facetCurrent}
                </span>
                <Button
                  variant="secondary"
                  size="small"
                  aria-label="下一页品牌分组"
                  disabled={
                    !data.facetsTruncated ||
                    query.facetCurrent >= 51 ||
                    result.isFetching
                  }
                  onClick={() =>
                    current() &&
                    setQuery((previous) => ({
                      ...previous,
                      facetCurrent: previous.facetCurrent + 1,
                    }))
                  }
                >
                  <ChevronRight />
                </Button>
              </div>
              {data.facetsTruncated && (
                <p role="status" className="mt-3 text-xs text-muted-foreground">
                  本页最多 200 个品牌分组，
                  {query.facetCurrent >= 51
                    ? '已达到浏览上限，请缩小国家、站点或品牌搜索范围。'
                    : '可翻页或搜索品牌，继续查看其余分组。'}
                </p>
              )}
            </>
          )}
        </section>
      </div>
      <div className="min-w-0 space-y-5">
        <section
          aria-label="首页变体组工作台"
          className="rounded-card border border-border bg-card p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <ModuleLabel module="asin">变体组</ModuleLabel>
              <h2 className="mt-3 text-xl font-bold">正在监控的目录</h2>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                近七日趋势为上海日期的组检查异常率，按已知结果计算；没有检查或仅有未知结果的日期保持空缺。
              </p>
            </div>
            <Button
              variant="secondary"
              size="small"
              pending={result.isFetching}
              onClick={() => void refresh()}
            >
              <RefreshCw />
              刷新工作台
            </Button>
          </div>
          <p className="mt-3 break-words text-xs text-muted-foreground">
            工作台范围：{query.country ?? '全部国家'} /{' '}
            {query.site ?? '全部站点'} / {query.brand ?? '全部品牌'}
          </p>
          {result.isPending && (
            <div aria-label="正在加载变体组工作台" className="mt-5 space-y-3">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-14" />
              ))}
            </div>
          )}
          {(denial || result.isError) && (
            <div
              role="alert"
              className="mt-5 rounded-control bg-status-danger-soft p-4 text-sm text-status-danger"
            >
              <p>
                {error instanceof ApiError
                  ? error.message
                  : '工作台暂不可用，请重试读取。'}
              </p>
              {data && (
                <p className="mt-2 text-xs">
                  当前保留上一次成功读取的同范围数据。
                </p>
              )}
              <Button
                variant="secondary"
                size="small"
                className="mt-3"
                onClick={() => void refresh()}
              >
                重试工作台读取
              </Button>
            </div>
          )}
          {data && (
            <>
              {!data.trendsAuthorized && (
                <p className="mt-4 text-xs text-muted-foreground">
                  没有历史读取权限，当前仅展示目录状态；七日趋势需要监控历史或数据分析读取权限。
                </p>
              )}
              {data.list.length === 0 ? (
                <div className="mt-5">
                  <EmptyState
                    title="此范围没有变体组"
                    description="调整国家、站点、品牌或异常筛选后重试。"
                  />
                </div>
              ) : (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        {['变体组', '状态', 'ASIN', '近七日', '最后检查'].map(
                          (title) => (
                            <th
                              key={title}
                              scope="col"
                              className="px-2 pb-3 font-medium"
                            >
                              {title}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.list.map((group) => (
                        <tr key={group.id} className="neo-row">
                          <td className="max-w-52 px-2 py-4">
                            <Link
                              to="/asin"
                              search={{ groupId: group.id }}
                              className="block truncate font-semibold underline-offset-4 hover:underline"
                              title={`${group.name} · ${group.id}`}
                            >
                              {group.name || group.id}
                            </Link>
                            <p
                              className="mt-1 truncate text-xs text-muted-foreground"
                              title={`${group.country} · ${group.site} · ${group.brand}`}
                            >
                              {group.country} · {group.brand}
                            </p>
                          </td>
                          <td className="px-2 py-4">
                            <StatusBadge
                              status={group.isBroken ? 'danger' : 'success'}
                            />
                          </td>
                          <td className="neo-mono px-2 py-4 text-xs">
                            {group.asinCount}
                          </td>
                          <td className="px-2 py-4">
                            {group.trend ? (
                              <WorkbenchSparkline
                                days={group.trend}
                                name={group.name || group.id}
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                无历史权限
                              </span>
                            )}
                          </td>
                          <td className="neo-mono px-2 py-4 text-xs">
                            {group.lastCheckTime
                              ? formatBeijing(
                                  group.lastCheckTime,
                                  'MM-DD HH:mm',
                                )
                              : '尚未检查'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  共 {data.total} 组 · 第 {data.current} / {pages} 页 · 本页{' '}
                  {data.list.length} 组
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="small"
                    aria-label="上一页变体组"
                    disabled={query.current === 1 || result.isFetching}
                    onClick={() =>
                      current() &&
                      setQuery((previous) => ({
                        ...previous,
                        current: previous.current - 1,
                      }))
                    }
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    aria-label="下一页变体组"
                    disabled={
                      query.current >= pages ||
                      query.current >= 1000 ||
                      query.current * query.pageSize > 10_000 ||
                      result.isFetching
                    }
                    onClick={() =>
                      current() &&
                      setQuery((previous) => ({
                        ...previous,
                        current: previous.current + 1,
                      }))
                    }
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
              {(query.current >= 1000 ||
                query.current * query.pageSize > 10_000) &&
                query.current < pages && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    已达到分页浏览上限，请缩小筛选范围继续查看。
                  </p>
                )}
            </>
          )}
        </section>
        <details open className="rounded-card">
          <summary className="mb-3 cursor-pointer text-xs font-semibold text-muted-foreground">
            国家状态图
          </summary>
          {props.statusPanel}
        </details>
      </div>
      {props.alertsPanel}
    </div>
  );
}
export function HomeWorkbench(props: Props) {
  const { runtime, identity } = useAuth(),
    auth = useIdentity();
  const [denial, setDenial] = useState(() => deniedReads.get(identity));
  const [trendDenial, setTrendDenial] = useState(() =>
    deniedTrends.get(identity),
  );
  const scope = workbenchScope(auth, runtime.session.revision);
  const onDenied = (error: ApiError) => {
    if (auth.status !== 'authenticated' || identity.getSnapshot() !== auth)
      return;
    const value = { auth, error };
    deniedReads.set(identity, value);
    setDenial(value);
  };
  const onTrendsDenied = () => {
    if (auth.status !== 'authenticated' || identity.getSnapshot() !== auth)
      return;
    deniedTrends.set(identity, auth);
    setTrendDenial(auth);
    runtime.queryClient.setQueriesData<HomeWorkbenchData>(
      { queryKey: [...HOME_WORKBENCH_QUERY_KEY, scope] },
      (data) => data && withoutTrends(data),
    );
  };
  useEffect(() => {
    const previous = deniedReads.get(identity);
    if (auth.status === 'authenticated' && previous && previous.auth !== auth)
      deniedReads.delete(identity);
    const previousTrend = deniedTrends.get(identity);
    if (
      auth.status === 'authenticated' &&
      previousTrend &&
      previousTrend !== auth
    )
      deniedTrends.delete(identity);
  }, [auth, identity]);
  return scope ? (
    <AuthorizedWorkbench
      key={`${scope}:${props.country}`}
      scope={scope}
      denial={denial?.auth === auth ? denial.error : undefined}
      onDenied={onDenied}
      trendsDenied={trendDenial === auth}
      onTrendsDenied={onTrendsDenied}
      {...props}
    />
  ) : (
    <div className="grid items-start gap-5 xl:grid-cols-[208px_minmax(0,1fr)_320px]">
      {props.countryControls}
      {props.statusPanel}
      {props.alertsPanel}
    </div>
  );
}
