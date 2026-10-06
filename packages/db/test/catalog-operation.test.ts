import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/client';
import {
  parseCatalogIdentity,
  parseCatalogTaskBinding,
  parseCatalogTerminalProof,
  taskMatchesCatalogOperation,
  type CatalogOperationIdentity,
} from '../src/domain/catalog-operation';
import {
  assertCatalogWriteExecution,
  catalogTransactionExecution,
  withCatalogOperationExecution,
  withCatalogOperationExemptExecution,
} from '../src/repositories/catalog-operation-execution';
import type { PgCatalogOperationRepository } from '../src/repositories/catalog-operation-repository';

const identity: CatalogOperationIdentity = {
  ownerId: ' owner ',
  domain: 'asin',
  kind: 'check',
  generation: '1',
  operationId: '00000000-0000-4000-8000-000000000224',
};
const task = {
  userId: identity.ownerId,
  taskId: '00000000-0000-4000-8000-000000000225',
  taskType: 'variant-check' as const,
  taskSubType: 'asin-check',
  createdAt: '2026-10-07T00:00:00.000Z',
};
function fixture() {
  const db = { execute: vi.fn() } as unknown as Db;
  const pin = { identity, pinId: task.taskId };
  const repository = {
    beginPin: vi.fn(async () => pin),
    assertPin: vi.fn(async () => undefined),
    finishPin: vi.fn(async () => undefined),
  };
  return {
    db,
    repository,
    repo: repository as unknown as PgCatalogOperationRepository,
  };
}
describe('durable catalog identity and actual transaction scope', () => {
  it('retains literal owner and int64 generation without normalization', () => {
    expect(
      parseCatalogIdentity({
        ...identity,
        ownerId: ' ',
        generation: '9223372036854775807',
      }),
    ).toMatchObject({ ownerId: ' ', generation: '9223372036854775807' });
    expect(
      parseCatalogIdentity({ ...identity, ownerId: '😀'.repeat(50) }).ownerId,
    ).toBe('😀'.repeat(50));
  });
  it.each(['0', '01', '-1', '1.5', '9223372036854775808', 'x', '', '1e3'])(
    'rejects invalid generation %j with a fixed public error',
    (generation) => {
      expect(() => parseCatalogIdentity({ ...identity, generation })).toThrow(
        'CATALOG_OPERATION_INVALID',
      );
    },
  );
  it.each(['', '\u0000', '\u0085', '\ud800', 'a'.repeat(51)])(
    'rejects unencodable/oversized owner %j',
    (ownerId) => {
      expect(() => parseCatalogIdentity({ ...identity, ownerId })).toThrow(
        'CATALOG_OPERATION_INVALID',
      );
    },
  );
  it('rejects unknown fields and non-canonical immutable task timestamps', () => {
    expect(() =>
      parseCatalogIdentity({ ...identity, session: 'other' }),
    ).toThrow('CATALOG_OPERATION_INVALID');
    for (const createdAt of [
      '2026-10-07T00:00:00Z',
      '2026-02-30T00:00:00.000Z',
      '2026-10-07T00:00:00.000+00:00',
    ]) {
      expect(() => parseCatalogTaskBinding({ ...task, createdAt })).toThrow(
        'CATALOG_OPERATION_INVALID',
      );
    }
    expect(() =>
      parseCatalogTerminalProof({
        source: 'worker',
        status: 'completed',
        task: { ...task, ownerId: task.userId },
      }),
    ).toThrow('CATALOG_OPERATION_INVALID');
  });
  it('only admits a definite rejected producer proof; failed/partial/unknown submissions cannot claim it', () => {
    expect(
      parseCatalogTerminalProof({
        source: 'producer',
        status: 'rejected',
        task,
      }),
    ).toMatchObject({ source: 'producer', status: 'rejected' });
    for (const status of [
      'failed',
      'completed',
      'cancelled',
      'unknown',
      'partial',
    ])
      expect(() =>
        parseCatalogTerminalProof({ source: 'producer', status, task }),
      ).toThrow('CATALOG_OPERATION_INVALID');
  });
  it('binds owner, operation kind and domain-specific task subtype', () => {
    expect(taskMatchesCatalogOperation(identity, task)).toBe(true);
    expect(
      taskMatchesCatalogOperation(identity, { ...task, userId: 'owner' }),
    ).toBe(false);
    expect(
      taskMatchesCatalogOperation({ ...identity, domain: 'competitor' }, task),
    ).toBe(false);
    expect(
      taskMatchesCatalogOperation({ ...identity, kind: 'write' }, task),
    ).toBe(false);
    expect(
      taskMatchesCatalogOperation(
        { ...identity, kind: 'monitor' },
        { ...task, taskType: 'monitor', taskSubType: 'primary' },
      ),
    ).toBe(true);
  });
  it('rejects a differently cased UUID spelling instead of aliasing immutable Redis task keys', () => {
    const uppercase = '00000000-0000-4000-8000-000000000ABC';
    expect(() =>
      parseCatalogIdentity({ ...identity, operationId: uppercase }),
    ).toThrow('CATALOG_OPERATION_INVALID');
    expect(() =>
      parseCatalogTaskBinding({ ...task, taskId: uppercase }),
    ).toThrow('CATALOG_OPERATION_INVALID');
  });
  it('refuses missing scope and a scope without actual locked transaction transport', async () => {
    const f = fixture();
    expect(() => assertCatalogWriteExecution(f.db, 'asin')).toThrow(
      'CATALOG_OPERATION_MISSING',
    );
    await withCatalogOperationExecution(f.repo, identity, async () => {
      expect(() => assertCatalogWriteExecution(f.db, 'asin')).toThrow(
        'CATALOG_OPERATION_MISSING',
      );
      const tx = catalogTransactionExecution();
      await tx.begin();
      expect(() => assertCatalogWriteExecution(f.db, 'asin')).toThrow(
        'CATALOG_OPERATION_MISSING',
      );
      await tx.guard(f.db);
      expect(() => assertCatalogWriteExecution(f.db, 'asin')).not.toThrow();
      expect(() => assertCatalogWriteExecution(f.db, 'competitor')).toThrow(
        'CATALOG_OPERATION_IDENTITY',
      );
      await tx.settled('committed');
      expect(() => assertCatalogWriteExecution(f.db, 'asin')).toThrow(
        'CATALOG_OPERATION_MISSING',
      );
      await tx.settled('uncertain');
      expect(f.repository.finishPin).toHaveBeenCalledExactlyOnceWith(
        { identity, pinId: task.taskId },
        'committed',
      );
      await expect(tx.guard(f.db)).rejects.toThrow('CATALOG_OPERATION_MISSING');
    });
  });
  it('cannot substitute nested identities or register competitor transport before primary guard', async () => {
    const f = fixture();
    await withCatalogOperationExecution(f.repo, identity, async () => {
      expect(() =>
        withCatalogOperationExecution(
          f.repo,
          { ...identity, domain: 'competitor' },
          async () => undefined,
        ),
      ).toThrow('CATALOG_OPERATION_IDENTITY');
      expect(() =>
        withCatalogOperationExemptExecution(
          'scheduled-system',
          async () => undefined,
        ),
      ).toThrow('CATALOG_OPERATION_IDENTITY');
      const tx = catalogTransactionExecution();
      expect(() => tx.allowBusinessDatabase(f.db)).toThrow(
        'CATALOG_OPERATION_MISSING',
      );
      await tx.begin();
      await expect(tx.begin()).rejects.toThrow('CATALOG_OPERATION_IDENTITY');
      f.repository.assertPin.mockRejectedValueOnce(
        new Error('closed generation'),
      );
      await expect(tx.guard(f.db)).rejects.toThrow('closed generation');
      expect(() => assertCatalogWriteExecution(f.db, 'asin')).toThrow(
        'CATALOG_OPERATION_MISSING',
      );
      await tx.settled('rolled-back');
    });
  });
  it.each(['anonymous-check', 'scheduled-system'] as const)(
    'permits trusted %s check writes only, in actual transport lifetime',
    async (reason) => {
      const f = fixture();
      await withCatalogOperationExemptExecution(reason, async () => {
        const tx = catalogTransactionExecution();
        await tx.begin();
        await tx.guard(f.db);
        expect(() =>
          assertCatalogWriteExecution(f.db, 'asin', true),
        ).not.toThrow();
        expect(() => assertCatalogWriteExecution(f.db, 'asin')).toThrow(
          'CATALOG_OPERATION_IDENTITY',
        );
        await tx.settled('committed');
        expect(() => assertCatalogWriteExecution(f.db, 'asin', true)).toThrow(
          'CATALOG_OPERATION_MISSING',
        );
      });
      expect(f.repository.beginPin).not.toHaveBeenCalled();
    },
  );
});
