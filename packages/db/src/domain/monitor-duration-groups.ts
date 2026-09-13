import {
  formatMonitorPeriod,
  getMonitorDurationBucketHours,
  type MonitorGranularity,
  type MonitorSourceGranularity,
} from './monitor-calendar';
import {
  accumulateDurationMetrics,
  createDurationMetricsAccumulator,
  finalizeDurationMetrics,
  type DurationMetricSource,
  type DurationMetricsAccumulator,
} from './monitor-duration';

export interface MonitorDurationSourceRow extends DurationMetricSource {
  slot_period?: string | null;
  country?: string | null;
  site?: string | null;
  brand?: string | null;
  variant_group_id?: string | null;
  variant_group_name?: string | null;
}

/** Callers supply bounded source rows. Group metadata comes from the first row,
 * insertion order is preserved, and ASIN deduplication happens within each group. */
export function buildMonitorDurationRowsByGroup<
  Row extends MonitorDurationSourceRow,
  Meta extends Record<string, unknown>,
>(
  sourceRows: readonly Row[],
  {
    sourceGranularity = 'hour',
    targetGranularity = 'day',
    queryStartDate = null,
    queryEndDate = null,
    buildGroupKey,
    buildGroupMeta,
  }: {
    sourceGranularity?: MonitorSourceGranularity;
    targetGranularity?: MonitorGranularity;
    queryStartDate?: Date | null;
    queryEndDate?: Date | null;
    buildGroupKey: (period: string, row: Row) => string | null | undefined;
    buildGroupMeta: (period: string, row: Row) => Meta;
  },
) {
  const grouped = new Map<
    string,
    { meta: Meta; accumulator: DurationMetricsAccumulator }
  >();
  for (const row of sourceRows) {
    const slotPeriod = String(row?.slot_period || '').trim();
    if (!slotPeriod) continue;
    const hours = getMonitorDurationBucketHours(
      slotPeriod,
      sourceGranularity,
      queryStartDate,
      queryEndDate,
    );
    if (hours <= 0) continue;
    const targetPeriod = formatMonitorPeriod(slotPeriod, targetGranularity);
    const key = buildGroupKey(targetPeriod, row);
    if (!key) continue;
    let group = grouped.get(key);
    if (!group) {
      group = {
        meta: buildGroupMeta(targetPeriod, row),
        accumulator: createDurationMetricsAccumulator(),
      };
      grouped.set(key, group);
    }
    accumulateDurationMetrics(group.accumulator, row, hours);
  }
  return Array.from(grouped.values(), ({ meta, accumulator }) => {
    const metrics = finalizeDurationMetrics(accumulator);
    return {
      ...meta,
      ...metrics,
      ratio_all_asin: metrics.ratioAllAsin,
      ratio_all_time: metrics.ratioAllTime,
      total_asins_dedup: metrics.totalAsinsDedup,
      broken_asins_dedup: metrics.brokenAsinsDedup,
    };
  });
}
