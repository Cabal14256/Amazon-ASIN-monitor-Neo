import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import {
  MonitorAnalyticsQueryError,
  validateMonitorAnalyticsQuery,
  type MonitorAnalyticsQuery,
} from '../domain/monitor-analytics-query';
import { getMonitorDurationSourceGranularity } from '../domain/monitor-calendar';
import {
  createDurationMetricsAccumulator,
  finalizeDurationMetrics,
} from '../domain/monitor-duration';
import type { MonitorDurationSourceRow } from '../domain/monitor-duration-groups';
import { MonitorDurationStream } from '../domain/monitor-duration-stream';
import { monitorAggregateCoverageSelect } from './monitor-aggregate-coverage';
import {
  consumeMonitorAnalyticsRows,
  isMonitorAggregateDefinitionFailure,
} from './monitor-analytics-cursor';
import {
  monitorAggregateSourceSelect,
  monitorPeriodGroupsSelect,
  monitorRawDurationSourceSelect,
} from './monitor-analytics-sql';
import type {
  MonitorDurationQueryOptions,
  MonitorDurationQueryResult,
} from './monitor-duration-query';

const ci = (value: SQL) =>
  sql`rtrim(${value}) COLLATE public.legacy_utf8mb4_unicode_ci`;
const groupKey = (row: MonitorDurationSourceRow) =>
  [row.country || '', row.site || '', row.brand || ''].join('|');
function count(value: unknown) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  )
    throw new MonitorAnalyticsQueryError('invalid-result');
  return Number(value);
}
/** One SELECT owns proof, group count, page and source buckets. Restrict source
 * rows to requested groups BEFORE their SQL GROUP BY; no full-range bucket
 * array is materialized merely to return one page of at most 100 groups. */
export function monitorPeriodSourceQuery(
  query: MonitorAnalyticsQuery,
  aggregate: boolean,
): SQL {
  validateMonitorAnalyticsQuery(query);
  if (!['period-summary', 'period-summary/details'].includes(query.operation))
    throw new MonitorAnalyticsQueryError('input');
  const detail = query.operation === 'period-summary/details';
  const granularity = getMonitorDurationSourceGranularity(
    query.timeSlotGranularity,
    query.startTime,
    query.endTime,
  );
  const rangeOnly = { ...query };
  delete rangeOnly.country;
  delete rangeOnly.site;
  delete rangeOnly.brand;
  const groups = detail
    ? sql`SELECT ${query.country || ''}::text AS country, ${
        query.site || ''
      }::text AS site, ${query.brand || ''}::text AS brand`
    : monitorPeriodGroupsSelect(
        query,
        aggregate ? 'aggregate' : 'raw',
        granularity,
      );
  const scope = sql`(SELECT covered FROM coverage) AND EXISTS(SELECT 1 FROM requested_groups p WHERE
    ${ci(aggregate ? sql`agg.country` : sql`mh.country`)}=${ci(sql`p.country`)}
    AND ${ci(
      aggregate
        ? sql`coalesce(agg.site,'')`
        : sql`coalesce(mh.site_snapshot,'')`,
    )}=${ci(sql`p.site`)}
    AND ${ci(
      aggregate
        ? sql`coalesce(agg.brand,'')`
        : sql`coalesce(mh.brand_snapshot,'')`,
    )}=${ci(sql`p.brand`)})`;
  const source = aggregate
    ? monitorAggregateSourceSelect(rangeOnly, 'dim', granularity, scope)
    : monitorRawDurationSourceSelect(rangeOnly, 'dim', granularity, scope);
  return sql`WITH coverage AS MATERIALIZED (${
    aggregate
      ? monitorAggregateCoverageSelect(query, 'dim', granularity)
      : sql`SELECT true AS covered`
  }),
    grouped AS MATERIALIZED (SELECT * FROM (${groups}) groups WHERE (SELECT covered FROM coverage)),
    requested_groups AS MATERIALIZED (SELECT row_number() OVER (ORDER BY country,site,brand) AS page_index,
      coalesce(country,'') AS country,coalesce(site,'') AS site,coalesce(brand,'') AS brand FROM grouped
      ORDER BY country,site,brand LIMIT ${detail ? 1 : query.pageSize} OFFSET ${
    detail ? 0 : (query.current! - 1) * query.pageSize!
  }),
    source AS (${source}), header AS (SELECT coverage.covered,(SELECT count(*) FROM grouped) AS total_rows,
      EXISTS(SELECT 1 FROM public.monitor_history mh WHERE
        ${
          query.startTime
            ? sql`mh.check_time>=${query.startTime}::timestamp`
            : sql`true`
        } AND
        ${
          query.endTime
            ? sql`mh.check_time<=${query.endTime}::timestamp`
            : sql`true`
        }) AS has_history FROM coverage)
    SELECT header.*,p.page_index,p.country AS page_country,p.site AS page_site,p.brand AS page_brand,source.*
    FROM header LEFT JOIN requested_groups p ON true LEFT JOIN source ON
      ${ci(sql`source.country`)}=${ci(sql`p.country`)} AND ${ci(
    sql`source.site`,
  )}=${ci(sql`p.site`)} AND ${ci(sql`source.brand`)}=${ci(sql`p.brand`)}
    ORDER BY source.slot_period ASC NULLS FIRST,source.country,source.site,source.brand,source.asin_key,p.page_index`;
}

