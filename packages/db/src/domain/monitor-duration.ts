/** Shared arithmetic for the Legacy raw-row and continuous-aggregate paths.
 * SQL adapters supply bounded rows and finite bucket durations. Keep rounding
 * and the per-ASIN denominator distinct from the global time denominator. */
export type SqlMetricValue = number | string | boolean | null | undefined;
export interface DurationMetricSource {
  total_checks?: SqlMetricValue;
  check_count?: SqlMetricValue;
  broken_count?: SqlMetricValue;
  brokenCount?: SqlMetricValue;
  has_peak?: SqlMetricValue;
  is_peak?: SqlMetricValue;
  asin_key?: string | null;
  asinKey?: string | null;
}
export interface DurationTotals {
  totalDurationHours: number;
  abnormalDurationHours: number;
  normalDurationHours: number;
  peakDurationHours: number;
  peakAbnormalDurationHours: number;
  lowDurationHours: number;
  lowAbnormalDurationHours: number;
  totalChecks: number;
  brokenCount: number;
}
export interface DurationMetrics extends DurationTotals {
  ratioAllAsin: number;
  ratioAllTime: number;
  globalPeakRate: number;
  globalLowRate: number;
  ratioHigh: number;
  ratioLow: number;
  totalAsinsDedup: number;
  brokenAsinsDedup: number;
}
export interface DurationMetricsAccumulator extends DurationTotals {
  asinMetrics: Map<
    string,
    { totalDurationHours: number; abnormalDurationHours: number }
  >;
}
const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;
const round = (value: number) => Number(value.toFixed(4));
const rate = (numerator: number, denominator: number) =>
  denominator > 0 ? round((numerator / denominator) * 100) : 0;

export function createDurationMetricsAccumulator(): DurationMetricsAccumulator {
  return {
    totalDurationHours: 0,
    abnormalDurationHours: 0,
    normalDurationHours: 0,
    peakDurationHours: 0,
    peakAbnormalDurationHours: 0,
    lowDurationHours: 0,
    lowAbnormalDurationHours: 0,
    totalChecks: 0,
    brokenCount: 0,
    asinMetrics: new Map(),
  };
}
export function accumulateDurationMetrics(
  accumulator: DurationMetricsAccumulator | null | undefined,
  row: DurationMetricSource | null | undefined,
  bucketDurationHours: number,
): void {
  if (!accumulator || !bucketDurationHours || bucketDurationHours <= 0) return;
  const totalChecks = Number(row?.total_checks ?? row?.check_count ?? 0);
  const brokenCount = Number(row?.broken_count ?? row?.brokenCount ?? 0);
  const abnormalRatio =
    totalChecks > 0 ? clamp(brokenCount / totalChecks, 0, 1) : 0;
  const abnormalDurationHours = clamp(
    bucketDurationHours * abnormalRatio,
    0,
    bucketDurationHours,
  );
  const normalDurationHours = Math.max(
    0,
    bucketDurationHours - abnormalDurationHours,
  );
  const isPeak = Number(row?.has_peak ?? row?.is_peak ?? 0) === 1;
  const asinKey = String(row?.asin_key || row?.asinKey || '').trim();
  accumulator.totalDurationHours += bucketDurationHours;
  accumulator.abnormalDurationHours += abnormalDurationHours;
  accumulator.normalDurationHours += normalDurationHours;
  accumulator.totalChecks += totalChecks;
  accumulator.brokenCount += brokenCount;
  if (isPeak) {
    accumulator.peakDurationHours += bucketDurationHours;
    accumulator.peakAbnormalDurationHours += abnormalDurationHours;
  } else {
    accumulator.lowDurationHours += bucketDurationHours;
    accumulator.lowAbnormalDurationHours += abnormalDurationHours;
  }
  if (!asinKey) return;
  let asinMetrics = accumulator.asinMetrics.get(asinKey);
  if (!asinMetrics) {
    asinMetrics = { totalDurationHours: 0, abnormalDurationHours: 0 };
    accumulator.asinMetrics.set(asinKey, asinMetrics);
  }
  asinMetrics.totalDurationHours += bucketDurationHours;
  asinMetrics.abnormalDurationHours += abnormalDurationHours;
}
export function finalizeDurationMetrics(
  accumulator: DurationMetricsAccumulator,
): DurationMetrics {
  const totalDurationHours = round(accumulator.totalDurationHours);
  const abnormalDurationHours = round(accumulator.abnormalDurationHours);
  const normalDurationHours = round(accumulator.normalDurationHours);
  const peakDurationHours = round(accumulator.peakDurationHours);
  const peakAbnormalDurationHours = round(
    accumulator.peakAbnormalDurationHours,
  );
  const lowDurationHours = round(accumulator.lowDurationHours);
  const lowAbnormalDurationHours = round(accumulator.lowAbnormalDurationHours);
  let totalAsinsDedup = 0,
    brokenAsinsDedup = 0,
    sumAsinDurationRate = 0;
  for (const asinMetrics of accumulator.asinMetrics.values()) {
    if (asinMetrics.totalDurationHours <= 0) continue;
    totalAsinsDedup++;
    sumAsinDurationRate += clamp(
      asinMetrics.abnormalDurationHours / asinMetrics.totalDurationHours,
      0,
      1,
    );
    if (asinMetrics.abnormalDurationHours > 0) brokenAsinsDedup++;
  }
  return {
    totalDurationHours,
    abnormalDurationHours,
    normalDurationHours,
    peakDurationHours,
    peakAbnormalDurationHours,
    lowDurationHours,
    lowAbnormalDurationHours,
    ratioAllAsin: rate(sumAsinDurationRate, totalAsinsDedup),
    ratioAllTime: rate(abnormalDurationHours, totalDurationHours),
    globalPeakRate: rate(peakAbnormalDurationHours, totalDurationHours),
    globalLowRate: rate(lowAbnormalDurationHours, totalDurationHours),
    ratioHigh: rate(peakAbnormalDurationHours, peakDurationHours),
    ratioLow: rate(lowAbnormalDurationHours, lowDurationHours),
    totalChecks: Number(accumulator.totalChecks || 0),
    brokenCount: Number(accumulator.brokenCount || 0),
    totalAsinsDedup,
    brokenAsinsDedup,
  };
}
const metricFields = [
  'totalDurationHours',
  'abnormalDurationHours',
  'normalDurationHours',
  'peakDurationHours',
  'peakAbnormalDurationHours',
  'lowDurationHours',
  'lowAbnormalDurationHours',
  'ratioAllAsin',
  'ratioAllTime',
  'globalPeakRate',
  'globalLowRate',
  'ratioHigh',
  'ratioLow',
  'totalChecks',
  'brokenCount',
  'totalAsinsDedup',
  'brokenAsinsDedup',
] as const satisfies readonly (keyof DurationMetrics)[];
export function normalizeSqlDurationMetricRow<
  T extends Record<string, unknown> = Record<never, never>,
>(
  row: Partial<Record<keyof DurationMetrics, SqlMetricValue>> = {},
  extra: T = {} as T,
) {
  const metrics = Object.fromEntries(
    metricFields.map((key) => [key, Number(row[key] || 0)]),
  ) as unknown as DurationMetrics;
  return {
    ...extra,
    ...metrics,
    ratio_all_asin: metrics.ratioAllAsin,
    ratio_all_time: metrics.ratioAllTime,
    total_asins_dedup: metrics.totalAsinsDedup,
    broken_asins_dedup: metrics.brokenAsinsDedup,
  };
}
