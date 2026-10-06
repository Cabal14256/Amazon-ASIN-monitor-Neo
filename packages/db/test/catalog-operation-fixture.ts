import type { Db } from '../src/client';
import type {
  CatalogOperationDomain,
  CatalogOperationIdentity,
} from '../src/domain/catalog-operation';
import {
  catalogTransactionExecution,
  withCatalogOperationExecution,
} from '../src/repositories/catalog-operation-execution';
import type { PgCatalogOperationRepository } from '../src/repositories/catalog-operation-repository';

/** Mock only the transaction/fence transport in existing business-policy tests.
 * The real-PG integration suite separately proves the held SQL locks/pins. */
export async function withFixtureCatalogOperation<T>(
  db: Pick<Db, 'execute'>,
  domain: CatalogOperationDomain,
  action: () => Promise<T>,
): Promise<T> {
  const identity: CatalogOperationIdentity = {
    ownerId: 'synthetic-policy-owner',
    domain,
    kind: 'write',
    generation: '1',
    operationId: '00000000-0000-4000-8000-000000000224',
  };
  const repository = {
    beginPin: async () => ({
      identity,
      pinId: '00000000-0000-4000-8000-000000000225',
    }),
    assertPin: async () => undefined,
    finishPin: async () => undefined,
  } as unknown as PgCatalogOperationRepository;
  return withCatalogOperationExecution(repository, identity, async () => {
    const execution = catalogTransactionExecution();
    await execution.begin();
    await execution.guard(db);
    try {
      return await action();
    } finally {
      await execution.settled('committed');
    }
  });
}
