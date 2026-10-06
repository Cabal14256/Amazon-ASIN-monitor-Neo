import type { TaskInfo } from '@asin-monitor/contracts';
import { ApiError } from '../../lib/http';
import {
  summarizeBatchDelete,
  type CatalogBatchDeleteOutcome,
} from '../../services/catalog-batch-delete';
import { isTerminalTask } from '../../services/tasks';
import {
  catalogSafetyKey,
  readCatalogSafetyGate,
  writeCatalogSafetyGate,
  type CatalogBatchDeleteGate,
  type CatalogSafetyGate,
} from './catalog-safety-gate';

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Locks = Pick<LockManager, 'request'>;

/** Shares the single-write/import lock and persists before a destructive request. */
export class CatalogBatchDeleteRecovery {
  readonly key: string;
  readonly fallbackKey: string;
  constructor(
    readonly owner: string,
    readonly domain: 'asin' | 'competitor',
    private readonly local: StoragePort,
    private readonly session: StoragePort | null,
    private readonly locks: Locks,
    private readonly uuid = () => crypto.randomUUID(),
  ) {
    this.key = catalogSafetyKey(owner, domain);
    this.fallbackKey = `${this.key}:batch-receipt`;
  }
  read(): CatalogSafetyGate | null {
    const local = readCatalogSafetyGate(this.local, this.owner, this.domain);
    try {
      const fallbackStorage = {
        getItem: () => this.session?.getItem(this.fallbackKey) ?? null,
        removeItem: () => this.session?.removeItem(this.fallbackKey),
      };
      const fallback = readCatalogSafetyGate(
        fallbackStorage,
        this.owner,
        this.domain,
      );
      if (
        local?.phase === 'batch-delete' &&
        fallback?.phase === 'batch-delete' &&
        local.operationId === fallback.operationId &&
        local.state === 'unknown'
      )
        return fallback;
    } catch {
      /* The durable submission guard remains authoritative. */
    }
    return local;
  }
  private remember(gate: CatalogBatchDeleteGate): boolean {
    const saved =
      writeCatalogSafetyGate(this.local, this.owner, this.domain, gate) &&
      JSON.stringify(
        readCatalogSafetyGate(this.local, this.owner, this.domain),
      ) === JSON.stringify(gate);
    try {
      if (saved) this.session?.removeItem(this.fallbackKey);
      else this.session?.setItem(this.fallbackKey, JSON.stringify(gate));
    } catch {
      /* Mounted state still retains the accepted receipt. */
    }
    return saved;
  }
  private clear(expected: CatalogBatchDeleteGate): boolean {
    const current = this.read();
    if (
      current?.phase !== 'batch-delete' ||
      current.operationId !== expected.operationId ||
      current.taskId !== expected.taskId ||
      current.state !== expected.state
    )
      return false;
    if (!writeCatalogSafetyGate(this.local, this.owner, this.domain, null))
      return false;
    try {
      this.session?.removeItem(this.fallbackKey);
    } catch {
      return false;
    }
    return this.read() === null;
  }
  submit(
    groupIds: string[],
    send: () => Promise<CatalogBatchDeleteOutcome>,
    current: () => boolean,
    publish: (gate: CatalogBatchDeleteGate | null) => void,
  ) {
    return this.locks.request(this.key, async () => {
      if (!current()) return { kind: 'stale' as const };
      const existing = this.read();
      if (existing) return { kind: 'blocked' as const, gate: existing };
      const claim: CatalogBatchDeleteGate = {
        phase: 'batch-delete',
        operationId: this.uuid(),
        groupIds: [...groupIds],
        submittedAt: Date.now(),
        state: 'unknown',
      };
      if (!this.remember(claim))
        throw new Error('无法保存删除状态，尚未发送请求。');
      if (!current()) {
        this.clear(claim);
        return { kind: 'stale' as const };
      }
      publish(claim);
      try {
        const result = await send();
        const gate: CatalogBatchDeleteGate =
          result.mode === 'async'
            ? {
                ...claim,
                state: 'task',
                taskId: result.taskId,
                message:
                  result.status === 'unknown'
                    ? '任务提交结果尚未确认，请查询任务状态；不会再次提交。'
                    : '批量删除任务已受理，尚未完成删除。',
              }
            : {
                ...claim,
                state: 'refresh',
                message: summarizeBatchDelete(result),
              };
        const persisted = this.remember(gate);
        if (current()) publish(gate);
        return { kind: 'accepted' as const, gate, persisted };
      } catch (error) {
        const rejected =
          error instanceof ApiError &&
          (['INVALID_INPUT', 'AUTH', 'CAPACITY', 'CLOSED'].includes(
            error.kind,
          ) ||
            (['HTTP', 'BUSINESS'].includes(error.kind) &&
              [400, 401, 403, 404, 409, 413, 429].includes(error.status ?? 0)));
        const cleared = rejected && this.clear(claim);
        if (current()) publish(cleared ? null : claim);
        return {
          kind: cleared ? ('rejected' as const) : ('unknown' as const),
          gate: claim,
          error,
        };
      }
    });
  }
  /** A 404 is not proof that an uncertain job cannot appear later. */
  reconcile(
    expected: CatalogBatchDeleteGate,
    readTask: (id: string) => Promise<TaskInfo>,
    refresh: () => Promise<void>,
    current: () => boolean,
    acknowledgeUnknown = false,
  ) {
    return this.locks.request(this.key, async () => {
      if (!current()) return { kind: 'stale' as const };
      const stored = this.read();
      if (JSON.stringify(stored) !== JSON.stringify(expected))
        return { kind: 'changed' as const };
      let gate = expected;
      if (expected.state === 'task' && expected.taskId) {
        const task = await readTask(expected.taskId);
        const subtype =
          this.domain === 'competitor'
            ? 'competitor-variant-group-delete'
            : 'variant-group-delete';
        if (
          task.taskId !== expected.taskId ||
          task.taskType !== 'batch-delete' ||
          task.taskSubType !== subtype ||
          (!isTerminalTask(task.status) &&
            !['pending', 'processing', 'cancelling'].includes(task.status))
        )
          throw new Error('任务标识或类型不匹配，保留删除保护。');
        if (!isTerminalTask(task.status))
          return { kind: 'active' as const, task };
        gate = {
          ...expected,
          state: 'refresh',
          message: `${
            task.status === 'completed'
              ? '任务已完成。'
              : task.status === 'cancelled'
              ? '任务已取消，可能已部分删除。'
              : '任务失败，可能已部分删除。'
          } ${
            task.result
              ? summarizeBatchDelete(task.result)
              : '请核对目录与任务详情。'
          }`.slice(0, 500),
        };
        this.remember(gate);
      }
      if (!current()) return { kind: 'stale' as const };
      await refresh();
      if (!current()) return { kind: 'stale' as const };
      if (gate.state === 'unknown' && !acknowledgeUnknown)
        return { kind: 'unknown' as const };
      if (!this.clear(gate)) return { kind: 'changed' as const };
      return {
        kind: 'cleared' as const,
        message:
          gate.message ??
          '已人工核实目录及待执行任务，删除保护已解除；未重发删除。',
      };
    });
  }
}

export function browserBatchDeleteRecovery(
  owner: string,
  domain: 'asin' | 'competitor',
): CatalogBatchDeleteRecovery {
  if (!owner || !navigator.locks)
    throw new Error('浏览器不支持安全的跨标签写入锁。');
  let session: Storage | null = null;
  try {
    session = window.sessionStorage;
  } catch {
    /* Optional receipt fallback. */
  }
  return new CatalogBatchDeleteRecovery(
    owner,
    domain,
    window.localStorage,
    session,
    navigator.locks,
  );
}
