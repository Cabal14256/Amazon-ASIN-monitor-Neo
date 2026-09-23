import { useQuery } from '@tanstack/react-query';
import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useAuth } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  FilterChip,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import { Field, Input } from '../../components/ui/field';
import {
  Card,
  CardContent,
  CardHeader,
  ModuleLabel,
} from '../../components/ui/surfaces';
import {
  catalogError,
  checkedAt,
  childStatus,
  groupStatus,
  statusOf,
  statusSource,
} from './catalog-data';
import type {
  CatalogConfig,
  CatalogGroup,
  CatalogQuery,
} from './catalog-types';

const PAGE_SIZES = [10, 20, 50, 100] as const;
const CHILD_PAGE_SIZE = 50;
const TABLE_FEATURES = tableFeatures({});
type StatusFilter = 'ALL' | 'BROKEN' | 'NORMAL';
const INITIAL_QUERY: CatalogQuery = { current: 1, pageSize: 10 };

function Notice({
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
      className="rounded-card border border-status-danger/25 bg-status-danger-soft p-5 sm:p-6"
    >
      <h3 className="font-semibold text-status-danger">{title}</h3>
      <p className="mt-2 text-sm text-status-danger">{catalogError(error)}</p>
      <Button variant="secondary" className="mt-4" onClick={retry}>
        重试加载
      </Button>
    </div>
  );
}

function GroupCard({
  group,
  config,
  selected,
  onSelect,
}: {
  group: CatalogGroup;
  config: CatalogConfig;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li className="rounded-control border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words font-semibold">
              {group.name || '未命名变体组'}
            </h3>
            <StatusBadge status={groupStatus(group)} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {group.country || '未知国家'}
            {config.showSite && ` · ${group.site || '站点未记录'}`}
            {' · '}
            {group.brand || '品牌未记录'}
          </p>
        </div>
        <Button
          variant="secondary"
          size="small"
          aria-expanded={selected}
          onClick={onSelect}
        >
          {selected ? '收起详情' : '查看 ASIN'}
          <ChevronDown
            aria-hidden="true"
            className={selected ? 'rotate-180' : ''}
          />
        </Button>
      </div>
      <div className="mt-4 grid gap-3 border-t border-border pt-4 text-xs sm:grid-cols-3">
        <p>
          <span className="text-muted-foreground">ASIN 数量</span>
          <strong className="ml-2 font-semibold">
            {group.children?.length ?? group.asin_count ?? '—'}
          </strong>
        </p>
        <p>
          <span className="text-muted-foreground">
            {config.showSource ? '状态来源' : '展示口径'}
          </span>
          <span className="ml-2">
            {config.showSource
              ? statusSource(group.statusSource)
              : '按子 ASIN 判定'}
          </span>
        </p>
        <p>
          <span className="text-muted-foreground">上次检查</span>
          <span className="neo-mono ml-2">
            {checkedAt(group.lastCheckTime ?? group.last_check_time)}
          </span>
        </p>
      </div>
    </li>
  );
}

