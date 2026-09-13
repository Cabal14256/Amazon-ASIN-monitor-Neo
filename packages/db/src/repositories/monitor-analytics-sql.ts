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
import type { MonitorAggregateFamily } from './monitor-aggregate-coverage';

// All relations are explicitly public: raw reads and the coverage proof must
// refer to the same hypertable even when a connection has a custom search_path.
const relations = {
  asin: sql`public.monitor_history_agg_v2`,
  dim: sql`public.monitor_history_agg_dim_v2`,
  variant_group: sql`public.monitor_history_agg_variant_group_v2`,
};
const periods: Record<MonitorGranularity, string> = {
  hour: 'YYYY-MM-DD HH24:00:00',
  day: 'YYYY-MM-DD',
  week: 'IYYY-IW',
  month: 'YYYY-MM',
};
const rawSlots = {
  hour: sql`mh.hour_ts`,
  day: sql`mh.day_ts`,
  month: sql`mh.month_ts`,
};
const ci = (expression: SQL) =>
  sql`rtrim(${expression}) COLLATE public.legacy_utf8mb4_unicode_ci`;
const equals = (expression: SQL, value: string) =>
  sql`${ci(expression)} = rtrim(${value}::text)`;
const asinKey = ci(
  sql`coalesce(nullif(rtrim(mh.asin_code), ''), 'ID#' || rtrim(mh.asin_id))`,
);
const asinFilter = sql`${ci(sql`mh.check_type`)} = 'ASIN'
  AND (mh.asin_id IS NOT NULL OR nullif(rtrim(mh.asin_code), '') IS NOT NULL)`;
const groupJoin = sql`LEFT JOIN public.variant_groups vg
  ON rtrim(vg.id) COLLATE public.neo_import_group_ci = rtrim(mh.variant_group_id) COLLATE public.neo_import_group_ci`;

function validateSource(
  family: MonitorAggregateFamily,
  granularity: MonitorSourceGranularity,
) {
  if (
    !Object.hasOwn(relations, family) ||
    !Object.hasOwn(rawSlots, granularity)
  )
    throw new MonitorAnalyticsQueryError('input');
}
export function monitorPeriodSql(
  time: SQL,
  granularity: MonitorGranularity,
): SQL {
  if (!Object.hasOwn(periods, granularity))
    throw new MonitorAnalyticsQueryError('input');
  return sql`to_char(${time}, ${periods[granularity]})`;
}
function countryCondition(column: SQL, country: string): SQL {
  return country === 'EU'
    ? sql`${ci(column)} IN ('UK','DE','FR','IT','ES')`
    : equals(column, country);
}
function rawWhere(query: MonitorAnalyticsQuery): SQL[] {
  const where: SQL[] = [];
  if (query.country)
    where.push(countryCondition(sql`mh.country`, query.country));
  if (query.startTime)
    where.push(sql`mh.check_time >= ${query.startTime}::timestamp`);
  if (query.endTime)
    where.push(sql`mh.check_time <= ${query.endTime}::timestamp`);
  if (query.variantGroupId)
    where.push(equals(sql`mh.variant_group_id`, query.variantGroupId));
  if (query.asinId) where.push(equals(sql`mh.asin_id`, query.asinId));
  return where;
}
const conjunction = (parts: SQL[]) =>
  parts.length ? sql.join(parts, sql` AND `) : sql`true`;

// The extra eight hours are observable Legacy behavior, also pinned in 0001.
// This is distinct from the chart's peak-mark wall-clock display.
function peakSql(): SQL {
  const hour = sql`extract(hour FROM mh.check_time + interval '8 hours')`;
  const country = ci(sql`mh.country`);
  return sql`CASE
    WHEN ${country}='US' THEN (${hour}>=2 AND ${hour}<6) OR (${hour}>=9 AND ${hour}<12)
    WHEN ${country}='UK' THEN ${hour}>=22 OR ${hour}<2 OR (${hour}>=3 AND ${hour}<6)
    WHEN ${country} IN ('DE','FR','ES','IT') THEN ${hour}>=20 OR (${hour}>=2 AND ${hour}<5)
    ELSE false END`;
}

/** Composable grouped SELECT; callers may stream it rather than materialize all
 * ASIN buckets in application memory. Statistics uses asin, other raw duration
 * queries use dim, and ASIN-by-group uses variant_group. */
