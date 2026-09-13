import { sql, type SQL } from 'drizzle-orm';
import {
  validateMonitorAnalyticsQuery,
  type MonitorAnalyticsQuery,
} from '../domain/monitor-analytics-query';

/** Compose with the interval SELECT so the proof and rows share its snapshot.
 * Imported rows, late updates/deletes, failed or concurrent rebuilds remain
 * uncovered. A completed receipt replaces Legacy's watermark-only assumption.
 */
export function monitorIntervalCoverageSelect(
  query: MonitorAnalyticsQuery,
): SQL {
  validateMonitorAnalyticsQuery(query);
  const country =
    query.country === 'EU'
      ? sql`rtrim(country) COLLATE public.neo_import_group_ci IN ('UK','DE','FR','IT','ES')`
      : query.country
      ? sql`rtrim(country) COLLATE public.neo_import_group_ci = rtrim(${query.country}::text)`
      : sql`true`;
  return sql`
    WITH RECURSIVE source_relations(oid) AS (
      SELECT 'public.monitor_history'::regclass::oid
      UNION ALL SELECT i.inhrelid FROM pg_catalog.pg_inherits i
        JOIN source_relations parent ON parent.oid = i.inhparent
    ), expected_triggers(oid, name, kind, function_id) AS (
      SELECT oid, 'trg_monitor_interval_source_dirty', 29, 'public.neo_queue_monitor_interval()'::regprocedure::oid FROM source_relations
      UNION ALL SELECT 'public.monitor_history'::regclass::oid, 'trg_monitor_interval_source_truncate', 34, 'public.neo_queue_monitor_interval_truncate()'::regprocedure::oid
      UNION ALL SELECT 'public.monitor_history_status_interval'::regclass::oid, 'trg_monitor_interval_projection_dirty', 29, 'public.neo_queue_monitor_interval()'::regprocedure::oid
      UNION ALL SELECT 'public.monitor_history_status_interval'::regclass::oid, 'trg_monitor_interval_projection_truncate', 34, 'public.neo_queue_monitor_interval_truncate()'::regprocedure::oid
    ), receipts AS MATERIALIZED (
      SELECT * FROM public.monitor_interval_dirty WHERE ${country}
    )
    SELECT (
      EXISTS (SELECT 1 FROM public.monitor_interval_projection WHERE singleton AND version = 1)
      AND NOT EXISTS (
        SELECT 1 FROM expected_triggers e WHERE NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = e.oid
            AND t.tgname = e.name AND t.tgtype = e.kind AND t.tgfoid = e.function_id
            AND t.tgenabled IN ('O','A') AND t.tgqual IS NULL
        )
      )
      AND NOT EXISTS (SELECT 1 FROM receipts WHERE completed_revision <> revision)
      AND NOT EXISTS (
        SELECT 1 FROM receipts CROSS JOIN LATERAL unnest(source_relation_ids) relation_id
        WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = relation_id::oid)
      )
      AND EXISTS (SELECT 1 FROM receipts WHERE active AND first_check_time IS NOT NULL AND last_check_time IS NOT NULL)
      AND ${
        query.startTime
          ? sql`(SELECT min(first_check_time) FROM receipts WHERE active) <= ${query.startTime}::timestamp`
          : sql`true`
      }
      AND ${
        query.endTime
          ? sql`${query.endTime}::timestamp <= (SELECT max(last_check_time) FROM receipts WHERE active) + interval '120 minutes'`
          : sql`true`
      }
      -- Legacy's case-insensitive interval PK can collide with its case-sensitive
      -- JS state keys. Use raw buckets for those ambiguous historical identities.
      AND NOT EXISTS (
        SELECT 1 FROM public.monitor_interval_dirty WHERE active
        GROUP BY rtrim(asin_key) COLLATE public.neo_import_group_ci,
          rtrim(country) COLLATE public.neo_import_group_ci HAVING count(*) > 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.monitor_interval_dirty WHERE active
        GROUP BY asin_key || '|' || country HAVING count(*) > 1
      )
    ) AS covered
  `;
}
