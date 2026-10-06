import { isValidTaskId } from '../../services/tasks';

export interface CatalogBatchDeleteGate {
  phase: 'batch-delete';
  operationId: string;
  groupIds: string[];
  submittedAt: number;
  state: 'unknown' | 'task' | 'refresh';
  taskId?: string;
  message?: string;
}

export type CatalogSafetyGate =
  | CatalogBatchDeleteGate
  | {
      phase: 'refresh';
      message: string | null;
      detailId: string | null;
      createUncertain: boolean;
      operationId?: string;
    }
  | { phase: 'inspection'; operationId?: string };

export function catalogSafetyKey(owner: string, source: string): string {
  return `neo:catalog-write-safety:${encodeURIComponent(
    owner,
  )}:${encodeURIComponent(source)}`;
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
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid');
    const gate = value as Record<string, unknown>;
    if (gate.phase === 'batch-delete') {
      if (
        typeof gate.operationId !== 'string' ||
        !/^[a-z0-9-]{1,80}$/i.test(gate.operationId) ||
        !Array.isArray(gate.groupIds) ||
        gate.groupIds.length > 1000 ||
        gate.groupIds.some(
          (id) =>
            typeof id !== 'string' ||
            !id ||
            [...id].length > 50 ||
            /[\x00-\x1f\x7f]/.test(id),
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
    if (gate)
      storage.setItem(catalogSafetyKey(owner, source), JSON.stringify(gate));
    else storage.removeItem(catalogSafetyKey(owner, source));
    return true;
  } catch {
    return false;
  }
}
