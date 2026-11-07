import type { ImportDomain } from '../../services/asin-import';
import { notifyCatalogGateChanged } from '../catalog/catalog-gate-events';

export interface AsinImportGate {
  phase: 'sending' | 'accepted' | 'uncertain' | 'settled';
  taskId: string | null;
  savedAt: number;
  operationId?: string;
  catalogOperation?: 'batch-delete';
}

const KEY_PREFIX: Record<ImportDomain, string> = {
  asin: 'neo:asin-import:',
  competitor: 'neo:competitor-import:',
};
const TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function importGateKey(domain: ImportDomain, owner: string) {
  return `${KEY_PREFIX[domain]}${encodeURIComponent(owner)}`;
}

export const asinImportGateKey = (owner: string) =>
  importGateKey('asin', owner);
export const competitorImportGateKey = (owner: string) =>
  importGateKey('competitor', owner);

export function readImportGate(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  domain: ImportDomain,
  owner: string,
): AsinImportGate | null {
  if (!owner) return null;
  try {
    const raw = storage.getItem(importGateKey(domain, owner));
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid');
    const gate = value as Record<string, unknown>;
    if (
      !['sending', 'accepted', 'uncertain', 'settled'].includes(
        String(gate.phase),
      ) ||
      (gate.taskId !== null &&
        (typeof gate.taskId !== 'string' || !TASK_ID.test(gate.taskId))) ||
      (['accepted', 'settled'].includes(String(gate.phase)) &&
        gate.taskId === null) ||
      typeof gate.savedAt !== 'number' ||
      !Number.isFinite(gate.savedAt) ||
      (gate.operationId !== undefined &&
        (typeof gate.operationId !== 'string' ||
          !/^[a-z0-9-]{1,80}$/i.test(gate.operationId))) ||
      (gate.catalogOperation !== undefined &&
        (gate.catalogOperation !== 'batch-delete' || !gate.operationId))
    )
      throw new Error('invalid');
    return {
      phase:
        gate.phase === 'sending'
          ? 'uncertain'
          : (gate.phase as AsinImportGate['phase']),
      taskId: gate.taskId as string | null,
      savedAt: gate.savedAt,
      ...(typeof gate.operationId === 'string'
        ? { operationId: gate.operationId }
        : {}),
      ...(gate.catalogOperation === 'batch-delete'
        ? { catalogOperation: 'batch-delete' as const }
        : {}),
    };
  } catch {
    // A damaged or unreadable record cannot prove an import did not start.
    // Keep the original key for explicit task reconciliation; never retry POST.
    return { phase: 'uncertain', taskId: null, savedAt: 0 };
  }
}

export type AsinImportClaim =
  | { kind: 'claimed'; gate: AsinImportGate }
  | { kind: 'blocked'; gate: AsinImportGate }
  | { kind: 'unavailable' };

/** Call only while holding the browser Web Lock for this owner. */
export function claimImportGate(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  domain: ImportDomain,
  owner: string,
  clock: () => number = Date.now,
): AsinImportClaim {
  const now = clock();
  const existing = readImportGate(storage, domain, owner);
  if (existing) return { kind: 'blocked', gate: existing };
  const gate: AsinImportGate = {
    phase: 'sending',
    taskId: null,
    savedAt: now,
    operationId: crypto.randomUUID(),
  };
  return writeImportGate(storage, domain, owner, gate)
    ? { kind: 'claimed', gate }
    : { kind: 'unavailable' };
}

export function writeImportGate(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  domain: ImportDomain,
  owner: string,
  gate: AsinImportGate | null,
): boolean {
  if (!owner) return false;
  try {
    if (gate)
      storage.setItem(importGateKey(domain, owner), JSON.stringify(gate));
    else storage.removeItem(importGateKey(domain, owner));
    notifyCatalogGateChanged(importGateKey(domain, owner));
    return true;
  } catch {
    return false;
  }
}

/** Preserve primary consumers and the keys already saved by the migration. */
export const readAsinImportGate = (
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  owner: string,
) => readImportGate(storage, 'asin', owner);
export const claimAsinImportGate = (
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  owner: string,
  clock?: () => number,
) => claimImportGate(storage, 'asin', owner, clock);
export const writeAsinImportGate = (
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  owner: string,
  gate: AsinImportGate | null,
) => writeImportGate(storage, 'asin', owner, gate);