export function monitorRawDurationSourceSelect(
  query: MonitorAnalyticsQuery,
  family: MonitorAggregateFamily,
  granularity: MonitorSourceGranularity,
): SQL {
  validateMonitorAnalyticsQuery(query);
  validateSource(family, granularity);
  const where = [...rawWhere(query), asinFilter];
  const slot = rawSlots[granularity],
    country = ci(sql`mh.country`);
  const select: SQL[] = [],
    groups: SQL[] = [slot, country, asinKey];
  if (family === 'dim') {
    const site = ci(sql`coalesce(mh.site_snapshot, '')`),
      brand = ci(sql`coalesce(mh.brand_snapshot, '')`);
    select.push(sql`${site} AS site`, sql`${brand} AS brand`);
    groups.push(site, brand);
    if (query.site) where.push(equals(sql`mh.site_snapshot`, query.site));
    if (query.brand) where.push(equals(sql`mh.brand_snapshot`, query.brand));
  }
  if (family === 'variant_group') {
    const id = ci(sql`mh.variant_group_id`),
      name = ci(sql`coalesce(mh.variant_group_name, vg.name)`);
    select.push(
      sql`${id} AS variant_group_id`,
      sql`${name} AS variant_group_name`,
    );
    groups.push(id, name);
    where.push(sql`mh.variant_group_id IS NOT NULL`);
  }
  return sql`SELECT ${monitorPeriodSql(slot, granularity)} AS slot_period,
    ${country} AS country, ${asinKey} AS asin_key,
    ${select.length ? sql`${sql.join(select, sql`, `)},` : sql``}
    count(*) AS total_checks,
    sum(CASE WHEN mh.is_broken IS TRUE THEN 1 ELSE 0 END) AS broken_count,
    bool_or(${peakSql()})::int AS has_peak
    FROM public.monitor_history mh ${
      family === 'variant_group' ? groupJoin : sql``
    }
    WHERE ${conjunction(where)}
    GROUP BY ${sql.join(groups, sql`, `)} ORDER BY ${slot} ASC, ${country} ASC`;
}

/** Internal projection only. A runtime caller MUST combine its consumption with
 * monitorAggregateCoverageSelect in the same statement and use raw on false.
 * Keeping this as SQL lets the repository aggregate or stream without a large
 * json_agg or a separate coverage/read snapshot race. */
export function monitorAggregateSourceSelect(
  query: MonitorAnalyticsQuery,
  family: MonitorAggregateFamily,
  granularity: MonitorSourceGranularity,
): SQL {
  validateMonitorAnalyticsQuery(query);
  validateSource(family, granularity);
  const where = [sql`agg.granularity = ${granularity}`];
  if (query.country)
    where.push(countryCondition(sql`agg.country`, query.country));
  if (query.startTime)
    where.push(
      sql`agg.time_slot >= date_trunc(${granularity}, ${query.startTime}::timestamp)`,
    );
  if (query.endTime)
    where.push(
      sql`agg.time_slot <= date_trunc(${granularity}, ${query.endTime}::timestamp)`,
    );
  if (family === 'dim') {
    if (query.site) where.push(equals(sql`agg.site`, query.site));
    if (query.brand) where.push(equals(sql`agg.brand`, query.brand));
  }
  if (family === 'variant_group')
    where.push(sql`agg.variant_group_id IS NOT NULL`);
  return sql`SELECT agg.time_slot,
    ${monitorPeriodSql(sql`agg.time_slot`, granularity)} AS slot_period,
    agg.country, agg.asin_key,
    ${
      family === 'variant_group'
        ? sql`agg.variant_group_id, agg.variant_group_name,`
        : family === 'dim'
        ? sql`agg.site, agg.brand,`
        : sql`''::text AS site, ''::text AS brand,`
    }
    agg.check_count AS total_checks, agg.broken_count, agg.has_peak::int AS has_peak
    FROM ${relations[family]} agg WHERE ${conjunction(where)}
    ORDER BY agg.time_slot ASC, agg.country ASC, agg.asin_key ASC`;
}

/** Original count statistics include GROUP checks and nullable flags. In
 * particular normal_count excludes NULL rather than total minus broken. */
export function monitorCountStatisticsSelect(
  query: MonitorAnalyticsQuery,
): SQL {
  validateMonitorAnalyticsQuery(query);
  if (
    !['statistics', 'by-country', 'by-variant-group'].includes(query.operation)
  )
    throw new MonitorAnalyticsQueryError('input');
  const where = rawWhere(query);
  if (query.checkType)
    where.push(
      query.checkType === 'ASIN'
        ? asinFilter
        : equals(sql`mh.check_type`, query.checkType),
    );
  const counts = sql`count(*) AS total_checks,
    sum(CASE WHEN mh.is_broken IS TRUE THEN 1 ELSE 0 END) AS broken_count,
    sum(CASE WHEN mh.is_broken IS FALSE THEN 1 ELSE 0 END) AS normal_count`;
  if (query.operation === 'by-country') {
    const country = ci(sql`mh.country`);
    return sql`SELECT ${country} AS country, ${counts} FROM public.monitor_history mh
      WHERE ${conjunction(where)} GROUP BY ${country} ORDER BY ${country} ASC`;
  }
  if (query.operation === 'by-variant-group') {
    const id = ci(sql`mh.variant_group_id`),
      name = ci(sql`vg.name`);
    where.push(sql`mh.variant_group_id IS NOT NULL`);
    return sql`SELECT ${id} AS variant_group_id, ${name} AS variant_group_name, ${counts}
      FROM public.monitor_history mh ${groupJoin} WHERE ${conjunction(where)}
      GROUP BY ${id}, ${name} ORDER BY broken_count DESC, total_checks DESC LIMIT ${
      query.limit
    }`;
  }
  return sql`SELECT ${counts}, count(DISTINCT ${ci(
    sql`mh.variant_group_id`,
  )}) AS group_count,
    count(DISTINCT ${ci(sql`mh.asin_id`)}) AS asin_count
    FROM public.monitor_history mh WHERE ${conjunction(where)}`;
}
