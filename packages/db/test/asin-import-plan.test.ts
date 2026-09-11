import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  prepareBatchAsins,
  prepareImportAsins,
} from '../src/domain/asin-batch-create';

function item(index: number) {
  return {
    asin: `B${index.toString().padStart(9, '0')}`,
    country: 'US',
    site: 'Shop',
    brand: 'Brand',
    parentId: 'group',
    asinType: '1',
  };
}
function legacy(raw: unknown[]) {
  const module = {
    exports: {} as {
      fixture(items: unknown[]): ReturnType<typeof prepareImportAsins>;
    },
  };
  let id = 0;
  runInNewContext(
    readFileSync(
      resolve(
        __dirname,
        '../../../server/src/services/asinBatchCreateService.js',
      ),
      'utf8',
    ) +
      '\nmodule.exports.fixture = (items) => { const result = createEmptyResult(items.length); return {items: normalizeItems(items, {hasSite: true}, result), result}; };',
    {
      module,
      require: (name: string) =>
        name === 'uuid' ? { v4: () => `id-${id++}` } : {},
    },
  );
  return JSON.parse(JSON.stringify(module.exports.fixture(raw)));
}
describe('import batch preparation spans all bounded database chunks', () => {
  it('preserves full-file duplicate detection and validation order against the actual Legacy service', () => {
    const raw = Array.from({ length: 1005 }, (_, index) => item(index));
    raw[2].asin = 'invalid';
    raw[1001] = { ...item(1), parentId: 'another-group' };
    raw[1002] = { ...item(2), asin: 'invalid' };
    raw[1003] = { ...item(1), country: 'UK' };
    let id = 0;
    const plan = prepareImportAsins(raw, () => `id-${id++}`);
    expect(plan).toEqual(legacy(raw));
    expect(plan.result.errors.map((error) => error.index)).toEqual([
      2, 1001, 1002,
    ]);
    expect(plan.items.some((value) => value.index === 1003)).toBe(true);
  });
  it('keeps the HTTP batch cap while allowing bounded larger file plans', () => {
    const raw = Array.from({ length: 1001 }, (_, index) => item(index));
    expect(() => prepareBatchAsins(raw)).toThrow('Invalid ASIN batch size');
    expect(prepareImportAsins(raw).items).toHaveLength(1001);
    expect(() => prepareImportAsins(Array(100001))).toThrow(
      'Invalid ASIN batch size',
    );
  });
});
