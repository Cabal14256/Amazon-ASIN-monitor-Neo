import { isValidTaskId } from '../../services/tasks';
import {
  importGateKey,
  readImportGate,
  type AsinImportGate,
} from '../asin/asin-import-gate';
import { notifyCatalogGateChanged } from './catalog-gate-events';

export interface CatalogBatchDeleteGate {
  phase: 'batch-delete';
  operationId: string;
  groupIds: string[];
  submittedAt: number;
  state: 'unknown' | 'task' | 'refresh';
  taskId?: string;
  message?: string;
  ownerScope?: string;
}

export type CatalogSafetyGate =
  | CatalogBatchDeleteGate
  | {
      phase: 'import';
      operationId: string;
      savedAt: number;
      receipt?: AsinImportGate;
    }
  | {
      phase: 'refresh';
      message: string | null;
      detailId: string | null;
      createUncertain: boolean;
      operationId?: string;
    }
  | { phase: 'inspection'; operationId?: string };

/** A validated ACK may complete only the exact, otherwise unchanged sent claim. */
export function canRecoverKnownBatchDeleteReceipt(
  claim: CatalogSafetyGate | null | undefined,
  receipt: CatalogSafetyGate | null | undefined,
): receipt is CatalogBatchDeleteGate {
  const claimKeys = [
    'phase',
    'operationId',
    'groupIds',
    'submittedAt',
    'state',
    'ownerScope',
  ];
  return Boolean(
    claim?.phase === 'batch-delete' &&
      claim.state === 'unknown' &&
      claim.taskId === undefined &&
      receipt?.phase === 'batch-delete' &&
      receipt.state === 'task' &&
      receipt.taskId &&
      isValidTaskId(receipt.taskId) &&
      typeof claim.ownerScope === 'string' &&
      receipt.ownerScope === claim.ownerScope &&
      claim.operationId !== 'invalid-record' &&
      receipt.operationId === claim.operationId &&
      receipt.submittedAt === claim.submittedAt &&
      claim.groupIds.length > 0 &&
      JSON.stringify(receipt.groupIds) === JSON.stringify(claim.groupIds) &&
      Object.keys(claim).every((key) => claimKeys.includes(key)) &&
      Object.keys(receipt).every((key) =>
        [...claimKeys, 'taskId', 'message'].includes(key),
      ),
  );
}

export function catalogSafetyKey(owner: string, source: string): string {
  return `neo:catalog-write-safety:${encodeURIComponent(
    owner,
  )}:${encodeURIComponent(source)}`;
}

/** Read under the owner/domain catalog lock before accepting any write. */
export function catalogImportBlocksWrite(
  storage: Pick<Storage, 'getItem'>,
  owner: string,
  domain: 'asin' | 'competitor',
): boolean {
  try {
    return storage.getItem(importGateKey(domain, owner)) !== null;
  } catch {
    return true;
  }
}

export function catalogSafetyStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage;
    stored.setItem('neo:catalog-write-safety-probe', '1');
    stored.removeItem('neo:catalog-write-safety-probe');
    return stored;
  } catch {
    return null;
  }
}

