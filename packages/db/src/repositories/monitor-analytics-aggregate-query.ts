import { sql, type SQL } from 'drizzle-orm';
import {
  MonitorAnalyticsQueryError,
  validateMonitorAnalyticsQuery,
  type MonitorAnalyticsQuery,
} from '../domain/monitor-analytics-query';
import type {
  MonitorGranularity,
  MonitorSourceGranularity,
} from '../domain/monitor-calendar';
import { monitorAggregateCoverageSelect } from './monitor-aggregate-coverage';
import {
  monitorAggregateBucketHoursSql,
  monitorAggregateMetricsSelect,
} from './monitor-analytics-metrics-sql';
import {
  monitorAggregateSourceSelect,
  monitorPeriodSql,
} from './monitor-analytics-sql';

const operations = new Set([
  'statistics',
  'by-time',
  'analytics-monthly-breakdown',
  'all-countries-summary',
  'region-summary',
  'asin-by-country',
  'asin-by-variant-group',
]);

/** Runtime aggregate query: the proof, source and result are in ONE statement.
 * A false proof returns a covered=false sentinel. A covered empty query returns
 * covered=true with group_key=NULL. The repository can distinguish the two
 * without a second read and can discard a failed attempt before raw fallback.
 * At most 5001 metric rows are transferred; callers reject the overflow row.
 */
export function monitorAggregateDurationSelect(
  query: MonitorAnalyticsQuery,
  granularity: MonitorSourceGranularity,
): SQL {
  validateMonitorAnalyticsQuery(query);
  if (!operations.has(query.operation))
    throw new MonitorAnalyticsQueryError('input');
  const variant = query.operation === 'asin-by-variant-group';
  const family = variant ? 'variant_group' : 'asin';
  const compatible =
    query.operation !== 'statistics' ||
    (!query.asinId &&
      !query.variantGroupId &&
      (!query.checkType || query.checkType === 'ASIN'));
  const coverage = compatible
    ? monitorAggregateCoverageSelect(query, family, granularity)
    : sql`SELECT false AS covered`;
  const hours = monitorAggregateBucketHoursSql(
    query,
    granularity,
    sql`agg.time_slot`,
  );
  const source = sql`SELECT agg.*, ${
    query.operation === 'region-summary' ? sql`round(${hours},4)` : hours
  } AS bucket_hours
    FROM (${monitorAggregateSourceSelect(query, family, granularity)}) agg
    WHERE (SELECT covered FROM coverage)`;
  const values = sql`agg.asin_key, agg.total_checks AS check_count, agg.broken_count, agg.has_peak, agg.bucket_hours`;
  let metrics: SQL;
  if (query.operation === 'region-summary') {
    // Legacy UNION ALL materializes its base at the visible DECIMAL(…,4)
    // bucket scale before multiplying by the per-bucket abnormal fraction.
    const base = sql`SELECT agg.country AS group_key, agg.country AS group_label, ${values}
      FROM source_base agg WHERE agg.country IN ('US','UK','DE','FR','ES','IT')
      UNION ALL SELECT 'EU_TOTAL' AS group_key, 'EU_TOTAL' AS group_label, ${values}
      FROM source_base agg WHERE agg.country IN ('UK','DE','FR','ES','IT')`;
    metrics = sql`WITH source_base AS MATERIALIZED (${source})
      SELECT * FROM (${monitorAggregateMetricsSelect(base)}) region_metrics`;
  } else {
    const period =
      query.operation === 'by-time' ||
      query.operation === 'analytics-monthly-breakdown';
    const key = variant
      ? sql`agg.variant_group_id`
      : period
      ? monitorPeriodSql(
          sql`agg.time_slot`,
          query.operation === 'analytics-monthly-breakdown'
            ? 'day'
            : (query.groupBy as MonitorGranularity),
        )
      : query.operation === 'asin-by-country'
      ? sql`agg.country`
      : sql`'ALL'::text`;
    const label = variant
      ? sql`coalesce(nullif(agg.variant_group_name,''),'')`
      : key;
    const base = sql`SELECT ${key} AS group_key, ${label} AS group_label,
      ${
        variant ? sql`coalesce(nullif(agg.country,''),'') AS country,` : sql``
      } ${values}
      FROM (${source}) agg ${
      variant ? sql`WHERE nullif(agg.asin_key,'') IS NOT NULL` : sql``
    }`;
    metrics = monitorAggregateMetricsSelect(
      base,
      variant ? 'variant_group' : 'label',
    );
    if (variant)
      metrics = sql`SELECT * FROM (${metrics}) ranked ORDER BY "abnormalDurationHours" DESC,"ratioAllTime" DESC LIMIT ${query.limit}`;
    else if (query.operation === 'asin-by-country')
      metrics = sql`SELECT * FROM (${metrics}) ranked ORDER BY "abnormalDurationHours" DESC,"ratioAllTime" DESC`;
  }
  return sql`WITH coverage AS MATERIALIZED (${coverage})
    SELECT coverage.covered, result.* FROM coverage
    LEFT JOIN LATERAL (${metrics}) result ON coverage.covered
    ${
      variant || query.operation === 'asin-by-country'
        ? sql`ORDER BY result."abnormalDurationHours" DESC,result."ratioAllTime" DESC`
        : sql`ORDER BY result.group_key ASC,result.group_label ASC`
    }
    LIMIT 5001`;
}
