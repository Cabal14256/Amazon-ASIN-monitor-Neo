import type { Asin, VariantGroup } from '@asin-monitor/db';
import { parseCatalogVariantResult } from '@asin-monitor/sp-api';

export const before = new Date('2026-01-01T00:00:00.000Z');
export const checkedAt = new Date('2026-09-12T00:00:00.000Z');
export function group(patch: Partial<VariantGroup> = {}): VariantGroup {
  return {
    id: 'g1',
    name: 'Fixture group',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    isBroken: false,
    variantStatus: 'NORMAL',
    manualBroken: false,
    manualBrokenReason: null,
    manualBrokenUpdatedAt: null,
    manualBrokenUpdatedBy: null,
    isCompetitor: false,
    createTime: before,
    updateTime: before,
    lastCheckTime: null,
    feishuNotifyEnabled: true,
    ...patch,
  };
}
export function asin(index = 1, patch: Partial<Asin> = {}): Asin {
  return {
    id: `a${index}`,
    asin: `B${String(index).padStart(9, '0')}`,
    name: `Fixture ${index}`,
    asinType: 'MAIN_LINK',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    variantGroupId: 'g1',
    isBroken: false,
    variantStatus: 'NORMAL',
    manualBroken: false,
    manualBrokenReason: null,
    manualBrokenUpdatedAt: null,
    manualBrokenUpdatedBy: null,
    manualExcludedFromGroup: false,
    manualExcludedReason: null,
    manualExcludedUpdatedAt: null,
    manualExcludedUpdatedBy: null,
    createTime: before,
    updateTime: before,
    lastCheckTime: null,
    feishuNotifyEnabled: true,
    ...patch,
  };
}
export function product(
  index = 1,
  hasVariants = true,
  title = 'Complete catalog title',
) {
  const code = asin(index).asin;
  return parseCatalogVariantResult(
    {
      asin: code,
      summaries: [{ itemName: title, brand: 'Complete catalog brand' }],
      relationships: hasVariants
        ? [
            {
              relationships: [
                { type: 'VARIATION', parentAsins: ['B000000099'] },
              ],
            },
          ]
        : [],
    },
    code,
  );
}
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
