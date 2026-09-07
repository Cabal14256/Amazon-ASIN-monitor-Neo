import type { Asin, VariantGroup } from '@asin-monitor/db';

export const fixtureAt = new Date('2026-09-07T00:00:00.000Z');
export function queryGroup(
  overrides: Partial<VariantGroup> = {},
): VariantGroup {
  return {
    id: 'group-83',
    name: 'Fixture group',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture brand',
    isBroken: false,
    variantStatus: 'NORMAL',
    manualBroken: false,
    manualBrokenReason: null,
    manualBrokenUpdatedAt: null,
    manualBrokenUpdatedBy: null,
    isCompetitor: false,
    createTime: fixtureAt,
    updateTime: fixtureAt,
    lastCheckTime: null,
    feishuNotifyEnabled: true,
    ...overrides,
  };
}
export function queryAsin(overrides: Partial<Asin> = {}): Asin {
  return {
    id: 'asin-83',
    asin: 'B000000083',
    name: 'Fixture product',
    asinType: '1',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture brand',
    variantGroupId: 'group-83',
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
    createTime: fixtureAt,
    updateTime: fixtureAt,
    lastCheckTime: null,
    feishuNotifyEnabled: true,
    ...overrides,
  };
}