export async function readMonitorPeriodQuery(
  db: Db,
  query: MonitorAnalyticsQuery,
  ensureOpen: () => void,
  options: MonitorDurationQueryOptions,
): Promise<MonitorDurationQueryResult> {
  validateMonitorAnalyticsQuery(query);
  if (!['period-summary', 'period-summary/details'].includes(query.operation))
    throw new MonitorAnalyticsQueryError('input');
  const detail = query.operation === 'period-summary/details';
  const granularity = getMonitorDurationSourceGranularity(
    query.timeSlotGranularity,
    query.startTime,
    query.endTime,
  );
  const timeRange =
    query.startTime && query.endTime
      ? `${query.startTime} ~ ${query.endTime}`
      : query.startTime || query.endTime || '-';
  const read = async (aggregate: boolean) => {
    const stream = new MonitorDurationStream<
      MonitorDurationSourceRow,
      Record<string, unknown>
    >({
      startTime: query.startTime,
      endTime: query.endTime,
      sourceGranularity: granularity,
      targetGranularity: detail ? query.timeSlotGranularity! : granularity,
      periodScoped: detail,
      buildGroupKey: (time, row) => (detail ? time : groupKey(row)),
      buildGroupMeta: (time, row) =>
        detail
          ? { timeSlot: time }
          : {
              timeRange,
              country: row.country || '',
              site: row.site || '',
              brand: row.brand || '',
            },
    });
    const groups = new Map<
      number,
      { country: string; site: string; brand: string }
    >();
    let covered = false,
      total = 0,
      hasHistory = false,
      sourceRows = 0;
    await consumeMonitorAnalyticsRows(
      db,
      monitorPeriodSourceQuery(query, aggregate),
      (batch) => {
        const source: MonitorDurationSourceRow[] = [];
        for (const row of batch) {
          if (typeof row.covered !== 'boolean')
            throw new MonitorAnalyticsQueryError('invalid-result');
          covered = row.covered;
          total = count(row.total_rows);
          hasHistory = row.has_history === true;
          if (row.page_index !== null) {
            groups.set(count(row.page_index), {
              country: String(row.page_country || ''),
              site: String(row.page_site || ''),
              brand: String(row.page_brand || ''),
            });
            if (groups.size > (detail ? 1 : query.pageSize!))
              throw new MonitorAnalyticsQueryError('invalid-result');
          }
          if (row.slot_period !== null) {
            if (typeof row.slot_period !== 'string')
              throw new MonitorAnalyticsQueryError('invalid-result');
            count(row.total_checks);
            count(row.broken_count);
            sourceRows++;
            source.push(row as MonitorDurationSourceRow);
          }
        }
        stream.add(source);
      },
      ensureOpen,
    );
    if (
      !covered ||
      (aggregate && (detail ? sourceRows === 0 : total === 0 && hasHistory))
    )
      return null;
    const metrics = stream.finish();
    if (detail) return metrics;
    const byGroup = new Map(metrics.map((row) => [groupKey(row), row]));
    const empty = finalizeDurationMetrics(createDurationMetricsAccumulator());
    const list = [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, group]) => ({
        ...(byGroup.get(groupKey(group)) || { timeRange, ...group, ...empty }),
        hasTimeSlotDetails: true,
      }));
    return { list, total, current: query.current!, pageSize: query.pageSize! };
  };
  if (options.aggregateEnabled) {
    try {
      const data = await read(true);
      if (data !== null) return { data, source: 'agg' };
      options.onAggregateFallback('coverage');
    } catch (error) {
      if (!isMonitorAggregateDefinitionFailure(error)) throw error;
      options.onAggregateFallback('definition');
    }
  }
  const data = await read(false);
  if (data === null) throw new MonitorAnalyticsQueryError('invalid-result');
  return { data, source: 'raw' };
}
