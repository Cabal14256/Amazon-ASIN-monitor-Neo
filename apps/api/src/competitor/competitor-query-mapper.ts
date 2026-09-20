import type { CompetitorVariantGroup as GroupResponse } from '@asin-monitor/contracts';
import type {
  CompetitorAsin,
  CompetitorGroupReadResult,
} from '@asin-monitor/db';
import { normalizeAsinType } from '@asin-monitor/variant-check';

const flag = (value: boolean | null): 0 | 1 | null =>
  value === null ? null : value ? 1 : 0;
const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Legacy competitor display deliberately derives group state from children
 * only, even when a persisted broken parent satisfied the query filter. */
export function mapCompetitorQueryGroups(
  result: CompetitorGroupReadResult,
): GroupResponse[] {
  const byGroup = new Map<string, CompetitorAsin[]>();
  for (const asin of result.asins) {
    const rows = byGroup.get(asin.variantGroupId) ?? [];
    rows.push(asin);
    byGroup.set(asin.variantGroupId, rows);
  }
  return result.groups.map((group) => {
    const rows = byGroup.get(group.id) ?? [];
    const broken = rows.some((asin) => asin.isBroken === true) ? 1 : 0;
    const status = broken ? 'BROKEN' : 'NORMAL';
    return {
      id: group.id,
      name: group.name,
      country: group.country,
      brand: group.brand,
      is_broken: broken,
      isBroken: broken,
      variant_status: status,
      variantStatus: status,
      feishu_notify_enabled: flag(group.feishuNotifyEnabled),
      feishuNotifyEnabled: flag(group.feishuNotifyEnabled) ?? 0,
      create_time: iso(group.createTime),
      update_time: iso(group.updateTime),
      last_check_time: iso(group.lastCheckTime),
      createTime: iso(group.createTime),
      updateTime: iso(group.updateTime),
      lastCheckTime: iso(group.lastCheckTime),
      ...(group.asinCount === undefined ? {} : { asin_count: group.asinCount }),
      children: rows.map((asin) => ({
        id: asin.id,
        asin: asin.asin,
        name: asin.name,
        asinType: normalizeAsinType(asin.asinType),
        country: asin.country,
        brand: asin.brand,
        parentId: group.id,
        isBroken: flag(asin.isBroken),
        variantStatus: asin.variantStatus,
        createTime: iso(asin.createTime),
        updateTime: iso(asin.updateTime),
        lastCheckTime: iso(asin.lastCheckTime),
        feishuNotifyEnabled: flag(asin.feishuNotifyEnabled) ?? 0,
      })),
    };
  });
}
