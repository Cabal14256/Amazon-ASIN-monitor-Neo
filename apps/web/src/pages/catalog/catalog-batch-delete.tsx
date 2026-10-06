import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { Button } from '../../components/ui/button';
import { useTaskQuery } from '../../hooks/tasks';
import { isBulkDeleteId } from '../../services/catalog-batch-delete';
import { isTerminalTask } from '../../services/tasks';
import { browserBatchDeleteRecovery } from './catalog-batch-delete-recovery';
import { catalogAccessDenied, catalogError } from './catalog-data';
import {
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
  const busyRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(options);
  latest.current = options;
  const recovery = useMemo(() => {
    try {
      return browserBatchDeleteRecovery(owner, options.config.id);
    } catch {
      return null;
    }
  }, [owner, options.config.id]);
  const gate = options.safety?.phase === 'batch-delete' ? options.safety : null;
  const task = useTaskQuery(
    runtime,
    gate?.state === 'task' ? gate.taskId : undefined,
    access.canReadASIN,
  );
  const enabled = Boolean(
    options.config.batchDelete &&
      options.enabled &&
      access.canDeleteASIN &&
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
        ? createAccess(state.identity).canDeleteASIN
        : createAccess(state.identity).canReadASIN)
    );
  };
  const publish = (value: CatalogSafetyGate | null) => {
    if (!current(false)) return;
    runtime.queryClient.setQueryData(
      ['catalog-write-safety', owner, options.config.id],
      value,
    );
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    setSelection({ scope, ids: [] });
    setConfirmation(null);
    setMessage(null);
    setAcknowledged(false);
  }, [scope]);
  useLayoutEffect(() => {
    if (!options.safety) return;
    setSelection({ scope, ids: [] });
    setConfirmation(null);
  }, [options.safety, scope]);
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
        if (stored?.phase === 'batch-delete')
          runtime.queryClient.setQueryData(
            ['catalog-write-safety', owner, recovery.domain],
            stored,
          );
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
  }, [owner, recovery, runtime.queryClient, revision]);

  async function refresh() {
    if (!current(false)) throw new Error('当前会话已变化，请在原账号下核实。');
    const config = latest.current.config;
    const query = latest.current.query;
    await runtime.queryClient.cancelQueries({ queryKey: [config.id] });
    if (!current(false)) throw new Error('当前会话已变化，请在原账号下核实。');
    const first = await config.list(runtime.http, query);
    if (!current(false)) throw new Error('当前会话已变化，请在原账号下核实。');
    const last = Math.max(1, Math.ceil(first.total / first.pageSize));
    const corrected =
      first.current > last ? { ...query, current: last } : query;
    const fresh =
      corrected === query ? first : await config.list(runtime.http, corrected);
    if (!current(false)) throw new Error('当前会话已变化，请在原账号下核实。');
    runtime.queryClient.removeQueries({ queryKey: [config.id, 'group'] });
    runtime.queryClient.setQueryData([config.id, 'groups', corrected], fresh);
    if (corrected !== query) latest.current.onQuery(corrected);
  }
  async function reconcile(
    expected: CatalogBatchDeleteGate,
    acknowledgeUnknown = false,
  ) {
    if (!recovery || !current(false) || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await recovery.reconcile(
        expected,
        (id) => runtime.tasks.get(id),
        refresh,
        () => current(false),
        acknowledgeUnknown,
      );
      if (!current(false)) return;
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
    } catch (error) {
      if (current(false)) {
        publish(recovery.read());
        setMessage(`核实失败，删除保护仍保留：${catalogError(error)}`);
        if (catalogAccessDenied(error)) latest.current.onDenied();
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
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
    busyRef.current = true;
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
        () => current(true),
        publish,
      );
      if (!current(false)) return;
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
      if (current(false)) setMessage(catalogError(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
    if (accepted?.state === 'refresh') await reconcile(accepted);
  }
  const reconcileCurrent = useRef(reconcile);
  reconcileCurrent.current = reconcile;
  const terminalAttempts = useRef(new Set<string>());
  useEffect(() => {
    if (
      !gate ||
      gate.state !== 'task' ||
      task.data?.taskId !== gate.taskId ||
      !isTerminalTask(task.data.status)
    )
      return;
    const key = `${owner}:${revision}:${gate.operationId}:${task.data.status}`;
    if (terminalAttempts.current.has(key) || busyRef.current) return;
    terminalAttempts.current.add(key);
    void reconcileCurrent.current(gate);
  }, [gate, task.data, owner, revision, busy]);
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
              <li key={id}>{id}</li>
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
            {gate.state === 'task'
              ? '批量删除任务已受理，等待核实结果'
              : gate.state === 'refresh'
              ? '删除已结束，等待重读目录'
              : '批量删除提交结果未知'}
          </h3>
          <p className="mt-2 text-sm">
            {gate.message ||
              '请求可能已经受理。保护期间不能再次写入；不会自动重试删除。'}
          </p>
          {gate.taskId && (
            <p className="neo-mono my-2 break-all text-xs">
              任务 ID：{gate.taskId}
            </p>
          )}
          {gate.state === 'task' && task.data && (
            <p className="my-2 text-sm">
              任务状态：{task.data.status} · 进度{' '}
              {Math.max(0, Math.min(100, task.data.progress))}%
            </p>
          )}
          {gate.state === 'task' && task.isError && (
            <p className="my-2 text-sm">
              任务查询失败，保护仍保留：{catalogError(task.error)}
            </p>
          )}
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
          {gate.state === 'unknown' && (
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
