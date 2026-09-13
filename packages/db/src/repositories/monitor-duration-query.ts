import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { MonitorAnalyticsResultLimitError } from '../domain/monitor-abnormal-duration';
import {
  MonitorAnalyticsQueryError,
  validateMonitorAnalyticsQuery,
  type MonitorAnalyticsQuery,
} from '../domain/monitor-analytics-query';
import {
  getMonitorDurationSourceGranularity,
  type MonitorGranularity,
  type MonitorSourceGranularity,
} from '../domain/monitor-calendar';
import {
  createDurationMetricsAccumulator,
  finalizeDurationMetrics,
  normalizeSqlDurationMetricRow,
} from '../domain/monitor-duration';
import type { MonitorDurationSourceRow } from '../domain/monitor-duration-groups';
import { MonitorDurationStream } from '../domain/monitor-duration-stream';
import { monitorAggregateDurationSelect } from './monitor-analytics-aggregate-query';
import {
  consumeMonitorAnalyticsRows,
  isMonitorAggregateDefinitionFailure,
} from './monitor-analytics-cursor';
import {
  monitorCountStatisticsSelect,
  monitorRawDurationSourceSelect,
} from './monitor-analytics-sql';

const supported = new Set([
  'statistics',
  'by-time',
  'analytics-monthly-breakdown',
  'all-countries-summary',
  'region-summary',
  'asin-by-country',
  'asin-by-variant-group',
]);
const regionNames: Record<string, string> = {
  US: '美国',
  EU_TOTAL: '欧洲汇总',
  UK: '英国',
  DE: '德国',
  FR: '法国',
  ES: '西班牙',
  IT: '意大利',
};
const european = new Set(['UK', 'DE', 'FR', 'ES', 'IT']);
type Row = Record<string, unknown>;
export interface MonitorDurationQueryResult {
  data: Row | Row[];
  source: 'raw' | 'agg' | 'agg:day-fallback';
}
export interface MonitorDurationQueryOptions {
  aggregateEnabled: boolean;
  onAggregateFallback: (reason: 'coverage' | 'definition') => void;
}
function safeCount(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new MonitorAnalyticsQueryError('invalid-result');
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new MonitorAnalyticsQueryError('invalid-result');
  return count;
}
function countsPayload(): SQL {
  // JSON numbers would silently lose precision before the result validator.
  return sql`jsonb_build_object('total_checks',counts.total_checks::text,
    'broken_count',counts.broken_count::text,'normal_count',counts.normal_count::text,
    'group_count',counts.group_count::text,'asin_count',counts.asin_count::text)`;
}
function rootResult(counts: Row | undefined, metrics: Row = {}): Row {
  if (!counts) throw new MonitorAnalyticsQueryError('invalid-result');
  const sum = (value: unknown) =>
    value === null ? 0 : String(safeCount(value));
  return {
    totalChecks: safeCount(counts.total_checks),
    brokenCount: sum(counts.broken_count),
    normalCount: sum(counts.normal_count),
    groupCount: safeCount(counts.group_count),
    asinCount: safeCount(counts.asin_count),
    totalDurationHours: metrics.totalDurationHours || 0,
    abnormalDurationHours: metrics.abnormalDurationHours || 0,
    normalDurationHours: metrics.normalDurationHours || 0,
    ratioAllAsin: metrics.ratioAllAsin || 0,
    ratioAllTime: metrics.ratioAllTime || 0,
  };
}
function decodeCounts(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MonitorAnalyticsQueryError('invalid-result');
  return value as Row;
}
function ranked(rows: Row[]) {
  return rows.sort(
    (a, b) =>
      Number(b.abnormalDurationHours) - Number(a.abnormalDurationHours) ||
      Number(b.ratioAllTime) - Number(a.ratioAllTime),
  );
}
function finishRows(
  query: MonitorAnalyticsQuery,
  rows: Row[],
  counts?: Row,
): Row | Row[] {
  const operation = query.operation;
  if (operation === 'statistics') return rootResult(counts, rows[0]);
  const timeRange =
    query.startTime && query.endTime
      ? `${query.startTime} ~ ${query.endTime}`
      : '';
  if (operation === 'all-countries-summary')
    return { timeRange, ...normalizeSqlDurationMetricRow(rows[0] || {}) };
  if (operation === 'region-summary') {
    const empty = finalizeDurationMetrics(createDurationMetricsAccumulator());
    const byRegion = new Map(rows.map((row) => [row.regionCode, row]));
    return Object.entries(regionNames).map(([regionCode, region]) => ({
      region,
      regionCode,
      timeRange,
      ...empty,
      ...(byRegion.get(regionCode) || {}),
    }));
  }
  if (operation === 'by-time' || operation === 'analytics-monthly-breakdown')
    return rows.map((row) => ({
      ...row,
      total_asins: row.totalAsinsDedup,
      broken_asins: row.brokenAsinsDedup,
      asin_broken_rate: row.ratioAllAsin,
      normal_count: Math.max(
        0,
        Number(row.totalChecks) - Number(row.brokenCount),
      ),
    }));
  return ranked(
    rows.map((row) => ({
      ...row,
      total_checks: row.totalChecks,
      broken_count: row.brokenCount,
      normal_count: Math.max(
        0,
        Number(row.totalChecks) - Number(row.brokenCount),
      ),
    })),
  ).slice(0, operation === 'asin-by-variant-group' ? query.limit : undefined);
}
function aggregateRow(row: Row, operation: string): Row {
  const extra =
    operation === 'region-summary'
      ? { regionCode: row.group_label }
      : operation === 'asin-by-country'
      ? { country: row.group_key }
      : operation === 'asin-by-variant-group'
      ? {
          variant_group_id: row.group_key,
          variant_group_name: row.group_label,
          country: row.country,
        }
      : operation === 'by-time' || operation === 'analytics-monthly-breakdown'
      ? { time_period: row.group_label }
      : {};
  const metrics = normalizeSqlDurationMetricRow(row, extra);
  for (const [key, value] of Object.entries(
    normalizeSqlDurationMetricRow(row),
  )) {
    if (!Number.isFinite(value) || value < 0)
      throw new MonitorAnalyticsQueryError('invalid-result');
    if (
      [
        'totalChecks',
        'brokenCount',
        'totalAsinsDedup',
        'brokenAsinsDedup',
      ].includes(key)
    )
      safeCount(value);
  }
  return metrics;
}
/** Internal data reader. Caller owns an exclusive transaction, authorization
 * locks, absolute deadline and admission slot for the entire operation.
 * Statistics counts and duration share a SELECT snapshot on both paths.
 * A failed aggregate cursor is rolled back before a fresh raw accumulator.
 */