export function readCatalogSafetyGate(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  owner: string,
  source: string,
): CatalogSafetyGate | null {
  if (!owner) return null;
  const key = catalogSafetyKey(owner, source);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    // Read failure cannot prove that a destructive operation has no guard.
    return { phase: 'inspection', operationId: 'storage-unreadable' };
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { phase: 'inspection', operationId: 'invalid-record' };
  }
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid');
    let gate = value as Record<string, unknown>;
    if (gate.phase === 'inspection' && 'batchDelete' in gate) {
      const child = gate.batchDelete;
      if (
        !child ||
        typeof child !== 'object' ||
        Array.isArray(child) ||
        (child as Record<string, unknown>).operationId !== gate.operationId ||
        (child as Record<string, unknown>).phase !== 'batch-delete'
      )
        return { phase: 'inspection', operationId: 'invalid-record' };
      gate = child as Record<string, unknown>;
    } else if (gate.phase === 'inspection' && 'importOperation' in gate) {
      const child = gate.importOperation as Record<string, unknown> | null;
      const valid =
        child &&
        !Array.isArray(child) &&
        typeof gate.operationId === 'string' &&
        /^[a-z0-9-]{1,80}$/i.test(gate.operationId) &&
        Number.isSafeInteger(child.savedAt) &&
        (child.savedAt as number) >= 0;
      if (!valid) return { phase: 'inspection', operationId: 'invalid-record' };
      const receipt = readImportGate(
        { getItem: () => JSON.stringify(child), removeItem: () => undefined },
        source === 'competitor' ? 'competitor' : 'asin',
        owner,
      );
      if (
        !receipt ||
        receipt.catalogOperation ||
        (receipt.operationId && receipt.operationId !== gate.operationId) ||
        receipt.savedAt !== child.savedAt
      )
        return { phase: 'inspection', operationId: 'invalid-record' };
      return {
        phase: 'import',
        operationId: gate.operationId as string,
        savedAt: child.savedAt as number,
        receipt,
      };
    }
    if (gate.phase === 'batch-delete') {
      let scopeValid = true;
      if (gate.ownerScope !== undefined) {
        try {
          const scope: unknown =
            typeof gate.ownerScope === 'string' &&
            gate.ownerScope.length <= 1000
              ? JSON.parse(gate.ownerScope)
              : null;
          scopeValid =
            Array.isArray(scope) &&
            scope.length === 3 &&
            scope[0] === source &&
            scope[1] === owner &&
            (scope[2] === null || typeof scope[2] === 'string');
        } catch {
          scopeValid = false;
        }
      }
      if (
        !scopeValid ||
        typeof gate.operationId !== 'string' ||
        !/^[a-z0-9-]{1,80}$/i.test(gate.operationId) ||
        !Array.isArray(gate.groupIds) ||
        gate.groupIds.length > 1000 ||
        gate.groupIds.some(
          (id) =>
            typeof id !== 'string' ||
            !id ||
            [...id].length > 50 ||
            [...id].some(
              (character) =>
                character.charCodeAt(0) <= 31 ||
                character.charCodeAt(0) === 127,
            ),
        ) ||
        !Number.isSafeInteger(gate.submittedAt) ||
        (gate.submittedAt as number) < 0 ||
        !['unknown', 'task', 'refresh'].includes(String(gate.state)) ||
        (gate.taskId !== undefined &&
          (typeof gate.taskId !== 'string' || !isValidTaskId(gate.taskId))) ||
        (gate.state === 'task' && !gate.taskId) ||
        (gate.message !== undefined &&
          (typeof gate.message !== 'string' || gate.message.length > 500))
      )
        // A damaged destructive-operation record must never reopen writes.
        return {
          phase: 'batch-delete',
          operationId: 'invalid-record',
          groupIds: [],
          submittedAt: 0,
          state: 'unknown',
          message: '批量删除恢复记录损坏，请人工核实任务与目录。',
        };
      return gate as unknown as CatalogBatchDeleteGate;
    }
    if (
      gate.operationId !== undefined &&
      (typeof gate.operationId !== 'string' ||
        !/^[a-z0-9-]{1,80}$/i.test(gate.operationId))
    )
      throw new Error('invalid');
    const operationId =
      typeof gate.operationId === 'string'
        ? { operationId: gate.operationId }
        : {};
    if (gate.phase === 'inspection')
      return { phase: 'inspection', ...operationId };
    if (
      gate.phase !== 'refresh' ||
      (gate.message !== null &&
        (typeof gate.message !== 'string' || gate.message.length > 300)) ||
      (gate.detailId !== null &&
        (typeof gate.detailId !== 'string' ||
          [...gate.detailId].length > 50)) ||
      typeof gate.createUncertain !== 'boolean'
    )
      throw new Error('invalid');
    return {
      phase: 'refresh',
      message: gate.message,
      detailId: gate.detailId,
      createUncertain: gate.createUncertain,
      ...operationId,
    };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // A later write will require storage to become available again.
    }
    return null;
  }
}

export function writeCatalogSafetyGate(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  owner: string,
  source: string,
  gate: CatalogSafetyGate | null,
): boolean {
  if (!owner) return false;
  try {
    if (gate) {
      const stored =
        gate.phase === 'batch-delete'
          ? {
              phase: 'inspection',
              operationId: gate.operationId,
              batchDelete: gate,
            }
          : gate.phase === 'import'
          ? {
              phase: 'inspection',
              operationId: gate.operationId,
              importOperation: gate.receipt ?? {
                phase: 'uncertain',
                taskId: null,
                savedAt: gate.savedAt,
                operationId: gate.operationId,
              },
            }
          : gate;
      storage.setItem(catalogSafetyKey(owner, source), JSON.stringify(stored));
    } else storage.removeItem(catalogSafetyKey(owner, source));
    notifyCatalogGateChanged(catalogSafetyKey(owner, source));
    return true;
  } catch {
    return false;
  }
}
