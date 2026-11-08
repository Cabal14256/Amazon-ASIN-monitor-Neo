import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
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
  type RefObject,
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
import { useCreateExportTask, useTaskQuery } from '../../hooks/tasks';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import { isCheckGroupId } from '../../services/catalog-check';
import { isTerminalTask } from '../../services/tasks';
import { AsinBatchCreatePanel } from '../asin/asin-batch-create-panel';
import { AsinBatchCreateResult } from '../asin/asin-batch-create-result';
import {
  readAsinBatchReceipt,
  removeAsinBatchReceipt,
  saveAsinBatchReceipt,
  type AsinBatchReceipt,
} from '../asin/asin-batch-receipt';
import { importGateKey } from '../asin/asin-import-gate';
import { CatalogActionPanel } from './catalog-actions';
import { useCatalogBatchDelete } from './catalog-batch-delete';
import { retireBatchReceiptAfterIdentityChange } from './catalog-batch-receipt-retirement';
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
import { CATALOG_GATE_CHANGED } from './catalog-gate-events';
import { runWithCatalogOperationLock } from './catalog-operation-lock';
import { CatalogRefreshContext } from './catalog-refresh-context';
import {
  canRecoverKnownBatchDeleteReceipt,
  catalogImportBlocksWrite,
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
import { CompetitorExportControls } from './competitor-export';
import { PrimaryAsinExportControls } from './primary-export';

const PAGE_SIZES = [1, 10, 20, 50, 100] as const;
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
type AcceptedCheckMemory = {
  scope: symbol;
  gate?: CatalogCheckGate;
  authorizationFailures?: number;
};
interface RetainedBatchReceipt {
  receipt: AsinBatchReceipt;
  owner: string;
}
function sameCheckReservation(left: CatalogCheckGate, right: CatalogCheckGate) {
  return (
    left.requestId === right.requestId &&
    left.submittedAt === right.submittedAt &&
    JSON.stringify(left.target) === JSON.stringify(right.target)
  );
}
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
      } else if (type === 'batch-create-asins') {
        onAction({ type, group: fresh });
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
                        {config.writes?.batchCreateAsins && (
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={preparingAction || actionsDisabled}
                            onClick={() =>
                              void prepareAction('batch-create-asins')
                            }
                          >
                            批量添加 ASIN
                          </Button>
                        )}
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
  const { runtime, identity } = useAuth();
  const auth = useIdentity();
  // Keep completed receipt retirement above the permission-scoped body. A
  // permission-only unmount must not lose cleanup when that session later ends.
  const batchResultRef = useRef<RetainedBatchReceipt | null>(null);
  useEffect(() => {
    const retire = () => {
      const previous = batchResultRef.current;
      if (!previous) return;
      // Transfer once to the existing retirement lifecycle. Repeated identity
      // notifications must not queue cleanup for this receipt a second time.
      batchResultRef.current = null;
      retireBatchReceiptAfterIdentityChange(
        identity,
        runtime,
        previous.receipt,
        previous.owner,
        () => undefined,
      );
    };
    const unsubscribe = identity.subscribe(() => {
      const current = identity.getSnapshot();
      const previous = batchResultRef.current;
      if (
        previous &&
        (current.status === 'anonymous' ||
          (current.status === 'authenticated' &&
            JSON.stringify([
              config.id,
              current.identity.user.id,
              current.identity.sessionId ?? null,
            ]) !== previous.owner))
      )
        retire();
    });
    return () => {
      unsubscribe();
      retire();
    };
  }, [config.id, identity, runtime]);
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
  return (
    <CatalogPageBody
      key={scope}
      config={config}
      extra={extra}
      batchResultRef={batchResultRef}
    />
  );
}

