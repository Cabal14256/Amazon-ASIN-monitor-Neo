import type {
  DecoratedAsin,
  VariantGroup as GroupResponse,
} from '@asin-monitor/contracts';
import {
  resolveAsinVariantStatus,
  resolveGroupVariantStatus,
  type Asin,
  type AsinGroupReadResult,
  type VariantGroup,
} from '@asin-monitor/db';

const flag = (value: boolean | null): 0 | 1 | null =>
  value === null ? null : value ? 1 : 0;
const iso = (value: Date | null) => value?.toISOString() ?? null;
type SerializedDates<T> = {
  [K in keyof T]: T[K] extends Date | null
    ? Exclude<T[K], Date> | string
    : T[K];
};
function statusJson<T extends Record<string, unknown>>(
  value: T,
): SerializedDates<T> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      item instanceof Date ? item.toISOString() : item,
    ]),
  ) as SerializedDates<T>;
}
export function normalizeAsinType(value: string | null): '1' | '2' | null {
  const normalized = value?.trim();
  return normalized === '1' || normalized === 'MAIN_LINK'
    ? '1'
    : normalized === '2' || normalized === 'SUB_REVIEW'
    ? '2'
    : null;
}
export function mapAsinQueryGroups(
  result: AsinGroupReadResult,
): GroupResponse[] {
  const byGroup = new Map<string, Asin[]>();
  for (const asin of result.asins) {
    const rows = byGroup.get(asin.variantGroupId) ?? [];
    rows.push(asin);
    byGroup.set(asin.variantGroupId, rows);
  }
  return result.groups.map((group) =>
    mapGroup(group, byGroup.get(group.id) ?? []),
  );
}
function mapGroup(
  group: VariantGroup & { asinCount?: number },
  rows: Asin[],
): GroupResponse {
  const resolved = rows.map((row) => ({
    row,
    status: resolveAsinVariantStatus(row, group),
  }));
  const children: DecoratedAsin[] = resolved.map(({ row, status }) => ({
    id: row.id,
    asin: row.asin,
    name: row.name,
    asinType: normalizeAsinType(row.asinType),
    country: row.country,
    site: row.site,
    brand: row.brand,
    parentId: group.id,
    ...statusJson(status),
    createTime: iso(row.createTime),
    updateTime: iso(row.updateTime),
    lastCheckTime: iso(row.lastCheckTime),
    feishuNotifyEnabled: flag(row.feishuNotifyEnabled) ?? 1,
  }));
  const state = resolveGroupVariantStatus(
    group,
    resolved.map((item) => item.status),
  );
  return {
    id: group.id,
    name: group.name,
    country: group.country,
    site: group.site,
    brand: group.brand,
    is_broken: state.isBroken,
    variant_status: state.variantStatus,
    manual_broken: flag(group.manualBroken),
    manual_broken_reason: group.manualBrokenReason,
    manual_broken_updated_at: iso(group.manualBrokenUpdatedAt),
    manual_broken_updated_by: group.manualBrokenUpdatedBy,
    is_competitor: flag(group.isCompetitor),
    feishu_notify_enabled: flag(group.feishuNotifyEnabled),
    create_time: iso(group.createTime),
    update_time: iso(group.updateTime),
    last_check_time: iso(group.lastCheckTime),
    ...statusJson(state),
    children,
    ...(group.asinCount === undefined ? {} : { asin_count: group.asinCount }),
    createTime: iso(group.createTime),
    updateTime: iso(group.updateTime),
    lastCheckTime: iso(group.lastCheckTime),
    feishuNotifyEnabled: flag(group.feishuNotifyEnabled) ?? 1,
  };
}
