import { ApiError } from '../../lib/http';
import { isTerminalTask } from '../../services/tasks';
import {
  validCatalogCheckGate,
  type CatalogCheckGate,
  type CheckTarget,
} from './catalog-check-types';
import {
  catalogSafetyKey,
  readCatalogSafetyGate,
  writeCatalogSafetyGate,
} from './catalog-safety-gate';
import type { CatalogCheckResult } from './catalog-types';
export type { CatalogCheckGate, CheckTarget } from './catalog-check-types';
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Locks = Pick<LockManager, 'request'>;
export const catalogCheckGateKey = (catalog: string, owner: string) =>
  `neo:catalog-check:${encodeURIComponent(catalog)}:${encodeURIComponent(
    owner,
  )}`;

function parse(raw: string | null): CatalogCheckGate | null {
  if (raw === null) return null;
  if (raw.length > 128 * 1024) throw new Error('CHECK_GATE_INVALID');
  const gate = JSON.parse(raw) as CatalogCheckGate;
  if (!validCatalogCheckGate(gate)) throw new Error('CHECK_GATE_INVALID');
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
    private readonly shared?: {
      owner: string;
      catalog: string;
      publish?: (
        gate: import('./catalog-safety-gate').CatalogSafetyGate | null,
      ) => void;
    },
  ) {
    this.key = catalogCheckGateKey(catalog, owner);
  }
  private get lockKey(): string {
    return this.shared
      ? catalogSafetyKey(this.shared.owner, this.shared.catalog)
      : this.key;
  }
  private sharedGate() {
    return this.shared
      ? readCatalogSafetyGate(
          this.local,
          this.shared.owner,
          this.shared.catalog,
        )
      : null;
  }

  private ownsSharedGate(
    current: ReturnType<CatalogCheckRecovery['sharedGate']>,
    requestId: string,
  ): boolean {
    if (!current) return true;
    if (current.operationId !== requestId) return false;
    if (current.phase === 'check') return true;
    // An old client may rewrite its parsed inspection reservation, dropping
    // the envelope payload. Only our matching independent receipt can prove
    // this reservation belongs to the check being updated or reconciled.
    return (
      current.phase === 'inspection' &&
      parse(this.local.getItem(this.key))?.requestId === requestId
    );
  }

  read(): CatalogCheckGate | null {
    const shared = this.sharedGate();
    const local =
      shared?.phase === 'check'
        ? shared.check
        : parse(this.local.getItem(this.key));
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
      if (this.shared) {
        const current = this.sharedGate();
        if (!this.ownsSharedGate(current, gate.requestId)) return false;
        const shared = {
          phase: 'check' as const,
          operationId: gate.requestId,
          check: gate,
        };
        if (
          !writeCatalogSafetyGate(
            this.local,
            this.shared.owner,
            this.shared.catalog,
            shared,
          ) ||
          JSON.stringify(this.sharedGate()) !== JSON.stringify(shared)
        )
          return false;
        this.shared.publish?.(shared);
      }
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
      const legacy = parse(this.local.getItem(this.key));
      if (
        legacy &&
        (legacy.requestId !== expected.requestId ||
          (legacy.taskId !== undefined && legacy.taskId !== expected.taskId))
      )
        return false;
      if (this.shared) {
        const shared = this.sharedGate();
        if (!this.ownsSharedGate(shared, expected.requestId)) return false;
      }
      this.local.removeItem(this.key);
      this.session?.removeItem(this.key);
      if (
        this.shared &&
        !writeCatalogSafetyGate(
          this.local,
          this.shared.owner,
          this.shared.catalog,
          null,
        )
      )
        return false;
      const cleared = this.read() === null;
      if (cleared) this.shared?.publish?.(null);
      return cleared;
    } catch {
      return false;
    }
  }
  clear(expected: CatalogCheckGate, current = () => true): Promise<boolean> {
    return this.locks.request(
      this.lockKey,
      () => current() && this.clearCurrent(expected),
    );
  }
  async reconcile(
    expected: CatalogCheckGate,
    readTask: (id: string) => Promise<{ taskId: string; status: string }>,
    beforeClear: () => Promise<void> = async () => undefined,
    current = () => true,
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
    return (await this.clear(expected, current))
      ? ('cleared' as const)
      : ('changed' as const);
  }
  submit(
    target: CheckTarget,
    send: () => Promise<CatalogCheckResult>,
    current = () => true,
  ) {
    return this.locks.request(this.lockKey, async () => {
      if (!current()) return { kind: 'stale' as const };
      const existing = this.read();
      if (existing) return { kind: 'blocked' as const, gate: existing };
      if (this.sharedGate())
        throw new ApiError(
          'INVALID_INPUT',
          '目录已有操作结果待核实，请先恢复原操作。',
        );
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
  publish?: (
    gate: import('./catalog-safety-gate').CatalogSafetyGate | null,
  ) => void,
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
    Date.now,
    () => crypto.randomUUID(),
    { catalog, owner, publish },
  );
}