function CatalogPageBody({
  config,
  extra,
  batchResultRef,
}: {
  config: CatalogConfig;
  extra?: ReactNode;
  batchResultRef: RefObject<RetainedBatchReceipt | null>;
}) {
  const { runtime, identity, announce } = useAuth();
  const auth = useIdentity();
  const exportTask = useCreateExportTask(runtime);
  const ownerId = auth.status === 'authenticated' ? auth.identity.user.id : '';
  const peerSessionId =
    auth.status === 'authenticated' ? auth.identity.sessionId : undefined;
  const safetyKey = useMemo(
    () => ['catalog-write-safety', ownerId, config.id] as const,
    [config.id, ownerId],
  );
  const [hydratedSafetyKey, setHydratedSafetyKey] = useState<
    typeof safetyKey | null
  >(null);
  const safetyHydrated = !config.writes || hydratedSafetyKey === safetyKey;
  const importSafetyKey = useMemo(
    () => ['catalog-import-safety', ownerId, config.id] as const,
    [ownerId, config.id],
  );
  const importBlocked = useQuery({
    queryKey: importSafetyKey,
    queryFn: () => false,
    enabled: false,
    initialData: () => {
      if (!ownerId || !config.writes) return false;
      const stored = catalogSafetyStorage();
      return !stored || catalogImportBlocksWrite(stored, ownerId, config.id);
    },
    gcTime: Infinity,
  }).data;
  const [storageUnavailable, setStorageUnavailable] = useState(() =>
    Boolean(ownerId && config.writes && !catalogSafetyStorage()),
  );
  const [storageRecoveryError, setStorageRecoveryError] = useState<
    string | null
  >(null);
  const [recoveringStorage, setRecoveringStorage] = useState(false);
  const [peerRefreshRetry, setPeerRefreshRetry] = useState(0);
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
    expected?: CatalogSafetyGate | null,
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
    if (
      expected !== undefined &&
      JSON.stringify(current) !== JSON.stringify(expected)
    ) {
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
    await runWithCatalogOperationLock(
      navigator.locks,
      ownerId,
      config.id,
      work,
    );
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
    if (catalogImportBlocksWrite(stored, ownerId, config.id)) {
      runtime.queryClient.setQueryData(importSafetyKey, true);
      throw new ApiError(
        'INVALID_INPUT',
        '已有导入请求待核实，导入保护解除前不能写入目录。',
      );
    }
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
        candidate.type === 'create-group' ||
        candidate.type === 'create-asin' ||
        candidate.type === 'batch-create-asins',
      operationId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...(candidate.type === 'batch-create-asins'
        ? { batchCreate: true, batchCreateOwner: batchOwner }
        : {}),
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
      !importBlocked &&
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
      !importBlocked &&
      !storageUnavailable,
  );
  const canCheck = Boolean(config.checks && access.canReadASIN);
  const userId = auth.status === 'authenticated' ? auth.identity.user.id : '';
  const sessionId =
    auth.status === 'authenticated' ? auth.identity.sessionId : undefined;
  const sessionRevision = runtime.session?.revision;
  const acceptedCheckKey = useMemo(
    () =>
      [
        'catalog-check-accepted',
        config.id,
        userId,
        sessionId,
        sessionRevision,
      ] as const,
    [config.id, userId, sessionId, sessionRevision],
  );
  // A valid ACK may outlive the mounted route when both storage areas reject
  // its update. A removed submission scope must never be recreated by late ACKs.
  useEffect(() => {
    runtime.queryClient.setQueryDefaults(['catalog-check-accepted'], {
      gcTime: Infinity,
    });
  }, [runtime.queryClient]);
  useQuery<AcceptedCheckMemory | null>({
    queryKey: acceptedCheckKey,
    queryFn: () => null,
    enabled: false,
    gcTime: Infinity,
  });
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
  const batchOwner = JSON.stringify([
    config.id,
    ownerId,
    auth.status === 'authenticated' ? auth.identity.sessionId ?? null : null,
  ]);
  const batchPending = useRef<{
    serial: number;
    owner: string;
    userId: string;
    source: 'asin' | 'competitor';
    queryClient: typeof runtime.queryClient;
  } | null>(null);
  const [batchResult, setBatchResult] = useState<{
    serial: number;
    owner: string;
    groupName: string;
    result: BatchCreateAsinsData;
    receipt: AsinBatchReceipt;
    persisted: boolean;
    recoveredFromOwner?: string;
  } | null>(null);
  // A permission-only transition hides the result, but its original receipt
  // still needs cleanup if this session is subsequently logged out/replaced.
  if (batchResult) batchResultRef.current = batchResult;
  const knownBatchReceipts = useRef(
    new Map<string, { receipt: AsinBatchReceipt; persisted: boolean }>(),
  );
  const retireBatchReceipt = useCallback(
    (receipt: AsinBatchReceipt, displayedOwner: string) => {
      retireBatchReceiptAfterIdentityChange(
        identity,
        runtime,
        receipt,
        displayedOwner,
        () => {
          const memory = knownBatchReceipts.current.get(receipt.operationId);
          if (memory?.receipt.owner === receipt.owner)
            knownBatchReceipts.current.delete(receipt.operationId);
        },
      );
    },
    [identity, runtime],
  );
  const [batchReceiptWarning, setBatchReceiptWarning] = useState<string | null>(
    null,
  );
  const [batchRecoveryNotice, setBatchRecoveryNotice] = useState<string | null>(
    null,
  );
  const [recoveringBatchReceipt, setRecoveringBatchReceipt] = useState(false);
  const batchReceiptRecoveryEpoch = useRef(0);
  const [accessDenied, setAccessDenied] = useState(false);
  const [accessRetryError, setAccessRetryError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const recheckActive = useRef(false);
  const [keyword, setKeyword] = useState('');
  const [country, setCountry] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [query, setQuery] = useState<CatalogQuery>(INITIAL_QUERY);
  const importReadEpoch = useRef(0);
  const importSessionRevision = runtime.session.revision;
  useLayoutEffect(() => {
    importReadEpoch.current++;
  }, [query, ownerId, peerSessionId, importSessionRevision]);
  const refreshImportedCatalog = useMemo(
    () => async () => {
      const epoch = importReadEpoch.current;
      const check = () => {
        const state = identity.getSnapshot();
        const policy = createAccess(
          state.status === 'authenticated' ? state.identity : undefined,
        );
        if (
          importReadEpoch.current !== epoch ||
          runtime.session.revision !== importSessionRevision ||
          state.status !== 'authenticated' ||
          state.identity.user.id !== ownerId ||
          state.identity.sessionId !== peerSessionId ||
          !policy.canReadASIN ||
          policy.mustChangePassword
        )
          throw new ApiError(
            'CANCELLED',
            '目录查询或会话已改变，请重读当前目录后再解除导入保护',
          );
      };
      check();
      await runtime.queryClient.cancelQueries({ queryKey: [config.id] });
      check();
      const first = await config.list(runtime.http, query);
      check();
      const last = Math.max(1, Math.ceil(first.total / first.pageSize));
      const corrected =
        first.current > last ? { ...query, current: last } : query;
      const fresh =
        corrected === query
          ? first
          : await config.list(runtime.http, corrected);
      check();
      runtime.queryClient.removeQueries({ queryKey: [config.id, 'group'] });
      runtime.queryClient.setQueryData([config.id, 'groups', corrected], fresh);
      if (corrected !== query) setQuery(corrected);
    },
    [
      config,
      identity,
      importSessionRevision,
      ownerId,
      peerSessionId,
      query,
      runtime,
    ],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const crossTabSafetyRevision = useRef(0);
  const clearCatalogCache = useCallback(
    async (guard?: () => void) => {
      guard?.();
      await runtime.queryClient
        .cancelQueries({ queryKey: [config.id] })
        .catch(() => undefined);
      guard?.();
      runtime.queryClient.removeQueries({ queryKey: [config.id, 'groups'] });
      runtime.queryClient.removeQueries({ queryKey: [config.id, 'group'] });
    },
    [config.id, runtime.queryClient],
  );
  const [forceRefresh, setForceRefresh] = useState(true);
  const selectionScope = JSON.stringify(query);
  const catalogReadRevision = useRef(0);
  useLayoutEffect(() => {
    // Include a monotonic revision so changing away and back cannot authorize
    // an earlier response to unlock the current catalog.
    ++catalogReadRevision.current;
  }, [selectionScope, selectedId]);
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
  useLayoutEffect(() => {
    // Invalidate the stored targets, not only their visibility. Returning to a
    // previous query must never revive an old selection or confirmation.
    setSelectedGroups({ scope: selectionScope, ids: [] });
    setConfirmation(null);
  }, [selectionScope]);
  const selection: CatalogSelection = {
    ids: selectedGroupIds,
    disabled:
      !safetyHydrated ||
      importBlocked ||
      checkBusy ||
      writing ||
      Boolean(safety) ||
      storageUnavailable,
    toggle: (id) => {
      if (
        !safetyHydrated ||
        importBlocked ||
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
  const peerCheckRequest = useRef<AbortController | null>(null);
  const invalidatePeerCheck = useCallback(() => {
    ++crossTabSafetyRevision.current;
    peerCheckRequest.current?.abort();
  }, []);
  const [peerCheckRefresh, setPeerCheckRefresh] = useState<
    'reading' | 'failed' | null
  >(null);
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
      const durable = recovery.read();
      const memory =
        runtime.queryClient.getQueryData<AcceptedCheckMemory>(acceptedCheckKey);
      const accepted = memory?.gate;
      const matches =
        durable &&
        accepted &&
        sameCheckReservation(durable, accepted) &&
        (!durable.taskId || durable.taskId === accepted.taskId);
      const gate =
        matches && !durable.taskId
          ? { ...durable, taskId: accepted.taskId }
          : durable;
      if (accepted && !matches)
        runtime.queryClient.setQueryData(acceptedCheckKey, null);
      if (gate) {
        const paused = matches && (memory?.authorizationFailures ?? 0) >= 2;
        checkBusyRef.current = true;
        setCheckState({
          target: gate.target,
          gate,
          phase: gate.taskId && !paused ? 'task' : 'unknown',
          taskId: gate.taskId,
          uncertain: true,
          message: paused
            ? '任务状态连续无权读取，自动重试已暂停；请到任务中心核实，或重试核实原任务。任务编号和防重记录继续保留。'
            : '上次提交结果待核实，请先查看任务中心；核实前不会重复提交。',
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
  }, [canCheck, recovery, acceptedCheckKey, runtime.queryClient]);
  const restoreCurrentCheck = useRef(restoreCheck);
  restoreCurrentCheck.current = restoreCheck;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      checkRequest.current?.abort();
      peerCheckRequest.current?.abort();
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
  const rereadReleasedCheck = useCallback(
    async (stored: Storage, revision: number) => {
      peerCheckRequest.current?.abort();
      const controller = new AbortController();
      peerCheckRequest.current = controller;
      const current = () =>
        mounted.current &&
        currentCheckScope() &&
        !controller.signal.aborted &&
        revision === crossTabSafetyRevision.current;
      const guard = () => {
        if (!current()) throw new ApiError('CANCELLED', '身份或页面已变化');
      };
      setPeerCheckRefresh('reading');
      try {
        guard();
        await clearCatalogCache();
        guard();
        const firstPage = await config.list(
          runtime.http,
          query,
          controller.signal,
        );
        guard();
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
            : await config.list(
                runtime.http,
                correctedQuery,
                controller.signal,
              );
        guard();
        const latest = readCatalogSafetyGate(stored, ownerId, config.id);
        if (latest || recovery?.read()) {
          if (latest) runtime.queryClient.setQueryData(safetyKey, latest);
          restoreCheck();
          setPeerCheckRefresh(null);
          return;
        }
        runtime.queryClient.setQueryData(
          [config.id, 'groups', correctedQuery],
          fresh,
        );
        if (correctedQuery !== query) setQuery(correctedQuery);
        runtime.queryClient.setQueryData(safetyKey, null);
        setPeerCheckRefresh(null);
      } catch {
        if (current()) setPeerCheckRefresh('failed');
        // The cached check still blocks operations until a successful GET.
      } finally {
        if (peerCheckRequest.current === controller)
          peerCheckRequest.current = null;
      }
    },
    [
      clearCatalogCache,
      config,
      currentCheckScope,
      ownerId,
      query,
      recovery,
      restoreCheck,
      runtime,
      safetyKey,
    ],
  );
  useLayoutEffect(() => {
    if (!ownerId || !config.writes) return;
    let active = true;
    const syncSafety = (event?: StorageEvent) => {
      // The writable-storage probe broadcasts its own set/remove events to
      // other tabs. Ignore unrelated keys before any probe can broadcast again.
      if (
        event &&
        event.key !== null &&
        event.key !== catalogSafetyKey(ownerId, config.id) &&
        event.key !== importGateKey(config.id, ownerId)
      )
        return;
      const stored = catalogSafetyStorage();
      if (!stored) {
        setStorageUnavailable(true);
        return;
      }
      if (event && event.storageArea !== stored) return;
      const incoming = readCatalogSafetyGate(stored, ownerId, config.id);
      const importing = catalogImportBlocksWrite(stored, ownerId, config.id);
      const currentImportBlocked =
        runtime.queryClient.getQueryData<boolean>(importSafetyKey);
      if (importing) runtime.queryClient.setQueryData(importSafetyKey, true);
      const revision = ++crossTabSafetyRevision.current;
      if (incoming) {
        peerCheckRequest.current?.abort();
        setPeerCheckRefresh(null);
        const known =
          runtime.queryClient.getQueryData<CatalogSafetyGate>(safetyKey);
        const receiptScope = JSON.stringify([
          config.id,
          ownerId,
          peerSessionId ?? null,
        ]);
        runtime.queryClient.setQueryData(
          safetyKey,
          canRecoverKnownBatchDeleteReceipt(incoming, known) &&
            known.ownerScope === receiptScope
            ? known
            : incoming,
        );
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
      if (!currentSafety && !currentImportBlocked) {
        runtime.queryClient.setQueryData(safetyKey, null);
        setPeerCheckRefresh(null);
        return;
      }
      if (currentSafety?.phase === 'check') {
        void rereadReleasedCheck(stored, revision);
        return;
      }
      if (importing) return;
      if (
        currentSafety?.phase === 'refresh' &&
        currentSafety.batchCreate &&
        currentSafety.createUncertain
      )
        return;
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
            readCatalogSafetyGate(stored, ownerId, config.id) ||
            catalogImportBlocksWrite(stored, ownerId, config.id)
          )
            return;
          const currentIdentity = identity.getSnapshot();
          if (
            currentIdentity.status !== 'authenticated' ||
            currentIdentity.identity.user.id !== ownerId ||
            currentIdentity.identity.sessionId !== peerSessionId ||
            !createAccess(currentIdentity.identity).canReadASIN ||
            createAccess(currentIdentity.identity).mustChangePassword
          )
            return;
          runtime.queryClient.setQueryData(
            [config.id, 'groups', correctedQuery],
            fresh,
          );
          if (correctedQuery !== query) setQuery(correctedQuery);
          runtime.queryClient.setQueryData(safetyKey, null);
          runtime.queryClient.setQueryData(importSafetyKey, false);
        } catch {
          // Keep the safety gate until this tab can reread the catalog.
          if (active && revision === crossTabSafetyRevision.current)
            setNotice(
              '目录重读失败，操作保护仍保留；可再次重读，不能重新提交旧操作。',
            );
        }
      })();
    };
    // The disabled query may cache null while the page misses storage events.
    syncSafety();
    setHydratedSafetyKey(safetyKey);
    const changed = (event: Event) => {
      if (
        (event as CustomEvent<string>).detail ===
        importGateKey(config.id, ownerId)
      )
        syncSafety();
    };
    window.addEventListener('storage', syncSafety);
    window.addEventListener(CATALOG_GATE_CHANGED, changed);
    return () => {
      active = false;
      invalidatePeerCheck();
      window.removeEventListener('storage', syncSafety);
      window.removeEventListener(CATALOG_GATE_CHANGED, changed);
    };
  }, [
    clearCatalogCache,
    config,
    ownerId,
    query,
    runtime,
    safetyKey,
    importSafetyKey,
    peerRefreshRetry,
    peerSessionId,
    identity,
    rereadReleasedCheck,
    invalidatePeerCheck,
  ]);
  useEffect(() => {
    if (!action) return;
    actionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    actionRef.current?.focus();
  }, [action]);
  useEffect(() => {
    batchReceiptRecoveryEpoch.current++;
    const previous = batchResultRef.current;
    if (
      previous &&
      previous.owner !== batchOwner &&
      navigator.locks &&
      (auth.status === 'authenticated' || auth.status === 'anonymous')
    ) {
      batchResultRef.current = null;
      retireBatchReceipt(previous.receipt, previous.owner);
    }
    setBatchReceiptWarning(null);
    setBatchRecoveryNotice(null);
    setRecoveringBatchReceipt(false);
    setBatchResult((current) =>
      current?.owner === batchOwner &&
      access.canWriteASIN &&
      !access.mustChangePassword
        ? current
        : null,
    );
    const pending = batchPending.current;
    if (pending && (pending.owner !== batchOwner || !access.canWriteASIN)) {
      const stored = catalogSafetyStorage();
      const gate = stored
        ? readCatalogSafetyGate(stored, pending.userId, pending.source)
        : null;
      if (gate)
        pending.queryClient.setQueryData(
          ['catalog-write-safety', pending.userId, pending.source],
          gate,
        );
      batchPending.current = null;
      writingRef.current = false;
      setWriting(false);
      setAction((current) =>
        current?.type === 'batch-create-asins' ? null : current,
      );
    }
  }, [
    batchOwner,
    access.canWriteASIN,
    access.mustChangePassword,
    auth.status,
    retireBatchReceipt,
  ]);
  useLayoutEffect(() => {
    if (
      config.id !== 'asin' ||
      !ownerId ||
      !access.canWriteASIN ||
      access.mustChangePassword
    )
      return;
    const recovered = readAsinBatchReceipt(
      ownerId,
      batchOwner,
      safety?.operationId,
    );
    if (!recovered) return;
    if (
      safety?.phase === 'refresh' &&
      safety.batchCreate &&
      recovered.receipt.groupId !== safety.detailId
    )
      return;
    setBatchResult((current) =>
      current?.receipt.operationId === recovered.receipt.operationId &&
      current.owner === batchOwner
        ? current
        : {
            serial: 0,
            owner: batchOwner,
            groupName: recovered.receipt.groupName,
            result: recovered.receipt.result,
            ...recovered,
          },
    );
  }, [
    config.id,
    ownerId,
    batchOwner,
    access.canWriteASIN,
    access.mustChangePassword,
    safety,
  ]);
  const data = groups.data;
  const current = data?.current ?? query.current ?? 1;
  const pageSize = data?.pageSize ?? query.pageSize ?? 10;
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const batchDelete = useCatalogBatchDelete({
    config,
    query,
    groups: data?.list ?? [],
    safety,
    safetyHydrated,
    enabled:
      safetyHydrated &&
      !storageUnavailable &&
      !importBlocked &&
      !checkBusy &&
      !writing &&
      !accessDenied,
    onQuery: setQuery,
    onDenied: () => reportAccessDenied(),
  });
  const sharedSelection: CatalogSelection | undefined = batchDelete.selection
    ? {
        ...batchDelete.selection,
        toggle: (id) => {
          setConfirmation(null);
          batchDelete.selection?.toggle(id);
        },
      }
    : canCheck && config.checks?.batch
    ? selection
    : undefined;
  const sharedGroupIds = sharedSelection?.ids ?? [];
  const sharedSelectionRevision = JSON.stringify(sharedGroupIds);
  useLayoutEffect(() => {
    setConfirmation(null);
  }, [sharedSelectionRevision]);

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
    const accepted =
      runtime.queryClient.getQueryData<AcceptedCheckMemory>(acceptedCheckKey);
    let durable: CatalogCheckGate | null = null;
    try {
      durable = recovery?.read() ?? null;
    } catch {
      /* Storage failure must not prevent identity revalidation. */
    }
    const matching =
      durable &&
      accepted?.gate &&
      sameCheckReservation(durable, accepted.gate) &&
      (!durable.taskId || durable.taskId === accepted.gate.taskId);
    const gate =
      matching && durable && accepted?.gate
        ? { ...durable, taskId: durable.taskId ?? accepted.gate.taskId }
        : durable;
    runtime.clearUserWork();
    if (outstanding) runtime.queryClient.setQueryData(safetyKey, outstanding);
    // A 403 suspends access until revalidation; it does not prove a new owner.
    // IdentityStore clears this receipt if revalidation confirms another scope.
    if (gate?.taskId && currentCheckScope())
      runtime.queryClient.setQueryData<AcceptedCheckMemory>(acceptedCheckKey, {
        scope: accepted?.scope ?? Symbol('catalog-check-revalidation'),
        gate,
        authorizationFailures:
          (matching ? accepted.authorizationFailures ?? 0 : 0) + 1,
      });
    void recheckAccess();
  }, [
    recheckAccess,
    runtime,
    safetyKey,
    acceptedCheckKey,
    currentCheckScope,
    recovery,
  ]);

  const refreshCheckedCatalog = useCallback(async () => {
    const revision = catalogReadRevision.current;
    const guard = () => {
      if (
        !mounted.current ||
        !currentCheckScope() ||
        revision !== catalogReadRevision.current
      )
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
    const revision = catalogReadRevision.current;
    const current = () =>
      mounted.current &&
      currentCheckScope() &&
      revision === catalogReadRevision.current;
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
      const cleared = !gate || Boolean(await recovery?.clear(gate, current));
      if (!mounted.current || checkOwner.current !== userId) return;
      if (cleared) {
        handledTasks.current.add(task.taskId);
        runtime.queryClient.setQueryData(acceptedCheckKey, null);
      }
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
    runtime.queryClient,
    acceptedCheckKey,
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
      const scope = Symbol('catalog-check-submission');
      runtime.queryClient.setQueryData<AcceptedCheckMemory>(acceptedCheckKey, {
        scope,
      });
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
        (gate, persisted) => {
          if (persisted) return;
          const memory =
            runtime.queryClient.getQueryData<AcceptedCheckMemory>(
              acceptedCheckKey,
            );
          const verified = identity.getSnapshot();
          if (
            memory?.scope !== scope ||
            runtime.session?.revision !== sessionRevision ||
            verified.status === 'anonymous' ||
            (verified.status === 'authenticated' &&
              (verified.identity.user.id !== userId ||
                verified.identity.sessionId !== sessionId))
          )
            return;
          runtime.queryClient.setQueryData(acceptedCheckKey, { scope, gate });
        },
      );
      if (!current() || result.kind === 'stale') {
        staleSubmission = true;
        return;
      }
      if (result.kind === 'task' || result.kind === 'blocked') {
        setSelectedGroups({ scope: selectionScope, ids: [] });
        batchDelete.clearSelection();
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
    const revision = catalogReadRevision.current;
    const current = () =>
      mounted.current &&
      currentCheckScope() &&
      revision === catalogReadRevision.current;
    const matchingReceipt = () => {
      try {
        const durable = recovery.read();
        if (!durable || !sameCheckReservation(durable, gate)) return false;
        const accepted =
          runtime.queryClient.getQueryData<AcceptedCheckMemory>(
            acceptedCheckKey,
          )?.gate;
        const taskId =
          durable.taskId ??
          (accepted && sameCheckReservation(durable, accepted)
            ? accepted.taskId
            : undefined);
        return taskId === gate.taskId;
      } catch {
        return false;
      }
    };
    try {
      const outcome = await recovery.reconcile(
        gate,
        (id) => runtime.tasks.get(id),
        async () => {
          if (!current()) throw new ApiError('CANCELLED', '目录或身份已变化');
          await refreshCheckedCatalog();
        },
        current,
      );
      if (!mounted.current || !currentCheckScope()) return;
      if (outcome === 'active') {
        if (!matchingReceipt()) {
          restoreCurrentCheck.current();
          return;
        }
        const memory =
          runtime.queryClient.getQueryData<AcceptedCheckMemory>(
            acceptedCheckKey,
          );
        if (
          memory?.gate &&
          sameCheckReservation(memory.gate, gate) &&
          memory.gate.taskId === gate.taskId
        )
          runtime.queryClient.setQueryData(acceptedCheckKey, {
            ...memory,
            authorizationFailures: 0,
          });
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
      runtime.queryClient.setQueryData(acceptedCheckKey, null);
      setCheckState(null);
      setNotice('已核实原任务，可以重新提交检查。');
    } catch (error) {
      if (!mounted.current || !currentCheckScope()) return;
      if (!matchingReceipt()) {
        restoreCurrentCheck.current();
        return;
      }
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
    if (next.type === 'batch-create-asins') {
      if (batchResult) removeAsinBatchReceipt(ownerId, batchResult.receipt);
      batchResultRef.current = null;
      knownBatchReceipts.current.clear();
      setBatchResult(null);
    }
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
  async function createVariantGroupExport() {
    if (
      config.id !== 'asin' ||
      !access.canReadASIN ||
      access.mustChangePassword
    )
      return;
    try {
      const result = await exportTask.mutateAsync({
        exportType: 'variant-group',
        params: {
          keyword: query.keyword,
          country: query.country,
          variantStatus: query.variantStatus,
        },
      });
      const message = `变体组导出任务已提交：${result.taskId}`;
      setNotice(message);
      announce(message);
    } catch (error) {
      setNotice(catalogError(error));
    }
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
    guard?: () => void,
  ) {
    guard?.();
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
          uncertainAction.type === 'create-asin' ||
          uncertainAction.type === 'batch-create-asins',
        operationId: claim.operationId,
        ...(uncertainAction.type === 'batch-create-asins'
          ? {
              batchCreate: true,
              ...(claim.phase === 'refresh' && claim.batchCreateOwner
                ? { batchCreateOwner: claim.batchCreateOwner }
                : {}),
            }
          : {}),
      },
      claim,
    );
    await clearCatalogCache(guard);
  }

  useEffect(() => {
    if (groups.isError && catalogAccessDenied(groups.error))
      reportAccessDenied();
  }, [groups.error, groups.isError, reportAccessDenied]);

  async function readAfterWrite(
    detailId: string | null,
    guard?: () => void,
    recoveryQuery = query,
  ) {
    guard?.();
    const detailRequest = detailId
      ? config.detail(runtime.http, detailId).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      : Promise.resolve(null);
    const [firstPage, detailResult] = await Promise.all([
      config.list(runtime.http, recoveryQuery),
      detailRequest,
    ]);
    guard?.();
    const lastPage = Math.max(
      1,
      Math.ceil(firstPage.total / firstPage.pageSize),
    );
    const correctedQuery =
      firstPage.current > lastPage
        ? { ...recoveryQuery, current: lastPage }
        : recoveryQuery;
    const fresh =
      correctedQuery === recoveryQuery
        ? firstPage
        : await config.list(runtime.http, correctedQuery);
    guard?.();
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
    guard?: () => void,
  ) {
    guard?.();
    if (savedAction.type === 'delete-group') setSelectedId(null);
    const detailId =
      savedAction.type === 'delete-group'
        ? null
        : savedAction.type === 'batch-create-asins'
        ? savedAction.group.id
        : selectedId;
    setNotice(null);
    const refreshedGate: CatalogSafetyGate = {
      phase: 'refresh',
      message,
      detailId,
      createUncertain: false,
      operationId: claim.operationId,
      ...(savedAction.type === 'batch-create-asins'
        ? {
            batchCreate: true,
            ...(claim.phase === 'refresh' && claim.batchCreateOwner
              ? { batchCreateOwner: claim.batchCreateOwner }
              : {}),
          }
        : {}),
    };
    if (!setSafety(refreshedGate, claim)) return;
    const known = knownBatchReceipts.current.get(claim.operationId ?? '');
    if (savedAction.type === 'batch-create-asins' && !known?.persisted) return;
    try {
      await clearCatalogCache(guard);
      await readAfterWrite(detailId, guard);
      guard?.();
      if (setSafety(null, refreshedGate))
        knownBatchReceipts.current.delete(claim.operationId ?? '');
      if (message) {
        setNotice(message);
        announce(message);
      }
    } catch (cause) {
      guard?.();
      if (catalogAccessDenied(cause)) {
        reportAccessDenied();
      }
    }
  }

  async function retryReleasedCheck() {
    if (
      peerCheckRefresh === 'reading' ||
      safety?.phase !== 'check' ||
      !mounted.current ||
      !currentCheckScope()
    )
      return;
    try {
      await runWithCatalogLock(async () => {
        if (!mounted.current || !currentCheckScope()) return;
        const stored = catalogSafetyStorage();
        if (!stored) {
          setStorageUnavailable(true);
          return;
        }
        const latest = readCatalogSafetyGate(stored, ownerId, config.id);
        if (latest || recovery?.read()) {
          if (latest) runtime.queryClient.setQueryData(safetyKey, latest);
          restoreCheck();
          setPeerCheckRefresh(null);
          return;
        }
        await rereadReleasedCheck(stored, ++crossTabSafetyRevision.current);
      });
    } catch {
      if (mounted.current && currentCheckScope()) setPeerCheckRefresh('failed');
    }
  }

  function guardBatch(serial: number, owner: string) {
    const latest = identity.getSnapshot();
    const latestOwner =
      latest.status === 'authenticated'
        ? JSON.stringify([
            config.id,
            latest.identity.user.id,
            latest.identity.sessionId ?? null,
          ])
        : '';
    if (
      !mounted.current ||
      batchPending.current?.serial !== serial ||
      batchPending.current.owner !== owner ||
      latestOwner !== owner ||
      latest.status !== 'authenticated' ||
      !createAccess(latest.identity).canWriteASIN
    )
      throw new ApiError('CANCELLED', '身份、权限或页面已变化');
  }

  function batchWritingChange(serial: number, owner: string, pending: boolean) {
    if (!mounted.current) return;
    if (pending) {
      batchPending.current = {
        serial,
        owner,
        userId: ownerId,
        source: config.id,
        queryClient: runtime.queryClient,
      };
      writingChange(true);
    } else if (
      batchPending.current?.serial === serial &&
      batchPending.current.owner === owner
    ) {
      batchPending.current = null;
      writingChange(false);
    }
  }

  async function restorePreviousBatchReceipt() {
    if (
      config.id !== 'asin' ||
      safety?.phase !== 'refresh' ||
      !safety.batchCreate ||
      !safety.batchCreateOwner ||
      safety.batchCreateOwner === batchOwner ||
      !safety.operationId ||
      !safety.detailId ||
      !access.canWriteASIN ||
      access.mustChangePassword ||
      storageUnavailable ||
      recoveringBatchReceipt
    )
      return;
    const originalOwner = safety.batchCreateOwner;
    const recoveryRevision = runtime.session.revision;
    const recoveryEpoch = batchReceiptRecoveryEpoch.current;
    const guard = () => {
      const current = identity.getSnapshot();
      const permissions = createAccess(
        current.status === 'authenticated' ? current.identity : undefined,
      );
      if (
        !mounted.current ||
        batchReceiptRecoveryEpoch.current !== recoveryEpoch ||
        runtime.session.revision !== recoveryRevision ||
        current.status !== 'authenticated' ||
        JSON.stringify([
          config.id,
          current.identity.user.id,
          current.identity.sessionId ?? null,
        ]) !== batchOwner ||
        !permissions.canWriteASIN ||
        permissions.mustChangePassword
      )
        throw new ApiError('CANCELLED', '身份、权限或页面已变化');
    };
    setRecoveringBatchReceipt(true);
    try {
      await runWithCatalogLock(async () => {
        guard();
        const stored = catalogSafetyStorage();
        const current = stored
          ? readCatalogSafetyGate(stored, ownerId, config.id)
          : null;
        if (!stored || JSON.stringify(current) !== JSON.stringify(safety))
          throw new ApiError('INVALID_INPUT', '原操作保护已变化，请重新核实。');
        // Read only the exact original session/operation bound by this user's gate.
        const original: unknown = JSON.parse(originalOwner);
        if (
          !Array.isArray(original) ||
          original[0] !== 'asin' ||
          original[1] !== ownerId
        )
          throw new ApiError('INVALID_INPUT', '原会话归属不匹配。');
        const recovered = readAsinBatchReceipt(
          ownerId,
          originalOwner,
          safety.operationId,
        );
        guard();
        if (!recovered || recovered.receipt.groupId !== safety.detailId)
          throw new ApiError(
            'INVALID_INPUT',
            '原会话回执缺失、损坏或与原组不匹配。',
          );
        setBatchResult({
          serial: 0,
          owner: batchOwner,
          groupName: recovered.receipt.groupName,
          result: recovered.receipt.result,
          recoveredFromOwner: originalOwner,
          ...recovered,
        });
        setBatchReceiptWarning(null);
        setBatchRecoveryNotice(
          '已显式恢复同一用户原会话的已知回执。原操作写入保护仍保留，请重读目录核实；未重新提交。',
        );
      });
    } catch (cause) {
      try {
        guard();
      } catch {
        return;
      }
      setBatchReceiptWarning(
        `${catalogError(cause)} 写入保护仍保留；请核实原操作，勿重发成功项。`,
      );
    } finally {
      try {
        guard();
        setRecoveringBatchReceipt(false);
      } catch {
        // A queued old-session recovery must not mutate the new session's UI.
      }
    }
  }

  async function retryAfterWrite(narrow = false) {
    if (safety?.phase !== 'refresh') return;
    const guardedBatchResult =
      batchResult?.receipt.operationId === safety.operationId
        ? batchResult
        : null;
    const { message, detailId, createUncertain } = safety;
    const targetQuery = narrow ? { ...query, current: 1, pageSize: 1 } : query;
    const recoveryRevision = runtime.session.revision;
    const guardRecovery = () => {
      const currentIdentity = identity.getSnapshot();
      if (
        !mounted.current ||
        runtime.session.revision !== recoveryRevision ||
        currentIdentity.status !== 'authenticated' ||
        JSON.stringify([
          config.id,
          currentIdentity.identity.user.id,
          currentIdentity.identity.sessionId ?? null,
        ]) !== batchOwner ||
        !createAccess(currentIdentity.identity).canReadASIN ||
        (guardedBatchResult?.recoveredFromOwner &&
          (!createAccess(currentIdentity.identity).canWriteASIN ||
            createAccess(currentIdentity.identity).mustChangePassword))
      )
        throw new ApiError('CANCELLED', '身份、权限或页面已变化');
    };
    let refreshed = false;
    try {
      await runWithCatalogLock(async () => {
        guardRecovery?.();
        const memory = knownBatchReceipts.current.get(safety.operationId ?? '');
        const receipt =
          guardedBatchResult?.receipt ??
          (memory?.receipt.owner === batchOwner ? memory.receipt : null) ??
          readAsinBatchReceipt(ownerId, batchOwner, safety.operationId)
            ?.receipt;
        if (
          receipt &&
          safety.batchCreate &&
          (receipt.operationId !== safety.operationId ||
            (receipt.owner !== batchOwner &&
              !(
                guardedBatchResult?.recoveredFromOwner === receipt.owner &&
                safety.batchCreateOwner === receipt.owner
              )) ||
            receipt.groupId !== detailId)
        ) {
          setBatchReceiptWarning('已知回执与原操作不匹配，写入保护仍保留。');
          return;
        }
        if (safety.batchCreate && !safety.createUncertain && !receipt) {
          setBatchReceiptWarning(
            '已知逐行回执不可读取，写入保护仍保留。请恢复浏览器存储或核实原操作；勿重发成功项。',
          );
          return;
        }
        if (
          receipt &&
          (receipt.owner === batchOwner ||
            guardedBatchResult?.recoveredFromOwner === receipt.owner) &&
          receipt.operationId === safety.operationId &&
          !saveAsinBatchReceipt(ownerId, receipt)
        ) {
          setBatchResult((current) =>
            current ? { ...current, persisted: false } : current,
          );
          return;
        }
        setBatchReceiptWarning(null);
        if (receipt)
          setBatchResult((current) =>
            current ? { ...current, persisted: true } : current,
          );
        const stored = catalogSafetyStorage();
        const current = stored
          ? readCatalogSafetyGate(stored, ownerId, config.id)
          : null;
        if (!stored) {
          setStorageUnavailable(true);
          return;
        }
        if (!current) {
          await readAfterWrite(detailId, guardRecovery, targetQuery);
          guardRecovery?.();
          const latest = readCatalogSafetyGate(stored, ownerId, config.id);
          if (!latest && createUncertain) {
            refreshed = setSafety(
              { phase: 'inspection', operationId: safety.operationId },
              null,
            );
          } else {
            runtime.queryClient.setQueryData(safetyKey, latest);
            refreshed = !latest;
          }
          return;
        }
        if (JSON.stringify(current) !== JSON.stringify(safety)) {
          runtime.queryClient.setQueryData(safetyKey, current);
          return;
        }
        await readAfterWrite(detailId, guardRecovery, targetQuery);
        guardRecovery?.();
        refreshed = setSafety(
          createUncertain
            ? { phase: 'inspection', operationId: safety.operationId }
            : null,
          safety,
        );
      });
      if (!refreshed) return;
      guardRecovery?.();
      knownBatchReceipts.current.delete(safety.operationId ?? '');
      if (message || narrow) {
        const report = `${message ?? ''}${
          narrow
            ? ' 已将目录改为每页 1 组，并按新范围成功重读。原大页读取未完成。'
            : ''
        }`;
        setNotice(report);
        announce(report);
      }
    } catch (cause) {
      if (guardRecovery) {
        try {
          guardRecovery();
        } catch {
          return;
        }
      }
      if (catalogAccessDenied(cause)) reportAccessDenied();
    }
  }

  async function reconcileCreate() {
    if (safety?.phase !== 'inspection') return;
    const recoveryRevision = runtime.session.revision;
    const guard = () => {
      const currentIdentity = identity.getSnapshot();
      if (
        !mounted.current ||
        runtime.session.revision !== recoveryRevision ||
        currentIdentity.status !== 'authenticated' ||
        JSON.stringify([
          config.id,
          currentIdentity.identity.user.id,
          currentIdentity.identity.sessionId ?? null,
        ]) !== batchOwner ||
        !createAccess(currentIdentity.identity).canReadASIN
      )
        throw new ApiError('CANCELLED', '身份、权限或页面已变化');
    };
    let reconciled = false;
    try {
      guard();
      await runWithCatalogLock(async () => {
        guard();
        const stored = catalogSafetyStorage();
        const current = stored
          ? readCatalogSafetyGate(stored, ownerId, config.id)
          : null;
        if (!stored) {
          setStorageUnavailable(true);
          return;
        }
        if (!current) {
          await readAfterWrite(null, guard);
          guard();
          const latest = readCatalogSafetyGate(stored, ownerId, config.id);
          guard();
          runtime.queryClient.setQueryData(safetyKey, latest);
          reconciled = !latest;
          return;
        }
        if (JSON.stringify(current) !== JSON.stringify(safety)) {
          guard();
          runtime.queryClient.setQueryData(safetyKey, current);
          return;
        }
        await readAfterWrite(null, guard);
        guard();
        reconciled = setSafety(null, safety);
      });
      guard();
      if (!reconciled) return;
      setNotice('目录已重新读取，请仅在确认原新建记录后继续写入。');
    } catch (cause) {
      try {
        guard();
      } catch {
        return;
      }
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
        runtime.queryClient.setQueryData(
          importSafetyKey,
          catalogImportBlocksWrite(stored, ownerId, config.id),
        );
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
  const batchReceiptPanel = batchResult &&
    batchResult.owner === batchOwner &&
    access.canWriteASIN &&
    !access.mustChangePassword &&
    (!safety || safety.operationId === batchResult.receipt.operationId) && (
      <div className="space-y-3">
        {batchRecoveryNotice && <p role="status">{batchRecoveryNotice}</p>}
        {(!batchResult.persisted || batchReceiptWarning) && (
          <p role="alert">
            {batchReceiptWarning ||
              '逐行回执尚未保存到本地，写入保护继续保留。请保留页面并修复存储，勿重新提交成功项。'}
          </p>
        )}
        <AsinBatchCreateResult
          key={batchResult.receipt.operationId}
          result={batchResult.result}
          groupName={batchResult.groupName}
          operationId={batchResult.receipt.operationId}
          protected={Boolean(safety)}
          dismiss={() => {
            if (safety) return;
            if (removeAsinBatchReceipt(ownerId, batchResult.receipt)) {
              batchResultRef.current = null;
              knownBatchReceipts.current.delete(
                batchResult.receipt.operationId,
              );
              setBatchResult(null);
            } else
              setBatchReceiptWarning('无法清理已保存回执，请恢复存储后重试。');
          }}
        />
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
          {safety.batchCreate && (
            <Button
              variant="secondary"
              disabled={storageUnavailable}
              onClick={() => void retryAfterWrite(true)}
            >
              改为每页 1 组重读（不重发）
            </Button>
          )}
          {safety.batchCreate &&
            safety.batchCreateOwner &&
            safety.batchCreateOwner !== batchOwner && (
              <div className="space-y-2">
                <p>
                  原操作属于你之前的登录会话。写入保护仍保留；可显式读取原会话绑定的已知回执后核实目录，勿重新提交。
                </p>
                <Button
                  variant="secondary"
                  disabled={
                    storageUnavailable ||
                    !access.canWriteASIN ||
                    access.mustChangePassword
                  }
                  pending={recoveringBatchReceipt}
                  onClick={() => void restorePreviousBatchReceipt()}
                >
                  恢复原会话已知回执（不提交）
                </Button>
              </div>
            )}
          {batchReceiptWarning && <p role="status">{batchReceiptWarning}</p>}
        </div>
        {batchReceiptPanel}
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
        {safety?.phase === 'check' && !checkState && peerCheckRefresh && (
          <div className="space-y-3 rounded-control bg-status-warning-soft p-4 text-sm text-status-warning">
            <p role="alert">
              {peerCheckRefresh === 'reading'
                ? '其他标签已核实原检查，正在重新读取本页目录；目录操作仍暂停。'
                : '其他标签已核实原检查，但本页目录重读失败；目录操作仍暂停。请重新读取目录后继续。'}
            </p>
            <Button
              variant="secondary"
              size="small"
              disabled={storageUnavailable}
              pending={peerCheckRefresh === 'reading'}
              onClick={() => void retryReleasedCheck()}
            >
              重新读取检查后的目录
            </Button>
          </div>
        )}
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
        <CatalogRefreshContext.Provider value={refreshImportedCatalog}>
          {extra}
        </CatalogRefreshContext.Provider>
        {config.id === 'competitor' && (
          <CompetitorExportControls
            query={query}
            disabled={writing || groups.isPending || !!groups.error}
          />
        )}
        {config.id === 'asin' && (
          <PrimaryAsinExportControls
            query={query}
            disabled={writing || groups.isPending || !!groups.error}
          />
        )}
        {importBlocked && (
          <div className="space-y-2">
            <p role="status">
              导入请求待核实，目录写入与批量删除已暂停；请先核实导入任务。
            </p>
            <Button
              variant="secondary"
              size="small"
              onClick={() => setPeerRefreshRetry((value) => value + 1)}
            >
              重读目录并核实导入保护（不提交）
            </Button>
          </div>
        )}
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
              {action.type === 'batch-create-asins' && config.id === 'asin' ? (
                <AsinBatchCreatePanel
                  key={actionSerial}
                  action={action}
                  config={config}
                  http={runtime.http}
                  close={() =>
                    setAction((current) =>
                      current === action ? null : current,
                    )
                  }
                  completed={async (result, completedAction, claim) => {
                    const guard = () => guardBatch(actionSerial, batchOwner);
                    guard();
                    setBatchResult({
                      serial: actionSerial,
                      owner: batchOwner,
                      groupName: completedAction.group.name,
                      result,
                      ...knownBatchReceipts.current.get(
                        claim.operationId ?? '',
                      )!,
                    });
                    setAction((current) =>
                      current === action ? null : current,
                    );
                    await afterWrite(
                      `批量添加已核实：成功 ${result.successCount} 个，失败 ${result.failedCount} 个。`,
                      completedAction,
                      claim,
                      guard,
                    );
                  }}
                  rememberReceipt={(result, completedAction, claim, input) => {
                    if (!claim.operationId) return;
                    const receipt: AsinBatchReceipt = {
                      operationId: claim.operationId,
                      owner: batchOwner,
                      groupId: completedAction.group.id,
                      groupName: completedAction.group.name,
                      submittedAt: Number(claim.operationId.split('-')[0]),
                      items: input.items.map((item) => ({ ...item })),
                      result,
                    };
                    const known = {
                      receipt,
                      persisted: saveAsinBatchReceipt(ownerId, receipt),
                    };
                    // Persist late receipts to their original owner, but only
                    // the current operation needs an in-memory recovery copy.
                    if (
                      batchPending.current?.serial === actionSerial &&
                      batchPending.current.owner === batchOwner
                    ) {
                      knownBatchReceipts.current.clear();
                      knownBatchReceipts.current.set(claim.operationId, known);
                    }
                  }}
                  denied={reportAccessDenied}
                  uncertain={(uncertainAction, claim) =>
                    reportUncertainWrite(uncertainAction, claim, () =>
                      guardBatch(actionSerial, batchOwner),
                    ).catch(() => undefined)
                  }
                  writingChange={(pending) =>
                    batchWritingChange(actionSerial, batchOwner, pending)
                  }
                  runExclusive={runWithCatalogLock}
                  beginWrite={beginWrite}
                  releaseWrite={(claim) => {
                    setSafety(null, claim);
                  }}
                />
              ) : (
                <CatalogActionPanel
                  key={actionSerial}
                  action={action}
                  config={config}
                  http={runtime.http}
                  close={() =>
                    setAction((current) =>
                      current === action ? null : current,
                    )
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
              )}
            </div>
          )}
        {batchReceiptPanel}

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
                      已选 {sharedGroupIds.length} 组
                    </span>
                    <Button
                      size="small"
                      disabled={
                        !sharedSelection ||
                        sharedSelection.disabled ||
                        sharedGroupIds.length === 0
                      }
                      onClick={() =>
                        setConfirmation({
                          scope: selectionScope,
                          forceRefresh,
                          target: {
                            kind: 'batch',
                            id: 'batch',
                            label: `所选 ${sharedGroupIds.length} 个主营变体组`,
                            groupIds: [...sharedGroupIds],
                          },
                        })
                      }
                    >
                      检查所选组
                    </Button>
                    {!batchDelete.selection && (
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={
                          !sharedSelection ||
                          sharedSelection.disabled ||
                          sharedGroupIds.length === 0
                        }
                        onClick={() => {
                          setSelectedGroups({ scope: selectionScope, ids: [] });
                          setConfirmation(null);
                        }}
                      >
                        清空选择
                      </Button>
                    )}
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
                {config.id === 'asin' &&
                  access.canReadASIN &&
                  !access.mustChangePassword && (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={writing || exportTask.isPending}
                      pending={exportTask.isPending}
                      onClick={() => void createVariantGroupExport()}
                    >
                      <Download aria-hidden="true" />
                      导出变体组
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
            {batchDelete.panel}
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
                    selection={sharedSelection}
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
