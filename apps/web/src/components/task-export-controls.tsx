import type { TaskInfo } from '@asin-monitor/contracts';
import { Download } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAccess } from '../auth/access';
import { useAuth, useIdentity } from '../auth/context';
import { ApiError } from '../lib/http';
import { isTerminalTask, isValidTaskId } from '../services/tasks';
import { Button } from './ui/button';

type ExportType =
  | 'asin'
  | 'competitor-asin'
  | 'competitor-variant-group'
  | 'parent-asin-query';
export interface TaskExportChoice {
  operation: ExportType;
  label: string;
  params: Record<string, unknown>;
}
interface TaskExportControlsProps {
  namespace: 'primary-asin-export' | 'competitor-export' | 'parent-asin-export';
  choices: readonly [TaskExportChoice, ...TaskExportChoice[]];
  disabled: boolean;
}
interface Receipt {
  operation: ExportType;
  taskId?: string;
  submittedAt: string;
}
const key = (namespace: string, owner: string, session: string) =>
  `neo:${namespace}:${JSON.stringify([owner, session])}`;
function read(
  name: string,
  choices: TaskExportControlsProps['choices'],
): Receipt | null {
  const raw = sessionStorage.getItem(name);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Receipt;
    if (
      !choices.some((choice) => choice.operation === value.operation) ||
      !Number.isFinite(Date.parse(value.submittedAt)) ||
      (value.taskId !== undefined && !isValidTaskId(value.taskId))
    )
      throw new Error();
    return value;
  } catch {
    throw new Error('导出保护记录无效，请在任务中心核实');
  }
}
export function TaskExportControls({
  namespace,
  choices,
  disabled,
}: TaskExportControlsProps) {
  const { runtime } = useAuth(),
    auth = useIdentity();
  const [revision, setRevision] = useState(runtime.session.revision);
  useEffect(
    () => runtime.subscribeSession(() => setRevision(runtime.session.revision)),
    [runtime],
  );
  if (
    auth.status !== 'authenticated' ||
    !createAccess(auth.identity).canReadASIN ||
    createAccess(auth.identity).mustChangePassword
  )
    return null;
  return (
    <ExportScope
      key={JSON.stringify([
        auth.identity.user.id,
        auth.identity.sessionId,
        revision,
        namespace,
      ])}
      owner={auth.identity.user.id}
      session={auth.identity.sessionId ?? ''}
      revision={revision}
      namespace={namespace}
      choices={choices}
      disabled={disabled}
    />
  );
}
function ExportScope({
  owner,
  session,
  revision,
  namespace,
  choices,
  disabled,
}: TaskExportControlsProps & {
  owner: string;
  session: string;
  revision: number;
}) {
  const { runtime, identity, announce } = useAuth();
  const name = key(namespace, owner, session),
    mounted = useRef(true),
    work = useRef<AbortController | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(() => {
    try {
      return read(name, choices);
    } catch {
      return {
        operation: choices[0].operation,
        submittedAt: new Date().toISOString(),
      };
    }
  });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [task, setTask] = useState<TaskInfo | null>(null);
  const [storageFailed, setStorageFailed] = useState(false),
    [verified, setVerified] = useState(false);
  const current = () => {
    const auth = identity.getSnapshot();
    return (
      mounted.current &&
      runtime.session.revision === revision &&
      auth.status === 'authenticated' &&
      auth.identity.user.id === owner &&
      (auth.identity.sessionId ?? '') === session &&
      createAccess(auth.identity).canReadASIN &&
      !createAccess(auth.identity).mustChangePassword
    );
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      work.current?.abort();
    };
  }, []);
  const persist = (value: Receipt | null) => {
    try {
      if (value) sessionStorage.setItem(name, JSON.stringify(value));
      else sessionStorage.removeItem(name);
    } catch {
      setStorageFailed(true);
      throw new Error('本地存储不可用，导出结果需在任务中心核实');
    }
    setReceipt(value);
  };
  async function submit(operation: ExportType) {
    if (!current() || work.current || receipt || disabled || storageFailed)
      return;
    const choice = choices.find((value) => value.operation === operation);
    if (!choice) return;
    const pending = { operation, submittedAt: new Date().toISOString() };
    try {
      persist(pending);
    } catch (error) {
      setMessage((error as Error).message);
      return;
    }
    const controller = new AbortController();
    work.current = controller;
    setBusy(true);
    setTask(null);
    try {
      const result = await runtime.tasks.createExport(
        {
          exportType: operation,
          params: choice.params,
        },
        controller.signal,
      );
      if (result.exportType !== operation)
        throw new ApiError('INVALID_RESPONSE', '导出任务类型响应不匹配');
      // Always preserve a known ACK for the original scope, even after leaving.
      sessionStorage.setItem(
        name,
        JSON.stringify({ ...pending, taskId: result.taskId }),
      );
      if (!current()) return;
      setReceipt({ ...pending, taskId: result.taskId });
      const notice = `${
        result.status === 'unknown' ? '提交结果待核实' : '导出任务已提交'
      }：${result.taskId}`;
      setMessage(notice);
      announce(notice);
    } catch (error) {
      const data =
        error instanceof ApiError &&
        error.data &&
        typeof error.data === 'object'
          ? (error.data as Record<string, unknown>)
          : undefined;
      if (
        data?.exportType === operation &&
        typeof data.taskId === 'string' &&
        isValidTaskId(data.taskId)
      ) {
        try {
          sessionStorage.setItem(
            name,
            JSON.stringify({ ...pending, taskId: data.taskId }),
          );
        } catch {
          /* Original unknown receipt remains. */
        }
        if (current()) setReceipt({ ...pending, taskId: data.taskId });
      } else if (
        error instanceof ApiError &&
        [400, 401, 403, 429].includes(error.status ?? 0)
      ) {
        try {
          sessionStorage.removeItem(name);
          if (current()) setReceipt(null);
        } catch {
          /* Retain unknown on storage failure. */
        }
      }
      if (current()) {
        setMessage(
          error instanceof Error
            ? error.message
            : '提交结果未确认，请核实原任务',
        );
        if (
          error instanceof ApiError &&
          (error.status === 403 || error.errorCode === 403)
        )
          void identity.refresh();
      }
    } finally {
      work.current = null;
      if (current()) setBusy(false);
    }
  }
  async function reread() {
    if (!receipt?.taskId || !current() || work.current) return;
    const controller = new AbortController();
    work.current = controller;
    setBusy(true);
    try {
      const result = await runtime.tasks.get(receipt.taskId, controller.signal);
      if (
        result.taskType !== 'export' ||
        result.taskSubType !== receipt.operation
      )
        throw new Error('任务身份不一致');
      if (current()) {
        setTask(result);
        setMessage(`${result.taskId} · ${result.status} · ${result.progress}%`);
      }
    } catch (error) {
      if (current()) {
        setMessage(error instanceof Error ? error.message : '读取失败');
        if (error instanceof ApiError && error.status === 403)
          void identity.refresh();
      }
    } finally {
      work.current = null;
      if (current()) setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {choices.map(({ operation, label }) => (
          <Button
            key={operation}
            variant="secondary"
            size="small"
            disabled={disabled || busy || !!receipt || storageFailed}
            onClick={() => void submit(operation)}
          >
            <Download aria-hidden="true" />
            {label}
          </Button>
        ))}
      </div>
      {(receipt || message) && (
        <p role="status" className="break-all text-sm">
          {message ||
            (receipt?.taskId
              ? `原导出任务：${receipt.taskId}`
              : '导出提交结果待核实，请先检查任务中心，避免重复提交。')}
        </p>
      )}
      {receipt && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <a className="underline underline-offset-4" href="/tasks">
            前往任务中心下载或取消
          </a>
          <Button
            size="small"
            variant="secondary"
            disabled={busy || !receipt.taskId}
            onClick={() => void reread()}
          >
            只查询原任务
          </Button>
          {!receipt.taskId && (
            <label>
              <input
                type="checkbox"
                checked={verified}
                onChange={(event) => setVerified(event.target.checked)}
              />{' '}
              已在任务中心核实原提交
            </label>
          )}
          <Button
            size="small"
            variant="secondary"
            disabled={
              busy ||
              (receipt.taskId
                ? !task || !isTerminalTask(task.status)
                : !verified)
            }
            onClick={() => {
              try {
                persist(null);
                setTask(null);
                setVerified(false);
                setMessage('原任务已核实，可以重新导出');
              } catch {
                /* Storage failure stays blocked. */
              }
            }}
          >
            已核实，恢复导出
          </Button>
        </div>
      )}
    </div>
  );
}
