import type { BackupConfig, TaskInfo } from '@asin-monitor/contracts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/field';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import { BackupApi } from '../../services/backup';
import {
  chooseBackupDestination,
  downloadBackup,
} from '../../services/backup-download';
import {
  backupConfigDraft,
  backupRestoreWarning,
  backupTaskOutcome,
  type BackupFile,
  type BackupTarget,
} from '../../services/backup-model';
import { taskStatus } from '../tasks/task-display';
import { BackupRecovery, type BackupGate } from './backup-recovery';

function failure(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : '读取或操作未确认，请重读并核实原任务、备份文件和数据库状态。';
}
const cancelled = (error: unknown) =>
  error instanceof ApiError && error.kind === 'CANCELLED';
const capability = (file: BackupFile) =>
  JSON.stringify([
    file.filename,
    file.target,
    file.size,
    file.restoreSupported,
    file.restoreMode,
    file.sourceEngine,
    file.scope,
    file.createdAt,
  ]);
const scheduleIdentity = (config: BackupConfig) =>
  JSON.stringify([
    config.id,
    config.enabled,
    config.scheduleType,
    config.scheduleValue,
    config.backupTime,
    config.updateTime,
  ]);
function bytesLabel(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(2)} MiB`
    : `${bytes} B`;
}
type Confirmation = { kind: 'restore' | 'delete'; file: BackupFile };

export function BackupPanel() {
  const { runtime, identity: identities } = useAuth();
  const identity = useIdentity();
  const [, renderSession] = useState(0);
  useEffect(
    () => runtime.subscribeSession(() => renderSession((value) => value + 1)),
    [runtime],
  );
  const principal =
    identity.status === 'authenticated' ? identity.identity : undefined;
  const access = createAccess(principal);
  const owner = principal?.user.id;
  const sessionId = principal?.sessionId;
  const revision = runtime.session.revision;
  const allowed = Boolean(
    owner && access.canWriteSettings && !access.mustChangePassword,
  );
  const current = () => {
    const value = identities.getSnapshot();
    const user = value.status === 'authenticated' ? value.identity : undefined;
    const policy = createAccess(user);
    return (
      user?.user.id === owner &&
      user?.sessionId === sessionId &&
      policy.canWriteSettings &&
      !policy.mustChangePassword &&
      runtime.session.revision === revision
    );
  };
  if (!allowed || !owner)
    return (
      <Card>
        <CardHeader title="备份与恢复" />
        <CardContent>
          <p role="status">
            备份列表、计划记录和操作都需要当前有效的 settings:write
            权限。请完成身份验证及必要的密码更新。
          </p>
        </CardContent>
      </Card>
    );
  return (
    <BackupWorkspace
      key={JSON.stringify([owner, sessionId, revision])}
      owner={owner}
      current={current}
    />
  );
}

function BackupWorkspace({
  owner,
  current: active,
}: {
  owner: string;
  current: () => boolean;
}) {
  const { runtime, identity, announce } = useAuth();
  const api = useMemo(() => new BackupApi(runtime.http), [runtime.http]);
  const currentRef = useRef(active);
  currentRef.current = active;
  const alive = useRef(true),
    requests = useRef(new Set<AbortController>());
  const readChannels = useRef(new Map<string, AbortController>());
  const current = () => alive.current && currentRef.current();
  const recovery = useMemo(() => {
    try {
      return navigator.locks && window.localStorage
        ? new BackupRecovery(
            owner,
            window.localStorage,
            navigator.locks,
            undefined,
            undefined,
            window.sessionStorage,
          )
        : null;
    } catch {
      return null;
    }
  }, [owner]);
  const [files, setFiles] = useState<BackupFile[]>([]),
    [page, setPage] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [draft, setDraft] = useState<ReturnType<
    typeof backupConfigDraft
  > | null>(null);
  const dirty = useRef(false),
    baseline = useRef<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<TaskInfo[]>([]),
    [scheduledError, setScheduledError] = useState<string | null>(null);
  const [gate, setGate] = useState<BackupGate | null>(null),
    [damaged, setDamaged] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [task, setTask] = useState<TaskInfo | null>(null),
    [verified, setVerified] = useState(false);
  const [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<BackupTarget>('primary'),
    [description, setDescription] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [download, setDownload] = useState<{
    filename: string;
    bytes: number;
  } | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const locked = busy || !!gate || damaged || refreshRequired || !recovery;

  useLayoutEffect(() => {
    alive.current = true;
    const controllers = requests.current;
    return () => {
      alive.current = false;
      for (const request of controllers) request.abort();
    };
  }, []);
  const onFailure = (error: unknown) => {
    if (!current() || (error instanceof ApiError && error.kind === 'CANCELLED'))
      return;
    setNotice(failure(error));
    if (
      error instanceof ApiError &&
      (error.status === 403 || error.kind === 'AUTH')
    )
      void identity.refresh();
  };
  const readGuard = () => {
    if (!current() || !recovery) return;
    try {
      setGate(recovery.read());
      setDamaged(false);
    } catch {
      setGate(null);
      setDamaged(true);
      setNotice(
        '备份操作保护记录损坏或不可读，请核实原任务、备份文件和数据库后再解除保护。',
      );
    }
    setVerified(false);
  };
  const request = async <T,>(
    work: (signal: AbortSignal) => Promise<T>,
    channel?: string,
  ): Promise<T> => {
    if (!current()) throw new ApiError('CANCELLED', '会话已改变');
    const controller = new AbortController();
    if (channel) {
      readChannels.current.get(channel)?.abort();
      readChannels.current.set(channel, controller);
    }
    requests.current.add(controller);
    try {
      const result = await work(controller.signal);
      if (!current() || controller.signal.aborted)
        throw new ApiError('CANCELLED', '会话或读取范围已改变');
      return result;
    } finally {
      requests.current.delete(controller);
      if (channel && readChannels.current.get(channel) === controller)
        readChannels.current.delete(channel);
    }
  };
  const loadFiles = async () => {
    const rows = await request((signal) => api.list(signal), 'files');
    setFiles(rows);
    setPage(0);
    setFileError(null);
    readGuard();
    setRefreshRequired(false);
  };
  const loadConfig = async () => {
    const value = await request((signal) => api.config(signal), 'config');
    setConfig(value);
    setConfigError(null);
    if (!dirty.current) {
      setDraft(backupConfigDraft(value));
      baseline.current = scheduleIdentity(value);
    }
  };
  const loadScheduled = async () => {
    const rows = await request((signal) => api.scheduled(signal), 'scheduled');
    setScheduled(rows);
    setScheduledError(null);
  };
  const refreshFiles = () =>
    void loadFiles().catch((error) => {
      if (cancelled(error)) return;
      if (current()) setFileError(failure(error));
      onFailure(error);
    });
  const refreshConfig = () =>
    void loadConfig().catch((error) => {
      if (cancelled(error)) return;
      if (current()) setConfigError(failure(error));
      onFailure(error);
    });
  const refreshScheduled = () =>
    void loadScheduled().catch((error) => {
      if (cancelled(error)) return;
      if (current()) setScheduledError(failure(error));
      onFailure(error);
    });
  useEffect(() => {
    readGuard();
    refreshFiles();
    refreshConfig();
    refreshScheduled();
    const peerChanged = (event: StorageEvent) => {
      if (!recovery || event.key !== recovery.key || !current()) return;
      if (event.newValue === null) {
        setRefreshRequired(true);
        setNotice('其他窗口已解除原保护，先成功重读备份列表才能继续操作。');
        refreshFiles();
      } else {
        readGuard();
        setTask(null);
        setConfirmation(null);
      }
    };
    window.addEventListener('storage', peerChanged);
    return () => window.removeEventListener('storage', peerChanged);
    // A keyed workspace owns one verified owner/session; callbacks read live scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, recovery]);

  const submit = async (
    operation: import('../../services/backup-model').BackupOperation,
  ) => {
    if (!current() || !recovery || locked) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await recovery.submit(
        operation,
        () => request((signal) => api.submit(operation, signal)),
        current,
      );
      if (!current()) return;
      if (outcome.kind === 'rejected') onFailure(outcome.error);
      else if (outcome.kind !== 'stale') {
        setGate(outcome.gate);
        setVerified(false);
        setTask(null);
        setNotice(
          outcome.kind === 'task'
            ? '已保留原任务编号，请查询原任务；核实前不能再次提交。'
            : '提交结果尚未确认，已保留保护，请先查询任务中心或人工核实。',
        );
        if ('persisted' in outcome && !outcome.persisted)
          setNotice(
            '原任务回执未能完整保存，请记录任务编号并核实；原提交保护仍保留。',
          );
        setDescription('');
      }
    } catch (error) {
      onFailure(error);
      readGuard();
    } finally {
      if (current()) setBusy(false);
    }
  };
  const confirm = async () => {
    if (!confirmation || locked || !current() || !recovery) return;
    const selected = confirmation;
    setConfirmation(null);
    if (selected.kind === 'restore') {
      setBusy(true);
      try {
        const rows = await request((signal) => api.list(signal), 'files');
        setFiles(rows);
        const fresh = rows.find(
          (file) => file.filename === selected.file.filename,
        );
        if (
          !fresh?.restoreSupported ||
          capability(fresh) !== capability(selected.file)
        )
          throw new ApiError(
            'INVALID_INPUT',
            '归档或恢复能力已改变，请重新查看列表并确认',
          );
        setBusy(false);
        await submit({
          operation: 'restore',
          target: fresh.target,
          filename: fresh.filename,
          restoreMode: fresh.restoreMode,
        });
      } catch (error) {
        onFailure(error);
      } finally {
        if (current()) setBusy(false);
      }
    } else {
      setBusy(true);
      try {
        await recovery.writeIfClear(
          () => request((signal) => api.remove(selected.file.filename, signal)),
          current,
        );
        await loadFiles();
        announce('备份已删除，列表已重新读取。');
      } catch (error) {
        setRefreshRequired(true);
        onFailure(error);
      } finally {
        if (current()) setBusy(false);
      }
    }
  };
  const saveSchedule = async () => {
    if (locked || !draft || !recovery || !current()) return;
    setBusy(true);
    try {
      await recovery.writeIfClear(async () => {
        const fresh = await request((signal) => api.config(signal), 'config');
        if (scheduleIdentity(fresh) !== baseline.current) {
          setConfig(fresh);
          throw new ApiError(
            'INVALID_INPUT',
            '自动计划已被其他管理员修改，请放弃旧草稿并重新读取后编辑',
          );
        }
        const saved = await request((signal) => api.saveConfig(draft, signal));
        setConfig(saved);
        setDraft(backupConfigDraft(saved));
        baseline.current = scheduleIdentity(saved);
        dirty.current = false;
      }, current);
      announce('自动备份计划已保存，调度器将读取新配置。');
    } catch (error) {
      setRefreshRequired(true);
      onFailure(error);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const queryOriginal = async () => {
    if (!gate || !recovery || busy) return;
    setBusy(true);
    try {
      const value = await request((signal) =>
        recovery.task(gate, (id) => runtime.tasks.get(id, signal)),
      );
      const latest = recovery.read();
      if (
        latest?.requestId !== gate.requestId ||
        latest?.taskId !== gate.taskId
      )
        throw new ApiError('CANCELLED', '原操作保护已改变');
      setTask(value);
      setNotice(
        value
          ? `原任务：${taskStatus(value.status).label}`
          : '原任务记录未找到或未返回编号，不能据此认定没有执行，请人工核实。',
      );
    } catch (error) {
      onFailure(error);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const clearVerified = async () => {
    if (!verified || !recovery || busy || !current()) return;
    setBusy(true);
    try {
      const cleared = gate
        ? await recovery.clearVerified(
            gate,
            (id) => request((signal) => runtime.tasks.get(id, signal)),
            loadFiles,
            current,
          )
        : await recovery.clearDamagedVerified(loadFiles, current, (id) =>
            request((signal) => runtime.tasks.get(id, signal)),
          );
      if (!cleared)
        throw new ApiError('INVALID_INPUT', '原保护已改变，请重新核实');
      readGuard();
      setTask(null);
      setNotice('核实与重读完成，原提交保护已解除。');
    } catch (error) {
      onFailure(error);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const startDownload = (file: BackupFile) => {
    if (!current() || downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    requests.current.add(controller);
    setDownload({ filename: file.filename, bytes: 0 });
    // The picker is invoked synchronously in this user gesture.
    let chosen: ReturnType<typeof chooseBackupDestination>;
    try {
      chosen = chooseBackupDestination(file);
    } catch (error) {
      chosen = Promise.reject(error);
    }
    void chosen
      .then(async (destination) => {
        if (!current() || controller.signal.aborted)
          throw new ApiError('CANCELLED', '下载已取消');
        await downloadBackup(
          runtime.http,
          api,
          file,
          destination,
          controller.signal,
          current,
          (bytes) => setDownload({ filename: file.filename, bytes }),
        );
        if (current())
          announce('备份归档已保存，包含 custom dump 与验证过的元数据。');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError')
          return;
        onFailure(error);
      })
      .finally(() => {
        requests.current.delete(controller);
        if (downloadController.current === controller)
          downloadController.current = null;
        if (current()) setDownload(null);
      });
  };
  const rows = files.slice(page * 20, (page + 1) * 20);
  return (
    <div className="space-y-6">
      {notice && (
        <p
          role="status"
          className="rounded-control bg-status-warning-soft p-4 text-sm"
        >
          {notice}
        </p>
      )}
      {(!recovery || gate || damaged || refreshRequired) && (
        <Card>
          <CardHeader title="备份操作保护" />
          <CardContent>
            <p>原操作尚需核实；刷新页面不会自动重复提交。</p>
            {refreshRequired && (
              <p role="alert" className="mt-3">
                其他窗口已解除原保护或本次操作需要重读。必须成功重读备份列表才能继续操作；读取失败时请使用“仅重读备份列表”重试。
              </p>
            )}
            {!recovery && (
              <p role="alert">
                当前浏览器无法提供持久存储和 Web
                Locks，不能安全提交备份或恢复。只读列表仍可查看。
              </p>
            )}
            {gate && (
              <p className="neo-mono mt-3 break-all">
                {gate.operation === 'create' ? '创建备份' : '恢复备份'} ·{' '}
                {gate.target} ·{' '}
                {formatBeijing(new Date(gate.submittedAt).toISOString())}
                <br />
                任务：{gate.taskId ?? '编号未确认'}
              </p>
            )}
            {task && (
              <div className="mt-3">
                <p>
                  {taskStatus(task.status).label} · {task.message}
                </p>
                {backupTaskOutcome(task).map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-3">
              <a href="/tasks" className="underline">
                任务中心
              </a>
              <Button
                variant="secondary"
                disabled={!gate?.taskId || busy}
                onClick={() => void queryOriginal()}
              >
                查询原任务
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={refreshFiles}
              >
                仅重读备份列表
              </Button>
            </div>
            {(gate || damaged) && (
              <div className="mt-4 space-y-3">
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={verified}
                    disabled={busy}
                    onChange={(event) => setVerified(event.target.checked)}
                  />
                  已核实原任务、备份文件与数据库状态，无需再次提交原操作
                </label>
                <Button
                  disabled={
                    !verified ||
                    busy ||
                    !recovery ||
                    (!!task &&
                      !['completed', 'failed', 'cancelled'].includes(
                        task.status,
                      ))
                  }
                  onClick={() => void clearVerified()}
                >
                  已核实，重读列表并解除保护
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader
          title="创建 PostgreSQL 备份"
          description="完整数据库的 pg_dump custom 归档；旧 MySQL SQL 文件保留供历史审计，不能在 Neo 恢复。"
        />
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit({ operation: 'create', target, description });
            }}
          >
            <Field label="目标数据库">
              {(control) => (
                <select
                  {...control}
                  value={target}
                  disabled={locked}
                  onChange={(event) =>
                    setTarget(event.target.value as BackupTarget)
                  }
                  className="rounded-input border border-input p-3"
                >
                  <option value="primary">主营数据库</option>
                  <option value="competitor">竞品数据库</option>
                </select>
              )}
            </Field>
            <Field label="备份描述">
              {(control) => (
                <Input
                  {...control}
                  value={description}
                  maxLength={500}
                  disabled={locked}
                  onChange={(event) => setDescription(event.target.value)}
                />
              )}
            </Field>
            <Button type="submit" disabled={locked} pending={busy}>
              创建异步备份任务
            </Button>
          </form>
        </CardContent>
      </Card>
      {confirmation && (
        <section
          role="alertdialog"
          aria-label={
            confirmation.kind === 'restore' ? '确认恢复备份' : '确认删除备份'
          }
          className="rounded-control border border-status-danger/40 p-5"
        >
          <p className="break-all font-semibold">
            {confirmation.file.filename}
          </p>
          <p className="mt-3">
            {confirmation.kind === 'restore'
              ? backupRestoreWarning(confirmation.file)
              : '删除后此归档与元数据将不可再用于下载或恢复，请确认已有独立副本。'}
          </p>
          <div className="mt-4 flex gap-3">
            <Button
              variant="destructive"
              disabled={locked}
              onClick={() => void confirm()}
            >
              确认{confirmation.kind === 'restore' ? '恢复' : '删除'}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmation(null)}>
              取消
            </Button>
          </div>
        </section>
      )}
      <Card>
        <CardHeader
          title="备份列表"
          description="只显示 API 已验证的 Neo custom 归档。恢复能力会在提交前重新读取。"
          action={
            <Button variant="secondary" disabled={busy} onClick={refreshFiles}>
              刷新备份列表
            </Button>
          }
        />
        <CardContent>
          {fileError ? (
            <p role="alert">{fileError}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      {['归档', '目标与大小', '时间来源', '操作'].map(
                        (label) => (
                          <th key={label} className="p-3">
                            {label}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((file) => (
                      <tr
                        key={file.filename}
                        className="border-t border-border"
                      >
                        <td className="max-w-xs break-all p-3">
                          {file.filename}
                          <br />
                          {file.description}
                        </td>
                        <td className="p-3">
                          {file.target === 'primary' ? '主营' : '竞品'} ·{' '}
                          {bytesLabel(file.size)}
                          <br />
                          {file.sourceEngine ?? '引擎未确认'}
                        </td>
                        <td className="p-3">
                          {formatBeijing(file.createdAt)}
                          <br />
                          {
                            {
                              'dump-start': '实际 dump 执行起点',
                              filename: '文件名时间（兼容记录）',
                              mtime: '文件修改时间（需核实）',
                              unavailable: '来源未确认',
                            }[file.timeSource]
                          }
                          {file.execution && (
                            <p>
                              执行结束：
                              {formatBeijing(file.execution.dumpCompletedAt)}
                              ；发布开始：
                              {formatBeijing(
                                file.execution.publicationStartedAt,
                              )}
                            </p>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={!!download}
                              onClick={() => startDownload(file)}
                            >
                              下载归档
                            </Button>
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={locked || !file.restoreSupported}
                              onClick={() =>
                                setConfirmation({ kind: 'restore', file })
                              }
                            >
                              {file.restoreSupported
                                ? file.restoreMode === 'isolated'
                                  ? '隔离恢复'
                                  : '原位恢复'
                                : '恢复能力未确认'}
                            </Button>
                            <Button
                              size="small"
                              variant="destructive"
                              disabled={locked}
                              onClick={() =>
                                setConfirmation({ kind: 'delete', file })
                              }
                            >
                              删除归档
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!files.length && (
                <p className="p-3 text-sm">暂无经过验证的 Neo 备份归档。</p>
              )}
              <div className="mt-4 flex items-center gap-3 text-sm">
                <Button
                  size="small"
                  variant="secondary"
                  disabled={!page}
                  onClick={() => setPage((value) => value - 1)}
                >
                  上一页
                </Button>
                <span>
                  {page + 1} / {Math.max(1, Math.ceil(files.length / 20))}
                </span>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={(page + 1) * 20 >= files.length}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            </>
          )}
          {download && (
            <div role="status" className="mt-4 text-sm">
              <p className="break-all">
                正在保存 {download.filename} · {bytesLabel(download.bytes)}
              </p>
              <Button
                variant="secondary"
                onClick={() => downloadController.current?.abort()}
              >
                取消下载
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader
          title="自动备份计划"
          description="Asia/Shanghai 时间；启用后按计划为主营及竞品创建完整备份。"
          action={
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                dirty.current = false;
                refreshConfig();
              }}
            >
              放弃草稿并重读计划
            </Button>
          }
        />
        <CardContent>
          {configError && <p role="alert">{configError}</p>}
          {draft && config ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void saveSchedule();
              }}
            >
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  disabled={locked}
                  onChange={(event) => {
                    dirty.current = true;
                    setDraft({ ...draft, enabled: event.target.checked });
                  }}
                />
                启用自动备份
              </label>
              <Field label="计划频率">
                {(control) => (
                  <select
                    {...control}
                    value={draft.scheduleType}
                    disabled={locked}
                    className="rounded-input border border-input p-3"
                    onChange={(event) => {
                      dirty.current = true;
                      const value = event.target
                        .value as BackupConfig['scheduleType'];
                      setDraft({
                        ...draft,
                        scheduleType: value,
                        scheduleValue: value === 'daily' ? null : 1,
                      });
                    }}
                  >
                    <option value="daily">每日</option>
                    <option value="weekly">每周</option>
                    <option value="monthly">每月</option>
                  </select>
                )}
              </Field>
              {draft.scheduleType !== 'daily' && (
                <Field
                  label={
                    draft.scheduleType === 'weekly' ? '星期（1为周一）' : '日期'
                  }
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="number"
                      min={1}
                      max={draft.scheduleType === 'weekly' ? 7 : 31}
                      value={draft.scheduleValue ?? 1}
                      disabled={locked}
                      onChange={(event) => {
                        dirty.current = true;
                        setDraft({
                          ...draft,
                          scheduleValue: Number(event.target.value),
                        });
                      }}
                    />
                  )}
                </Field>
              )}
              <Field label="上海执行时间">
                {(control) => (
                  <Input
                    {...control}
                    type="time"
                    required
                    value={draft.backupTime}
                    disabled={locked}
                    onChange={(event) => {
                      dirty.current = true;
                      setDraft({ ...draft, backupTime: event.target.value });
                    }}
                  />
                )}
              </Field>
              <Button type="submit" disabled={locked}>
                保存自动备份计划
              </Button>
            </form>
          ) : (
            <p>正在读取或尚未取得可编辑计划。</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader
          title="自动备份执行记录"
          description="系统计划所有者的最近 50 条保留记录；此视图不授予取消或修改任务权限。"
          action={
            <Button
              variant="secondary"
              disabled={busy}
              onClick={refreshScheduled}
            >
              重读执行记录
            </Button>
          }
        />
        <CardContent>
          {scheduledError ? (
            <p role="alert">{scheduledError}</p>
          ) : scheduled.length ? (
            <ul className="divide-y divide-border">
              {scheduled.map((entry) => (
                <li key={entry.taskId} className="py-3 text-sm">
                  <p className="neo-mono break-all">{entry.taskId}</p>
                  <p>
                    {taskStatus(entry.status).label} · {entry.message} ·{' '}
                    {entry.createdAt
                      ? formatBeijing(entry.createdAt)
                      : '时间未记录'}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p>暂无保留的系统计划执行记录。</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
