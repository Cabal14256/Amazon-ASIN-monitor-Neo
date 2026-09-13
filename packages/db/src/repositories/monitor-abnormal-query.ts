import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import {
  MonitorAbnormalBucketStream,
  MonitorStatusIntervalStream,
} from '../domain/monitor-abnormal-duration';
import {
  MonitorAnalyticsQueryError,
  validateMonitorAnalyticsQuery,
  type MonitorAnalyticsQuery,
} from '../domain/monitor-analytics-query';
import {
  formatMonitorSqlDate,
  parseMonitorDate,
} from '../domain/monitor-calendar';
import {
  consumeMonitorAnalyticsRows,
  isMonitorAggregateDefinitionFailure,
} from './monitor-analytics-cursor';
import { monitorAbnormalBucketsSelect } from './monitor-analytics-sql';
import { monitorIntervalCoverageSelect } from './monitor-interval-coverage';

const ci = (expression: SQL) =>
  sql`rtrim(${expression}) COLLATE public.neo_import_group_ci`;
const equal = (expression: SQL, value: string) =>
  sql`${ci(expression)} = rtrim(${value}::text)`;
const nonempty = (expression: SQL) =>
  sql`CASE WHEN nullif(rtrim(${expression}), '') IS NOT NULL THEN ${expression} END`;

/** Observed interval snapshots treat both NULL and empty strings as absent.
 * The raw bucket query intentionally keeps its different NULL-only behavior.
 * This SELECT is internal; the reader must compose the receipt proof with it.
 */
