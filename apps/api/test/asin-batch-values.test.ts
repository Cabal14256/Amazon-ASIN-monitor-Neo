import {
  addBatchAsinSuccess,
  batchAsinFitsStorage,
  prepareBatchAsins,
} from '@asin-monitor/db';
import { describe, expect, it } from 'vitest';
import {
  AsinWriteInputError,
  parseAsinBatchCreate,
} from '../src/asin/asin-write-values';
import { legacyAsinBatch } from './helpers/asin-batch-legacy';

export const batchItem = {
  asin: ' b000000093 ',
  country: ' us ',
  name: ' Product ',
  site: ' amazon.com ',
  brand: ' Fixture ',
  parentId: ' g ',
  asinType: 'MAIN_LINK',
};
describe('batch ASIN values / complete actual Legacy service results', () => {
  it.each(
    [
      [batchItem],
      [
        {
          ...batchItem,
          parentId: undefined,
          variantGroupId: ' g ',
          asinType: 'SUB_REVIEW',
        },
      ],
      [{ ...batchItem, name: null, asinType: 2 }],
      [{ ...batchItem, name: false, asinType: false }],
      [{ ...batchItem, name: 12, site: true, brand: 3 }],
      [null, false, 0, 'raw item', [], {}],
      [
        {
          ...batchItem,
          asin: 'bad',
          country: '',
          site: '',
          brand: '',
          parentId: '',
          asinType: 8,
        },
      ],
      [
        { ...batchItem, country: '' },
        { ...batchItem, site: '' },
        { ...batchItem, brand: '' },
        { ...batchItem, parentId: '' },
        { ...batchItem, asinType: 8 },
      ],
      [
        batchItem,
        { ...batchItem, asin: 'B000000093', country: 'US', parentId: 'other' },
      ],
      [{ ...batchItem, site: '' }, batchItem],
      [
        { ...batchItem, asin: 'B000000094' },
        { ...batchItem, asin: 'bad' },
        batchItem,
      ],
      [{ ...batchItem, parentId: ' ', variantGroupId: 'g' }],
    ].map((items) => ({ items })),
  )(
    'matches frozen normalization, failure priority and phase ordering %#',
    async ({ items }) => {
      const expected = await legacyAsinBatch(items);
      let count = 0;
      const plan = prepareBatchAsins(
        parseAsinBatchCreate({ items }),
        () => `new-${count++}`,
      );
      plan.items.forEach((item) => addBatchAsinSuccess(plan.result, item));
      expect(plan.result).toEqual(expected.result);
      expect(
        plan.items.map((item) => [
          item.id,
          item.asin,
          item.name,
          item.asinType,
          item.country,
          item.site,
          item.brand,
          item.parentId,
          0,
          'NORMAL',
        ]),
      ).toEqual(expected.inserts);
    },
  );
  it.each([
    null,
    [],
    {},
    { items: [] },
    { items: 'invalid' },
    { items: [batchItem], operator: 'spoof' },
    { items: Array.from({ length: 1001 }, () => batchItem) },
  ])('rejects invalid outer batch shape %#', (value) => {
    expect(() => parseAsinBatchCreate(value)).toThrow(AsinWriteInputError);
  });
  it('accepts the bounded maximum and leaves invalid rows for individual results', () => {
    const items = Array.from({ length: 1000 }, (_, index) =>
      index % 2 ? batchItem : null,
    );
    expect(parseAsinBatchCreate({ items })).toEqual(items);
  });
  it('uses PG codepoint limits without truncation and rejects non-storable NUL text', () => {
    const item = prepareBatchAsins([
      { ...batchItem, name: '🛒'.repeat(500), brand: '🛒'.repeat(100) },
    ]).items[0];
    expect(batchAsinFitsStorage(item)).toBe(true);
    expect(batchAsinFitsStorage({ ...item, name: item.name + '🛒' })).toBe(
      false,
    );
    expect(batchAsinFitsStorage({ ...item, site: 'a\0b' })).toBe(false);
  });
  it('isolates a JSON object that shadows toString without exposing its fields', () => {
    const plan = prepareBatchAsins([
      { ...batchItem, asin: { toString: null, private: 'fixture' } },
      batchItem,
    ]);
    expect(plan.result).toMatchObject({
      total: 2,
      failedCount: 1,
      errors: [{ index: 0, message: '参数格式无效' }],
    });
    expect(plan.items).toHaveLength(1);
    expect(JSON.stringify(plan.result)).not.toContain('fixture');
  });
});
