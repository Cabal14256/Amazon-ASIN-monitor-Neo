import { describe, expect, it } from 'vitest';
import {
  addBatchAsinFailure,
  addBatchAsinSuccess,
  prepareBatchAsins,
} from '../../../../../packages/db/src/domain/asin-batch-create';
import { catalogSafetyKey } from '../catalog/catalog-safety-gate';
import {
  parseAsinBatchReceipt,
  readAsinBatchReceipt,
  removeAsinBatchReceipt,
  removeUnprotectedAsinBatchReceipt,
  saveAsinBatchReceipt,
  type AsinBatchReceipt,
} from './asin-batch-receipt';

class MemoryStorage {
  entries = new Map<string, string>();
  getItem = (key: string) => this.entries.get(key) ?? null;
  setItem = (key: string, value: string) => {
    this.entries.set(key, value);
  };
  removeItem = (key: string) => {
    this.entries.delete(key);
  };
}
const owner = JSON.stringify(['asin', 'operator', 'session-1']);
function receipt(
  operationId = 'operation-1',
  submittedAt = 100,
): AsinBatchReceipt {
  return {
    operationId,
    owner,
    submittedAt,
    groupId: ' Raw Ś ',
    groupName: 'Fixture',
    items: [
      {
        asin: 'B000000001',
        country: 'US',
        parentId: ' Raw Ś ',
        site: 'amazon.com',
        brand: 'Fixture',
        name: null,
        asinType: null,
      },
      {
        asin: 'B000000002',
        country: 'US',
        parentId: ' Raw Ś ',
        site: 'amazon.com',
        brand: 'Fixture',
      },
    ],
    result: {
      total: 2,
      successCount: 1,
      failedCount: 1,
      results: [
        {
          index: 0,
          asin: 'B000000001',
          country: 'US',
          success: true,
          id: 'created-1',
          parentId: ' Raw Ś ',
        },
        {
          index: 1,
          asin: 'B000000002',
          country: 'US',
          success: false,
          message: 'Duplicate',
        },
      ],
      errors: [
        { index: 1, asin: 'B000000002', country: 'US', message: 'Duplicate' },
      ],
    },
  };
}
describe('strict owner/session/operation-bound primary batch receipts', () => {
  it.each([
    null,
    JSON.stringify({ phase: 'inspection', operationId: 'operation-other' }),
  ])(
    'retires an old session receipt only when raw gate %j proves it unprotected',
    (gate) => {
      const local = new MemoryStorage(),
        session = new MemoryStorage();
      const expected = receipt();
      expect(
        saveAsinBatchReceipt('operator', expected, { local, session }),
      ).toBe(true);
      if (gate !== null)
        local.setItem(catalogSafetyKey('operator', 'asin'), gate);
      expect(
        removeUnprotectedAsinBatchReceipt('operator', expected, {
          local,
          session,
        }),
      ).toBe(true);
      expect(
        readAsinBatchReceipt('operator', owner, expected.operationId, {
          local,
          session,
        }),
      ).toBeNull();
      expect(local.getItem(catalogSafetyKey('operator', 'asin'))).toBe(gate);
    },
  );
  it.each([
    '',
    '{broken',
    'null',
    JSON.stringify({ phase: 'inspection' }),
    JSON.stringify({ phase: 'inspection', operationId: 'operation-1' }),
    JSON.stringify({ phase: 'unknown', operationId: 'operation-other' }),
  ])(
    'preserves all exact recovery evidence behind an unreadable or potentially referencing gate %j',
    (gate) => {
      const local = new MemoryStorage(),
        session = new MemoryStorage();
      const expected = receipt();
      saveAsinBatchReceipt('operator', expected, { local, session });
      local.setItem(catalogSafetyKey('operator', 'asin'), gate);
      expect(
        removeUnprotectedAsinBatchReceipt('operator', expected, {
          local,
          session,
        }),
      ).toBe(false);
      expect(
        readAsinBatchReceipt('operator', owner, expected.operationId, {
          local,
          session,
        })?.receipt,
      ).toEqual(expected);
      expect(local.getItem(catalogSafetyKey('operator', 'asin'))).toBe(gate);
    },
  );
  it('fails closed on inaccessible storage or the wrong original user without mutating their receipt', () => {
    const local = new MemoryStorage(),
      session = new MemoryStorage();
    const expected = receipt();
    saveAsinBatchReceipt('operator', expected, { local, session });
    expect(
      removeUnprotectedAsinBatchReceipt('other', expected, { local, session }),
    ).toBe(false);
    expect(
      removeUnprotectedAsinBatchReceipt('operator', expected, {
        local: null,
        session,
      }),
    ).toBe(false);
    expect(
      removeUnprotectedAsinBatchReceipt('operator', expected, {
        local: {
          ...local,
          getItem: () => {
            throw new Error('inaccessible');
          },
        },
        session,
      }),
    ).toBe(false);
    expect(
      readAsinBatchReceipt('operator', owner, expected.operationId, {
        local,
        session,
      })?.receipt,
    ).toEqual(expected);
  });
  it.each([' Raw Ś ', '   ', '😺'.repeat(50)])(
    'persists the actual Neo producer literal parentId %j',
    (groupId) => {
      const value = receipt();
      value.groupId = groupId;
      value.items = value.items.map((item) => ({ ...item, parentId: groupId }));
      const plan = prepareBatchAsins(value.items, () => 'created-1');
      addBatchAsinSuccess(plan.result, plan.items[0]);
      addBatchAsinFailure(plan.result, plan.items[1], 'Duplicate');
      value.result = plan.result;
      expect(value.result.results[0]).toEqual({
        index: 0,
        id: 'created-1',
        asin: 'B000000001',
        country: 'US',
        parentId: groupId,
        success: true,
      });
      const storage = { local: new MemoryStorage(), session: null };
      expect(saveAsinBatchReceipt('operator', value, storage)).toBe(true);
      expect(
        readAsinBatchReceipt('operator', owner, 'operation-1', storage),
      ).toEqual({ receipt: value, persisted: true });
    },
  );
  it.each([
    null,
    1,
    'different-group',
    'Raw Ś',
    ' Raw Ś\u0000',
    ' Raw Ś\u0085',
    '\ud800',
  ])(
    'rejects an invalid or unrelated successful producer parentId %j',
    (parentId) => {
      const value = receipt();
      value.result.results[0].parentId = parentId;
      expect(parseAsinBatchReceipt(JSON.stringify(value))).toBeNull();
    },
  );
  it.each(['', '\u0000', '\u0085', '\ud800', '\udc00', '😺'.repeat(51)])(
    'rejects malformed literal parent IDs %j even when every row agrees',
    (groupId) => {
      const value = receipt();
      value.groupId = groupId;
      value.items = value.items.map((item) => ({ ...item, parentId: groupId }));
      value.result.results[0].parentId = groupId;
      expect(parseAsinBatchReceipt(JSON.stringify(value))).toBeNull();
    },
  );
  it('preserves original source and submitted items with known partial row outcomes', () => {
    const value = receipt();
    expect(parseAsinBatchReceipt(JSON.stringify(value))).toEqual(value);
    const storage = {
      local: new MemoryStorage(),
      session: new MemoryStorage(),
    };
    expect(saveAsinBatchReceipt('operator', value, storage)).toBe(true);
    expect(
      readAsinBatchReceipt('operator', owner, 'operation-1', storage),
    ).toEqual({ receipt: value, persisted: true });
    expect(
      readAsinBatchReceipt('other', owner, 'operation-1', storage),
    ).toBeNull();
    expect(
      readAsinBatchReceipt(
        'operator',
        JSON.stringify(['asin', 'operator', 'session-2']),
        undefined,
        storage,
      ),
    ).toBeNull();
    expect(
      readAsinBatchReceipt('operator', owner, 'replacement-operation', storage),
    ).toBeNull();
    expect(saveAsinBatchReceipt('other', value, storage)).toBe(false);
  });
  it('keeps a late old-operation receipt independently without moving the latest pointer backward', () => {
    const storage = {
      local: new MemoryStorage(),
      session: new MemoryStorage(),
    };
    const newer = receipt('new-operation', 200);
    const older = receipt('old-operation', 100);
    expect(saveAsinBatchReceipt('operator', newer, storage)).toBe(true);
    expect(saveAsinBatchReceipt('operator', older, storage)).toBe(true);
    expect(
      readAsinBatchReceipt('operator', owner, undefined, storage)?.receipt,
    ).toEqual(newer);
    expect(
      readAsinBatchReceipt('operator', owner, 'old-operation', storage)
        ?.receipt,
    ).toEqual(older);
    expect(removeAsinBatchReceipt('operator', older, storage)).toBe(true);
    expect(
      readAsinBatchReceipt('operator', owner, undefined, storage)?.receipt,
    ).toEqual(newer);
  });
  it('retains a session fallback and signals that local persistence failed, then can persist without any POST', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const original = local.setItem;
    local.setItem = () => {
      throw new Error('quota');
    };
    const value = receipt();
    expect(saveAsinBatchReceipt('operator', value, { local, session })).toBe(
      false,
    );
    expect(
      readAsinBatchReceipt('operator', owner, value.operationId, {
        local,
        session,
      }),
    ).toEqual({ receipt: value, persisted: false });
    local.setItem = original;
    expect(saveAsinBatchReceipt('operator', value, { local, session })).toBe(
      true,
    );
    expect(
      readAsinBatchReceipt('operator', owner, value.operationId, {
        local,
        session,
      }),
    ).toEqual({ receipt: value, persisted: true });
  });
  it('does not silently consider dropped storage writes persisted', () => {
    const local = new MemoryStorage();
    local.setItem = () => undefined;
    expect(
      saveAsinBatchReceipt('operator', receipt(), { local, session: null }),
    ).toBe(false);
    expect(
      readAsinBatchReceipt('operator', owner, undefined, {
        local,
        session: null,
      }),
    ).toBeNull();
  });
  it.each([
    'operationId',
    'owner',
    'groupId',
    'groupName',
    'submittedAt',
    'items',
    'result',
  ])('requires stored metadata %s', (key) => {
    const value = receipt() as unknown as Record<string, unknown>;
    delete value[key];
    expect(parseAsinBatchReceipt(JSON.stringify(value))).toBeNull();
  });
  it.each([
    (value: AsinBatchReceipt) => ({ ...value, secret: 'unexpected' }),
    (value: AsinBatchReceipt) => ({ ...value, owner: 'unverified' }),
    (value: AsinBatchReceipt) => ({ ...value, groupId: 'different-group' }),
    (value: AsinBatchReceipt) => ({
      ...value,
      result: { ...value.result, total: 3 },
    }),
    (value: AsinBatchReceipt) => ({
      ...value,
      result: { ...value.result, errors: [] },
    }),
    (value: AsinBatchReceipt) => ({
      ...value,
      result: {
        ...value.result,
        results: [value.result.results[0], value.result.results[0]],
      },
    }),
    (value: AsinBatchReceipt) => ({
      ...value,
      items: value.items.map((item) => ({
        ...item,
        authorization: 'unexpected',
      })),
    }),
    (value: AsinBatchReceipt) => ({
      ...value,
      items: value.items.map((item) => ({ ...item, asin: 'B00000000ſ' })),
    }),
    (value: AsinBatchReceipt) => ({
      ...value,
      result: {
        ...value.result,
        results: value.result.results.map((row) => ({
          ...row,
          secret: 'unexpected',
        })),
      },
    }),
  ])('rejects a tampered or incoherent persisted receipt %#', (tamper) => {
    expect(parseAsinBatchReceipt(JSON.stringify(tamper(receipt())))).toBeNull();
  });
  it('bounds persisted record size and rejects corrupted JSON', () => {
    expect(parseAsinBatchReceipt('{broken')).toBeNull();
    expect(parseAsinBatchReceipt('x'.repeat(2 * 1024 * 1024 + 1))).toBeNull();
  });
});
