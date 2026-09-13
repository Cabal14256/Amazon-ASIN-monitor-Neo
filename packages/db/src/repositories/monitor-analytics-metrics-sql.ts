import { sql, type SQL } from 'drizzle-orm';
import {
  MonitorAnalyticsQueryError,
  validateMonitorAnalyticsQuery,
  type MonitorAnalyticsQuery,
} from '../domain/monitor-analytics-query';
import type { MonitorSourceGranularity } from '../domain/monitor-calendar';

const intervals = {
  hour: sql`interval '1 hour'`,
  day: sql`interval '1 day'`,
  month: sql`interval '1 month'`,
};
/** Preserve MySQL DATETIME(0) casts and its decimal division working precision.
 * The visible bucket has scale 4, but MySQL keeps nine fractional digits while
 * multiplying it. Rounding to four here changes the abnormal-duration result.
 * Raw-row JavaScript arithmetic has a separate, already verified contract. */
export function monitorAggregateBucketHoursSql(
  query: MonitorAnalyticsQuery,
  granularity: MonitorSourceGranularity,
  timeSlot: SQL,
): SQL {
  validateMonitorAnalyticsQuery(query);
  if (!Object.hasOwn(intervals, granularity))
    throw new MonitorAnalyticsQueryError('input');
  const start = query.startTime || '1000-01-01 00:00:00',
    end = query.endTime || '9999-12-31 23:59:59';
  const startSecond = sql`date_trunc('second', ${start}::timestamp + interval '0.5 seconds')`;
  const endSecond = sql`date_trunc('second', ${end}::timestamp + interval '0.5 seconds')`;
  return sql`trunc(greatest(0, trunc(extract(epoch FROM (
    least(${timeSlot} + ${intervals[granularity]}, ${endSecond}) - greatest(${timeSlot}, ${startSecond})
  )))) / 3600::numeric, 9)`;
}

/** Complete SQL metric aggregation. Base provides group_key, group_label,
 * asin_key, integer check_count/broken_count/has_peak and bucket_hours from the
 * helper above. It must remain a composable SELECT so coverage and consumption
 * share one snapshot. Do not replace this with the JS raw-row finalizer.
 *
 * MySQL's grouped asin_metrics CTE materializes duration sums at scales 4 and 8.
 * The final ratios use those sums before their four-digit display rounding.
 * This explicitly retains the observed div_precision_increment=4 contract. */
export function monitorAggregateMetricsSelect(
  base: SQL,
  grouping: 'label' | 'variant_group' = 'label',
): SQL {
  if (!['label', 'variant_group'].includes(grouping))
    throw new MonitorAnalyticsQueryError('input');
  const variant = grouping === 'variant_group';
  const fraction = sql`CASE WHEN base.check_count > 0 THEN trunc(base.broken_count::numeric / base.check_count, 9) ELSE 0 END`;
  const abnormal = sql`base.bucket_hours * (${fraction})`;
  const sums = {
    total: sql`sum(total_duration_hours)`,
    abnormal: sql`sum(abnormal_duration_hours)`,
    peak: sql`sum(peak_duration_hours)`,
    peakAbnormal: sql`sum(peak_abnormal_duration_hours)`,
    low: sql`sum(low_duration_hours)`,
    lowAbnormal: sql`sum(low_abnormal_duration_hours)`,
  };
  const rate = (numerator: SQL, denominator: SQL) =>
    sql`round(CASE WHEN ${denominator}>0 THEN trunc(${numerator}/${denominator},18)*100 ELSE 0 END,4)`;
  return sql`WITH base AS (${base}), asin_metrics AS (
    SELECT base.group_key, ${
      variant
        ? sql`min(base.group_label) AS group_label, min(base.country) AS country`
        : sql`base.group_label`
    }, base.asin_key,
      round(sum(base.bucket_hours),4) AS total_duration_hours,
      round(sum(${abnormal}),8) AS abnormal_duration_hours,
      round(sum(CASE WHEN base.has_peak=1 THEN base.bucket_hours ELSE 0 END),4) AS peak_duration_hours,
      round(sum(CASE WHEN base.has_peak=1 THEN ${abnormal} ELSE 0 END),8) AS peak_abnormal_duration_hours,
      round(sum(CASE WHEN base.has_peak=0 THEN base.bucket_hours ELSE 0 END),4) AS low_duration_hours,
      round(sum(CASE WHEN base.has_peak=0 THEN ${abnormal} ELSE 0 END),8) AS low_abnormal_duration_hours,
      sum(base.check_count) AS total_checks, sum(base.broken_count) AS broken_count
      FROM base WHERE base.bucket_hours>0 GROUP BY base.group_key, ${
        variant ? sql`` : sql`base.group_label,`
      } base.asin_key
  ) SELECT group_key, ${
    variant
      ? sql`min(group_label) AS group_label, min(country) AS country`
      : sql`group_label`
  },
    round(${sums.total},4) AS "totalDurationHours",
    round(${sums.abnormal},4) AS "abnormalDurationHours",
    round(${sums.total}-${sums.abnormal},4) AS "normalDurationHours",
    round(${sums.peak},4) AS "peakDurationHours",
    round(${sums.peakAbnormal},4) AS "peakAbnormalDurationHours",
    round(${sums.low},4) AS "lowDurationHours",
    round(${sums.lowAbnormal},4) AS "lowAbnormalDurationHours",
    round(coalesce(round(avg(CASE WHEN total_duration_hours>0 THEN trunc(abnormal_duration_hours/total_duration_hours,18) END),16),0)*100,4) AS "ratioAllAsin",
    ${rate(sums.abnormal, sums.total)} AS "ratioAllTime",
    ${rate(sums.peakAbnormal, sums.total)} AS "globalPeakRate",
    ${rate(sums.lowAbnormal, sums.total)} AS "globalLowRate",
    ${rate(sums.peakAbnormal, sums.peak)} AS "ratioHigh",
    ${rate(sums.lowAbnormal, sums.low)} AS "ratioLow",
    sum(total_checks) AS "totalChecks", sum(broken_count) AS "brokenCount",
    count(*) AS "totalAsinsDedup",
    sum(CASE WHEN abnormal_duration_hours>0 THEN 1 ELSE 0 END) AS "brokenAsinsDedup"
    FROM asin_metrics GROUP BY group_key ${variant ? sql`` : sql`, group_label`}
    ${
      variant
        ? sql`HAVING sum(abnormal_duration_hours)>0 ORDER BY "abnormalDurationHours" DESC, "ratioAllTime" DESC`
        : sql`ORDER BY group_key ASC, group_label ASC`
    }`;
}