export async function readMonitorDurationQuery(
  db: Db,
  query: MonitorAnalyticsQuery,
  ensureOpen: () => void,
  options: MonitorDurationQueryOptions,
): Promise<MonitorDurationQueryResult> {
  validateMonitorAnalyticsQuery(query);
  if (!supported.has(query.operation))
    throw new MonitorAnalyticsQueryError('input');
  ensureOpen();
  const root = query.operation === 'statistics',
    variant = query.operation === 'asin-by-variant-group';
  const period =
    query.operation === 'by-time' ||
    query.operation === 'analytics-monthly-breakdown';
  const target = (
    query.operation === 'by-time'
      ? query.groupBy
      : query.timeSlotGranularity || 'day'
  ) as MonitorGranularity;
  const granularity =
    query.operation === 'analytics-monthly-breakdown'
      ? 'day'
      : getMonitorDurationSourceGranularity(
          target,
          query.startTime,
          query.endTime,
        );
  const attemptAggregate = async (source: MonitorSourceGranularity) => {
    let select = monitorAggregateDurationSelect(query, source);
    if (root)
      select = sql`SELECT ${countsPayload()} AS statistics_counts, metrics.*
      FROM (${monitorCountStatisticsSelect(
        query,
      )}) counts CROSS JOIN (${select}) metrics`;
    if (
      query.operation === 'by-time' ||
      query.operation === 'analytics-monthly-breakdown'
    )
      select = sql`SELECT metrics.*, EXISTS(SELECT 1 FROM public.monitor_history mh WHERE
        ${
          query.startTime
            ? sql`mh.check_time>=${query.startTime}::timestamp`
            : sql`true`
        } AND
        ${
          query.endTime
            ? sql`mh.check_time<=${query.endTime}::timestamp`
            : sql`true`
        }) AS has_history
        FROM (${select}) metrics`;
    const rows: Row[] = [];
    let covered = false,
      hasHistory = false,
      counts: Row | undefined;
    try {
      await consumeMonitorAnalyticsRows(
        db,
        select,
        (batch) => {
          for (const row of batch) {
            if (typeof row.covered !== 'boolean')
              throw new MonitorAnalyticsQueryError('invalid-result');
            covered = row.covered;
            hasHistory = row.has_history === true;
            if (root) counts = decodeCounts(row.statistics_counts);
            if (covered && row.group_key !== null)
              rows.push(aggregateRow(row, query.operation));
            if (rows.length > 5000)
              throw new MonitorAnalyticsResultLimitError();
          }
        },
        ensureOpen,
        5001,
      );
    } catch (error) {
      if (!isMonitorAggregateDefinitionFailure(error)) throw error;
      options.onAggregateFallback('definition');
      return null;
    }
    if (!covered || (period && !rows.length && hasHistory)) {
      options.onAggregateFallback('coverage');
      return null;
    }
    return finishRows(query, rows, counts);
  };
  if (options.aggregateEnabled && !(root && query.checkType === 'GROUP')) {
    const data = await attemptAggregate(granularity);
    if (data !== null) return { data, source: 'agg' };
    // Legacy accepts 23:59:any-second as an aligned end and ignores millis.
    if (
      query.operation === 'by-time' &&
      granularity === 'hour' &&
      target === 'day' &&
      query.startTime &&
      query.endTime &&
      query.endTime >= query.startTime &&
      query.startTime.slice(11, 19) === '00:00:00' &&
      query.endTime.slice(11, 16) === '23:59'
    ) {
      const fallback = await attemptAggregate('day');
      if (fallback !== null)
        return { data: fallback, source: 'agg:day-fallback' };
    }
  }
  const region = query.operation === 'region-summary';
  const groupKey = (time: string, row: MonitorDurationSourceRow) =>
    period
      ? time
      : variant
      ? row.variant_group_id
      : query.operation === 'asin-by-country'
      ? row.country
      : region
      ? Object.hasOwn(regionNames, String(row.country || '').toUpperCase()) &&
        row.country?.toUpperCase() !== 'EU_TOTAL'
        ? row.country?.toUpperCase()
        : ''
      : 'ALL';
  const stream = new MonitorDurationStream<MonitorDurationSourceRow, Row>({
    sourceGranularity: granularity,
    targetGranularity: target,
    ...query,
    periodScoped: period,
    buildGroupKey: groupKey,
    buildGroupMeta: (time, row) =>
      period
        ? { time_period: time }
        : variant
        ? {
            variant_group_id: row.variant_group_id || '',
            variant_group_name: row.variant_group_name || '',
            country: row.country || '',
          }
        : query.operation === 'asin-by-country'
        ? { country: row.country || '' }
        : region
        ? { regionCode: String(row.country || '').toUpperCase() }
        : {},
  });
  const eu = region
    ? new MonitorDurationStream<MonitorDurationSourceRow, Row>({
        sourceGranularity: granularity,
        targetGranularity: target,
        ...query,
        buildGroupKey: () => 'EU_TOTAL',
        buildGroupMeta: () => ({ regionCode: 'EU_TOTAL' }),
      })
    : undefined;
  let select = monitorRawDurationSourceSelect(
    query,
    root ? 'asin' : variant ? 'variant_group' : 'dim',
    granularity,
  );
  if (root)
    select = sql`SELECT ${countsPayload()} AS statistics_counts,
    NULL::text AS slot_period,NULL::text AS country,NULL::text AS asin_key,
    NULL::bigint AS total_checks,NULL::bigint AS broken_count,NULL::int AS has_peak
    FROM (${monitorCountStatisticsSelect(query)}) counts
    UNION ALL SELECT NULL::jsonb,source.slot_period,source.country,source.asin_key,
      source.total_checks,source.broken_count,source.has_peak FROM (${select}) source
      ${query.checkType === 'GROUP' ? sql`WHERE false` : sql``}`;
  let counts: Row | undefined;
  await consumeMonitorAnalyticsRows(
    db,
    select,
    (batch) => {
      const rows: MonitorDurationSourceRow[] = [];
      for (const row of batch) {
        if (root && row.statistics_counts !== null) {
          if (counts) throw new MonitorAnalyticsQueryError('invalid-result');
          counts = decodeCounts(row.statistics_counts);
        } else {
          safeCount(row.total_checks);
          safeCount(row.broken_count);
          if (typeof row.slot_period !== 'string')
            throw new MonitorAnalyticsQueryError('invalid-result');
          rows.push(row as MonitorDurationSourceRow);
        }
      }
      stream.add(rows);
      eu?.add(
        rows.filter((row) =>
          european.has(String(row.country || '').toUpperCase()),
        ),
      );
    },
    ensureOpen,
  );
  let rows: Row[] = [...stream.finish(), ...(eu?.finish() || [])];
  if (variant)
    rows = rows.filter(
      (row) => row.variant_group_id && Number(row.abnormalDurationHours) > 0,
    );
  return { data: finishRows(query, rows, counts), source: 'raw' };
}
