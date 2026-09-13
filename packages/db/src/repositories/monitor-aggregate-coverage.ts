import { sql, type SQL } from 'drizzle-orm';
import {
  MonitorAnalyticsQueryError,
  validateMonitorAnalyticsQuery,
  type MonitorAnalyticsQuery,
} from '../domain/monitor-analytics-query';
import {
  addMonitorGranularity,
  floorMonitorDate,
  formatMonitorSqlDate,
  type MonitorSourceGranularity,
} from '../domain/monitor-calendar';

export type MonitorAggregateFamily = 'asin' | 'dim' | 'variant_group';
// Pinned 0001 view definitions; a changed projection must pass reconciliation
// before it can be used for runtime analytics. Unknown extension versions fall back.
const definitions = {
  asin: {
    hour: 'c8fbca31141d9ff2fd87bb2bc27a23da',
    day: '1b7e82e30be65a827df91d5aa5b040c9',
    month: 'b7e5ab6f505add599994843dafe1b1e2',
  },
  dim: {
    hour: 'fd463ab0f4fd3ee1984f43864b8bd130',
    day: 'f77caf1fe9c24ced94d2e3248847ef3f',
    month: '37c470c8fe8198ada8aeb2b7f3fd6066',
  },
  variant_group: {
    hour: '188e2199865d8f41489bdc08f02ee4b9',
    day: '5ab32fcf37370bc31d3c5940d31c7b38',
    month: 'd23ff17c43d69097626a6232a37b725b',
  },
} as const;

/** Embed this SELECT as a CTE in the SAME statement that reads the CAGG. A
 * separate coverage query followed by an aggregate query has a snapshot race.
 *
 * A materialization watermark alone cannot detect gaps or old data corrections.
 * Timescale 2.29.2 starts with an infinite materialization invalidation and cuts
 * refreshed windows out of it. Check both invalidation logs, the raw threshold,
 * and the CAGG watermark over every requested bucket, including partial edges.
 * Catalog/permission errors must roll back to a savepoint before raw fallback.
 * See upstream 2.29.2/tsl/src/continuous_aggs/README.md and sql/pre_install/tables.sql.
 */
export function monitorAggregateCoverageSelect(
  query: MonitorAnalyticsQuery,
  family: MonitorAggregateFamily,
  granularity: MonitorSourceGranularity,
): SQL {
  validateMonitorAnalyticsQuery(query);
  if (
    !Object.hasOwn(definitions, family) ||
    !['hour', 'day', 'month'].includes(granularity)
  )
    throw new MonitorAnalyticsQueryError('input');
  if (!query.startTime || !query.endTime || query.endTime < query.startTime)
    return sql`SELECT false AS covered`;
  const start = floorMonitorDate(query.startTime, granularity);
  const end = addMonitorGranularity(
    floorMonitorDate(query.endTime, granularity),
    granularity,
  );
  if (!start || !end) return sql`SELECT false AS covered`;
  const startText = formatMonitorSqlDate(start),
    endText = formatMonitorSqlDate(end);
  if (!/^\d{4}-/.test(startText) || !/^\d{4}-/.test(endText))
    return sql`SELECT false AS covered`;
  const name = `monitor_history_cagg_${family}_${granularity}`;
  const digest = definitions[family][granularity];
  // EXTRACT over timestamp (not timestamptz) uses wall-clock epoch seconds.
  // This matches Timescale's timestamp internal microseconds without host/session TZ.
  return sql`
    WITH requested AS (
      SELECT (extract(epoch FROM ${startText}::timestamp)*1000000)::bigint AS first,
        (extract(epoch FROM ${endText}::timestamp)*1000000)::bigint AS after_last
    )
    SELECT EXISTS (
      SELECT 1 FROM _timescaledb_catalog.continuous_agg AS c
      JOIN _timescaledb_catalog.hypertable AS h ON h.id=c.raw_hypertable_id
      JOIN _timescaledb_catalog.continuous_aggs_watermark AS w ON w.mat_hypertable_id=c.mat_hypertable_id
      JOIN _timescaledb_catalog.continuous_aggs_invalidation_threshold AS t ON t.hypertable_id=c.raw_hypertable_id
      JOIN timescaledb_information.continuous_aggregates AS v ON v.view_schema=c.user_view_schema AND v.view_name=c.user_view_name
      CROSS JOIN requested AS r
      WHERE c.user_view_schema='public' AND c.user_view_name=${name}
        AND h.schema_name='public' AND h.table_name='monitor_history'
        AND c.materialized_only AND v.materialized_only
        AND (SELECT extversion FROM pg_extension WHERE extname='timescaledb')='2.29.2'
        AND md5(regexp_replace(v.view_definition,'[[:space:]]+',' ','g'))=${digest}
        AND obj_description(format('%I.%I',c.user_view_schema,c.user_view_name)::regclass,'pg_class')=${`amazon-asin-monitor:cagg-definition:p1-t4a-v2:md5:${digest}`}
        AND w.watermark>=r.after_last AND t.watermark>=r.after_last
        AND NOT EXISTS (
          SELECT 1 FROM _timescaledb_catalog.continuous_aggs_hypertable_invalidation_log AS i
          WHERE i.hypertable_id=c.raw_hypertable_id AND i.lowest_modified_value<r.after_last AND i.greatest_modified_value>=r.first
        )
        AND NOT EXISTS (
          SELECT 1 FROM _timescaledb_catalog.continuous_aggs_materialization_invalidation_log AS i
          WHERE i.materialization_id=c.mat_hypertable_id AND i.lowest_modified_value<r.after_last AND i.greatest_modified_value>=r.first
        )
    ) AS covered
  `;
}
