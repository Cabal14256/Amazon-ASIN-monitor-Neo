import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { taskMatchesCatalogOperation } from '../src/domain/catalog-operation';
import {
  createVariantCheckOperation,
  decodeVariantCheckReceiptResult,
} from '../src/domain/variant-check-receipt';
import {
  readVariantCheckReceipt,
  saveVariantCheckReceipt,
} from '../src/repositories/variant-check-receipt-repository';

const identity = {
  taskId: '10000000-0000-4000-8000-000000000251',
  userId: 'competitor-owner',
  taskCreatedAt: '2026-11-06T00:00:00.000Z',
  taskType: 'batch-check' as const,
  taskSubType: 'competitor-variant-group' as const,
  step: 'result',
  resultKind: 'competitor-batch' as const,
  expiresAt: '2026-11-13T00:00:00.000Z',
};
describe('competitor batch receipt identity and database boundary', () => {
  it('freezes ordered raw identifiers and duplicate positions in the request digest', () => {
    const ids = [' padded ', 'padded', ' padded '];
    const first = createVariantCheckOperation(identity, {
      groupIds: ids,
      forceRefresh: false,
    });
    expect(
      createVariantCheckOperation(identity, {
        forceRefresh: false,
        groupIds: ids,
      }),
    ).toEqual(first);
    for (const changed of [
      ['padded', ' padded ', ' padded '],
      [' padded ', 'padded'],
      ['padded', 'padded', 'padded'],
    ]) {
      const other = createVariantCheckOperation(identity, {
        groupIds: changed,
        forceRefresh: false,
      });
      expect(other.operationKey).toBe(first.operationKey);
      expect(other.requestHash).not.toBe(first.requestHash);
    }
  });
  it('accepts only competitor group substeps and the dedicated competitor root result', () => {
    expect(() =>
      createVariantCheckOperation(
        { ...identity, step: 'group-0', resultKind: 'competitor-group' },
        { groupId: 'g1', forceRefresh: true },
      ),
    ).not.toThrow();
    for (const patch of [
      { resultKind: 'batch' },
      { resultKind: 'group' },
      { step: 'result', resultKind: 'competitor-group' },
      { step: 'group-0', resultKind: 'competitor-batch' },
    ])
      expect(() =>
        createVariantCheckOperation(
          { ...identity, ...patch } as typeof identity,
          {},
        ),
      ).toThrow();
    expect(
      decodeVariantCheckReceiptResult(
        {
          total: 1,
          results: [{ groupId: 'g1', success: false, error: 'not found' }],
          successCount: 0,
        },
        'competitor-batch',
      ),
    ).toMatchObject({ successCount: 0 });
  });
  it('refuses competitor reads and writes through the primary receipt port before executing SQL', async () => {
    const db = { execute: vi.fn(), select: vi.fn(), insert: vi.fn() },
      guard = vi.fn();
    const operation = createVariantCheckOperation(identity, {
      groupIds: ['g1'],
      forceRefresh: true,
    });
    await expect(
      readVariantCheckReceipt(db as never, guard, operation, false),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      saveVariantCheckReceipt(db as never, guard, operation, {
        total: 0,
        results: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('binds a batch check only to its owner and competitor domain', () => {
    const operation = {
      ownerId: identity.userId,
      domain: 'competitor' as const,
      operationId: identity.taskId,
      generation: '1',
      kind: 'check' as const,
    };
    const task = {
      taskId: identity.taskId,
      userId: identity.userId,
      taskType: identity.taskType,
      taskSubType: identity.taskSubType,
      createdAt: identity.taskCreatedAt,
    };
    expect(taskMatchesCatalogOperation(operation, task)).toBe(true);
    expect(
      taskMatchesCatalogOperation({ ...operation, domain: 'asin' }, task),
    ).toBe(false);
    expect(
      taskMatchesCatalogOperation(operation, { ...task, userId: 'different' }),
    ).toBe(false);
  });
  it('keeps the upgrade repeatable and rollback transactional without deleting completion evidence', () => {
    const up = readFileSync(
      resolve(
        __dirname,
        '../migrations/0018_competitor_batch_check_receipts.sql',
      ),
      'utf8',
    );
    const down = readFileSync(
      resolve(
        __dirname,
        '../migrations/0018_competitor_batch_check_receipts.rollback.sql',
      ),
      'utf8',
    );
    expect(up).toContain("'competitor-batch'");
    for (const source of [up, down]) {
      expect(source).toContain('BEGIN;');
      expect(source).toContain('COMMIT;');
      expect(source).toContain('DROP CONSTRAINT IF EXISTS');
      expect(source).not.toMatch(
        /\b(?:DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i,
      );
    }
  });
});