export function monitorAbnormalIntervalsSelect(
  query: MonitorAnalyticsQuery,
  now = new Date(),
): SQL {
  validateMonitorAnalyticsQuery(query);
  if (
    query.operation !== 'abnormal-duration-statistics' ||
    !Number.isFinite(now.getTime())
  )
    throw new MonitorAnalyticsQueryError('input');
  const end = query.endTime ?? formatMonitorSqlDate(now);
  const asin = sql`coalesce(${nonempty(sql`si.asin_code`)}, a.asin)`;
  const where = [
    sql`si.interval_start < ${end}::timestamp`,
    sql`coalesce(si.interval_end, ${end}::timestamp) > ${
      query.startTime ?? '1970-01-01 00:00:00'
    }::timestamp`,
  ];
  if (query.variantGroupId)
    where.push(equal(sql`si.variant_group_id`, query.variantGroupId));
  for (const [column, values] of [
    [sql`si.asin_id`, query.asinIds],
    [asin, query.asinCodes],
  ] as const)
    if (values?.length)
      where.push(
        sql`${ci(column)} IN (${sql.join(
          values.map((value) => sql`rtrim(${value}::text)`),
          sql`, `,
        )})`,
      );
  if (query.asinName)
    where.push(
      sql`public.neo_monitor_like(coalesce(${nonempty(
        sql`si.asin_name`,
      )}, a.name, ''), ${`%${query.asinName}%`})`,
    );
  if (query.variantGroupName)
    where.push(
      sql`public.neo_monitor_like(coalesce(${nonempty(
        sql`si.variant_group_name`,
      )}, vg.name, ''), ${`%${query.variantGroupName}%`})`,
    );
  if (query.asinType === '1' || query.asinType === 'MAIN_LINK')
    where.push(sql`${ci(sql`a.asin_type`)} IN ('1','MAIN_LINK')`);
  else if (query.asinType === '2' || query.asinType === 'SUB_REVIEW')
    where.push(sql`${ci(sql`a.asin_type`)} IN ('2','SUB_REVIEW')`);
  else if (query.asinType) where.push(equal(sql`a.asin_type`, query.asinType));
  if (query.country)
    where.push(
      query.country === 'EU'
        ? sql`${ci(sql`si.country`)} IN ('UK','DE','FR','IT','ES')`
        : equal(sql`si.country`, query.country),
    );
  return sql`SELECT si.asin_key, si.asin_id, ${asin} AS asin,
    coalesce(${nonempty(sql`si.asin_name`)}, a.name, coalesce(${nonempty(
    sql`si.asin_code`,
  )}, 'ID#' || si.asin_id)) AS asin_name,
    si.country, si.variant_group_id, coalesce(${nonempty(
      sql`si.variant_group_name`,
    )}, vg.name, '') AS variant_group_name,
    to_char(si.interval_start, 'YYYY-MM-DD HH24:MI:SS') AS interval_start,
    to_char(si.interval_end, 'YYYY-MM-DD HH24:MI:SS') AS interval_end,
    si.is_broken::integer AS is_broken
    FROM public.monitor_history_status_interval si
    LEFT JOIN public.asins a ON ${ci(sql`a.id`)} = ${ci(sql`si.asin_id`)}
    LEFT JOIN public.variant_groups vg ON ${ci(sql`vg.id`)} = ${ci(
    sql`si.variant_group_id`,
  )}
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${ci(sql`si.country`)}, ${ci(
    sql`si.asin_key`,
  )}, si.interval_start`;
}
const nullableText = (value: unknown): string | null => {
  if (value === null || typeof value === 'string') return value;
  throw new MonitorAnalyticsQueryError('invalid-result');
};
const count = (value: unknown): number => {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new MonitorAnalyticsQueryError('invalid-result');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new MonitorAnalyticsQueryError('invalid-result');
  return number;
};
export interface MonitorAbnormalQueryOptions {
  intervalEnabled: boolean;
  onIntervalFallback: (reason: 'coverage' | 'definition') => void;
}
export async function readMonitorAbnormalQuery(
  db: Db,
  query: MonitorAnalyticsQuery,
  ensureOpen: () => void,
  options: MonitorAbnormalQueryOptions,
  now = new Date(),
) {
  validateMonitorAnalyticsQuery(query);
  if (query.operation !== 'abnormal-duration-statistics')
    throw new MonitorAnalyticsQueryError('input');
  ensureOpen();
  if (options.intervalEnabled && query.startTime && query.endTime) {
    try {
      const state = new MonitorStatusIntervalStream(query, now);
      let covered = false;
      await consumeMonitorAnalyticsRows(
        db,
        sql`
        WITH coverage AS MATERIALIZED (${monitorIntervalCoverageSelect(query)})
        SELECT coverage.covered, intervals.* FROM coverage LEFT JOIN LATERAL (
          SELECT source.* FROM (${monitorAbnormalIntervalsSelect(
            query,
            now,
          )}) source
          WHERE (SELECT covered FROM coverage)
        ) intervals ON coverage.covered
        ORDER BY ${ci(sql`intervals.country`)}, ${ci(
          sql`intervals.asin_key`,
        )}, intervals.interval_start
      `,
        (rows) => {
          for (const row of rows) {
            if (typeof row.covered !== 'boolean')
              throw new MonitorAnalyticsQueryError('invalid-result');
            covered = row.covered;
            if (!covered || row.interval_start === null) continue;
            const start = nullableText(row.interval_start),
              end = nullableText(row.interval_end);
            if (
              !parseMonitorDate(start) ||
              (end && !parseMonitorDate(end)) ||
              ![0, 1].includes(count(row.is_broken))
            )
              throw new MonitorAnalyticsQueryError('invalid-result');
            state.add([
              {
                asin_id: nullableText(row.asin_id),
                asin_key: nullableText(row.asin_key),
                asin: nullableText(row.asin),
                country: nullableText(row.country),
                interval_start: start,
                interval_end: end,
                is_broken: count(row.is_broken),
              },
            ]);
          }
        },
        ensureOpen,
      );
      if (covered) return { data: state.finish(), source: 'interval' as const };
      options.onIntervalFallback('coverage');
    } catch (error) {
      if (!isMonitorAggregateDefinitionFailure(error)) throw error;
      options.onIntervalFallback('definition');
    }
  }
  const state = new MonitorAbnormalBucketStream(query);
  await consumeMonitorAnalyticsRows(
    db,
    monitorAbnormalBucketsSelect(query),
    (rows) => {
      for (const row of rows) {
        if (typeof row.time_period !== 'string')
          throw new MonitorAnalyticsQueryError('invalid-result');
        state.add([
          {
            time_period: row.time_period,
            asin_id: nullableText(row.asin_id),
            asin: nullableText(row.asin),
            country: nullableText(row.country),
            total_checks: count(row.total_checks),
            broken_count: count(row.broken_count),
          },
        ]);
      }
    },
    ensureOpen,
  );
  return { data: state.finish(), source: 'raw' as const };
}
