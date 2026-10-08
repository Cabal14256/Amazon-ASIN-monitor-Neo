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

/** Raw summaries clip only when BOTH bounds exist. Legacy subtracts integer
 * Date milliseconds before binary64 division by 3600000: converting fractional
 * seconds first changes display rounding at 180/540 ms boundaries. */
export function monitorRawSummaryBucketHoursSql(
  query: MonitorAnalyticsQuery,
  granularity: MonitorSourceGranularity,
  timeSlot: SQL,
): SQL {
  validateMonitorAnalyticsQuery(query);
  if (!Object.hasOwn(intervals, granularity))
    throw new MonitorAnalyticsQueryError('input');
  const end = sql`${timeSlot} + ${intervals[granularity]}`;
  const duration =
    query.startTime && query.endTime
      ? sql`least(${end}, ${query.endTime}::timestamp) - greatest(${timeSlot}, ${query.startTime}::timestamp)`
      : sql`${end} - ${timeSlot}`;
  return sql`greatest(0::double precision, (extract(epoch FROM (${duration})) * 1000)::double precision / 3600000::double precision)`;
}

/** Sufficient statistics for the frozen Legacy raw summary finalizer. Use the
 * dimension projection: each site/brand/ASIN bucket contributes its own hours.
 * No bucket, fraction or intermediate accumulator is rounded. Ordered float8
 * sums avoid parallel partial aggregation changing the binary64 accumulation
 * order. Global normal hours are summed independently, as in Legacy raw JS.
 * Only bounded group rows cross the wire; coverage and source stay one SELECT. */
export function monitorRawSummaryMetricsSelect(base: SQL): SQL {
  const order = sql`time_slot, country, asin_key, site, brand`;
  const sum = (value: SQL) => sql`sum(${value} ORDER BY ${order})`;
  // JS Map keys use String.trim() and exact string equality AFTER source SQL
  // grouping. Do not let the legacy case-insensitive column collation merge
  // differently cased keys coming from separate countries/dimensions.
  const whitespace =
    '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  const asinKey = sql`btrim(base.asin_key, ${whitespace}) COLLATE "C"`;
  const fraction = sql`CASE WHEN base.check_count>0 THEN
    least(1::double precision, greatest(0::double precision,
      base.broken_count::double precision / base.check_count::double precision))
    ELSE 0::double precision END`;
  const abnormal = sql`least(base.bucket_hours, greatest(0::double precision,
    base.bucket_hours * (${fraction})))`;
  return sql`WITH base AS (${base}), contributions AS MATERIALIZED (
    SELECT base.*, ${asinKey} AS normalized_asin_key, ${abnormal} AS abnormal_hours,
      greatest(0::double precision, base.bucket_hours - (${abnormal})) AS normal_hours
    FROM base WHERE base.bucket_hours>0
  ), global_metrics AS (
    SELECT group_key, group_label,
      ${sum(sql`bucket_hours`)} AS "totalDurationHours",
      ${sum(sql`abnormal_hours`)} AS "abnormalDurationHours",
      ${sum(sql`normal_hours`)} AS "normalDurationHours",
      ${sum(
        sql`CASE WHEN has_peak=1 THEN bucket_hours ELSE 0::double precision END`,
      )} AS "peakDurationHours",
      ${sum(
        sql`CASE WHEN has_peak=1 THEN abnormal_hours ELSE 0::double precision END`,
      )} AS "peakAbnormalDurationHours",
      ${sum(
        sql`CASE WHEN has_peak=0 THEN bucket_hours ELSE 0::double precision END`,
      )} AS "lowDurationHours",
      ${sum(
        sql`CASE WHEN has_peak=0 THEN abnormal_hours ELSE 0::double precision END`,
      )} AS "lowAbnormalDurationHours",
      sum(check_count) AS "totalChecks", sum(broken_count) AS "brokenCount"
    FROM contributions GROUP BY group_key, group_label
  ), asin_metrics AS (
    SELECT group_key, group_label, normalized_asin_key AS asin_key,
      ${sum(sql`bucket_hours`)} AS total_hours,
      ${sum(sql`abnormal_hours`)} AS abnormal_hours
    FROM contributions WHERE nullif(normalized_asin_key,'') IS NOT NULL
    GROUP BY group_key, group_label, normalized_asin_key
  ), asin_groups AS (
    SELECT group_key, group_label,
      sum(least(1::double precision,greatest(0::double precision,abnormal_hours/total_hours)) ORDER BY asin_key) AS "sumAsinDurationRate",
      count(*) AS "totalAsinsDedup",
      count(*) FILTER (WHERE abnormal_hours>0) AS "brokenAsinsDedup"
    FROM asin_metrics WHERE total_hours>0 GROUP BY group_key,group_label
  ) SELECT global_metrics.*, coalesce(asin_groups."sumAsinDurationRate",0) AS "sumAsinDurationRate",
    coalesce(asin_groups."totalAsinsDedup",0) AS "totalAsinsDedup",
    coalesce(asin_groups."brokenAsinsDedup",0) AS "brokenAsinsDedup"
    FROM global_metrics LEFT JOIN asin_groups USING(group_key,group_label)
    ORDER BY group_key ASC,group_label ASC`;
}

/** Complete SQL metric aggregation. Base provides group_key, group_label,
 * asin_key, integer check_count/broken_count/has_peak and bucket_hours from the
 * helper above. It must remain a composable SELECT so coverage and consumption
 * share one snapshot. Do not replace this with the JS raw-row finalizer.
 *
 * MySQL's temporary-table GROUP BY stores every accumulator update at scales
 * 4 and 8. Round each term before summing: rounding only the final sum changes
 * duplicate-ASIN buckets (two 2-second buckets become 0.0012, not 0.0011).
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
      sum(round(base.bucket_hours,4)) AS total_duration_hours,
      sum(round(${abnormal},8)) AS abnormal_duration_hours,
      sum(CASE WHEN base.has_peak=1 THEN round(base.bucket_hours,4) ELSE 0 END) AS peak_duration_hours,
      sum(CASE WHEN base.has_peak=1 THEN round(${abnormal},8) ELSE 0 END) AS peak_abnormal_duration_hours,
      sum(CASE WHEN base.has_peak=0 THEN round(base.bucket_hours,4) ELSE 0 END) AS low_duration_hours,
      sum(CASE WHEN base.has_peak=0 THEN round(${abnormal},8) ELSE 0 END) AS low_abnormal_duration_hours,
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
