import { ApiError } from '../../lib/http';
import { isTerminalTask, isValidTaskId } from '../../services/tasks';
import type { CatalogCheckResult } from './catalog-types';

export type CheckTarget = { kind: 'group' | 'asin'; id: string; label: string };
export interface CatalogCheckGate {
  requestId: string;
  target: CheckTarget;
  submittedAt: number;
  taskId?: string;
}
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Locks = Pick<LockManager, 'request'>;
export const catalogCheckGateKey = (catalog: string, owner: string) =>
  `neo:catalog-check:${encodeURIComponent(catalog)}:${encodeURIComponent(
    owner,
  )}`;

function parse(raw: string | null): CatalogCheckGate | null {
  if (raw === null) return null;
  if (raw.length > 4096) throw new Error('CHECK_GATE_INVALID');
  const gate = JSON.parse(raw) as CatalogCheckGate;
  if (
    !gate ||
    typeof gate.requestId !== 'string' ||
    !gate.requestId ||
    !Number.isSafeInteger(gate.submittedAt) ||
    !gate.target ||
    !['group', 'asin'].includes(gate.target.kind) ||
    typeof gate.target.id !== 'string' ||
    !gate.target.id ||
    typeof gate.target.label !== 'string' ||
    (gate.taskId !== undefined &&
      (typeof gate.taskId !== 'string' || !isValidTaskId(gate.taskId)))
  )
    throw new Error('CHECK_GATE_INVALID');
  return gate;
}

/** Each owner/catalog has one durable submission guard; mutations use Web Locks.
 * A failed receipt update retains the original guard and a session fallback. */
export class CatalogCheckRecovery {
  readonly key: string;
  constructor(
    catalog: string,
    owner: string,
    private readonly local: StoragePort,
    private readonly session: StoragePort | null,
    private readonly locks: Locks,
    private readonly clock = Date.now,
    private readonly uuid: () => string = () => crypto.randomUUID(),
  ) {
    this.key = catalogCheckGateKey(catalog, owner);
  }

  read(): CatalogCheckGate | null {
    const local = parse(this.local.getItem(this.key));
    let session: CatalogCheckGate | null = null;
    try {
      session = parse(this.session?.getItem(this.key) ?? null);
    } catch {
      /* The durable local guard remains authoritative. */
    }
    return session &&
      (!local || (session.requestId === local.requestId && !local.taskId))
      ? session
      : local;
  }
  private write(gate: CatalogCheckGate): boolean {
    try {
      const raw = JSON.stringify(gate);
      this.local.setItem(this.key, raw);
      if (this.local.getItem(this.key) !== raw) return false;
      return true;
    } catch {
      return false;
    }
  }
  private remember(gate: CatalogCheckGate): boolean {
    const persisted = this.write(gate);
    try {
      if (persisted) this.session?.removeItem(this.key);
      else this.session?.setItem(this.key, JSON.stringify(gate));
    } catch {
      /* Keep the task ID in the mounted page and show a save warning. */
    }
    return persisted;
  }
  private clearCurrent(expected: CatalogCheckGate): boolean {
    const current = this.read();
    if (!current) return true;
    if (
      current?.requestId !== expected.requestId ||
      (current.taskId !== undefined && current.taskId !== expected.taskId)
    )
      return false;
    try {
      this.local.removeItem(this.key);
      this.session?.removeItem(this.key);
      return this.read() === null;
    } catch {
      return false;
    }
  }
  clear(expected: CatalogCheckGate): Promise<boolean> {
    return this.locks.request(this.key, () => this.clearCurrent(expected));
  }
  async reconcile(
    expected: CatalogCheckGate,
    readTask: (id: string) => Promise<{ taskId: string; status: string }>,
    beforeClear: () => Promise<void> = async () => undefined,
  ) {
    if (expected.taskId) {
      const task = await readTask(expected.taskId).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      });
      if (task && task.taskId !== expected.taskId)
        throw new Error('CHECK_TASK_IDENTITY_CHANGED');
      if (task && !isTerminalTask(task.status)) return 'active' as const;
    }
    await beforeClear();
    return (await this.clear(expected))
      ? ('cleared' as const)
      : ('changed' as const);
  }
  submit(
    target: CheckTarget,
    send: () => Promise<CatalogCheckResult>,
    current = () => true,
  ) {
    return this.locks.request(this.key, async () => {
      if (!current()) return { kind: 'stale' as const };
      const existing = this.read();
      if (existing) return { kind: 'blocked' as const, gate: existing };
      const gate: CatalogCheckGate = {
        requestId: this.uuid(),
        target,
        submittedAt: this.clock(),
      };
      // Never dispatch unless a refresh can recover the pending submission.
      if (!this.write(gate)) throw new Error('CHECK_GATE_STORAGE_UNAVAILABLE');
      try {
        const result = await send();
        if (result.kind === 'task') {
          const accepted = { ...gate, taskId: result.taskId };
          return {
            kind: 'task' as const,
            gate: accepted,
            persisted: this.remember(accepted),
            uncertain: result.status === 'unknown',
          };
        }
        return {
          kind: 'result' as const,
          gate,
          result: result.result,
          cleared: this.clearCurrent(gate),
        };
      } catch (error) {
        const rejected = definiteCheckRejection(error);
        const cleared = rejected && this.clearCurrent(gate);
        return {
          kind: cleared ? ('rejected' as const) : ('unknown' as const),
          gate,
          error,
        };
      }
    });
  }
}

export function definiteCheckRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (['INVALID_INPUT', 'AUTH', 'CAPACITY', 'CLOSED'].includes(error.kind) ||
      (['HTTP', 'BUSINESS'].includes(error.kind) &&
        [400, 401, 403, 404, 413, 429].includes(error.status ?? 0)))
  );
}

export function browserCheckRecovery(
  catalog: string,
  owner: string,
): CatalogCheckRecovery {
  if (!owner || typeof window === 'undefined' || !navigator.locks)
    throw new Error('CHECK_GATE_UNAVAILABLE');
  let session: Storage | null = null;
  try {
    session = window.sessionStorage;
  } catch {
    /* Optional receipt fallback. */
  }
  return new CatalogCheckRecovery(
    catalog,
    owner,
    window.localStorage,
    session,
    navigator.locks,
  );
}
