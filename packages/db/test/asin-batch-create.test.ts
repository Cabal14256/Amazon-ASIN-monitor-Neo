import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { legacyAsinBatch } from '../../../apps/api/test/helpers/asin-batch-legacy';
import type { Db } from '../src/client';
import { prepareBatchAsins } from '../src/domain/asin-batch-create';
import { DrizzleAsinWriteUnit } from '../src/repositories/asin-write-repository';

const item = (index = 1, parentId = 'g') => ({
  asin: `B${String(index).padStart(9, '0')}`,
  country: 'US',
  site: 'Shop',
  brand: 'Brand',
  parentId,
});

function writer(
  count: number,
  existing: { asin: string; country: string }[] = [],
) {
  const events: string[] = [];
  const values = vi.fn(async (_rows: any[]) => undefined);
  const select = vi.fn((fields) => {
    const rows = fields
      ? existing
      : [
          { id: 'g', country: 'US' },
          { id: ' g ', country: 'US' },
          { id: '   ', country: 'US' },
        ];
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      for: () => {
        events.push('parent-locked');
        return query;
      },
      then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
    };
    return query;
  });
  const execute = vi.fn(async (query) => {
    const text = new PgDialect().sqlToQuery(query).sql;
    events.push(text);
    return { rows: [{ child_count: count }] };
  });
  const db = {
    select,
    execute,
    insert: () => ({ values }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as unknown as Db;
  return {
    unit: new DrizzleAsinWriteUnit(db, () => undefined),
    execute,
    values,
    events,
  };
}

describe('primary HTTP batch parent identity and locked readable capacity', () => {
  it('preserves the literal parent in the actual Legacy service', async () => {
    const result = await legacyAsinBatch([item(1, ' g ')], {
      groups: [
        { id: 'g', country: 'US' },
        { id: ' g ', country: 'US' },
      ],
    });
    expect(result.inserts[0][7]).toBe(' g ');
    expect(result.result.results).toMatchObject([
      { success: true, parentId: ' g ' },
    ]);
  });

  it('rejects the actual Legacy write when its current locked parent is full', async () => {
    const result = await legacyAsinBatch([item()], {
      childCounts: { g: 5000 },
    });
    expect(result.result).toMatchObject({ successCount: 0, failedCount: 1 });
    expect(result.inserts).toEqual([]);
    expect(result.result.errors[0].message).toContain('5000');
  });
  it('preserves the separately bounded full-file import write contract', async () => {
    const result = await legacyAsinBatch([item()], {
      childCounts: { g: 5001 },
      clearCache: false,
    });
    expect(result.result).toMatchObject({ successCount: 1, failedCount: 0 });
    expect(result.inserts).toHaveLength(1);
  });
  it('preserves literal parentId and alias, including canonical all-space IDs', () => {
    const plan = prepareBatchAsins([
      item(1, ' g '),
      { ...item(2), parentId: undefined, variantGroupId: ' raw-only ' },
      item(3, '   '),
      item(4, ''),
    ]);
    expect(plan.items.map((row) => row.parentId)).toEqual([
      ' g ',
      ' raw-only ',
      '   ',
    ]);
    expect(plan.result.errors).toMatchObject([
      { index: 3, message: '所属变体组不能为空' },
    ]);
  });

  it.each([
    'g\0x',
    'g\u001fx',
    'g\u007fx',
    'g\u0085x',
    'g\ud800x',
    'g\udc00x',
    '🛒'.repeat(51),
  ])(
    'rejects an unsafe canonical ID as a row failure in both services %#',
    async (parentId) => {
      const plan = prepareBatchAsins([item(1, parentId)]);
      const legacy = await legacyAsinBatch([item(1, parentId)]);
      expect(plan.items).toEqual([]);
      expect(plan.result).toMatchObject({
        failedCount: 1,
        errors: [{ message: '所属变体组ID格式无效' }],
      });
      expect(legacy.result).toEqual(plan.result);
    },
  );

  it('accepts the exact 50 codepoint ID without trimming or truncation', async () => {
    const parentId = '🛒'.repeat(50);
    const plan = prepareBatchAsins([item(1, parentId)]);
    const legacy = await legacyAsinBatch([item(1, parentId)], {
      groups: [{ id: parentId, country: 'US' }],
    });
    expect(plan.items[0].parentId).toBe(parentId);
    expect(legacy.result.results).toMatchObject([{ success: true, parentId }]);
  });

  it('writes a canonical all-space parent in both actual service implementations', async () => {
    const f = writer(0);
    const result = await f.unit.batchCreateAsins([item(1, '   ')]);
    const legacy = await legacyAsinBatch([item(1, '   ')], {
      groups: [{ id: '   ', country: 'US' }],
    });
    expect(result.results).toMatchObject([{ success: true, parentId: '   ' }]);
    expect(f.values.mock.calls.flat(2)).toMatchObject([
      { variantGroupId: '   ' },
    ]);
    expect(legacy.result.results).toMatchObject([
      { success: true, parentId: '   ' },
    ]);
  });

  it('writes and returns the exact raw parent beside its trimmed neighbor', async () => {
    const f = writer(0);
    const result = await f.unit.batchCreateAsins([item(1, ' g ')]);
    expect(result.results).toMatchObject([{ success: true, parentId: ' g ' }]);
    expect(f.values.mock.calls.flat(2)).toMatchObject([
      { variantGroupId: ' g ' },
    ]);
  });

  it('rejects every new row when the parent is full after its lock', async () => {
    const f = writer(5000);
    const result = await f.unit.batchCreateAsins([item(1), item(2)]);
    expect(result).toMatchObject({ successCount: 0, failedCount: 2 });
    expect(result.errors.every((row) => row.message.includes('5000'))).toBe(
      true,
    );
    expect(f.values).not.toHaveBeenCalled();
    const countIndex = f.events.findIndex((event) =>
      event.includes('child_count'),
    );
    expect(countIndex).toBeGreaterThan(f.events.indexOf('parent-locked'));
  });

  it('accepts the exact remaining capacity and excludes existing duplicates', async () => {
    const f = writer(4999, [{ asin: item(1).asin, country: 'US' }]);
    const result = await f.unit.batchCreateAsins([item(1), item(2)]);
    expect(result).toMatchObject({ successCount: 1, failedCount: 1 });
    expect(result.results.find((row) => row.success)?.asin).toBe(item(2).asin);
  });
});
