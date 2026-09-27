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
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
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
import { ApiError } from '../../lib/http';
import { CatalogActionPanel } from './catalog-actions';
import {
  asinGroupManualAction,
  asinManualAction,
  asinManualScope,
  catalogAccessDenied,
  catalogActionAllowed,
  catalogError,
  checkedAt,
  childStatus,
  groupStatus,
  statusOf,
  statusSource,
} from './catalog-data';
import {
  catalogSafetyKey,
  catalogSafetyStorage,
  readCatalogSafetyGate,
  writeCatalogSafetyGate,
  type CatalogSafetyGate,
} from './catalog-safety-gate';
import type {
  CatalogAction,
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
  disabled,
}: {
  group: CatalogGroup;
  config: CatalogConfig;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
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
          disabled={disabled}
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
  canWrite,
  canDelete,
  actionsDisabled,
  onAction,
  onDenied,
}: {
  id: string;
  config: CatalogConfig;
  onClose: () => void;
  childPage: number;
  onChildPageChange: (page: number) => void;
  canWrite?: boolean;
  canDelete?: boolean;
  actionsDisabled?: boolean;
  onAction?: (action: CatalogAction) => void;
  onDenied?: () => void;
}) {
  const { runtime } = useAuth();
  const [preparingAction, setPreparingAction] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const detail = useQuery({
    queryKey: [config.id, 'group', id],
    queryFn: ({ signal }) => config.detail(runtime.http, id, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (detail.isError && catalogAccessDenied(detail.error)) onDenied?.();
  }, [detail.error, detail.isError, onDenied]);
  const group = detail.data;
  const children = group?.children ?? [];
  const childPages = Math.max(1, Math.ceil(children.length / CHILD_PAGE_SIZE));
  const visiblePage = Math.min(childPage, childPages);
  const visibleChildren = children.slice(
    (visiblePage - 1) * CHILD_PAGE_SIZE,
    visiblePage * CHILD_PAGE_SIZE,
  );
  async function prepareAction(
    type: Exclude<CatalogAction['type'], 'create-group'>,
    childId?: string,
    manualFamily: 'self' | 'group' = 'self',
  ) {
    if (!onAction || preparingAction || actionsDisabled) return;
    setPreparingAction(true);
    try {
      const latest = await detail.refetch();
      if (!mounted.current) return;
      if (latest.isError) {
        if (catalogAccessDenied(latest.error)) onDenied?.();
        return;
      }
      const fresh = latest.data;
      if (!fresh) return;
      if (childId) {
        const child = fresh.children?.find((item) => item.id === childId);
        if (!child) return;
        if (type === 'asin-manual')
          (() => {
            const action =
              manualFamily === 'group'
                ? asinGroupManualAction(child)
                : asinManualAction(child);
            if (action) onAction({ type, action, group: fresh, child });
          })();
        else
          onAction({
            type: type as
              | 'edit-asin'
              | 'move-asin'
              | 'delete-asin'
              | 'asin-notify',
            group: fresh,
            child,
          });
      } else {
        onAction({
          type: type as
            | 'edit-group'
            | 'delete-group'
            | 'create-asin'
            | 'group-notify'
            | 'group-manual',
          group: fresh,
        });
      }
    } finally {
      if (mounted.current) setPreparingAction(false);
    }
  }
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
            {(canWrite || canDelete) && (
              <div className="flex flex-wrap gap-2">
                {canWrite && (
                  <>
                    <Button
                      variant="secondary"
                      size="small"
                      pending={preparingAction}
                      disabled={actionsDisabled}
                      onClick={() => void prepareAction('edit-group')}
                    >
                      编辑变体组
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={preparingAction || actionsDisabled}
                      onClick={() => void prepareAction('create-asin')}
                    >
                      添加 ASIN
                    </Button>
                    {config.id === 'asin' && (
                      <>
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={preparingAction || actionsDisabled}
                          onClick={() => void prepareAction('group-notify')}
                        >
                          {group.feishuNotifyEnabled
                            ? '关闭飞书通知'
                            : '开启飞书通知'}
                        </Button>
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={preparingAction || actionsDisabled}
                          onClick={() => void prepareAction('group-manual')}
                        >
                          {group.manualBroken ? '清除人工标记' : '标记人工异常'}
                        </Button>
                      </>
                    )}
                  </>
                )}
                {canDelete && (
                  <Button
                    variant="destructive"
                    size="small"
                    disabled={preparingAction || actionsDisabled}
                    onClick={() => void prepareAction('delete-group')}
                  >
                    删除变体组
                  </Button>
                )}
              </div>
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
                      {config.showManual && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          人工状态来源：{asinManualScope(child)}
                          {child.manualExcludedReason &&
                            ` · 排除原因：${child.manualExcludedReason}`}
                        </p>
                      )}
                      {(canWrite || canDelete) && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {canWrite && (
                            <>
                              <Button
                                variant="secondary"
                                size="small"
                                disabled={preparingAction || actionsDisabled}
                                onClick={() =>
                                  void prepareAction('edit-asin', child.id)
                                }
                              >
                                编辑
                              </Button>
                              <Button
                                variant="secondary"
                                size="small"
                                disabled={preparingAction || actionsDisabled}
                                onClick={() =>
                                  void prepareAction('move-asin', child.id)
                                }
                              >
                                移动
                              </Button>
                              {config.id === 'asin' && (
                                <>
                                  <Button
                                    variant="secondary"
                                    size="small"
                                    disabled={
                                      preparingAction || actionsDisabled
                                    }
                                    onClick={() =>
                                      void prepareAction(
                                        'asin-notify',
                                        child.id,
                                      )
                                    }
                                  >
                                    {child.feishuNotifyEnabled
                                      ? '关闭通知'
                                      : '开启通知'}
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    size="small"
                                    disabled={
                                      preparingAction || actionsDisabled
                                    }
                                    onClick={() =>
                                      void prepareAction(
                                        'asin-manual',
                                        child.id,
                                      )
                                    }
                                  >
                                    {asinManualAction(child) === 'MARK_BROKEN'
                                      ? '标记异常'
                                      : '清除自身标记'}
                                  </Button>
                                  {asinGroupManualAction(child) && (
                                    <Button
                                      variant="secondary"
                                      size="small"
                                      disabled={
                                        preparingAction || actionsDisabled
                                      }
                                      onClick={() =>
                                        void prepareAction(
                                          'asin-manual',
                                          child.id,
                                          'group',
                                        )
                                      }
                                    >
                                      {asinGroupManualAction(child) ===
                                      'EXCLUDE_GROUP_MANUAL'
                                        ? '排除组标记'
                                        : '恢复组标记'}
                                    </Button>
                                  )}
                                </>
                              )}
                            </>
                          )}
                          {canDelete && (
                            <Button
                              variant="destructive"
                              size="small"
                              disabled={preparingAction || actionsDisabled}
                              onClick={() =>
                                void prepareAction('delete-asin', child.id)
                              }
                            >
                              删除
                            </Button>
                          )}
                        </div>
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
  canWrite,
  canDelete,
  actionsDisabled,
  onAction,
  onDenied,
}: {
  groups: CatalogGroup[];
  config: CatalogConfig;
  selectedId: string | null;
  onSelect: (id: string) => void;
  canWrite?: boolean;
  canDelete?: boolean;
  actionsDisabled?: boolean;
  onAction?: (action: CatalogAction) => void;
  onDenied?: () => void;
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
            disabled={actionsDisabled}
            onClick={() => toggleGroup(row.original.id)}
          >
            {selectedId === row.original.id ? '收起' : '查看'}
          </Button>
        ),
      },
    ],
    [actionsDisabled, config, selectedId, toggleGroup],
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
              disabled={actionsDisabled}
            />
            {selectedId === row.id && (
              <li>
                <GroupDetail
                  id={row.id}
                  config={config}
                  onClose={() => toggleGroup(row.id)}
                  childPage={childPage}
                  onChildPageChange={setChildPage}
                  canWrite={canWrite}
                  canDelete={canDelete}
                  actionsDisabled={actionsDisabled}
                  onAction={onAction}
                  onDenied={onDenied}
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
                        canWrite={canWrite}
                        canDelete={canDelete}
                        actionsDisabled={actionsDisabled}
                        onAction={onAction}
                        onDenied={onDenied}
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
  const { runtime, identity, announce } = useAuth();
  const auth = useIdentity();
  const ownerId = auth.status === 'authenticated' ? auth.identity.user.id : '';
  const safetyKey = useMemo(
    () => ['catalog-write-safety', ownerId, config.id] as const,
    [config.id, ownerId],
  );
  const safety = useQuery<CatalogSafetyGate | null>({
    queryKey: safetyKey,
    queryFn: () => null,
    enabled: false,
    initialData: () => {
      if (!ownerId || !config.writes) return null;
      const stored = catalogSafetyStorage();
      return stored
        ? readCatalogSafetyGate(stored, ownerId, config.id)
        : { phase: 'inspection' };
    },
    gcTime: Infinity,
  }).data;
  const setSafety = (next: CatalogSafetyGate | null) => {
    const stored = catalogSafetyStorage();
    const saved =
      stored && writeCatalogSafetyGate(stored, ownerId, config.id, next);
    runtime.queryClient.setQueryData(
      safetyKey,
      saved ? next : { phase: 'inspection' },
    );
  };
  const access = createAccess(
    auth.status === 'authenticated' ? auth.identity : undefined,
  );
  const canWrite = Boolean(config.writes && access.canWriteASIN && !safety);
  const canDelete = Boolean(config.writes && access.canDeleteASIN && !safety);
  const [action, setAction] = useState<CatalogAction | null>(null);
  const [actionSerial, setActionSerial] = useState(0);
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  const actionRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [accessRetryError, setAccessRetryError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const recheckActive = useRef(false);
  const [keyword, setKeyword] = useState('');
  const [country, setCountry] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [query, setQuery] = useState<CatalogQuery>(INITIAL_QUERY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const crossTabSafetyRevision = useRef(0);
  const clearCatalogCache = useCallback(async () => {
    await runtime.queryClient
      .cancelQueries({ queryKey: [config.id] })
      .catch(() => undefined);
    runtime.queryClient.removeQueries({ queryKey: [config.id, 'groups'] });
    runtime.queryClient.removeQueries({ queryKey: [config.id, 'group'] });
  }, [config.id, runtime.queryClient]);
  const groups = useQuery({
    queryKey: [config.id, 'groups', query],
    queryFn: ({ signal }) => config.list(runtime.http, query, signal),
    enabled: () =>
      runtime.queryClient.getQueryData<CatalogSafetyGate | null>(safetyKey)
        ?.phase !== 'refresh',
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (!ownerId || !config.writes) return;
    const syncSafety = (event: StorageEvent) => {
      const stored = catalogSafetyStorage();
      if (
        !stored ||
        event.storageArea !== stored ||
        event.key !== catalogSafetyKey(ownerId, config.id)
      )
        return;
      const incoming = readCatalogSafetyGate(stored, ownerId, config.id);
      const revision = ++crossTabSafetyRevision.current;
      if (incoming) {
        runtime.queryClient.setQueryData(safetyKey, incoming);
        if (incoming.phase === 'refresh') {
          setAction(null);
          setSelectedId(null);
          setNotice(null);
          void clearCatalogCache();
        }
        return;
      }
      const currentSafety =
        runtime.queryClient.getQueryData<CatalogSafetyGate | null>(safetyKey);
      if (currentSafety?.phase === 'inspection') return;
      if (currentSafety?.phase !== 'refresh') {
        runtime.queryClient.setQueryData(safetyKey, null);
        return;
      }
      void (async () => {
        try {
          await clearCatalogCache();
          const fresh = await config.list(runtime.http, query);
          if (
            revision !== crossTabSafetyRevision.current ||
            readCatalogSafetyGate(stored, ownerId, config.id)
          )
            return;
          runtime.queryClient.setQueryData([config.id, 'groups', query], fresh);
          runtime.queryClient.setQueryData(
            safetyKey,
            currentSafety.createUncertain ? { phase: 'inspection' } : null,
          );
        } catch {
          // Keep the safety gate until this tab can reread the catalog.
        }
      })();
    };
    window.addEventListener('storage', syncSafety);
    return () => window.removeEventListener('storage', syncSafety);
  }, [clearCatalogCache, config, ownerId, query, runtime, safetyKey]);
  useEffect(() => {
    if (!action) return;
    actionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    actionRef.current?.focus();
  }, [action]);
  const data = groups.data;
  const current = data?.current ?? query.current ?? 1;
  const pageSize = data?.pageSize ?? query.pageSize ?? 10;
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  function openAction(next: CatalogAction) {
    if (writingRef.current || runtime.queryClient.getQueryData(safetyKey))
      return;
    setActionSerial((previous) => previous + 1);
    setAction(next);
  }

  function writingChange(next: boolean) {
    writingRef.current = next;
    setWriting(next);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writingRef.current) return;
    setAction(null);
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
    if (writingRef.current) return;
    setAction(null);
    setSelectedId(null);
    setQuery((previous) => ({ ...previous, current: next }));
  }

  const recheckAccess = useCallback(async () => {
    if (recheckActive.current) return;
    recheckActive.current = true;
    setRechecking(true);
    setAccessRetryError(null);
    try {
      const refreshed = await identity.refresh();
      if (
        refreshed.status !== 'authenticated' ||
        !createAccess(refreshed.identity).canReadASIN
      ) {
        setAccessRetryError('当前账号已无权读取 ASIN 目录。');
        return;
      }
      const fresh = await config.list(runtime.http, query);
      runtime.queryClient.setQueryData([config.id, 'groups', query], fresh);
      setAccessDenied(false);
    } catch {
      setAccessRetryError('重新读取目录失败，请稍后重试。');
    } finally {
      recheckActive.current = false;
      setRechecking(false);
    }
  }, [config, identity, query, runtime]);

  const reportAccessDenied = useCallback(() => {
    setAccessDenied(true);
    setAction(null);
    setSelectedId(null);
    setNotice(null);
    if (recheckActive.current) return;
    const outstanding =
      runtime.queryClient.getQueryData<CatalogSafetyGate | null>(safetyKey);
    runtime.clearUserWork();
    if (outstanding) runtime.queryClient.setQueryData(safetyKey, outstanding);
    void recheckAccess();
  }, [recheckAccess, runtime, safetyKey]);

  async function reportUncertainWrite(uncertainAction: CatalogAction) {
    setSelectedId(null);
    setAction(null);
    setNotice(null);
    setSafety({
      phase: 'refresh',
      message: null,
      detailId:
        uncertainAction.type === 'delete-group' ||
        uncertainAction.type === 'create-group'
          ? null
          : uncertainAction.group.id,
      createUncertain:
        uncertainAction.type === 'create-group' ||
        uncertainAction.type === 'create-asin',
    });
    await clearCatalogCache();
  }

  useEffect(() => {
    if (groups.isError && catalogAccessDenied(groups.error))
      reportAccessDenied();
  }, [groups.error, groups.isError, reportAccessDenied]);

  async function readAfterWrite(detailId: string | null) {
    const detailRequest = detailId
      ? config.detail(runtime.http, detailId).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      : Promise.resolve(null);
    const [firstPage, detailResult] = await Promise.all([
      config.list(runtime.http, query),
      detailRequest,
    ]);
    const lastPage = Math.max(
      1,
      Math.ceil(firstPage.total / firstPage.pageSize),
    );
    const correctedQuery =
      firstPage.current > lastPage ? { ...query, current: lastPage } : query;
    const fresh =
      correctedQuery === query
        ? firstPage
        : await config.list(runtime.http, correctedQuery);
    const stillListed = Boolean(
      detailId && fresh.list.some((item) => item.id === detailId),
    );
    if (
      detailResult &&
      !detailResult.ok &&
      !(
        !stillListed &&
        detailResult.error instanceof ApiError &&
        detailResult.error.status === 404
      )
    )
      throw detailResult.error;
    runtime.queryClient.setQueryData(
      [config.id, 'groups', correctedQuery],
      fresh,
    );
    if (correctedQuery !== query) setQuery(correctedQuery);
    if (detailId && stillListed && detailResult?.ok)
      runtime.queryClient.setQueryData(
        [config.id, 'group', detailId],
        detailResult.value,
      );
    else if (detailId && !stillListed) setSelectedId(null);
  }

  async function afterWrite(message: string, savedAction: CatalogAction) {
    if (savedAction.type === 'delete-group') setSelectedId(null);
    const detailId = savedAction.type === 'delete-group' ? null : selectedId;
    setNotice(null);
    setSafety({
      phase: 'refresh',
      message,
      detailId,
      createUncertain: false,
    });
    try {
      await clearCatalogCache();
      await readAfterWrite(detailId);
      setSafety(null);
      if (message) {
        setNotice(message);
        announce(message);
      }
    } catch (cause) {
      if (catalogAccessDenied(cause)) {
        reportAccessDenied();
      }
    }
  }

  async function retryAfterWrite() {
    if (safety?.phase !== 'refresh') return;
    const { message, detailId, createUncertain } = safety;
    try {
      await readAfterWrite(detailId);
      setSafety(createUncertain ? { phase: 'inspection' } : null);
      if (message) {
        setNotice(message);
        announce(message);
      }
    } catch (cause) {
      if (catalogAccessDenied(cause)) reportAccessDenied();
    }
  }

  async function reconcileCreate() {
    if (safety?.phase !== 'inspection') return;
    try {
      await readAfterWrite(null);
      setSafety(null);
      setNotice('目录已重新读取，请仅在确认原新建记录后继续写入。');
    } catch (cause) {
      if (catalogAccessDenied(cause)) reportAccessDenied();
      else setNotice('目录重读失败，写入仍暂停，请稍后重试。');
    }
  }

  if (accessDenied)
    return (
      <AppShell title={config.title}>
        <div className="space-y-3 rounded-control bg-status-warning-soft p-5 text-sm text-status-warning">
          <p role="alert">访问权限可能已变更，正在重新验证当前身份与目录…</p>
          {accessRetryError && <p role="status">{accessRetryError}</p>}
          {accessRetryError && (
            <Button
              variant="secondary"
              pending={rechecking}
              onClick={() => void recheckAccess()}
            >
              重新验证
            </Button>
          )}
        </div>
      </AppShell>
    );

  if (safety?.phase === 'refresh')
    return (
      <AppShell title={config.title}>
        <div className="space-y-3 rounded-control bg-status-warning-soft p-5 text-sm text-status-warning">
          <p role="alert">
            {safety.message
              ? '写入请求已完成，但目录或详情刷新失败。旧数据已隐藏，请重新读取后继续操作。'
              : '写入结果未确认。旧数据已隐藏，请重新读取核实后再操作，勿直接重试。'}
          </p>
          <Button variant="secondary" onClick={() => void retryAfterWrite()}>
            重新读取目录
          </Button>
        </div>
      </AppShell>
    );

  return (
    <AppShell title={config.title}>
      <div className="space-y-6">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
          <ModuleLabel module={config.id}>
            {config.label} / {canWrite || canDelete ? '目录管理' : '只读目录'}
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
              disabled={writing}
              onClick={() => {
                void groups.refetch();
              }}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
          </div>
        </section>

        {safety?.phase === 'inspection' && (
          <div className="space-y-3 rounded-control bg-status-warning-soft p-4 text-sm text-status-warning">
            <p role="alert">
              新建操作的结果仍未确认。可继续筛选和查看目录；写入已暂停，浏览器刷新后仍会保留此状态。请先核实新记录。
            </p>
            <Button
              variant="secondary"
              size="small"
              onClick={() => void reconcileCreate()}
            >
              已核实原操作，重读目录并恢复写入
            </Button>
          </div>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-control bg-status-success-soft p-4 text-sm text-status-success"
          >
            {notice}
          </p>
        )}
        {action &&
          config.writes &&
          catalogActionAllowed(action, canWrite, canDelete) && (
            <div ref={actionRef} tabIndex={-1}>
              <CatalogActionPanel
                key={actionSerial}
                action={action}
                config={config}
                http={runtime.http}
                close={() =>
                  setAction((current) => (current === action ? null : current))
                }
                saved={afterWrite}
                denied={reportAccessDenied}
                uncertain={reportUncertainWrite}
                writingChange={writingChange}
              />
            </div>
          )}

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
                    disabled={writing}
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
                    disabled={writing}
                    maxLength={10}
                    onChange={(event) => setCountry(event.target.value)}
                    placeholder="例如 US"
                  />
                )}
              </Field>
              <Button
                type="submit"
                disabled={writing}
                className="w-full md:w-auto"
              >
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
                      disabled={writing}
                      onClick={() => {
                        if (writingRef.current) return;
                        setStatus(value);
                        setAction(null);
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
              <div className="flex flex-wrap items-center gap-2">
                {canWrite && (
                  <Button
                    size="small"
                    disabled={writing}
                    onClick={() => openAction({ type: 'create-group' })}
                  >
                    新建变体组
                  </Button>
                )}
                <label className="flex items-center gap-2 text-xs">
                  每页{' '}
                  <select
                    aria-label="每页数量"
                    disabled={writing}
                    className="rounded-control border border-input bg-card px-3 py-2"
                    value={query.pageSize ?? 10}
                    onChange={(event) => {
                      if (writingRef.current) return;
                      setAction(null);
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
              </div>
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
                    onSelect={(id) => {
                      if (writingRef.current) return;
                      setAction(null);
                      setSelectedId(selectedId === id ? null : id);
                    }}
                    canWrite={canWrite}
                    canDelete={canDelete}
                    actionsDisabled={writing}
                    onAction={openAction}
                    onDenied={reportAccessDenied}
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
                      disabled={writing || current <= 1}
                      onClick={() => changePage(current - 1)}
                    >
                      <ChevronLeft aria-hidden="true" />
                      上一页
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={writing || current >= pages}
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
