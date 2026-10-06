import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  FilterChip,
  Progress,
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
import { useTaskQuery } from '../../hooks/tasks';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import { isCheckGroupId } from '../../services/catalog-check';
import { isTerminalTask } from '../../services/tasks';
import { CatalogActionPanel } from './catalog-actions';
import { summarizeCheckResult } from './catalog-check-feedback';
import {
  browserCheckRecovery,
  catalogCheckGateKey,
  type CatalogCheckGate,
  type CheckTarget,
} from './catalog-check-recovery';
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
import {
  CatalogSelectionInput,
  type CatalogSelection,
} from './catalog-selection';
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
type CheckState = {
  target: CheckTarget;
  phase:
    | 'submitting'
    | 'task'
    | 'unknown'
    | 'refreshing'
    | 'completed'
    | 'error';
  gate?: CatalogCheckGate;
  taskId?: string;
  uncertain?: boolean;
  message?: string;
};
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
  selection,
}: {
  group: CatalogGroup;
  config: CatalogConfig;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  selection?: CatalogSelection;
}) {
  return (
    <li className="rounded-control border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {selection && (
            <CatalogSelectionInput group={group} selection={selection} />
          )}
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
  canCheck,
  checkBusy,
  actionsDisabled,
  onAction,
  onCheck,
  onDenied,
}: {
  id: string;
  config: CatalogConfig;
  onClose: () => void;
  childPage: number;
  onChildPageChange: (page: number) => void;
  canWrite?: boolean;
  canDelete?: boolean;
  canCheck?: boolean;
  checkBusy?: boolean;
  actionsDisabled?: boolean;
  onAction?: (action: CatalogAction) => void;
  onCheck?: (target: CheckTarget) => void;
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
            {(canWrite || canDelete || canCheck) && (
              <div className="flex flex-wrap gap-2">
                {canCheck && (
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={checkBusy}
                    onClick={() =>
                      onCheck?.({
                        kind: 'group',
                        id: group.id,
                        label: group.name || group.id,
                      })
                    }
                  >
                    <RefreshCw aria-hidden="true" />
                    立即检查
                  </Button>
                )}
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
                      {(canWrite || canDelete || canCheck) && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {canCheck && (
                            <Button
                              variant="secondary"
                              size="small"
                              disabled={checkBusy}
                              onClick={() =>
                                onCheck?.({
                                  kind: 'asin',
                                  id: child.id,
                                  label: child.asin,
                                })
                              }
                            >
                              <RefreshCw aria-hidden="true" />
                              立即检查
                            </Button>
                          )}
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
  canCheck,
  checkBusy,
  actionsDisabled,
  onAction,
  onCheck,
  onDenied,
  selection,
}: {
  groups: CatalogGroup[];
  config: CatalogConfig;
  selectedId: string | null;
  onSelect: (id: string) => void;
  canWrite?: boolean;
  canDelete?: boolean;
  canCheck?: boolean;
  checkBusy?: boolean;
  actionsDisabled?: boolean;
  onAction?: (action: CatalogAction) => void;
  onCheck?: (target: CheckTarget) => void;
  onDenied?: () => void;
  selection?: CatalogSelection;
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
            {selection && (
              <CatalogSelectionInput
                group={row.original}
                selection={selection}
              />
            )}
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
    [actionsDisabled, config, selectedId, selection, toggleGroup],
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
              selection={selection}
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
                  canCheck={canCheck}
                  checkBusy={checkBusy}
                  actionsDisabled={actionsDisabled}
                  onAction={onAction}
                  onCheck={onCheck}
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
                        canCheck={canCheck}
                        checkBusy={checkBusy}
                        actionsDisabled={actionsDisabled}
                        onAction={onAction}
                        onCheck={onCheck}
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

export function CatalogPage({
  config,
  extra,
}: {
  config: CatalogConfig;
  extra?: ReactNode;
}) {
  const { runtime } = useAuth();
  const auth = useIdentity();
  const access = createAccess(
    auth.status === 'authenticated' ? auth.identity : undefined,
  );
  if (!access.canReadASIN || access.mustChangePassword)
    return (
      <AppShell title={config.title}>
        <p role="alert">
          {access.mustChangePassword
            ? '请先修改密码，再访问目录检查。'
            : '当前身份无权读取 ASIN 目录。'}
        </p>
      </AppShell>
    );
  const scope = JSON.stringify([
    auth.status === 'authenticated' ? auth.identity.user.id : '',
    auth.status === 'authenticated' ? auth.identity.sessionId : '',
    runtime.session?.revision,
    auth.status === 'authenticated' ? auth.identity.permissions : [],
  ]);
  return <CatalogPageBody key={scope} config={config} extra={extra} />;
}

function CatalogPageBody({
  config,
  extra,
}: {
  config: CatalogConfig;
  extra?: ReactNode;
}) {
  const { runtime, identity, announce } = useAuth();
  const auth = useIdentity();
  const ownerId = auth.status === 'authenticated' ? auth.identity.user.id : '';
  const safetyKey = useMemo(
    () => ['catalog-write-safety', ownerId, config.id] as const,
    [config.id, ownerId],
  );
  const [hydratedSafetyKey, setHydratedSafetyKey] = useState<
    typeof safetyKey | null
  >(null);
  const safetyHydrated = !config.writes || hydratedSafetyKey === safetyKey;
  const [storageUnavailable, setStorageUnavailable] = useState(() =>
    Boolean(ownerId && config.writes && !catalogSafetyStorage()),
  );
  const [storageRecoveryError, setStorageRecoveryError] = useState<
    string | null
  >(null);
  const [recoveringStorage, setRecoveringStorage] = useState(false);
  const safety = useQuery<CatalogSafetyGate | null>({
    queryKey: safetyKey,
    queryFn: () => null,
    enabled: false,
    initialData: () => {
      if (!ownerId || !config.writes) return null;
      const stored = catalogSafetyStorage();
      return stored ? readCatalogSafetyGate(stored, ownerId, config.id) : null;
    },
    gcTime: Infinity,
  }).data;
  const setSafety = (
    next: CatalogSafetyGate | null,
    expected?: CatalogSafetyGate,
  ): boolean => {
    const stored = catalogSafetyStorage();
    if (!stored) {
      setStorageUnavailable(true);
      runtime.queryClient.setQueryData(
        safetyKey,
        expected ?? next ?? safety ?? null,
      );
      return false;
    }
    const current = stored
      ? readCatalogSafetyGate(stored, ownerId, config.id)
      : null;
    if (expected && JSON.stringify(current) !== JSON.stringify(expected)) {
      runtime.queryClient.setQueryData(
        safetyKey,
        current ?? { phase: 'inspection' },
      );
      return false;
    }
    const saved =
      stored && writeCatalogSafetyGate(stored, ownerId, config.id, next);
    if (!saved) setStorageUnavailable(true);
    runtime.queryClient.setQueryData(
      safetyKey,
      saved ? next : current ?? expected ?? next,
    );
    return Boolean(saved);
  };
  const runWithCatalogLock = async (work: () => Promise<void>) => {
    if (!navigator.locks)
      throw new ApiError(
        'INVALID_INPUT',
        '浏览器不支持安全的跨标签写入锁，请使用支持 Web Locks 的浏览器。',
      );
    await navigator.locks.request(catalogSafetyKey(ownerId, config.id), work);
  };
  const beginWrite = (candidate: CatalogAction): CatalogSafetyGate => {
    const stored = catalogSafetyStorage();
    if (!stored) {
      setStorageUnavailable(true);
      throw new ApiError(
        'INVALID_INPUT',
        '浏览器本地存储不可用，无法安全提交。',
      );
    }
    const existing = readCatalogSafetyGate(stored, ownerId, config.id);
    if (existing || recovery?.read()) {
      runtime.queryClient.setQueryData(safetyKey, existing);
      throw new ApiError(
        'INVALID_INPUT',
        '已有目录操作或检查结果待核实，请先恢复原操作。',
      );
    }
    const gate: CatalogSafetyGate = {
      phase: 'refresh',
      message: null,
      detailId:
        candidate.type === 'delete-group' || candidate.type === 'create-group'
          ? null
          : candidate.group.id,
      createUncertain:
        candidate.type === 'create-group' || candidate.type === 'create-asin',
      operationId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    if (!writeCatalogSafetyGate(stored, ownerId, config.id, gate)) {
      setStorageUnavailable(true);
      throw new ApiError(
        'INVALID_INPUT',
        '无法保存写入状态，请检查浏览器本地存储权限。',
      );
    }
    return gate;
  };
  const access = createAccess(
    auth.status === 'authenticated' ? auth.identity : undefined,
  );
  const [checkState, setCheckState] = useState<CheckState | null>(null);
  const checkBusyRef = useRef(false);
  const checkBusy =
    checkState?.phase === 'submitting' ||
    checkState?.phase === 'task' ||
    checkState?.phase === 'unknown' ||
    checkState?.phase === 'refreshing';
  const canWrite = Boolean(
    config.writes &&
      safetyHydrated &&
      access.canWriteASIN &&
      !safety &&
      !checkBusy &&
      !storageUnavailable,
  );
  const canDelete = Boolean(
    config.writes &&
      safetyHydrated &&
      (config.id === 'competitor'
        ? access.canWriteASIN
        : access.canDeleteASIN) &&
      !safety &&
      !checkBusy &&
      !storageUnavailable,
  );
  const canCheck = Boolean(config.checks && access.canReadASIN);
  const userId = auth.status === 'authenticated' ? auth.identity.user.id : '';
  const sessionId =
    auth.status === 'authenticated' ? auth.identity.sessionId : undefined;
  const sessionRevision = runtime.session?.revision;
  const currentCheckScope = useCallback(() => {
    const current = identity.getSnapshot();
    const grant = createAccess(
      current.status === 'authenticated' ? current.identity : undefined,
    );
    return (
      current.status === 'authenticated' &&
      current.identity.user.id === userId &&
      current.identity.sessionId === sessionId &&
      runtime.session?.revision === sessionRevision &&
      grant.canReadASIN &&
      !grant.mustChangePassword
    );
  }, [identity, runtime.session, sessionId, sessionRevision, userId]);
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
  const [forceRefresh, setForceRefresh] = useState(true);
  const selectionScope = JSON.stringify(query);
  const [selectedGroups, setSelectedGroups] = useState<{
    scope: string;
    ids: string[];
  }>({ scope: selectionScope, ids: [] });
  const selectedGroupIds =
    selectedGroups.scope === selectionScope ? selectedGroups.ids : [];
  const [confirmation, setConfirmation] = useState<{
    scope: string;
    target: CheckTarget;
    forceRefresh: boolean;
  } | null>(null);
  const pendingConfirmation =
    confirmation?.scope === selectionScope ? confirmation : null;
  const selection: CatalogSelection = {
    ids: selectedGroupIds,
    disabled: checkBusy || writing || Boolean(safety) || storageUnavailable,
    toggle: (id) => {
      if (
        checkBusyRef.current ||
        writingRef.current ||
        safety ||
        !isCheckGroupId(id)
      )
        return;
      setConfirmation(null);
      setSelectedGroups((previous) => {
        const ids = previous.scope === selectionScope ? previous.ids : [];
        return {
          scope: selectionScope,
          ids: ids.includes(id)
            ? ids.filter((value) => value !== id)
            : [...ids, id],
        };
      });
    },
  };
  const mounted = useRef(true);
  const checkOwner = useRef(userId);
  checkOwner.current = userId;
  const checkRequest = useRef<AbortController | null>(null);
  const recovery = useMemo(() => {
    try {
      return config.checks && userId
        ? browserCheckRecovery(config.id, userId, (next) =>
            runtime.queryClient.setQueryData(safetyKey, next),
          )
        : null;
    } catch {
      return null;
    }
  }, [config.checks, config.id, userId, runtime.queryClient, safetyKey]);
  const handledTasks = useRef(new Set<string>());
  const handlingTasks = useRef(new Set<string>());
  const restoreCheck = useCallback(() => {
    if (!recovery || !canCheck) return;
    try {
      const gate = recovery.read();
      if (gate) {
        checkBusyRef.current = true;
        setCheckState({
          target: gate.target,
          gate,
          phase: gate.taskId ? 'task' : 'unknown',
          taskId: gate.taskId,
          uncertain: true,
          message: '上次提交结果待核实，请先查看任务中心；核实前不会重复提交。',
        });
      } else if (!checkRequest.current) {
        checkBusyRef.current = false;
        setCheckState(null);
      }
    } catch {
      setNotice(
        '无法读取浏览器中的检查记录，请恢复本地存储后重试；尚未发送新请求。',
      );
    }
  }, [canCheck, recovery]);
  const restoreCurrentCheck = useRef(restoreCheck);
  restoreCurrentCheck.current = restoreCheck;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      checkRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    restoreCheck();
    const sync = (event: StorageEvent) => {
      if (
        event.key === catalogCheckGateKey(config.id, userId) ||
        event.key === catalogSafetyKey(userId, config.id)
      )
        restoreCheck();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [config.id, restoreCheck, userId]);
  const checkTask = useTaskQuery(
    runtime,
    checkState?.phase === 'task' ? checkState.taskId : undefined,
    checkState?.phase === 'task' && !accessDenied,
  );
  const groups = useQuery({
    queryKey: [config.id, 'groups', query],
    queryFn: ({ signal }) => config.list(runtime.http, query, signal),
    enabled: () =>
      safetyHydrated &&
      runtime.queryClient.getQueryData<CatalogSafetyGate | null>(safetyKey)
        ?.phase !== 'refresh',
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  useLayoutEffect(() => {
    if (!ownerId || !config.writes) return;
    let active = true;
    const syncSafety = (event?: StorageEvent) => {
      // The writable-storage probe broadcasts its own set/remove events to
      // other tabs. Ignore unrelated keys before any probe can broadcast again.
      if (event && event.key !== catalogSafetyKey(ownerId, config.id)) return;
      const stored = catalogSafetyStorage();
      if (!stored) {
        setStorageUnavailable(true);
        return;
      }
      if (event && event.storageArea !== stored) return;
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
      if (
        currentSafety?.phase !== 'refresh' &&
        currentSafety?.phase !== 'inspection' &&
        currentSafety?.phase !== 'check'
      ) {
        runtime.queryClient.setQueryData(safetyKey, null);
        return;
      }
      void (async () => {
        try {
          await clearCatalogCache();
          const firstPage = await config.list(runtime.http, query);
          const lastPage = Math.max(
            1,
            Math.ceil(firstPage.total / firstPage.pageSize),
          );
          const correctedQuery =
            firstPage.current > lastPage
              ? { ...query, current: lastPage }
              : query;
          const fresh =
            correctedQuery === query
              ? firstPage
              : await config.list(runtime.http, correctedQuery);
          if (
            !active ||
            revision !== crossTabSafetyRevision.current ||
            readCatalogSafetyGate(stored, ownerId, config.id)
          )
            return;
          runtime.queryClient.setQueryData(
            [config.id, 'groups', correctedQuery],
            fresh,
          );
          if (correctedQuery !== query) setQuery(correctedQuery);
          runtime.queryClient.setQueryData(safetyKey, null);
        } catch {
          // Keep the safety gate until this tab can reread the catalog.
        }
      })();
    };
    // The disabled query may cache null while the page misses storage events.
    syncSafety();
    setHydratedSafetyKey(safetyKey);
    window.addEventListener('storage', syncSafety);
    return () => {
      active = false;
      window.removeEventListener('storage', syncSafety);
    };
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
    setCheckState(null);
    checkBusyRef.current = false;
    if (recheckActive.current) return;
    const outstanding =
      runtime.queryClient.getQueryData<CatalogSafetyGate | null>(safetyKey);
    runtime.clearUserWork();
    if (outstanding) runtime.queryClient.setQueryData(safetyKey, outstanding);
    void recheckAccess();
  }, [recheckAccess, runtime, safetyKey]);

  const refreshCheckedCatalog = useCallback(async () => {
    const guard = () => {
      if (!mounted.current || !currentCheckScope())
        throw new ApiError('CANCELLED', '身份或页面已变化');
    };
    guard();
    await runtime.queryClient.cancelQueries({ queryKey: [config.id] });
    guard();
    await runtime.queryClient.invalidateQueries({
      queryKey: [config.id],
      refetchType: 'none',
    });
    guard();
    const fresh = await config.list(runtime.http, query);
    guard();
    runtime.queryClient.setQueryData([config.id, 'groups', query], fresh);
    if (selectedId) {
      const detail = await config.detail(runtime.http, selectedId);
      guard();
      runtime.queryClient.setQueryData(
        [config.id, 'group', selectedId],
        detail,
      );
    }
  }, [config, query, runtime, selectedId, currentCheckScope]);

  useEffect(() => {
    if (
      checkState?.phase === 'task' &&
      checkTask.isError &&
      catalogAccessDenied(checkTask.error)
    )
      reportAccessDenied();
  }, [
    checkState?.phase,
    checkTask.error,
    checkTask.isError,
    reportAccessDenied,
  ]);

  useEffect(() => {
    const task = checkTask.data;
    if (
      checkState?.phase !== 'task' ||
      !checkState.taskId ||
      task?.taskId !== checkState.taskId ||
      !isTerminalTask(task.status) ||
      handledTasks.current.has(task.taskId) ||
      handlingTasks.current.has(task.taskId)
    )
      return;
    handlingTasks.current.add(task.taskId);
    setCheckState((current) =>
      current?.taskId === task.taskId
        ? { ...current, phase: 'refreshing' }
        : current,
    );
    const gate = checkState.gate;
    void (async () => {
      const message =
        task.status === 'completed'
          ? summarizeCheckResult(task.result)
          : task.error || task.message || '检查任务未完成。';
      try {
        await refreshCheckedCatalog();
      } catch (error) {
        if (catalogAccessDenied(error)) {
          reportAccessDenied();
          return;
        }
        if (mounted.current && currentCheckScope())
          setCheckState((current) =>
            current?.taskId === task.taskId
              ? {
                  ...current,
                  phase: 'unknown',
                  message:
                    message + '；目录重读未完成，防重记录保留，请核实后重试。',
                }
              : current,
          );
        return;
      }
      if (!mounted.current || !currentCheckScope()) return;
      const cleared =
        !gate ||
        Boolean(
          await recovery?.clear(
            gate,
            () => mounted.current && currentCheckScope(),
          ),
        );
      if (!mounted.current || checkOwner.current !== userId) return;
      if (cleared) handledTasks.current.add(task.taskId);
      checkBusyRef.current = !cleared;
      setCheckState((current) =>
        current?.taskId === task.taskId
          ? {
              ...current,
              phase: cleared
                ? task.status === 'completed'
                  ? 'completed'
                  : 'error'
                : 'unknown',
              message: cleared
                ? message
                : '任务已结束，但无法清除浏览器检查记录，请恢复存储后重新核实。',
            }
          : current,
      );
    })()
      .catch(() => {
        if (mounted.current && checkOwner.current === userId)
          setCheckState((current) =>
            current?.taskId === task.taskId
              ? {
                  ...current,
                  phase: 'unknown',
                  message: '无法保存任务核实结果，请恢复浏览器存储后重试。',
                }
              : current,
          );
      })
      .finally(() => handlingTasks.current.delete(task.taskId));
  }, [
    checkState,
    checkTask.data,
    refreshCheckedCatalog,
    reportAccessDenied,
    recovery,
    userId,
    currentCheckScope,
  ]);

  async function runCheck(
    target: CheckTarget,
    requestedForceRefresh = forceRefresh,
  ) {
    if (
      !config.checks ||
      !canCheck ||
      !currentCheckScope() ||
      writingRef.current ||
      checkBusyRef.current ||
      checkBusy
    )
      return;
    checkBusyRef.current = true;
    setNotice(null);
    setCheckState({ target, phase: 'submitting' });
    const current = () => mounted.current && currentCheckScope();
    const controller = new AbortController();
    checkRequest.current = controller;
    let staleSubmission = false;
    try {
      if (!recovery) throw new Error('CHECK_GATE_UNAVAILABLE');
      const result = await recovery.submit(
        target,
        () =>
          target.kind === 'batch'
            ? config.checks!.batch!(
                runtime.http,
                target.groupIds,
                { forceRefresh: requestedForceRefresh },
                controller.signal,
              )
            : config.checks![target.kind](
                runtime.http,
                target.id,
                { forceRefresh: requestedForceRefresh },
                controller.signal,
              ),
        current,
      );
      if (!current() || result.kind === 'stale') {
        staleSubmission = true;
        return;
      }
      if (result.kind === 'task' || result.kind === 'blocked') {
        setSelectedGroups({ scope: selectionScope, ids: [] });
        const gate = result.gate;
        setCheckState({
          target: gate.target,
          gate,
          phase: gate.taskId ? 'task' : 'unknown',
          taskId: gate.taskId,
          uncertain: result.kind === 'blocked' || result.uncertain,
          message: '已有提交待核实，请先查看任务中心。',
        });
        if (result.kind === 'task' && !result.persisted)
          setNotice(
            `浏览器未能保存最新任务编号，请记录 ${gate.taskId} 并到任务中心核实；原防重记录仍保留。`,
          );
        void runtime.queryClient.invalidateQueries({
          queryKey: ['tasks', 'list'],
        });
        return;
      }
      if (result.kind === 'unknown' || result.kind === 'rejected') {
        const uncertain = result.kind === 'unknown';
        checkBusyRef.current = uncertain;
        setCheckState({
          target,
          gate: uncertain ? result.gate : undefined,
          phase: uncertain ? 'unknown' : 'error',
          message: uncertain
            ? '提交结果未确认，请按提交时间和目标到任务中心核实，避免重复检查。'
            : catalogError(result.error),
        });
        if (catalogAccessDenied(result.error)) reportAccessDenied();
        return;
      }
      if (!result.cleared) {
        setCheckState({
          target,
          gate: result.gate,
          phase: 'unknown',
          message:
            '检查已完成，但无法清除本地记录；请核实目录并恢复存储后解锁。',
        });
        return;
      }
      setCheckState({ target, phase: 'refreshing' });
      try {
        await refreshCheckedCatalog();
        if (!current()) return;
        setCheckState({
          target,
          phase: 'completed',
          message: summarizeCheckResult(result.result),
        });
      } catch (error) {
        if (!current()) return;
        if (catalogAccessDenied(error)) {
          reportAccessDenied();
          return;
        }
        setCheckState({
          target,
          phase: 'completed',
          message: '检查完成，目录刷新失败，请手动刷新。',
        });
      } finally {
        checkBusyRef.current = false;
      }
    } catch (error) {
      if (!current()) return;
      checkBusyRef.current = false;
      if (catalogAccessDenied(error)) {
        reportAccessDenied();
        return;
      }
      setCheckState({
        target,
        phase: 'error',
        message:
          error instanceof ApiError
            ? catalogError(error)
            : '无法安全保存检查记录，请恢复浏览器本地存储和跨标签锁后重试；尚未发送新请求。',
      });
    } finally {
      if (checkRequest.current === controller) {
        checkRequest.current = null;
        // The new owner's effect may have run while this old request was set.
        // Restore that owner's persisted gate, rather than clearing shared state.
        if (mounted.current && (staleSubmission || !current()))
          restoreCurrentCheck.current();
      }
    }
  }

  async function reconcileCheck() {
    const gate = checkState?.gate;
    if (!gate || !recovery || checkRequest.current || !currentCheckScope())
      return;
    try {
      const outcome = await recovery.reconcile(
        gate,
        (id) => runtime.tasks.get(id),
        refreshCheckedCatalog,
        () => mounted.current && currentCheckScope(),
      );
      if (!mounted.current || !currentCheckScope()) return;
      if (outcome === 'active') {
        setCheckState({
          target: gate.target,
          gate,
          taskId: gate.taskId,
          phase: 'task',
        });
        setNotice('该任务仍在排队或执行，请等待终态或到任务中心核实。');
        return;
      }
      if (outcome !== 'cleared') {
        restoreCheck();
        setNotice('检查记录已变化或存储不可用，请重新核实。');
        return;
      }
      checkBusyRef.current = false;
      setCheckState(null);
      setNotice('已核实原任务，可以重新提交检查。');
    } catch (error) {
      if (!mounted.current || checkOwner.current !== userId) return;
      if (catalogAccessDenied(error)) reportAccessDenied();
      else
        setNotice(
          '任务核实或目录重读未完成，防重记录继续保留。请到任务中心核实后重试读取。',
        );
    }
  }

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

  async function reportUncertainWrite(
    uncertainAction: CatalogAction,
    claim: CatalogSafetyGate,
  ) {
    setSelectedId(null);
    setAction(null);
    setNotice(null);
    setSafety(
      {
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
        operationId: claim.operationId,
      },
      claim,
    );
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

  async function afterWrite(
    message: string,
    savedAction: CatalogAction,
    claim: CatalogSafetyGate,
  ) {
    if (savedAction.type === 'delete-group') setSelectedId(null);
    const detailId = savedAction.type === 'delete-group' ? null : selectedId;
    setNotice(null);
    const refreshedGate: CatalogSafetyGate = {
      phase: 'refresh',
      message,
      detailId,
      createUncertain: false,
      operationId: claim.operationId,
    };
    if (!setSafety(refreshedGate, claim)) return;
    try {
      await clearCatalogCache();
      await readAfterWrite(detailId);
      setSafety(null, refreshedGate);
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
    let refreshed = false;
    try {
      await runWithCatalogLock(async () => {
        const stored = catalogSafetyStorage();
        const current = stored
          ? readCatalogSafetyGate(stored, ownerId, config.id)
          : null;
        if (!stored) {
          setStorageUnavailable(true);
          return;
        }
        if (!current) {
          await readAfterWrite(detailId);
          const latest = readCatalogSafetyGate(stored, ownerId, config.id);
          runtime.queryClient.setQueryData(safetyKey, latest);
          refreshed = !latest;
          return;
        }
        if (JSON.stringify(current) !== JSON.stringify(safety)) {
          runtime.queryClient.setQueryData(safetyKey, current);
          return;
        }
        await readAfterWrite(detailId);
        refreshed = setSafety(
          createUncertain
            ? { phase: 'inspection', operationId: safety.operationId }
            : null,
          safety,
        );
      });
      if (!refreshed) return;
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
    let reconciled = false;
    try {
      await runWithCatalogLock(async () => {
        const stored = catalogSafetyStorage();
        const current = stored
          ? readCatalogSafetyGate(stored, ownerId, config.id)
          : null;
        if (!stored) {
          setStorageUnavailable(true);
          return;
        }
        if (!current) {
          await readAfterWrite(null);
          const latest = readCatalogSafetyGate(stored, ownerId, config.id);
          runtime.queryClient.setQueryData(safetyKey, latest);
          reconciled = !latest;
          return;
        }
        if (JSON.stringify(current) !== JSON.stringify(safety)) {
          runtime.queryClient.setQueryData(safetyKey, current);
          return;
        }
        await readAfterWrite(null);
        reconciled = setSafety(null, safety);
      });
      if (!reconciled) return;
      setNotice('目录已重新读取，请仅在确认原新建记录后继续写入。');
    } catch (cause) {
      if (catalogAccessDenied(cause)) reportAccessDenied();
      else setNotice('目录重读失败，写入仍暂停，请稍后重试。');
    }
  }

  async function recoverStorage() {
    if (recoveringStorage) return;
    setRecoveringStorage(true);
    setStorageRecoveryError(null);
    try {
      await runWithCatalogLock(async () => {
        const stored = catalogSafetyStorage();
        if (!stored) {
          setStorageRecoveryError(
            '本地存储仍不可用，请允许此站点保存数据后重试。',
          );
          return;
        }
        const outstanding =
          readCatalogSafetyGate(stored, ownerId, config.id) ??
          runtime.queryClient.getQueryData<CatalogSafetyGate | null>(safetyKey);
        if (outstanding) {
          // Storage recovery must never acknowledge an unconfirmed mutation.
          runtime.queryClient.setQueryData(safetyKey, outstanding);
        } else {
          await readAfterWrite(null);
          runtime.queryClient.setQueryData(
            safetyKey,
            readCatalogSafetyGate(stored, ownerId, config.id),
          );
        }
        setStorageUnavailable(false);
      });
    } catch (cause) {
      if (catalogAccessDenied(cause)) reportAccessDenied();
      else
        setStorageRecoveryError(
          '恢复检查未完成，请确认本地存储及跨标签锁可用，并重试读取目录。',
        );
    } finally {
      setRecoveringStorage(false);
    }
  }

  const storageWarning = storageUnavailable && (
    <div className="space-y-3 rounded-control bg-status-warning-soft p-4 text-sm text-status-warning">
      <p role="alert">
        浏览器本地存储不可用，写入已暂停。可继续查看目录；请允许此站点保存数据后检查恢复。已有待核实操作会继续保留。
      </p>
      {storageRecoveryError && <p role="status">{storageRecoveryError}</p>}
      <Button
        variant="secondary"
        size="small"
        pending={recoveringStorage}
        onClick={() => void recoverStorage()}
      >
        检查存储并恢复
      </Button>
    </div>
  );

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
        {storageWarning}
        <div className="space-y-3 rounded-control bg-status-warning-soft p-5 text-sm text-status-warning">
          <p role="alert">
            {safety.message
              ? '写入请求已完成，但目录或详情刷新失败。旧数据已隐藏，请重新读取后继续操作。'
              : '写入结果未确认。旧数据已隐藏，请重新读取核实后再操作，勿直接重试。'}
          </p>
          <Button
            variant="secondary"
            disabled={storageUnavailable}
            onClick={() => void retryAfterWrite()}
          >
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

        {storageWarning}
        {safety?.phase === 'check-invalid' && (
          <p
            role="alert"
            className="rounded-control bg-status-warning-soft p-4 text-sm"
          >
            检查恢复记录损坏，目录操作已暂停。请人工核实原任务和目录后修复恢复记录。
          </p>
        )}
        {safety?.phase === 'inspection' && (
          <div className="space-y-3 rounded-control bg-status-warning-soft p-4 text-sm text-status-warning">
            <p role="alert">
              新建操作的结果仍未确认。可继续筛选和查看目录；写入已暂停，浏览器刷新后仍会保留此状态。请先核实新记录。
            </p>
            <Button
              variant="secondary"
              size="small"
              disabled={storageUnavailable}
              onClick={() => void reconcileCreate()}
            >
              已核实原操作，重读目录并恢复写入
            </Button>
          </div>
        )}
        {extra}
        {pendingConfirmation && !checkBusy && (
          <section
            aria-label="确认检查"
            className="space-y-3 rounded-control border border-border bg-muted/55 p-4 text-sm"
          >
            <h2 className="font-semibold">确认提交检查</h2>
            <p>
              {pendingConfirmation.target.label}；
              {pendingConfirmation.forceRefresh
                ? '强制刷新最新数据'
                : '允许使用缓存'}
              。提交后可到任务中心查看进度。
            </p>
            <ul className="neo-mono max-h-40 overflow-auto break-all text-xs">
              {(pendingConfirmation.target.kind === 'batch'
                ? pendingConfirmation.target.groupIds
                : [pendingConfirmation.target.id]
              ).map((id) => (
                <li key={id}>{JSON.stringify(id)}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                size="small"
                disabled={writing || Boolean(safety) || storageUnavailable}
                onClick={() => {
                  const snapshot = pendingConfirmation;
                  setConfirmation(null);
                  void runCheck(snapshot.target, snapshot.forceRefresh);
                }}
              >
                确认提交检查
              </Button>
              <Button
                size="small"
                variant="ghost"
                onClick={() => setConfirmation(null)}
              >
                取消
              </Button>
            </div>
          </section>
        )}

        {notice && (
          <p
            role="status"
            className="rounded-control bg-status-success-soft p-4 text-sm text-status-success"
          >
            {notice}
          </p>
        )}
        {checkState && (
          <section
            aria-label="即时检查状态"
            className={
              'rounded-control border p-4 text-sm ' +
              (checkState.phase === 'error'
                ? 'border-status-danger/25 bg-status-danger-soft'
                : checkState.phase === 'completed'
                ? 'border-status-success/25 bg-status-success-soft'
                : 'border-border bg-muted/55')
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="break-words font-semibold">
                  {checkState.target.label} · 即时检查
                </p>
                <p role="status" className="break-words text-muted-foreground">
                  {checkState.phase === 'submitting'
                    ? '正在提交检查任务…'
                    : checkState.phase === 'refreshing'
                    ? '正在更新目录…'
                    : checkState.phase === 'task'
                    ? checkTask.data?.message ||
                      (checkState.uncertain && !checkTask.data
                        ? '提交状态待确认，正在查询任务。'
                        : checkTask.data?.status === 'processing'
                        ? '正在检查…'
                        : '任务已入队，等待处理。')
                    : checkState.message}
                </p>
                {checkState.taskId && (
                  <p className="neo-mono break-all text-xs text-muted-foreground">
                    {checkState.taskId}
                  </p>
                )}
                {checkState.gate && (
                  <p className="text-xs text-muted-foreground">
                    提交时间（北京时间）：
                    {formatBeijing(checkState.gate.submittedAt)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {(checkState.taskId || checkState.gate) && (
                  <Link
                    to="/tasks"
                    className="inline-flex min-h-9 items-center rounded-control px-2 text-xs font-semibold text-primary underline underline-offset-4"
                  >
                    任务中心
                  </Link>
                )}
                {!checkBusy && (
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => setCheckState(null)}
                  >
                    关闭
                  </Button>
                )}
              </div>
            </div>
            {checkState.phase === 'task' && (
              <div className="mt-4">
                <Progress value={checkTask.data?.progress} label="检查进度" />
                {checkTask.isError && (
                  <div
                    role="alert"
                    className="mt-3 flex flex-wrap items-center gap-3"
                  >
                    <span>
                      任务状态读取失败：{catalogError(checkTask.error)}
                    </span>
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => void checkTask.refetch()}
                    >
                      重试读取
                    </Button>
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => {
                        setCheckState((current) =>
                          current?.taskId
                            ? {
                                ...current,
                                phase: 'unknown',
                                message:
                                  '已停止本页跟踪，防重记录仍保留；请到任务中心核实后恢复。',
                              }
                            : current,
                        );
                      }}
                    >
                      停止跟踪
                    </Button>
                  </div>
                )}
              </div>
            )}
            {checkState.phase === 'unknown' && checkState.gate && (
              <div className="mt-3 space-y-3">
                <p>
                  请先核对任务中心中的提交时间、检查目标和结果，确认原任务不会继续执行。刷新页面不会解除防重记录。
                </p>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => void reconcileCheck()}
                >
                  已核实原任务，恢复检查
                </Button>
              </div>
            )}
          </section>
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
                runExclusive={runWithCatalogLock}
                beginWrite={beginWrite}
                releaseWrite={(claim) => {
                  setSafety(null, claim);
                }}
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
                {canCheck && (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={forceRefresh}
                      disabled={checkBusy || writing || Boolean(safety)}
                      onChange={(event) =>
                        setForceRefresh(event.target.checked)
                      }
                    />
                    强制刷新
                  </label>
                )}
                {canCheck && config.checks?.batch && (
                  <>
                    <span className="text-xs text-muted-foreground">
                      已选 {selectedGroupIds.length} 组
                    </span>
                    <Button
                      size="small"
                      disabled={
                        selection.disabled || selectedGroupIds.length === 0
                      }
                      onClick={() =>
                        setConfirmation({
                          scope: selectionScope,
                          forceRefresh,
                          target: {
                            kind: 'batch',
                            id: 'batch',
                            label: `所选 ${selectedGroupIds.length} 个主营变体组`,
                            groupIds: [...selectedGroupIds],
                          },
                        })
                      }
                    >
                      检查所选组
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={
                        selection.disabled || selectedGroupIds.length === 0
                      }
                      onClick={() => {
                        setSelectedGroups({ scope: selectionScope, ids: [] });
                        setConfirmation(null);
                      }}
                    >
                      清空选择
                    </Button>
                  </>
                )}
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
                    canCheck={canCheck}
                    checkBusy={checkBusy || writing || Boolean(safety)}
                    selection={
                      canCheck && config.checks?.batch ? selection : undefined
                    }
                    actionsDisabled={writing}
                    onAction={openAction}
                    onCheck={(target) =>
                      config.id === 'competitor'
                        ? setConfirmation({
                            scope: selectionScope,
                            target,
                            forceRefresh,
                          })
                        : void runCheck(target)
                    }
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