function GroupDetail({
  id,
  config,
  onClose,
  childPage,
  onChildPageChange,
}: {
  id: string;
  config: CatalogConfig;
  onClose: () => void;
  childPage: number;
  onChildPageChange: (page: number) => void;
}) {
  const { runtime } = useAuth();
  const detail = useQuery({
    queryKey: [config.id, 'group', id],
    queryFn: ({ signal }) => config.detail(runtime.http, id, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const group = detail.data;
  const children = group?.children ?? [];
  const childPages = Math.max(1, Math.ceil(children.length / CHILD_PAGE_SIZE));
  const visiblePage = Math.min(childPage, childPages);
  const visibleChildren = children.slice(
    (visiblePage - 1) * CHILD_PAGE_SIZE,
    visiblePage * CHILD_PAGE_SIZE,
  );
  return (
    <Card aria-label={`${config.label}变体组详情`} className="overflow-hidden">
      <CardHeader
        title="变体组详情"
        description="按当前数据源展示组内 ASIN 与有效状态。"
        action={
          <Button variant="ghost" size="small" onClick={onClose}>
            关闭
          </Button>
        }
      />
      <CardContent className="space-y-5">
        {detail.isPending && (
          <div aria-label="正在加载变体组详情" className="space-y-3">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-24" />
          </div>
        )}
        {!group && detail.isError && (
          <Notice
            title="详情暂不可用"
            error={detail.error}
            retry={() => {
              void detail.refetch();
            }}
          />
        )}
        {group && (
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
                {group.name || '未命名变体组'}
              </h3>
              <StatusBadge status={groupStatus(group)} />
              {config.showSource && (
                <span className="text-xs text-muted-foreground">
                  {statusSource(group.statusSource)}
                </span>
              )}
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">
                  {config.showSite ? '国家 / 站点' : '国家'}
                </dt>
                <dd className="mt-1">
                  {group.country || '—'}
                  {config.showSite && ` / ${group.site || '—'}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">品牌</dt>
                <dd className="mt-1">{group.brand || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">飞书通知</dt>
                <dd className="mt-1">
                  {group.feishuNotifyEnabled == null
                    ? '未记录'
                    : statusOf(group.feishuNotifyEnabled) === 'danger'
                    ? '已开启'
                    : '已关闭'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">上次检查</dt>
                <dd className="neo-mono mt-1">
                  {checkedAt(group.lastCheckTime ?? group.last_check_time)}
                </dd>
              </div>
            </dl>
            {config.showManual && group.manualBrokenReason && (
              <p className="rounded-control bg-status-warning-soft p-3 text-sm">
                人工标记原因：{group.manualBrokenReason}
              </p>
            )}
            <div>
              <h4 className="mb-3 font-semibold">
                组内 ASIN{' '}
                <span className="neo-mono ml-1 text-sm text-muted-foreground">
                  {children.length}
                </span>
              </h4>
              {children.length === 0 ? (
                <EmptyState
                  title="组内暂无 ASIN"
                  description="当前变体组未返回任何 ASIN。"
                />
              ) : (
                <ul className="grid gap-3 lg:grid-cols-2">
                  {visibleChildren.map((child) => (
                    <li
                      key={child.id}
                      className="rounded-control border border-border p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="neo-mono break-all font-semibold">
                            {child.asin}
                          </p>
                          <p className="mt-1 break-words text-sm text-muted-foreground">
                            {child.name || '名称未记录'}
                          </p>
                        </div>
                        <StatusBadge status={childStatus(child)} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {String(child.asinType) === '1'
                            ? '主链'
                            : String(child.asinType) === '2'
                            ? '副评'
                            : '类型未记录'}
                        </span>
                        {config.showSource && (
                          <span>{statusSource(child.statusSource)}</span>
                        )}
                        <span>上次检查：{checkedAt(child.lastCheckTime)}</span>
                        <span>
                          飞书通知：
                          {child.feishuNotifyEnabled == null
                            ? '未记录'
                            : statusOf(child.feishuNotifyEnabled) === 'danger'
                            ? '已开启'
                            : '已关闭'}
                        </span>
                      </div>
                      {config.showManual && child.manualBrokenReason && (
                        <p className="mt-2 text-xs text-status-warning">
                          人工标记原因：{child.manualBrokenReason}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {childPages > 1 && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">
                    第 {visiblePage} / {childPages} 页 · 每页最多{' '}
                    {CHILD_PAGE_SIZE} 个 ASIN
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={visiblePage <= 1}
                      onClick={() => onChildPageChange(visiblePage - 1)}
                    >
                      <ChevronLeft aria-hidden="true" />
                      上一页
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={visiblePage >= childPages}
                      onClick={() => onChildPageChange(visiblePage + 1)}
                    >
                      下一页
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function GroupRows({
  groups,
  config,
  selectedId,
  onSelect,
}: {
  groups: CatalogGroup[];
  config: CatalogConfig;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Both CSS layouts stay mounted; one parent page keeps rotation/resize stable.
  const [childPage, setChildPage] = useState(1);
  const toggleGroup = useCallback(
    (id: string) => {
      setChildPage(1);
      onSelect(id);
    },
    [onSelect],
  );
  const columns = useMemo<ColumnDef<typeof TABLE_FEATURES, CatalogGroup>[]>(
    () => [
      {
        id: 'group',
        header: '变体组',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="break-words font-semibold">
              {row.original.name || '未命名变体组'}
            </p>
            <p className="neo-mono mt-1 break-all text-xs text-muted-foreground">
              {row.original.id}
            </p>
          </div>
        ),
      },
      {
        id: 'site',
        header: config.showSite ? '站点 / 品牌' : '国家 / 品牌',
        cell: ({ row }) => (
          <div>
            <p>
              {row.original.country || '—'}
              {config.showSite && ` · ${row.original.site || '—'}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.original.brand || '—'}
            </p>
          </div>
        ),
      },
      {
        id: 'children',
        header: '组内 ASIN',
        cell: ({ row }) => (
          <span className="neo-mono font-semibold">
            {row.original.children?.length ?? row.original.asin_count ?? '—'}
          </span>
        ),
      },
      {
        id: 'status',
        header: '状态 / 检查',
        cell: ({ row }) => (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={groupStatus(row.original)} />
              {config.showSource && (
                <span className="text-xs text-muted-foreground">
                  {statusSource(row.original.statusSource)}
                </span>
              )}
            </div>
            <p className="neo-mono text-xs text-muted-foreground">
              {checkedAt(
                row.original.lastCheckTime ?? row.original.last_check_time,
              )}
            </p>
          </div>
        ),
      },
      {
        id: 'action',
        header: '详情',
        cell: ({ row }) => (
          <Button
            variant="secondary"
            size="small"
            aria-expanded={selectedId === row.original.id}
            onClick={() => toggleGroup(row.original.id)}
          >
            {selectedId === row.original.id ? '收起' : '查看'}
          </Button>
        ),
      },
    ],
    [config, selectedId, toggleGroup],
  );
  const table = useTable({
    features: TABLE_FEATURES,
    columns,
    data: groups,
    getRowId: (row) => row.id,
  });
  const rows = table.getRowModel().rows;
  return (
    <>
      <ul className="space-y-3 lg:hidden">
        {rows.map((row) => (
          <Fragment key={row.id}>
            <GroupCard
              group={row.original}
              config={config}
              selected={selectedId === row.id}
              onSelect={() => toggleGroup(row.id)}
            />
            {selectedId === row.id && (
              <li>
                <GroupDetail
                  id={row.id}
                  config={config}
                  onClose={() => toggleGroup(row.id)}
                  childPage={childPage}
                  onChildPageChange={setChildPage}
                />
              </li>
            )}
          </Fragment>
        ))}
      </ul>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[800px] table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[40%]" />
            <col className="w-[15%]" />
            <col className="w-[12%]" />
            <col className="w-[23%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr
                key={headerGroup.id}
                className="border-b border-border text-xs text-muted-foreground"
              >
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className="px-3 pb-3 font-medium"
                  >
                    {header.isPlaceholder ? null : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.id}>
                <tr className="neo-row border-b border-border align-top">
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-4">
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
                {selectedId === row.id && (
                  <tr>
                    <td colSpan={columns.length} className="pb-4">
                      <GroupDetail
                        id={row.id}
                        config={config}
                        onClose={() => toggleGroup(row.id)}
                        childPage={childPage}
                        onChildPageChange={setChildPage}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function CatalogPage({ config }: { config: CatalogConfig }) {
  const { runtime } = useAuth();
  const [keyword, setKeyword] = useState('');
  const [country, setCountry] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [query, setQuery] = useState<CatalogQuery>(INITIAL_QUERY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const groups = useQuery({
    queryKey: [config.id, 'groups', query],
    queryFn: ({ signal }) => config.list(runtime.http, query, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const data = groups.data;
  const current = data?.current ?? query.current ?? 1;
  const pageSize = data?.pageSize ?? query.pageSize ?? 10;
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelectedId(null);
    setQuery({
      keyword: keyword.trim() || undefined,
      country: country.trim().toUpperCase() || undefined,
      variantStatus: status === 'ALL' ? undefined : status,
      current: 1,
      pageSize: query.pageSize,
    });
  }
  function changePage(next: number) {
    setSelectedId(null);
    setQuery((previous) => ({ ...previous, current: next }));
  }

  return (
    <AppShell title={config.title}>
      <div className="space-y-6">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
          <ModuleLabel module={config.id}>
            {config.label} / 只读目录
          </ModuleLabel>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-black tracking-tight">
                {config.heading}
              </h1>
              <p className="mt-3 text-sm leading-6 text-white/65">
                {config.description}
              </p>
            </div>
            <Button
              variant="secondary"
              size="small"
              pending={groups.isFetching}
              onClick={() => {
                void groups.refetch();
              }}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
          </div>
        </section>

        <Card>
          <CardHeader
            title="筛选目录"
            description="关键词、国家和异常状态由服务器筛选。"
          />
          <CardContent>
            <form
              onSubmit={applyFilters}
              className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end"
            >
              <Field label="关键词">
                {(control) => (
                  <Input
                    {...control}
                    value={keyword}
                    maxLength={200}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder="变体组名称、编号或 ASIN"
                  />
                )}
              </Field>
              <Field label="国家代码">
                {(control) => (
                  <Input
                    {...control}
                    value={country}
                    maxLength={10}
                    onChange={(event) => setCountry(event.target.value)}
                    placeholder="例如 US"
                  />
                )}
              </Field>
              <Button type="submit" className="w-full md:w-auto">
                <Search aria-hidden="true" />
                查询
              </Button>
              <fieldset className="md:col-span-3">
                <legend className="mb-2 text-sm font-semibold">状态</legend>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ['ALL', '全部'],
                      ['BROKEN', '异常'],
                      ['NORMAL', '正常'],
                    ] as const
                  ).map(([value, label]) => (
                    <FilterChip
                      key={value}
                      selected={status === value}
                      onClick={() => {
                        setStatus(value);
                        setSelectedId(null);
                        setQuery({
                          keyword: keyword.trim() || undefined,
                          country: country.trim().toUpperCase() || undefined,
                          variantStatus: value === 'ALL' ? undefined : value,
                          current: 1,
                          pageSize: query.pageSize,
                        });
                      }}
                    >
                      {label}
                    </FilterChip>
                  ))}
                </div>
              </fieldset>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="变体组"
            description={
              data
                ? `符合条件的变体组 ${data.total} 组 · ASIN ${
                    data.totalASINs ?? '未统计'
                  } 个`
                : '按当前筛选条件读取目录'
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
                </select>
                组
              </label>
            }
          />
          <CardContent className="space-y-5">
            {groups.isPending && (
              <div
                aria-label={`正在加载${config.label}目录`}
                className="space-y-3"
              >
                <Skeleton className="h-28" />
                <Skeleton className="h-28" />
                <Skeleton className="h-28" />
              </div>
            )}
            {!data && groups.isError && (
              <Notice
                title={`${config.label}目录暂不可用`}
                error={groups.error}
                retry={() => {
                  void groups.refetch();
                }}
              />
            )}
            {data && (
              <>
                {groups.isError && (
                  <p
                    role="status"
                    className="rounded-control bg-status-warning-soft p-3 text-sm text-status-warning"
                  >
                    刷新失败，当前展示上一次成功读取的数据。
                  </p>
                )}
                {data.list.length === 0 ? (
                  <EmptyState
                    title="未找到变体组"
                    description="当前筛选条件下没有匹配的数据，请调整关键词、国家或状态。"
                  />
                ) : (
                  <GroupRows
                    groups={data.list}
                    config={config}
                    selectedId={selectedId}
                    onSelect={(id) =>
                      setSelectedId(selectedId === id ? null : id)
                    }
                  />
                )}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5 text-sm">
                  <span className="text-muted-foreground">
                    第 {current} / {pages} 页 · 共 {data.total} 组
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
                      disabled={current >= pages}
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
      </div>
    </AppShell>
  );
}
