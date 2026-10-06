import { Upload } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { useTaskQuery } from '../../hooks/tasks';
import { ApiError } from '../../lib/http';
import {
  submitVariantGroupImport,
  uncertainAsinImportTaskId,
  validateAsinImportFile,
  type ImportDomain,
} from '../../services/asin-import';
import { isActiveTask, isTerminalTask } from '../../services/tasks';
import {
  claimImportGate,
  importGateKey,
  readImportGate,
  writeImportGate,
  type AsinImportGate,
} from './asin-import-gate';

function storage(kind: 'local' | 'session' = 'local'): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function restoredGate(
  stored: Storage,
  domain: ImportDomain,
  userId: string,
): AsinImportGate | null {
  const persisted = readImportGate(stored, domain, userId);
  if (
    persisted &&
    (persisted.phase !== 'uncertain' || persisted.taskId !== null)
  )
    return persisted;
  const session = storage('session');
  const fallback = session ? readImportGate(session, domain, userId) : null;
  return fallback?.phase === 'uncertain' &&
    fallback.taskId &&
    (!persisted || fallback.savedAt === persisted.savedAt)
    ? fallback
    : persisted;
}

function publicError(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : '导入请求未能确认，请先到任务中心核实。';
}

function definiteRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.kind === 'INVALID_INPUT' ||
      error.kind === 'AUTH' ||
      (error.kind === 'HTTP' &&
        [400, 403, 413, 429].includes(error.status ?? 0)))
  );
}

export function AsinImportPanel({
  domain = 'asin',
}: {
  domain?: ImportDomain;
}) {
  const verified = useIdentity();
  const current =
    verified.status === 'authenticated' ? verified.identity : undefined;
  const access = createAccess(current);
  if (!access.canWriteASIN || access.mustChangePassword) return null;
  // A new owner/session or domain must not reuse files, task snapshots or in-flight UI.
  // Persisted gates remain owner/domain scoped so refresh can recover the same task.
  return (
    <ImportPanel
      key={JSON.stringify([domain, current?.user.id, current?.sessionId])}
      domain={domain}
    />
  );
}

