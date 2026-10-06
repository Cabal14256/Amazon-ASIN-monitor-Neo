import type { PermissionCode } from '@asin-monitor/contracts';
import type {
  CatalogOperationIdentity,
  CatalogTaskBinding,
} from '@asin-monitor/db';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { AuthPrincipal } from '../../src/auth/auth.types';
import type { CatalogOperationSubmission } from '../../src/catalog/catalog-operation.service';

/** HTTP unit fixtures replace only the durable storage adapter. Actual fencing
 * is covered by the service and PostgreSQL/compiled Worker integration suites. */
export function catalogOperationUnitFixture() {
  return {
    execute: vi.fn(
      async <T>(
        principal: AuthPrincipal,
        domain: CatalogOperationIdentity['domain'],
        kind: CatalogOperationIdentity['kind'],
        _permission: PermissionCode,
        action: (submission: CatalogOperationSubmission) => Promise<T>,
      ) =>
        action({
          identity: {
            ownerId: principal.userId,
            domain,
            kind,
            operationId: randomUUID(),
            generation: '1',
          },
          retain: vi.fn(),
          bindTask: vi.fn(async (_task: CatalogTaskBinding) => undefined),
          reject: vi.fn(async () => true),
        }),
    ),
    settleRemovedTask: vi.fn(async () => undefined),
  };
}
