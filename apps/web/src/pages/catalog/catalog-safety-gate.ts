export type CatalogSafetyGate =
  | {
      phase: 'refresh';
      message: string | null;
      detailId: string | null;
      createUncertain: boolean;
      operationId?: string;
      batchCreate?: boolean;
      batchCreateOwner?: string;
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
      typeof gate.createUncertain !== 'boolean' ||
      (gate.batchCreate !== undefined && typeof gate.batchCreate !== 'boolean')
    )
      throw new Error('invalid');
    let batchCreateOwner: string | undefined;
    if (gate.batchCreateOwner !== undefined) {
      try {
        if (
          typeof gate.batchCreateOwner !== 'string' ||
          gate.batchCreateOwner.length > 1000
        )
          throw new Error('invalid');
        const origin: unknown = JSON.parse(gate.batchCreateOwner);
        if (
          !Array.isArray(origin) ||
          origin.length !== 3 ||
          origin[0] !== source ||
          source !== 'asin' ||
          origin[1] !== owner ||
          (origin[2] !== null && typeof origin[2] !== 'string')
        )
          throw new Error('invalid');
        batchCreateOwner = gate.batchCreateOwner;
      } catch {
        return {
          phase: 'refresh',
          message:
            '原会话回执绑定无效，写入保护仍保留。请核实原操作，勿重发成功项。',
          detailId: gate.detailId,
          createUncertain: false,
          batchCreate: true,
          ...operationId,
        };
      }
    }
    return {
      phase: 'refresh',
      message: gate.message,
      detailId: gate.detailId,
      createUncertain: gate.createUncertain,
      ...operationId,
      ...(gate.batchCreate === true ? { batchCreate: true } : {}),
      ...(batchCreateOwner ? { batchCreateOwner } : {}),
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