function ImportPanel({ domain }: { domain: ImportDomain }) {
  const { runtime, identity, announce } = useAuth();
  const verified = useIdentity();
  const current =
    verified.status === 'authenticated' ? verified.identity : undefined;
  const userId = current?.user.id ?? '';
  const access = createAccess(current);
  const canImport = access.canWriteASIN && !access.mustChangePassword;
  const domainLabel = domain === 'competitor' ? '竞品 ASIN' : '主营 ASIN';
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [gate, setGate] = useState<AsinImportGate | null>(null);
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [settlementUnavailable, setSettlementUnavailable] = useState(false);
  const [settlementRetry, setSettlementRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const claiming = useRef(false);
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const owner = useRef(userId);
  owner.current = userId;
  const importAllowed = useRef(canImport);
  importAllowed.current = canImport;
  const taskId = gate?.taskId ?? lastTaskId ?? undefined;
  const task = useTaskQuery(
    runtime,
    taskId,
    Boolean(canImport && userId && taskId && access.canReadASIN),
  );
  const latestTask = useRef(task.data);
  latestTask.current = task.data;
  const matchingTask =
    task.data?.taskId === gate?.taskId ? task.data : undefined;
  const activeTask = Boolean(matchingTask && isActiveTask(matchingTask.status));
  const terminalTask = Boolean(
    matchingTask && isTerminalTask(matchingTask.status),
  );
  const canReconcile = Boolean(
    gate &&
      !activeTask &&
      !(terminalTask && gate.phase !== 'settled') &&
      (gate.phase === 'settled' ||
        (gate.phase === 'uncertain' &&
          (!gate.taskId ||
            matchingTask ||
            task.isError ||
            !access.canReadASIN)) ||
        (gate.phase === 'accepted' && (task.isError || !access.canReadASIN))),
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  useEffect(() => {
    request.current?.abort();
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    setLastTaskId(null);
    setNotice(null);
    setSettlementUnavailable(false);
    if (!canImport || !userId) {
      setGate(null);
      setOpen(false);
      return;
    }
    const stored = storage();
    const restored = stored ? restoredGate(stored, domain, userId) : null;
    setGate(restored);
    if (restored) setOpen(true);
  }, [canImport, domain, userId]);

  useEffect(() => {
    if (!canImport || !userId) return;
    const syncGate = (event: StorageEvent) => {
      const stored = storage();
      if (
        !stored ||
        event.storageArea !== stored ||
        event.key !== importGateKey(domain, userId)
      )
        return;
      const restored = restoredGate(stored, domain, userId);
      if (request.current && !restored) return;
      if (!restored) {
        if (gateRef.current?.taskId) setLastTaskId(gateRef.current.taskId);
      }
      if (!restored || restored.phase === 'settled') {
        void runtime.queryClient.invalidateQueries({ queryKey: [domain] });
      }
      gateRef.current = restored;
      setGate(restored);
      if (restored) setOpen(true);
    };
    window.addEventListener('storage', syncGate);
    return () => window.removeEventListener('storage', syncGate);
  }, [canImport, domain, runtime.queryClient, userId]);

  useEffect(() => {
    const result = task.data;
    if (
      !result ||
      !taskId ||
      result.taskId !== taskId ||
      !isTerminalTask(result.status) ||
      gate?.taskId !== taskId ||
      gate.phase === 'settled'
    )
      return;
    setSettlementUnavailable(false);
    const stored = storage();
    const locks = navigator.locks;
    if (!stored || !locks) {
      setSettlementUnavailable(true);
      setNotice('无法保存导入任务状态，请检查浏览器本地存储和跨标签锁。');
      return;
    }
    let active = true;
    const message =
      result.status === 'completed'
        ? '导入任务已完成，请核对任务中心的成功、失败行与报告。'
        : result.status === 'cancelled'
        ? '导入任务已取消，可能已有部分行提交；请核对后再决定是否重试。'
        : '导入任务失败，可能已有部分行提交；请核对后再决定是否重试。';
    void locks
      .request(importGateKey(domain, userId), () => {
        // Do not interpret temporarily inaccessible storage as an absent gate.
        stored.getItem(importGateKey(domain, userId));
        const persisted = restoredGate(stored, domain, userId);
        // A failed write may leave only the original sending claim, while the
        // current tab still knows the authoritative task ID.
        const matchesSendingClaim =
          gate.phase === 'uncertain' &&
          persisted?.phase === 'uncertain' &&
          persisted.taskId === null &&
          persisted.savedAt === gate.savedAt;
        if (persisted?.taskId !== taskId && !matchesSendingClaim)
          return { kind: 'changed' as const, gate: persisted };
        const nextGate: AsinImportGate | null =
          result.status === 'completed'
            ? null
            : { phase: 'settled', taskId, savedAt: gate.savedAt };
        const session = storage('session');
        const sessionRaw = session?.getItem(importGateKey(domain, userId));
        if (!writeImportGate(stored, domain, userId, nextGate))
          return { kind: 'unavailable' as const };
        if (
          session &&
          sessionRaw &&
          !writeImportGate(session, domain, userId, null)
        )
          return { kind: 'unavailable' as const };
        return { kind: 'settled' as const, gate: nextGate };
      })
      .then((transition) => {
        if (!active || owner.current !== userId || !mounted.current) return;
        if (transition.kind === 'changed') {
          setGate(transition.gate);
          if (transition.gate) setOpen(true);
          // Another tab may already have settled this authoritative terminal
          // result while this effect was waiting for the same Web Lock.
          void runtime.queryClient.invalidateQueries({ queryKey: [domain] });
          return;
        }
        if (transition.kind === 'unavailable') {
          setSettlementUnavailable(true);
          setNotice('无法保存导入任务状态，请检查浏览器本地存储权限。');
          return;
        }
        setLastTaskId(taskId);
        setGate(transition.gate);
        setNotice(message);
        announce(message);
        void runtime.queryClient.invalidateQueries({ queryKey: [domain] });
      })
      .catch(() => {
        if (active && owner.current === userId && mounted.current) {
          setSettlementUnavailable(true);
          setNotice('无法取得浏览器导入锁，请稍后重试。');
        }
      });
    return () => {
      active = false;
    };
  }, [
    announce,
    domain,
    gate?.phase,
    gate?.taskId,
    gate?.savedAt,
    runtime.queryClient,
    task.data,
    taskId,
    userId,
    settlementRetry,
  ]);

  if (!canImport) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || gate || claiming.current || request.current || !userId) return;
    try {
      validateAsinImportFile(file);
    } catch (error) {
      setNotice(publicError(error));
      return;
    }
    const stored = storage();
    if (!stored) {
      setNotice('浏览器本地存储不可用，无法安全记录导入状态。');
      return;
    }
    const locks = navigator.locks;
    if (!locks) {
      setNotice(
        '浏览器不支持安全的跨标签导入锁，请使用支持 Web Locks 的浏览器。',
      );
      return;
    }
    claiming.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await locks.request(importGateKey(domain, userId), async () => {
        if (
          owner.current !== userId ||
          !importAllowed.current ||
          !mounted.current
        )
          return;
        const claim = claimImportGate(stored, domain, userId);
        if (claim.kind !== 'claimed') {
          if (claim.kind === 'blocked') {
            setGate(claim.gate);
            setOpen(true);
            setNotice('已有导入请求待核实，请先查看任务中心。');
          } else setNotice('无法保存导入状态，请检查浏览器本地存储权限。');
          return;
        }
        const controller = new AbortController();
        request.current = controller;
        setLastTaskId(null);
        setGate(claim.gate);
        try {
          const result = await submitVariantGroupImport(
            runtime.http,
            file,
            domain,
            controller.signal,
          );
          const accepted: AsinImportGate = {
            phase: 'accepted',
            taskId: result.taskId,
            savedAt: Date.now(),
          };
          const persisted = writeImportGate(stored, domain, userId, accepted);
          const session = storage('session');
          const fallback: AsinImportGate = {
            ...accepted,
            phase: 'uncertain',
            savedAt: claim.gate.savedAt,
          };
          if (session)
            writeImportGate(
              session,
              domain,
              userId,
              persisted ? null : fallback,
            );
          if (owner.current !== userId || !mounted.current) return;
          setGate(persisted ? accepted : fallback);
          setLastTaskId(result.taskId);
          setNotice(
            persisted
              ? '文件已受理为异步任务，等待任务中心确认处理结果。'
              : '任务已受理，但浏览器未能保存任务编号。请立即记录下方编号并到任务中心核实；刷新页面后编号可能丢失。',
          );
          setFile(null);
          if (fileInput.current) fileInput.current.value = '';
        } catch (error) {
          const unknownId = uncertainAsinImportTaskId(error);
          const uncertain = !definiteRejection(error);
          const nextGate: AsinImportGate | null = uncertain
            ? { phase: 'uncertain', taskId: unknownId, savedAt: Date.now() }
            : null;
          const persisted = writeImportGate(stored, domain, userId, nextGate);
          const fallback: AsinImportGate | null =
            uncertain && !persisted
              ? {
                  phase: 'uncertain',
                  taskId: unknownId,
                  savedAt: claim.gate.savedAt,
                }
              : nextGate;
          const session = storage('session');
          if (session)
            writeImportGate(
              session,
              domain,
              userId,
              !persisted && unknownId ? fallback : null,
            );
          if (owner.current !== userId || !mounted.current) return;
          setGate(
            persisted
              ? nextGate
              : fallback ??
                  restoredGate(stored, domain, userId) ?? {
                    phase: 'uncertain',
                    taskId: null,
                    savedAt: claim.gate.savedAt,
                  },
          );
          if (uncertain) {
            setFile(null);
            if (fileInput.current) fileInput.current.value = '';
          }
          setNotice(
            uncertain
              ? unknownId
                ? persisted
                  ? '提交状态未确认，请先按任务编号到任务中心核实，避免重复导入。'
                  : '提交状态未确认，浏览器未能保存任务编号。请立即记录下方编号并到任务中心核实；刷新页面后编号可能丢失。'
                : persisted
                ? '提交状态未确认，请按提交时间和文件到任务中心核实，避免重复导入。'
                : '提交状态未确认，浏览器未能保存导入门禁。请按提交时间和文件到任务中心核实，避免重复导入。'
              : persisted
              ? publicError(error)
              : '请求已被拒绝，但浏览器未能清除导入门禁；请核实后解锁。',
          );
          if (error instanceof ApiError && error.status === 403)
            void identity.refresh();
        } finally {
          if (request.current === controller) request.current = null;
        }
      });
    } catch {
      if (mounted.current) {
        setNotice('无法取得浏览器导入锁，请稍后重试。');
      }
    } finally {
      claiming.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function unlockAfterReconciliation() {
    if (!canReconcile) return;
    const stored = storage();
    const locks = navigator.locks;
    if (!stored || !locks || !gate) {
      setNotice('无法清除导入锁，请检查浏览器本地存储权限。');
      return;
    }
    const expected = gate;
    let result: 'changed' | 'cleared' | 'unavailable' | 'active';
    try {
      const key = importGateKey(domain, userId);
      const previousRaw = stored.getItem(key);
      result = await locks.request(key, () => {
        if (
          latestTask.current?.taskId === expected.taskId &&
          isActiveTask(latestTask.current.status)
        )
          return 'active' as const;
        if (
          latestTask.current?.taskId === expected.taskId &&
          isTerminalTask(latestTask.current.status) &&
          expected.phase !== 'settled'
        )
          return 'changed' as const;
        const current = readImportGate(stored, domain, userId);
        const session = storage('session');
        const sessionGate = session
          ? readImportGate(session, domain, userId)
          : null;
        const matchesUnsavedGate =
          expected.phase === 'uncertain' &&
          expected.taskId &&
          ((current?.phase === 'uncertain' &&
            current.taskId === null &&
            current.savedAt === expected.savedAt) ||
            (!current &&
              JSON.stringify(sessionGate) === JSON.stringify(expected)));
        if (
          stored.getItem(key) !== previousRaw ||
          (JSON.stringify(current) !== JSON.stringify(expected) &&
            !matchesUnsavedGate)
        )
          return 'changed' as const;
        return writeImportGate(stored, domain, userId, null)
          ? ('cleared' as const)
          : ('unavailable' as const);
      });
    } catch {
      result = 'unavailable';
    }
    if (owner.current !== userId || !mounted.current) return;
    if (result === 'active') {
      setNotice('原导入任务仍在运行，结束前不能解锁或重新导入。');
      return;
    }
    if (result !== 'cleared') {
      setGate(restoredGate(stored, domain, userId));
      setNotice(
        result === 'changed'
          ? '原任务状态已变化，请重新核实后再解锁。'
          : '无法清除导入锁，请检查浏览器本地存储权限。',
      );
      return;
    }
    const session = storage('session');
    if (session && !writeImportGate(session, domain, userId, null)) {
      setNotice('无法清除导入锁，请检查浏览器会话存储权限。');
      return;
    }
    setGate(null);
    setLastTaskId(null);
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    setNotice('请确认原任务不会继续写入后再重新导入。');
  }

  function downloadTemplate() {
    const header =
      domain === 'competitor'
        ? '\uFEFF变体组名称,国家,品牌,ASIN,ASIN类型,ASIN名称\r\n'
        : '\uFEFF变体组名称,国家,站点,品牌,ASIN,ASIN类型,ASIN名称\r\n';
    const url = URL.createObjectURL(new Blob([header], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download =
      domain === 'competitor' ? '竞品ASIN导入模板.csv' : 'ASIN导入模板.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  return (
    <section aria-label={`${domainLabel} 导入`}>
      <Button
        variant="secondary"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <Upload aria-hidden="true" />
        导入 CSV / XLSX
      </Button>
      {open && (
        <Card className="mt-3">
          <CardHeader
            title={`批量导入${domainLabel}`}
            description="上传单个 CSV 或 XLSX 文件，最多 10 MiB。服务端异步处理后可在任务中心核对逐行结果。"
          />
          <CardContent className="space-y-4">
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                首行列名：
                {domain === 'competitor'
                  ? '变体组名称、国家、品牌、ASIN、ASIN类型'
                  : '变体组名称、国家、站点、品牌、ASIN、ASIN类型'}
                ；可选 ASIN名称放在类型之后。ASIN类型可填 1（主链）或
                2（副评）。
              </p>
              <Button variant="ghost" size="small" onClick={downloadTemplate}>
                下载 CSV 模板
              </Button>
            </div>
            <form
              onSubmit={(event) => void submit(event)}
              className="space-y-4"
            >
              <label
                className="block text-sm font-medium"
                htmlFor={`${domain}-import-file`}
              >
                选择文件
              </label>
              <input
                ref={fileInput}
                id={`${domain}-import-file`}
                type="file"
                accept=".csv,.xlsx"
                disabled={Boolean(gate) || busy}
                onChange={(event) =>
                  setFile(event.currentTarget.files?.item(0) ?? null)
                }
                className="block w-full rounded-control border border-input bg-card p-3 text-sm"
              />
              {file && <p className="break-all text-xs">{file.name}</p>}
              <Button
                type="submit"
                pending={busy}
                disabled={!file || Boolean(gate)}
              >
                上传并创建导入任务
              </Button>
              {busy && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => request.current?.abort()}
                >
                  取消本地上传
                </Button>
              )}
            </form>
            {notice && (
              <p role="status" className="text-sm">
                {notice}
              </p>
            )}
            {gate && (
              <div className="space-y-3 rounded-control bg-status-warning-soft p-4 text-sm">
                <p>
                  {gate.phase === 'accepted'
                    ? '任务已受理，处理完成前请勿重复上传同一文件。'
                    : gate.phase === 'sending'
                    ? '正在提交文件，请等待受理结果。'
                    : gate.phase === 'settled'
                    ? '任务已结束，可能已有部分行提交；请核对结果后再解锁。'
                    : '提交结果不确定，请先核实任务状态。'}
                </p>
                {gate.taskId && (
                  <p className="neo-mono break-all text-xs">
                    任务编号：{gate.taskId}
                  </p>
                )}
                {task.data && (
                  <Progress value={task.data.progress} label="导入任务进度" />
                )}
                {task.isError && (
                  <p role="alert">暂时无法读取任务，请到任务中心核实。</p>
                )}
                <a className="font-semibold underline" href="/tasks">
                  打开任务中心
                </a>
                {settlementUnavailable &&
                  terminalTask &&
                  gate.phase !== 'settled' && (
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => setSettlementRetry((value) => value + 1)}
                    >
                      重试保存任务状态
                    </Button>
                  )}
                {canReconcile && (
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => void unlockAfterReconciliation()}
                  >
                    已核实原任务，允许重新导入
                  </Button>
                )}
              </div>
            )}
            {!gate && lastTaskId && (
              <p className="neo-mono break-all text-xs">
                上次任务编号：{lastTaskId} ·{' '}
                <a className="underline" href="/tasks">
                  查看任务中心
                </a>
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
