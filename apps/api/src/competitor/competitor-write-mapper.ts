import type { CompetitorAsinRecord } from '@asin-monitor/contracts';
import type { CompetitorAsin } from '@asin-monitor/db';
import { normalizeAsinType } from '@asin-monitor/variant-check';

/** Standalone Legacy ASIN writes return variantGroupId, without child aliases. */
export function mapCompetitorAsinWrite(
  asin: CompetitorAsin,
): CompetitorAsinRecord {
  return {
    id: asin.id,
    asin: asin.asin,
    name: asin.name,
    asinType: normalizeAsinType(asin.asinType),
    country: asin.country,
    brand: asin.brand,
    variantGroupId: asin.variantGroupId,
    isBroken: asin.isBroken === null ? null : asin.isBroken ? 1 : 0,
    variantStatus: asin.variantStatus,
    createTime: asin.createTime?.toISOString() ?? null,
    updateTime: asin.updateTime?.toISOString() ?? null,
    lastCheckTime: asin.lastCheckTime?.toISOString() ?? null,
    feishuNotifyEnabled: asin.feishuNotifyEnabled ? 1 : 0,
  };
}
