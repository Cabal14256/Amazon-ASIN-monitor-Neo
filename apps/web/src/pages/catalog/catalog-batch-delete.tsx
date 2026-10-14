import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { Button } from '../../components/ui/button';
import { useTaskQuery } from '../../hooks/tasks';
import { ApiError } from '../../lib/http';
import { isBulkDeleteId } from '../../services/catalog-batch-delete';
import { isTerminalTask } from '../../services/tasks';
import { browserBatchDeleteRecovery } from './catalog-batch-delete-recovery';
import { catalogAccessDenied, catalogError } from './catalog-data';
import {
  canRecoverKnownBatchDeleteReceipt,
  type CatalogBatchDeleteGate,
  type CatalogSafetyGate,
} from './catalog-safety-gate';
import type {
  CatalogConfig,
  CatalogGroup,
  CatalogQuery,
} from './catalog-types';

export interface CatalogSelection {
  ids: readonly string[];
  disabled: boolean;
  toggle: (id: string) => void;
}

export function useCatalogBatchDelete(options: {
  config: CatalogConfig;
  query: CatalogQuery;
  groups: CatalogGroup[];
  safety: CatalogSafetyGate | null | undefined;
  safetyHydrated: boolean;
  enabled: boolean;
  onQuery: (query: CatalogQuery) => void;
  onDenied: () => void;
}) {
  const { runtime, identity, announce } = useAuth();
  const auth = useIdentity();
  const owner = auth.status === 'authenticated' ? auth.identity.user.id : '';
  const access = createAccess(
    auth.status === 'authenticated' ? auth.identity : undefined,
  );
  const revision = runtime.session.revision;
  const sessionId =
    auth.status === 'authenticated' ? auth.identity.sessionId : undefined;
  const scope = JSON.stringify([
    owner,
    options.config.id,
    options.query,
    revision,
    sessionId,
    access.canDeleteASIN,
    access.mustChangePassword,
  ]);
  const authScope = JSON.stringify([
    owner,
    options.config.id,
    revision,
    sessionId,
    access.canReadASIN,
    access.canDeleteASIN,
    access.mustChangePassword,
  ]);
  const [selectionState, setSelection] = useState<{
    scope: string;
    ids: string[];
  }>({ scope, ids: [] });
  const ids = selectionState.scope === scope ? selectionState.ids : [];
  const [confirmation, setConfirmation] = useState<{
    scope: string;
    ids: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef<symbol | null>(null);
  const scopeEpoch = useRef(0);
  const queryEpoch = useRef(0);
  const [message, setMessage] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(options);
  latest.current = options;
  const recovery = useMemo(() => {
    try {
      return browserBatchDeleteRecovery(owner, options.config.id, sessionId);
    } catch {
      return null;
    }
  }, [owner, options.config.id, sessionId]);
  const gate = options.safety?.phase === 'batch-delete' ? options.safety : null;
  const receiptOwner = JSON.stringify([
    options.config.id,
    owner,
    sessionId ?? null,
  ]);
  const [restoredReceipt, setRestoredReceipt] = useState<{
    owner: string;
    operationId: string;
  } | null>(null);
  const priorSession = Boolean(
    gate?.ownerScope && gate.ownerScope !== receiptOwner,
  );
  const receiptVisible =
    !priorSession ||
    (restoredReceipt?.owner === receiptOwner &&
      restoredReceipt.operationId === gate?.operationId &&
      access.canDeleteASIN &&
      !access.mustChangePassword);
  const task = useTaskQuery(
    runtime,
    gate?.state === 'task' && receiptVisible ? gate.taskId : undefined,
    options.safetyHydrated && access.canReadASIN && !access.mustChangePassword,
  );
  const enabled = Boolean(
    options.config.batchDelete &&
      options.enabled &&
      access.canDeleteASIN &&
      !access.mustChangePassword &&
      !options.safety &&
      recovery &&
      !busy,
  );
  const current = (write: boolean) => {
    const state = identity.getSnapshot();
    return (
      mounted.current &&
      runtime.session.revision === revision &&
      state.status === 'authenticated' &&
      state.identity.user.id === owner &&
      state.identity.sessionId === sessionId &&
      (write
        ? createAccess(state.identity).canDeleteASIN &&
          !createAccess(state.identity).mustChangePassword
        : createAccess(state.identity).canReadASIN)
    );
  };
  const publish = (value: CatalogSafetyGate | null) => {
    if (!current(false)) return;
    const key = ['catalog-write-safety', owner, options.config.id];
    const known = runtime.queryClient.getQueryData<CatalogSafetyGate>(key);
    runtime.queryClient.setQueryData(
      key,
      canRecoverKnownBatchDeleteReceipt(value, known) &&
        known.ownerScope === receiptOwner
        ? known
        : value,
    );
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    scopeEpoch.current++;
    busyRef.current = null;
    setBusy(false);
    setRestoredReceipt(null);
  }, [authScope]);
  useLayoutEffect(() => {
    queryEpoch.current++;
    setSelection({ scope, ids: [] });
    setConfirmation(null);
    setMessage(null);
    setAcknowledged(false);
  }, [scope]);
  useLayoutEffect(() => {
    if (!options.safety && options.enabled) return;
    setSelection({ scope, ids: [] });
    setConfirmation(null);
  }, [options.safety, options.enabled, scope]);
  useEffect(() => {
    setAcknowledged(false);
  }, [gate?.operationId, gate?.state, gate?.taskId]);
  useEffect(
    () =>
      runtime.subscribeSession(() => {
        setSelection({ scope: '', ids: [] });
        setConfirmation(null);
        setMessage(null);
        setAcknowledged(false);
      }),
    [runtime],
  );
  useLayoutEffect(() => {
    if (!owner || !recovery) return;
    const restore = () => {
      try {
        const stored = recovery.read();
        if (stored?.phase === 'batch-delete') {
          const key = ['catalog-write-safety', owner, recovery.domain];
          const known =
            runtime.queryClient.getQueryData<CatalogSafetyGate>(key);
          runtime.queryClient.setQueryData(
            key,
            canRecoverKnownBatchDeleteReceipt(stored, known) &&
              known.ownerScope === receiptOwner
              ? known
              : stored,
          );
        }
      } catch {
        setMessage('无法读取删除恢复记录，请恢复本地存储后重试。');
      }
    };
    restore();
    const sync = (event: StorageEvent) => {
      if (event.key === recovery.key || event.key === null) restore();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [owner, recovery, runtime.queryClient, revision, sessionId, receiptOwner]);

  async function refresh() {
    const epoch = queryEpoch.current;
    const check = () => {
      if (!current(false))
        throw new Error('当前会话已变化，请在原账号下核实。');
      if (queryEpoch.current !== epoch)
        throw new ApiError(
          'CANCELLED',
          '查询范围已改变，请重读当前目录后再解除删除保护。',
        );
    };
    check();
    const config = latest.current.config;
    const query = latest.current.query;
    await runtime.queryClient.cancelQueries({ queryKey: [config.id] });
    check();
    const first = await config.list(runtime.http, query);
    check();
    const last = Math.max(1, Math.ceil(first.total / first.pageSize));
    const corrected =
      first.current > last ? { ...query, current: last } : query;
    const fresh =
      corrected === query ? first : await config.list(runtime.http, corrected);
    check();
    runtime.queryClient.removeQueries({ queryKey: [config.id, 'group'] });
    runtime.queryClient.setQueryData([config.id, 'groups', corrected], fresh);
    if (corrected !== query) latest.current.onQuery(corrected);
  }
  async function restoreOriginalReceipt() {
    if (
      !gate?.ownerScope ||
      !priorSession ||
      !recovery ||
      !current(true) ||
      busyRef.current
    )
      return;
    const busyToken = Symbol();
    const epoch = scopeEpoch.current;
    const active = () => current(true) && scopeEpoch.current === epoch;
    busyRef.current = busyToken;
    setBusy(true);
    try {
      await navigator.locks.request(recovery.key, async () => {
        if (!active()) return;
        const stored = recovery.read();
        if (
          stored?.phase !== 'batch-delete' ||
          stored.ownerScope !== gate.ownerScope ||
          stored.operationId !== gate.operationId ||
          stored.submittedAt !== gate.submittedAt ||
          JSON.stringify(stored.groupIds) !== JSON.stringify(gate.groupIds)
        )
          throw new Error('原会话回执绑定已变化，删除保护仍保留。');
        if (!active()) return;
        setRestoredReceipt({
          owner: receiptOwner,
          operationId: stored.operationId,
        });
        publish(stored);
        setMessage(
          '已显式恢复同一用户原会话的删除回执；请核实任务与目录，未重新提交删除。',
        );
      });
    } catch (error) {
      if (active()) setMessage(catalogError(error));
    } finally {
      if (busyRef.current === busyToken) {
        busyRef.current = null;
        if (active()) setBusy(false);
      }
    }
  }
  async function reconcile(
    expected: CatalogBatchDeleteGate,
    acknowledgeUnknown = false,
  ) {
    if (
      !recovery ||
      !current(false) ||
      busyRef.current ||
      !receiptVisible ||
      (priorSession && !current(true))
    )
      return;
    const busyToken = Symbol();
    const epoch = scopeEpoch.current;
    const active = () =>
      current(false) &&
      scopeEpoch.current === epoch &&
      (!priorSession || current(true));
    busyRef.current = busyToken;
    setBusy(true);
    setMessage(null);
    try {
      const result = await recovery.reconcile(
        expected,
        (id) => runtime.tasks.get(id),
        refresh,
        active,
        acknowledgeUnknown,
      );
      if (!active()) return;
      if (result.kind === 'changed' && recovery.read() === null) {
        // A peer cleared its durable claim. This tab still needs fresh rows.
        await refresh();
        if (!active()) return;
      }
      publish(recovery.read());
      if (result.kind === 'cleared') {
        setMessage(result.message);
        announce(result.message);
        setSelection({ scope, ids: [] });
        setAcknowledged(false);
      } else if (result.kind === 'active')
        setMessage(
          `删除任务仍在执行（${result.task.status}）；尚未完成，不会重发。`,
        );
      else if (result.kind === 'unknown')
        setMessage(
          '目录已重读，但读取目录不能证明没有延迟任务；删除保护仍保留。',
        );
      else if (result.kind === 'changed')
        setMessage('删除恢复记录已变化，请核对最新回执。');
      else if (result.kind === 'unsaved')
        setMessage(
          '已知删除回执无法保存到本地，写入保护仍保留；请保留页面并恢复存储后再次核实，勿重发删除。',
        );
    } catch (error) {
      if (active()) {
        try {
          const stored = recovery.read();
          if (stored) publish(stored);
        } catch {
          // Preserve the mounted guard/known receipt while storage is unreadable.
        }
        setMessage(`核实失败，删除保护仍保留：${catalogError(error)}`);
        if (catalogAccessDenied(error)) latest.current.onDenied();
      }
    } finally {
      if (busyRef.current === busyToken) {
        busyRef.current = null;
        if (active()) setBusy(false);
      }
    }
  }
  async function submit() {
    const confirmed = confirmation;
    if (
      !confirmed ||
      confirmed.scope !== scope ||
      !enabled ||
      !current(true) ||
      !recovery ||
      busyRef.current
    )
      return;
    const busyToken = Symbol();
    const epoch = scopeEpoch.current;
    const active = (write: boolean) =>
      current(write) && scopeEpoch.current === epoch;
    busyRef.current = busyToken;
    setBusy(true);
    setConfirmation(null);
    setSelection({ scope, ids: [] });
    setMessage(null);
    let accepted: CatalogBatchDeleteGate | null = null;
    try {
      const result = await recovery.submit(
        confirmed.ids,
        () =>
          options.config.batchDelete!(runtime.http, {
            groupIds: confirmed.ids,
            useAsync: true,
          }),
        () => active(true),
        (value) => {
          if (active(false)) publish(value);
        },
        () =>
          active(true) &&
          !runtime.queryClient.getQueryData([
            'catalog-import-safety',
            owner,
            options.config.id,
          ]) &&
          !runtime.queryClient.getQueryData([
            'catalog-write-safety',
            owner,
            options.config.id,
          ]),
      );
      if (result.kind === 'accepted' && result.gate.state === 'task') {
        // Identity revalidation unmounts this page. Keep a validated ACK in the
        // original runtime scope, never in a replacement identity or generation.
        const state = identity.getSnapshot();
        const eligible =
          runtime.session.revision === revision &&
          result.gate.ownerScope === receiptOwner &&
          (state.status === 'loading' ||
            state.status === 'error' ||
            (state.status === 'authenticated' &&
              state.identity.user.id === owner &&
              state.identity.sessionId === sessionId &&
              createAccess(state.identity).canReadASIN &&
              !createAccess(state.identity).mustChangePassword));
        if (eligible) {
          try {
            const stored = recovery.read();
            const key = ['catalog-write-safety', owner, options.config.id];
            const cached =
              runtime.queryClient.getQueryData<CatalogSafetyGate>(key);
            if (
              cached &&
              (JSON.stringify(cached) === JSON.stringify(stored) ||
                JSON.stringify(cached) === JSON.stringify(result.gate)) &&
              (JSON.stringify(stored) === JSON.stringify(result.gate) ||
                canRecoverKnownBatchDeleteReceipt(stored, result.gate))
            )
              runtime.queryClient.setQueryData(key, result.gate);
          } catch {
            // An unreadable or changed guard cannot prove ACK ownership.
          }
        }
      }
      if (!active(false)) return;
      if (result.kind === 'accepted') {
        accepted = result.gate;
        if (!result.persisted)
          setMessage(
            '任务回执未能保存到本地；请保留当前页面与任务 ID，修复存储后再核实。',
          );
      } else if (result.kind === 'blocked') publish(result.gate);
      else if (result.kind === 'rejected') {
        setMessage(`删除请求被拒绝：${catalogError(result.error)}`);
        if (catalogAccessDenied(result.error)) latest.current.onDenied();
      } else if (result.kind === 'unknown')
        setMessage(
          '删除提交结果未知；不会自动重试。请核对任务中心与目录后再解除保护。',
        );
    } catch (error) {
      if (active(false)) setMessage(catalogError(error));
    } finally {
      if (busyRef.current === busyToken) {
        busyRef.current = null;
        if (active(false)) setBusy(false);
      }
    }
    if (accepted?.state === 'refresh') await reconcile(accepted);
  }
  const reconcileCurrent = useRef(reconcile);
  reconcileCurrent.current = reconcile;
  const terminalAttempts = useRef(new Set<string>());
  useEffect(() => {
    const receipt = task.data;
    if (
      !gate ||
      !receiptVisible ||
      gate.state !== 'task' ||
      !receipt ||
      receipt.taskId !== gate.taskId ||
      !isTerminalTask(receipt.status)
    )
      return;
    const key = `${receiptOwner}:${revision}:${gate.operationId}:${receipt.status}`;
    if (terminalAttempts.current.has(key) || busyRef.current) return;
    terminalAttempts.current.add(key);
    void reconcileCurrent.current(gate);
  }, [gate, task.data, receiptVisible, receiptOwner, revision, busy]);
  const selection: CatalogSelection | undefined =
    options.config.batchDelete && access.canDeleteASIN
      ? {
          ids,
          disabled: !enabled,
          toggle: (id) => {
            if (
              !enabled ||
              !current(true) ||
              !isBulkDeleteId(id) ||
              !options.groups.some((group) => group.id === id)
            )
              return;
            setConfirmation(null);
            setSelection((previous) => {
              const selected = previous.scope === scope ? previous.ids : [];
              return {
                scope,
                ids: selected.includes(id)
                  ? selected.filter((item) => item !== id)
                  : [...selected, id],
              };
            });
          },
        }
      : undefined;
  const panel = options.config.batchDelete ? (
    <div className="space-y-3">
      {selection && !gate && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>已选择 {ids.length} 组（仅当前页；翻页或更改筛选会清空）</span>
          <Button
            variant="secondary"
            size="small"
            disabled={
              !enabled ||
              !options.groups.some((group) => isBulkDeleteId(group.id))
            }
            onClick={() => {
              setConfirmation(null);
              setSelection({
                scope,
                ids: options.groups
                  .filter((group) => isBulkDeleteId(group.id))
                  .map((group) => group.id),
              });
            }}
          >
            选择本页可删除组
          </Button>
          <Button
            variant="ghost"
            size="small"
            disabled={!enabled || !ids.length}
            onClick={() => {
              setConfirmation(null);
              setSelection({ scope, ids: [] });
            }}
          >
            清空选择
          </Button>
          <Button
            variant="destructive"
            size="small"
            disabled={!enabled || !ids.length}
            onClick={() => setConfirmation({ scope, ids: [...ids] })}
          >
            批量删除所选组
          </Button>
        </div>
      )}
      {confirmation?.scope === scope && enabled && (
        <section
          role="alert"
          aria-label="确认批量删除"
          className="rounded-control border border-status-danger p-4"
        >
          <h3 className="font-semibold">
            确认删除 {confirmation.ids.length} 个变体组及其全部 ASIN
          </h3>
          <p className="my-2 text-sm">
            删除不可撤销，按服务端执行时的组内数据删除。仅提交这些原始 ID：
          </p>
          <ul className="max-h-40 overflow-auto break-all text-xs">
            {confirmation.ids.map((id) => (
              <li key={id} className="whitespace-pre-wrap">
                {JSON.stringify(id)}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void submit()}
            >
              确认批量删除
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              取消批量删除
            </Button>
          </div>
        </section>
      )}
      {gate && (
        <section
          role="alert"
          aria-label="批量删除结果待核实"
          className="rounded-control border border-status-warning p-4"
        >
          <h3 className="font-semibold">
            {!receiptVisible
              ? '原会话批量删除结果待核实'
              : gate.state === 'task'
              ? '批量删除任务已受理，等待核实结果'
              : gate.state === 'refresh'
              ? '删除已结束，等待重读目录'
              : '批量删除提交结果未知'}
          </h3>
          <p className="mt-2 text-sm">
            {!receiptVisible
              ? '原操作属于你之前的登录会话，写入保护仍保留。请显式读取绑定的回执再核实，勿重发删除。'
              : gate.message ||
                '请求可能已经受理。保护期间不能再次写入；不会自动重试删除。'}
          </p>
          {!receiptVisible && (
            <Button
              variant="secondary"
              disabled={
                busy || !access.canDeleteASIN || access.mustChangePassword
              }
              onClick={() => void restoreOriginalReceipt()}
            >
              恢复原会话删除回执（不提交）
            </Button>
          )}
          {receiptVisible && gate.taskId && (
            <p className="neo-mono my-2 break-all text-xs">
              任务 ID：{gate.taskId}
            </p>
          )}
          {receiptVisible && (
            <div className="my-2 text-xs">
              <p className="neo-mono break-all">原操作：{gate.operationId}</p>
              <ul className="max-h-32 overflow-auto break-all">
                {gate.groupIds.map((id) => (
                  <li key={id}>原始组 ID：{JSON.stringify(id)}</li>
                ))}
              </ul>
            </div>
          )}
          {receiptVisible && gate.state === 'task' && task.data && (
            <p className="my-2 text-sm">
              任务状态：{task.data.status} · 进度{' '}
              {Math.max(0, Math.min(100, task.data.progress))}%
            </p>
          )}
          {receiptVisible && gate.state === 'task' && task.isError && (
            <p className="my-2 text-sm">
              任务查询失败，保护仍保留：{catalogError(task.error)}
            </p>
          )}
          {receiptVisible && (
            <Button
              variant="secondary"
              disabled={busy || !access.canReadASIN}
              onClick={() => void reconcile(gate)}
            >
              {busy
                ? '正在核实…'
                : gate.taskId
                ? '查询任务并重读目录'
                : '重读目录核对结果'}
            </Button>
          )}
          {receiptVisible && gate.state === 'unknown' && (
            <div className="mt-3 space-y-2 text-sm">
              <p>
                请在任务中心或由管理员核实本次操作，确认不存在待执行或延迟删除任务。仅重读目录不足以解除保护。
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                我已核实目录及任务，不存在待执行删除任务
              </label>
              <Button
                variant="secondary"
                disabled={!acknowledged || busy || !access.canReadASIN}
                onClick={() => void reconcile(gate, true)}
              >
                解除删除保护（不重发请求）
              </Button>
            </div>
          )}
        </section>
      )}
      {message && (
        <p role="status" className="rounded-control bg-muted p-3 text-sm">
          {message}
        </p>
      )}
    </div>
  ) : null;
  return { selection, panel, busy };
}
