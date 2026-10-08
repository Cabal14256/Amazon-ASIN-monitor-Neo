import { importGateKey, type AsinImportGate } from '../asin/asin-import-gate';
import { notifyCatalogGateChanged } from './catalog-gate-events';
import {
  catalogSafetyKey,
  readCatalogSafetyGate,
  writeCatalogSafetyGate,
} from './catalog-safety-gate';

/** One acquisition order also excludes older bundles that hold only one key. */
export async function runWithCatalogOperationLock<T>(
  locks: Pick<LockManager, 'request'>,
  owner: string,
  domain: 'asin' | 'competitor',
  work: () => T | Promise<T>,
): Promise<T> {
  return await locks.request(
    catalogSafetyKey(owner, domain),
    async () =>
      await locks.request(
        importGateKey(domain, owner),
        async () => await work(),
      ),
  );
}

/** Retain the old import key and an old-reader-compatible shared blocking record. */
export function writeImportCatalogSafety(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  owner: string,
  domain: 'asin' | 'competitor',
  expected: AsinImportGate,
  next: AsinImportGate | null,
): boolean {
  const operationId =
    expected.operationId ?? `legacy-import-${expected.savedAt}`;
  const current = readCatalogSafetyGate(storage, owner, domain);
  if (
    current &&
    (current.phase !== 'import' || current.operationId !== operationId)
  )
    return false;
  if (!next && !current) return true;
  const saved = writeCatalogSafetyGate(
    storage,
    owner,
    domain,
    next
      ? { phase: 'import', operationId, savedAt: next.savedAt, receipt: next }
      : null,
  );
  if (saved) notifyCatalogGateChanged(importGateKey(domain, owner));
  return saved;
}
