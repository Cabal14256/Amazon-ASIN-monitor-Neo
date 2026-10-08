import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../client';
import {
  CatalogOperationError,
  parseCatalogIdentity,
  type CatalogOperationDomain,
  type CatalogOperationIdentity,
  type CatalogOperationPin,
  type CatalogPhysicalOutcome,
} from '../domain/catalog-operation';
import type { PgCatalogOperationRepository } from './catalog-operation-repository';

type Scope = {
  allowedDatabases: Set<Pick<Db, 'execute'>>;
} & (
  | {
      kind: 'fenced';
      repository: PgCatalogOperationRepository;
      identity: CatalogOperationIdentity;
    }
  | { kind: 'exempt'; reason: 'anonymous-check' | 'scheduled-system' }
);
const scopes = new AsyncLocalStorage<Scope>();

export function withCatalogOperationExecution<T>(
  repository: PgCatalogOperationRepository,
  identity: CatalogOperationIdentity,
  action: () => Promise<T>,
): Promise<T> {
  if (scopes.getStore())
    throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
  return scopes.run(
    {
      kind: 'fenced',
      repository,
      identity: parseCatalogIdentity(identity),
      allowedDatabases: new Set(),
    },
    action,
  );
}

/** Trusted internal call sites only. No request field selects this exemption. */
export function withCatalogOperationExemptExecution<T>(
  reason: 'anonymous-check' | 'scheduled-system',
  action: () => Promise<T>,
): Promise<T> {
  if (
    scopes.getStore() ||
    !['anonymous-check', 'scheduled-system'].includes(reason)
  )
    throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
  return scopes.run(
    { kind: 'exempt', reason, allowedDatabases: new Set() },
    action,
  );
}

/** Actual mutation methods call this: a scope without its transaction's held
 * slot/pin locks is insufficient. Query/authorization methods do not call it. */
export function assertCatalogWriteExecution(
  db: Pick<Db, 'execute'>,
  domain: CatalogOperationDomain,
  allowCheckExemption: boolean | 'scheduled-system' = false,
): void {
  const scope = scopes.getStore();
  if (!scope || !scope.allowedDatabases.has(db))
    throw new CatalogOperationError('CATALOG_OPERATION_MISSING');
  if (scope.kind === 'exempt') {
    if (
      !allowCheckExemption ||
      (allowCheckExemption === 'scheduled-system' &&
        scope.reason !== 'scheduled-system')
    )
      throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
  } else if (scope.identity.domain !== domain)
    throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
}

export interface CatalogTransactionExecution {
  readonly scoped: boolean;
  begin(): Promise<void>;
  guard(db: Pick<Db, 'execute'>): Promise<void>;
  allowBusinessDatabase(db: Pick<Db, 'execute'>): void;
  settled(outcome: CatalogPhysicalOutcome): Promise<void>;
}

/** Captured once for each real transaction; no TTL counting or virtual promise
 * completion. Its caller reports COMMIT/ROLLBACK ACK, or retains uncertainty. */
export function catalogTransactionExecution(): CatalogTransactionExecution {
  const scope = scopes.getStore();
  let pin: CatalogOperationPin | undefined;
  let observed = false;
  let guarded = false;
  let begun = false;
  const databases = new Set<Pick<Db, 'execute'>>();
  return {
    scoped: scope !== undefined,
    async begin() {
      if (begun || observed)
        throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
      begun = true;
      if (scope?.kind === 'fenced')
        pin = await scope.repository.beginPin(scope.identity);
    },
    async guard(db) {
      if (!begun || observed)
        throw new CatalogOperationError('CATALOG_OPERATION_MISSING');
      if (scope?.kind === 'fenced') {
        if (!pin) throw new CatalogOperationError('CATALOG_OPERATION_MISSING');
        await scope.repository.assertPin(db, pin);
      }
      if (scope) scope.allowedDatabases.add(db);
      databases.add(db);
      guarded = true;
    },
    allowBusinessDatabase(db) {
      if (!guarded || observed)
        throw new CatalogOperationError('CATALOG_OPERATION_MISSING');
      if (scope) scope.allowedDatabases.add(db);
      databases.add(db);
    },
    async settled(outcome) {
      if (observed) return;
      observed = true;
      // A captured unit/DB reference must not authorize a write after COMMIT.
      for (const db of databases) scope?.allowedDatabases.delete(db);
      if (scope?.kind === 'fenced' && pin)
        await scope.repository.finishPin(pin, outcome);
    },
  };
}
