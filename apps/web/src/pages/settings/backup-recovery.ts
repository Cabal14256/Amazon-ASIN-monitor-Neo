import type { TaskInfo } from '@asin-monitor/contracts';
import { ApiError } from '../../lib/http';
import {
  backupFilenameTarget,
  object,
  parseBackupSubmission,
  uncertainBackupSubmission,
  type BackupOperation,
  type BackupSubmission,
} from '../../services/backup-model';

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Locks = Pick<LockManager, 'request'>;
export interface BackupGate extends BackupOperation {
  requestId: string;
  submittedAt: number;
  state: 'sending' | 'unknown' | 'task';
  taskId?: string;
}
export const backupGateKey = (owner: string) =>
  `neo:backup-operation:${encodeURIComponent(owner)}`;

function decode(raw: string): BackupGate {
  if (raw.length > 8192) throw new Error('BACKUP_GATE_INVALID');
  const value = object(JSON.parse(raw));
  if (
    !value ||
    typeof value.requestId !== 'string' ||
    !/^[a-z0-9-]{1,80}$/i.test(value.requestId) ||
    !['create', 'restore'].includes(String(value.operation)) ||
    !['primary', 'competitor'].includes(String(value.target)) ||
    !['sending', 'unknown', 'task'].includes(String(value.state)) ||
    !Number.isSafeInteger(value.submittedAt) ||
    (value.submittedAt as number) < 0 ||
    (value.description !== undefined &&
      (typeof value.description !== 'string' ||
        value.description.length > 500)) ||
    (value.restoreMode !== undefined &&
      !['isolated', 'in-place'].includes(String(value.restoreMode)))
  )
    throw new Error('BACKUP_GATE_INVALID');
  if (
    value.operation === 'restore' &&
    (typeof value.filename !== 'string' ||
      backupFilenameTarget(value.filename) !== value.target)
  )
    throw new Error('BACKUP_GATE_INVALID');
  if (value.taskId !== undefined)
    parseBackupSubmission({ taskId: value.taskId, status: 'unknown' });
  if (value.state === 'task' && !value.taskId)
    throw new Error('BACKUP_GATE_INVALID');
  return {
    ...(value as unknown as BackupGate),
    state:
      value.state === 'sending'
        ? 'unknown'
        : (value.state as BackupGate['state']),
  };
}

/** One owner reservation spans both targets and survives reload/unknown ACK. */
export class BackupRecovery {
  readonly key: string;
  constructor(
    owner: string,
    private readonly storage: StoragePort,
    private readonly locks: Locks,
    private readonly clock = Date.now,
    private readonly uuid = () => crypto.randomUUID(),
  ) {
    this.key = backupGateKey(owner);
  }

  read(): BackupGate | null {
    const raw = this.storage.getItem(this.key);
    // Malformed/unreadable records must never be erased to reopen submission.
    return raw === null ? null : decode(raw);
  }

  private persist(gate: BackupGate, expected?: string): boolean {
    try {
      const current = this.read();
      if (current && current.requestId !== (expected ?? gate.requestId))
        return false;
      const raw = JSON.stringify(gate);
      this.storage.setItem(this.key, raw);
      return this.storage.getItem(this.key) === raw;
    } catch {
      return false;
    }
  }

  async submit(
    operation: BackupOperation,
    send: () => Promise<BackupSubmission>,
    current: () => boolean,
  ) {
    return this.locks.request(this.key, async () => {
      if (!current()) return { kind: 'stale' as const };
      const previous = this.read();
      if (previous) return { kind: 'blocked' as const, gate: previous };
      const gate: BackupGate = {
        ...operation,
        requestId: this.uuid(),
        submittedAt: this.clock(),
        state: 'sending',
      };
      decode(JSON.stringify(gate));
      if (!this.persist(gate)) throw new Error('BACKUP_GATE_UNAVAILABLE');
      try {
        const accepted = parseBackupSubmission(await send());
        const next: BackupGate = {
          ...gate,
          ...accepted,
          state: accepted.status === 'unknown' ? 'unknown' : 'task',
        };
        return {
          kind: 'task' as const,
          gate: next,
          persisted: this.persist(next, gate.requestId),
        };
      } catch (error) {
        const accepted = uncertainBackupSubmission(error);
        if (accepted) {
          const next: BackupGate = { ...gate, ...accepted, state: 'unknown' };
          return {
            kind: 'task' as const,
            gate: next,
            persisted: this.persist(next, gate.requestId),
          };
        }
        if (definiteBackupRejection(error) && this.erase(gate))
          return { kind: 'rejected' as const, error };
        const next = { ...gate, state: 'unknown' as const };
        return {
          kind: 'unknown' as const,
          gate: next,
          error,
          persisted: this.persist(next, gate.requestId),
        };
      }
    });
  }

  private erase(expected: BackupGate): boolean {
    try {
      const current = this.read();
      if (
        !current ||
        current.requestId !== expected.requestId ||
        (current.taskId && current.taskId !== expected.taskId)
      )
        return false;
      this.storage.removeItem(this.key);
      return this.storage.getItem(this.key) === null;
    } catch {
      return false;
    }
  }

  async task(
    expected: BackupGate,
    read: (id: string) => Promise<TaskInfo>,
  ): Promise<TaskInfo | null> {
    if (!expected.taskId) return null;
    try {
      const task = await read(expected.taskId);
      if (
        task.taskId !== expected.taskId ||
        task.taskType !== 'backup' ||
        task.taskSubType !== expected.operation
      )
        throw new ApiError('INVALID_RESPONSE', '恢复任务身份与原操作不一致');
      return task;
    } catch (error) {
      // A missing retained task is not proof that restore was never committed.
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async writeIfClear<T>(
    work: () => Promise<T>,
    current: () => boolean,
  ): Promise<T> {
    return this.locks.request(this.key, async () => {
      if (!current()) throw new ApiError('CANCELLED', '会话已改变');
      if (this.read())
        throw new ApiError(
          'INVALID_INPUT',
          '已有备份操作待核实，请先恢复原操作',
        );
      return await work();
    });
  }

  /** Explicit operator verification plus fresh GET; never repeats POST. */
  async clearVerified(
    expected: BackupGate,
    readTask: (id: string) => Promise<TaskInfo>,
    refresh: () => Promise<void>,
    current: () => boolean,
  ): Promise<boolean> {
    return this.locks.request(this.key, async () => {
      if (!current()) return false;
      const task = await this.task(expected, readTask);
      if (task && !['completed', 'failed', 'cancelled'].includes(task.status))
        throw new ApiError('INVALID_INPUT', '任务仍在执行，请等待终态后核实');
      await refresh();
      return current() && this.erase(expected);
    });
  }

  async clearDamagedVerified(
    refresh: () => Promise<void>,
    current: () => boolean,
  ): Promise<boolean> {
    return this.locks.request(this.key, async () => {
      if (!current()) return false;
      const raw = this.storage.getItem(this.key);
      if (raw === null) return true;
      try {
        decode(raw);
        return false;
      } catch {
        /* Only damaged records take this path. */
      }
      await refresh();
      if (!current() || this.storage.getItem(this.key) !== raw) return false;
      this.storage.removeItem(this.key);
      return this.storage.getItem(this.key) === null;
    });
  }
}

export function definiteBackupRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (['INVALID_INPUT', 'AUTH', 'CAPACITY', 'CLOSED'].includes(error.kind) ||
      (['HTTP', 'BUSINESS'].includes(error.kind) &&
        [400, 401, 403, 404, 409, 413, 429, 503].includes(
          error.status ?? error.errorCode ?? 0,
        )))
  );
}
