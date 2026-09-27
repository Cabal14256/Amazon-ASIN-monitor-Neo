export interface AsinImportGate {
  phase: 'sending' | 'accepted' | 'uncertain';
  taskId: string | null;
  savedAt: number;
}

const KEY_PREFIX = 'neo:asin-import:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asinImportGateKey(owner: string) {
  return `${KEY_PREFIX}${encodeURIComponent(owner)}`;
}

export function readAsinImportGate(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  owner: string,
  now = Date.now(),
): AsinImportGate | null {
  if (!owner) return null;
  try {
    const raw = storage.getItem(asinImportGateKey(owner));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid');
    const gate = value as Record<string, unknown>;
    if (
      !['sending', 'accepted', 'uncertain'].includes(String(gate.phase)) ||
      (gate.taskId !== null &&
        (typeof gate.taskId !== 'string' || !TASK_ID.test(gate.taskId))) ||
      (gate.phase === 'accepted' && gate.taskId === null) ||
      typeof gate.savedAt !== 'number' ||
      !Number.isFinite(gate.savedAt) ||
      gate.savedAt > now ||
      now - gate.savedAt > MAX_AGE_MS
    )
      throw new Error('invalid');
    return {
      phase:
        gate.phase === 'sending'
          ? 'uncertain'
          : (gate.phase as AsinImportGate['phase']),
      taskId: gate.taskId as string | null,
      savedAt: gate.savedAt,
    };
  } catch {
    try {
      storage.removeItem(asinImportGateKey(owner));
    } catch {
      // Storage can be unavailable; the current component still keeps its lock.
    }
    return null;
  }
}

export function writeAsinImportGate(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  owner: string,
  gate: AsinImportGate | null,
): boolean {
  if (!owner) return false;
  try {
    if (gate) storage.setItem(asinImportGateKey(owner), JSON.stringify(gate));
    else storage.removeItem(asinImportGateKey(owner));
    return true;
  } catch {
    return false;
  }
}
