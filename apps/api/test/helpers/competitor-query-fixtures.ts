import type { CompetitorAsin, CompetitorVariantGroup } from '@asin-monitor/db';
export const competitorQueryAt = new Date('2026-09-13T16:00:00Z');
export const competitorQueryGroup = (
  values: Partial<CompetitorVariantGroup> = {},
): CompetitorVariantGroup => ({
  id: 'group-119',
  name: '竞品组',
  country: 'US',
  brand: '合成品牌',
  isBroken: false,
  variantStatus: 'NORMAL',
  feishuNotifyEnabled: false,
  createTime: competitorQueryAt,
  updateTime: competitorQueryAt,
  lastCheckTime: null,
  ...values,
});
export const competitorQueryAsin = (
  values: Partial<CompetitorAsin> = {},
): CompetitorAsin => ({
  id: 'asin-119',
  asin: 'B000000119',
  name: '合成商品',
  country: 'US',
  brand: '合成品牌',
  variantGroupId: 'group-119',
  asinType: '1',
  isBroken: false,
  variantStatus: 'NORMAL',
  feishuNotifyEnabled: false,
  createTime: competitorQueryAt,
  updateTime: competitorQueryAt,
  lastCheckTime: null,
  ...values,
});
