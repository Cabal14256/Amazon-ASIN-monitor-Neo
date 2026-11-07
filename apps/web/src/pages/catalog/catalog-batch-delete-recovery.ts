import type { TaskInfo } from '@asin-monitor/contracts';
import { ApiError } from '../../lib/http';
import {
  summarizeBatchDelete,
  type CatalogBatchDeleteOutcome,
} from '../../services/catalog-batch-delete';
import { isTerminalTask } from '../../services/tasks';
import { importGateKey, writeImportGate } from '../asin/asin-import-gate';
import { notifyCatalogGateChanged } from './catalog-gate-events';
import { runWithCatalogOperationLock } from './catalog-operation-lock';
import {
  canRecoverKnownBatchDeleteReceipt,
  catalogImportBlocksWrite,
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
    private readonly uuid: () => string = () => crypto.randomUUID(),
    private readonly ownerScope?: string,
  ) {
    this.key = catalogSafetyKey(owner, domain);
    this.fallbackKey = `${this.key}:batch-receipt`;
  }
  read(): CatalogSafetyGate | null {
    // Preserve the guard if storage cannot be read or its JSON cannot be verified.
    const raw = this.local.getItem(this.key);
    const local = readCatalogSafetyGate(
      { getItem: () => raw, removeItem: () => undefined },
      this.owner,
      this.domain,
    );
    if (raw !== null && !local)
      throw new Error('无法验证原删除记录，删除保护仍保留。');
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
        !local &&
        fallback?.phase === 'batch-delete' &&
        fallback.operationId !== 'invalid-record'
      ) {
        const bridge = this.local.getItem(
          importGateKey(this.domain, this.owner),
        );
        if (bridge !== null && this.ownsImportBridge(bridge, fallback))
          return fallback;
      }
      if (
        local?.phase === 'batch-delete' &&
        fallback?.phase === 'batch-delete' &&
        local.operationId === fallback.operationId &&
        local.ownerScope === fallback.ownerScope &&
        local.submittedAt === fallback.submittedAt &&
        JSON.stringify(local.groupIds) === JSON.stringify(fallback.groupIds) &&
        { unknown: 0, task: 1, refresh: 2 }[fallback.state] >=
          { unknown: 0, task: 1, refresh: 2 }[local.state]
      )
        return fallback;
    } catch {
      /* The durable submission guard remains authoritative. */
    }
    return local;
  }
  private remember(
    gate: CatalogBatchDeleteGate,
    expected?: CatalogBatchDeleteGate,
  ): boolean {
    let saved = false;
    try {
      const current = this.read();
      if (expected && JSON.stringify(current) !== JSON.stringify(expected))
        return false;
      const importRaw = this.local.getItem(
        importGateKey(this.domain, this.owner),
      );
      if (importRaw !== null && !this.ownsImportBridge(importRaw, gate))
        return false;
      if (
        !writeImportGate(this.local, this.domain, this.owner, {
          phase: 'uncertain',
          taskId: null,
          savedAt: gate.submittedAt,
          operationId: gate.operationId,
          catalogOperation: 'batch-delete',
        })
      )
        throw new Error('无法保存旧版本导入阻断记录。');
      saved =
        writeCatalogSafetyGate(this.local, this.owner, this.domain, gate) &&
        JSON.stringify(this.read()) === JSON.stringify(gate);
    } catch {
      // Keep a validated known receipt in the session fallback and mounted UI.
    }
    try {
      if (saved) this.session?.removeItem(this.fallbackKey);
      else this.session?.setItem(this.fallbackKey, JSON.stringify(gate));
    } catch {
      /* Mounted state still retains the accepted receipt. */
    }
    return saved;
  }
  private clear(expected: CatalogBatchDeleteGate, unsent = false): boolean {
    const current = this.read();
    if (
      !(unsent && !current && this.local.getItem(this.key) === null) &&
      (current?.phase !== 'batch-delete' ||
        current.operationId !== expected.operationId ||
        current.ownerScope !== expected.ownerScope ||
        current.submittedAt !== expected.submittedAt ||
        JSON.stringify(current.groupIds) !==
          JSON.stringify(expected.groupIds) ||
        current.taskId !== expected.taskId ||
        current.state !== expected.state)
    )
      return false;
    const fallbackRaw = this.session?.getItem(this.fallbackKey) ?? null;
    if (fallbackRaw !== null) {
      const fallback = readCatalogSafetyGate(
        { getItem: () => fallbackRaw, removeItem: () => undefined },
        this.owner,
        this.domain,
      );
      if (
        fallback?.phase !== 'batch-delete' ||
        fallback.operationId !== expected.operationId ||
        fallback.ownerScope !== expected.ownerScope ||
        fallback.submittedAt !== expected.submittedAt ||
        JSON.stringify(fallback.groupIds) !== JSON.stringify(expected.groupIds)
      )
        return false;
    }
    const importRaw = this.local.getItem(
      importGateKey(this.domain, this.owner),
    );
    if (importRaw !== null && !this.ownsImportBridge(importRaw, expected))
      return false;
    if (
      importRaw !== null &&
      !writeImportGate(this.local, this.domain, this.owner, null)
    )
      return false;
    if (this.local.getItem(importGateKey(this.domain, this.owner)) !== null)
      return false;
    try {
      this.session?.removeItem(this.fallbackKey);
      if (this.session?.getItem(this.fallbackKey)) return false;
    } catch {
      return false;
    }
    if (!writeCatalogSafetyGate(this.local, this.owner, this.domain, null))
      return false;
    notifyCatalogGateChanged(importGateKey(this.domain, this.owner));
    return this.read() === null;
  }
  private ownsImportBridge(raw: string, gate: CatalogBatchDeleteGate): boolean {
    try {
      const bridge = JSON.parse(raw) as Record<string, unknown>;
      return (
        bridge.catalogOperation === 'batch-delete' &&
        bridge.operationId === gate.operationId &&
        bridge.savedAt === gate.submittedAt &&
        bridge.phase === 'uncertain' &&
        bridge.taskId === null
      );
    } catch {
      return false;
    }
  }
  submit(
    groupIds: string[],
    send: () => Promise<CatalogBatchDeleteOutcome>,
    current: () => boolean,
    publish: (gate: CatalogBatchDeleteGate | null) => void,
    beforeClaim: () => boolean = current,
  ) {
    return runWithCatalogOperationLock(
      this.locks,
      this.owner,
      this.domain,
      async () => {
        if (!beforeClaim()) return { kind: 'stale' as const };
        const existing = this.read();
        if (existing) return { kind: 'blocked' as const, gate: existing };
        if (catalogImportBlocksWrite(this.local, this.owner, this.domain))
          throw new ApiError(
            'INVALID_INPUT',
            '已有导入请求待核实，导入保护解除前不能删除。',
          );
        const claim: CatalogBatchDeleteGate = {
          phase: 'batch-delete',
          operationId: this.uuid(),
          groupIds: [...groupIds],
          submittedAt: Date.now(),
          state: 'unknown',
          ...(this.ownerScope ? { ownerScope: this.ownerScope } : {}),
        };
        if (!this.remember(claim)) {
          // Still under both locks; no destructive request has been dispatched.
          let rolledBack = false;
          try {
            rolledBack = this.clear(claim, true);
          } catch {
            /* Keep the exact operation-bound session receipt for recovery. */
          }
          if (current()) {
            const remaining = this.read();
            if (rolledBack) publish(null);
            else if (remaining?.phase === 'batch-delete') publish(remaining);
            else if (!remaining) publish(claim);
          }
          throw new ApiError(
            'INVALID_INPUT',
            rolledBack
              ? '无法保存删除状态，尚未发送请求；原保护已回滚。'
              : '无法保存删除状态，尚未发送请求；请恢复原删除回执并核实保护。',
          );
        }
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
          const persisted = this.remember(gate, claim);
          let matching = true;
          try {
            const stored = this.read();
            matching =
              JSON.stringify(stored) === JSON.stringify(gate) ||
              canRecoverKnownBatchDeleteReceipt(stored, gate);
          } catch {
            // The mounted accepted receipt remains visible while the durable guard is unreadable.
          }
          if (current() && matching) publish(gate);
          return { kind: 'accepted' as const, gate, persisted };
        } catch (error) {
          const rejected =
            error instanceof ApiError &&
            (['INVALID_INPUT', 'AUTH', 'CAPACITY', 'CLOSED'].includes(
              error.kind,
            ) ||
              (['HTTP', 'BUSINESS'].includes(error.kind) &&
                [400, 401, 403, 404, 409, 413, 429].includes(
                  error.status ?? 0,
                )));
          const cleared = rejected && this.clear(claim);
          if (current()) publish(cleared ? null : claim);
          return {
            kind: cleared ? ('rejected' as const) : ('unknown' as const),
            gate: claim,
            error,
          };
        }
      },
    );
  }
  /** A 404 is not proof that an uncertain job cannot appear later. */
  reconcile(
    expected: CatalogBatchDeleteGate,
    readTask: (id: string) => Promise<TaskInfo>,
    refresh: () => Promise<void>,
    current: () => boolean,
    acknowledgeUnknown = false,
  ) {
    return runWithCatalogOperationLock(
      this.locks,
      this.owner,
      this.domain,
      async () => {
        if (!current()) return { kind: 'stale' as const };
        const stored = this.read();
        if (JSON.stringify(stored) !== JSON.stringify(expected)) {
          if (
            stored?.phase !== 'batch-delete' ||
            !canRecoverKnownBatchDeleteReceipt(stored, expected) ||
            expected.ownerScope !== this.ownerScope
          )
            return { kind: 'changed' as const };
          // Both operation locks are held. Persist the ACK before any GET-only
          // reconciliation; saving a receipt never releases the unknown guard.
          if (!this.remember(expected, stored))
            return { kind: 'unsaved' as const };
        }
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
        }
        if (!current()) return { kind: 'stale' as const };
        if (gate.state !== 'unknown' && !this.remember(gate, expected))
          return { kind: 'unsaved' as const };
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
      },
    );
  }
}

export function browserBatchDeleteRecovery(
  owner: string,
  domain: 'asin' | 'competitor',
  sessionId: string | undefined,
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
    undefined,
    JSON.stringify([domain, owner, sessionId ?? null]),
  );
}
