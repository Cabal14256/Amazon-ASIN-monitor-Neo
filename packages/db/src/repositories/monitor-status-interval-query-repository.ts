import type {
  MonitorStatusIntervalData,
  MonitorStatusIntervalRecord,
} from '@asin-monitor/contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { parseMonitorAnalyticsQuery } from '../domain/monitor-analytics-query';
import {
  MonitorStatusIntervalQueryError,
  validateMonitorStatusIntervalQuery,
  type MonitorStatusIntervalReadQuery,
} from '../domain/monitor-status-interval-query';
import { monitorIntervalCoverageSelect } from './monitor-interval-coverage';

const MAX_INTERVAL_RESPONSE_BYTES = 8 * 1024 * 1024;
const ci = (expression: SQL) =>
  sql`rtrim(${expression}) COLLATE public.neo_import_group_ci`;

const nullableText = (value: unknown): string | null => {
  if (value === null || typeof value === 'string') return value;
  throw new MonitorStatusIntervalQueryError('invalid-result');
};

function intervalRecord(value: unknown): MonitorStatusIntervalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MonitorStatusIntervalQueryError('invalid-result');
  const row = value as Record<string, unknown>;
  const asinKey = row.asin_key;
  const country = row.country;
  const intervalStart = row.interval_start;
  const isBroken = row.is_broken;
  if (
    typeof asinKey !== 'string' ||
    !asinKey ||
    typeof country !== 'string' ||
    !country ||
    typeof intervalStart !== 'string' ||
    !intervalStart ||
    typeof isBroken !== 'boolean'
  )
    throw new MonitorStatusIntervalQueryError('invalid-result');
  return {
    asinKey,
    asinId: nullableText(row.asin_id),
    asinCode: nullableText(row.asin_code),
    asinName: nullableText(row.asin_name),
    country,
    variantGroupId: nullableText(row.variant_group_id),
    variantGroupName: nullableText(row.variant_group_name),
    intervalStart,
    intervalEnd: nullableText(row.interval_end),
    isBroken,
  };
}

const safeCount = (value: unknown): number => {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new MonitorStatusIntervalQueryError('invalid-result');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new MonitorStatusIntervalQueryError('invalid-result');
  return result;
};

function filters(query: MonitorStatusIntervalReadQuery): SQL {
  const conditions: SQL[] = [
    sql`si.interval_start < ${query.endTime}::timestamp`,
    sql`coalesce(si.interval_end, ${query.endTime}::timestamp) > ${query.startTime}::timestamp`,
  ];
  if (query.country)
    conditions.push(
      query.country.toUpperCase() === 'EU'
        ? sql`${ci(sql`si.country`)} IN ('UK','DE','FR','IT','ES')`
        : sql`${ci(sql`si.country`)} = rtrim(${query.country}::text)`,
    );
  if (query.variantGroupId)
    conditions.push(
      sql`${ci(sql`si.variant_group_id`)} = rtrim(${
        query.variantGroupId
      }::text)`,
    );
  if (query.asinId)
    conditions.push(sql`${ci(sql`si.asin_id`)} = rtrim(${query.asinId}::text)`);
  return sql.join(conditions, sql` AND `);
}

export interface MonitorStatusIntervalQueryUnit {
  listStatusIntervals(
    query: MonitorStatusIntervalReadQuery,
  ): Promise<MonitorStatusIntervalData>;
}

export async function readMonitorStatusIntervals(
  db: Db,
  query: MonitorStatusIntervalReadQuery,
  ensureOpen: () => void,
): Promise<MonitorStatusIntervalData> {
  validateMonitorStatusIntervalQuery(query);
  ensureOpen();
  await db.execute(sql`SET LOCAL search_path TO pg_catalog, public`);
  await db.execute(sql`SET LOCAL statement_timeout = 5000`);
  const coverageQuery = parseMonitorAnalyticsQuery(
    'abnormal-duration-statistics',
    {
      ...(query.country
        ? {
            country:
              query.country.toUpperCase() === 'EU' ? 'EU' : query.country,
          }
        : {}),
      startTime: query.startTime,
      endTime: query.endTime,
    },
  );
  const offset = (query.current - 1) * query.pageSize;
  const response = await db.execute(sql`
    WITH coverage AS MATERIALIZED (${monitorIntervalCoverageSelect(
      coverageQuery,
    )}),
    matched AS MATERIALIZED (
      SELECT si.asin_key, si.asin_id, si.asin_code, si.asin_name, si.country,
        si.variant_group_id, si.variant_group_name,
        to_char(si.interval_start, 'YYYY-MM-DD HH24:MI:SS') AS interval_start,
        to_char(si.interval_end, 'YYYY-MM-DD HH24:MI:SS') AS interval_end,
        si.is_broken
      FROM public.monitor_history_status_interval si
      WHERE ${filters(query)}
    ), page AS MATERIALIZED (
      SELECT * FROM matched
      WHERE (SELECT covered FROM coverage)
      ORDER BY country, asin_key, interval_start
      LIMIT ${query.pageSize} OFFSET ${offset}
    )
    SELECT (SELECT covered FROM coverage) AS covered,
      CASE WHEN (SELECT covered FROM coverage)
        THEN (SELECT count(*)::text FROM matched) ELSE '0' END AS total,
      CASE WHEN (SELECT covered FROM coverage)
        THEN COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.country, page.asin_key, page.interval_start) FROM page), '[]'::jsonb)
        ELSE '[]'::jsonb END AS records
  `);
  ensureOpen();
  const row = response.rows[0] as Record<string, unknown> | undefined;
  if (!row || typeof row.covered !== 'boolean' || !Array.isArray(row.records))
    throw new MonitorStatusIntervalQueryError('invalid-result');
  const encoded = JSON.stringify(row.records);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_INTERVAL_RESPONSE_BYTES)
    throw new MonitorStatusIntervalQueryError('too-large');
  const coverage = row.covered ? 'complete' : 'stale';
  if (coverage === 'stale')
    return {
      list: [],
      total: 0,
      current: query.current,
      pageSize: query.pageSize,
      coverage,
    };
  const list = row.records.map(intervalRecord);
  if (list.length > query.pageSize)
    throw new MonitorStatusIntervalQueryError('invalid-result');
  return {
    list,
    total: safeCount(row.total),
    current: query.current,
    pageSize: query.pageSize,
    coverage,
  };
}
