import {
  addBatchAsinSuccess,
  batchAsinFitsStorage,
  prepareCompetitorBatchAsins,
} from '@asin-monitor/db';
import { describe, expect, it } from 'vitest';
import {
  CompetitorWriteInputError,
  parseCompetitorBatchCreate,
} from '../src/competitor/competitor-write-values';
import { legacyAsinBatch } from './helpers/asin-batch-legacy';

const item = {
  asin: ' b000000125 ',
  country: ' us ',
  brand: ' Brand ',
  parentId: ' g ',
  name: ' Name ',
  asinType: 'MAIN_LINK',
};
describe('competitor batch normalization / actual Legacy service', () => {
  it.each(
    [
      [item],
      [{ ...item, site: '' }],
      [{ ...item, site: 'unused\0' + 'x'.repeat(101) }],
      [
        {
          ...item,
          parentId: undefined,
          variantGroupId: ' g ',
          asinType: 'SUB_REVIEW',
        },
      ],
      [{ ...item, name: false, asinType: false }],
      [{ ...item, name: 123, brand: true, asinType: ' 2 ' }],
      [{ ...item, name: null, asinType: null }],
      [null, false, 0, 'raw item', [], {}],
      [
        {
          ...item,
          asin: 'bad',
          country: '',
          brand: '',
          parentId: '',
          asinType: 8,
        },
      ],
      [
        { ...item, country: '' },
        { ...item, brand: '' },
        { ...item, parentId: '' },
        { ...item, asinType: 8 },
      ],
      [item, { ...item, parentId: 'other' }],
      [{ ...item, brand: '' }, item],
      [{ ...item, asin: 'B000000126' }, { ...item, asin: 'bad' }, item],
      [{ ...item, parentId: ' ', variantGroupId: 'g' }],
    ].map((items) => ({ items })),
  )(
    'preserves complete results and persisted columns %#',
    async ({ items }) => {
      const expected = await legacyAsinBatch(items, { domain: 'competitor' });
      let count = 0;
      const plan = prepareCompetitorBatchAsins(
        parseCompetitorBatchCreate({ items }),
        () => `new-${count++}`,
      );
      plan.items.forEach((value) => addBatchAsinSuccess(plan.result, value));
      expect(plan.result).toEqual(expected.result);
      expect(
        plan.items.map((value) => [
          value.id,
          value.asin,
          value.name,
          value.asinType,
          value.country,
          value.brand,
          value.parentId,
          0,
          'NORMAL',
          0,
        ]),
      ).toEqual(expected.inserts);
    },
  );
  it.each([
    null,
    [],
    {},
    { items: [] },
    { items: 'bad' },
    { items: [item], actor: 'spoof' },
    { items: Array(1001).fill(item) },
  ])('rejects invalid outer shape %#', (value) => {
    expect(() => parseCompetitorBatchCreate(value)).toThrow(
      CompetitorWriteInputError,
    );
  });
  it('bounds the maximum without rejecting individual invalid rows', () => {
    const items = Array(1000).fill(null);
    expect(parseCompetitorBatchCreate({ items })).toEqual(items);
    expect(() => prepareCompetitorBatchAsins([])).toThrow();
    expect(() => prepareCompetitorBatchAsins(Array(1001).fill(null))).toThrow();
  });
  it('ignores site storage constraints but preserves actual column limits', () => {
    const row = prepareCompetitorBatchAsins([
      {
        ...item,
        site: 'unused\0' + 'x'.repeat(101),
        name: '🛒'.repeat(500),
        brand: '🛒'.repeat(100),
      },
    ]).items[0];
    expect(batchAsinFitsStorage(row, false)).toBe(true);
    expect(batchAsinFitsStorage(row)).toBe(false);
    expect(batchAsinFitsStorage({ ...row, brand: 'x\0y' }, false)).toBe(false);
    expect(batchAsinFitsStorage({ ...row, name: row.name + '🛒' }, false)).toBe(
      false,
    );
  });
  it('isolates unconvertible JSON objects into a safe row failure', () => {
    const plan = prepareCompetitorBatchAsins([
      { ...item, asin: { toString: null, secret: 'private-fixture' } },
      item,
    ]);
    expect(plan.items).toHaveLength(1);
    expect(plan.result.errors).toEqual([
      { index: 0, asin: null, country: null, message: '参数格式无效' },
    ]);
    expect(JSON.stringify(plan.result)).not.toContain('private-fixture');
  });
});
