import {
  addMonitorGranularity,
  floorMonitorDate,
  formatMonitorPeriod,
  formatMonitorSqlDate,
  getMonitorBucketRange,
  getMonitorDurationBucketHours,
  parseMonitorDate,
  type MonitorGranularity,
} from './monitor-calendar';
import type { SqlMetricValue } from './monitor-duration';

const HOUR = 3_600_000;
const ROW_LIMIT = 50_000;
const PERIOD_LIMIT = 5000;
const WORK_LIMIT = 250_000;
const round = (value: number, digits: number) => Number(value.toFixed(digits));
const clamp = (value: number, max: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0;

export class MonitorAnalyticsResultLimitError extends RangeError {
  constructor() {
    super('Monitor analytics result exceeds limit');
  }
}
export interface MonitorAbnormalQueryRange {
  startTime?: string;
  endTime?: string;
  includeSeries?: '0' | '1';
}
export interface MonitorAbnormalSeriesRow {
  timePeriod: string;
  asinId: string | null;
  asin: string | null;
  country: string | null;
  abnormalDuration: number;
  totalDuration: number;
  abnormalRatio: number;
  brokenCount: number;
  totalChecks: number;
}
export interface MonitorAbnormalSummaryRow {
  key: string;
  asin: string;
  country: string;
  queryTimeRange: string;
  abnormalCount: number;
  averageAbnormalDuration: number;
  minAbnormalDuration: number;
  maxAbnormalDuration: number;
  maxAbnormalTime: string;
}
export interface MonitorAbnormalBucketRow {
  time_period: string;
  asin_id: string | null;
  asin: string | null;
  country: string | null;
  total_checks: SqlMetricValue;
  broken_count: SqlMetricValue;
}
export interface MonitorStatusIntervalRow {
  asin_id: string | null;
  asin_key?: string | null;
  asin?: string | null;
  country?: string | null;
  interval_start: string | null;
  interval_end: string | null;
  is_broken: SqlMetricValue;
}

export function getMonitorAbnormalGranularity({
  startTime,
  endTime,
}: MonitorAbnormalQueryRange): Exclude<MonitorGranularity, 'month'> {
  const start = parseMonitorDate(startTime),
    end = parseMonitorDate(endTime);
  if (!start || !end || end < start) return 'day';
  const hours = (end.getTime() - start.getTime()) / HOUR;
  return hours <= 7 * 24 ? 'hour' : hours <= 30 * 24 ? 'day' : 'week';
}

function periods(
  start: Date | null,
  end: Date | null,
  granularity: MonitorGranularity,
): string[] {
  if (!start || !end || end < start) return [];
  const result: string[] = [];
  let cursor = floorMonitorDate(start, granularity);
  while (cursor && cursor <= end) {
    if (result.length === PERIOD_LIMIT)
      throw new MonitorAnalyticsResultLimitError();
    result.push(formatMonitorPeriod(cursor, granularity));
    cursor = addMonitorGranularity(cursor, granularity);
  }
  return result;
}
type SummaryAccumulator = Omit<
  MonitorAbnormalSummaryRow,
  'averageAbnormalDuration'
> & { totalAbnormalDuration: number };
function addSummary(
  map: Map<string, SummaryAccumulator>,
  meta: { id: string | null; asin: string; country: string },
  query: MonitorAbnormalQueryRange,
  duration: number,
  count: number,
  time: string,
) {
  const key = `${meta.id || meta.asin}-${meta.country}`;
  let summary = map.get(key);
  if (!summary) {
    summary = {
      key,
      asin: meta.asin,
      country: meta.country,
      queryTimeRange:
        query.startTime && query.endTime
          ? `${query.startTime} ~ ${query.endTime}`
          : '-',
      abnormalCount: 0,
      totalAbnormalDuration: 0,
      minAbnormalDuration: Infinity,
      maxAbnormalDuration: 0,
      maxAbnormalTime: '-',
    };
    map.set(key, summary);
  }
  summary.abnormalCount += count;
  summary.totalAbnormalDuration += duration;
  if (count > 0 && duration > 0) {
    const perOccurrence = duration / count;
    summary.minAbnormalDuration = Math.min(
      summary.minAbnormalDuration,
      perOccurrence,
    );
    if (perOccurrence > summary.maxAbnormalDuration) {
      summary.maxAbnormalDuration = perOccurrence;
      summary.maxAbnormalTime = time || '-';
    }
  }
}
function finishSummary(
  map: Map<string, SummaryAccumulator>,
): MonitorAbnormalSummaryRow[] {
  return Array.from(map.values(), (item) => ({
    key: item.key,
    asin: item.asin,
    country: item.country,
    queryTimeRange: item.queryTimeRange,
    abnormalCount: item.abnormalCount,
    averageAbnormalDuration: round(
      item.abnormalCount > 0
        ? item.totalAbnormalDuration / item.abnormalCount
        : 0,
      2,
    ),
    minAbnormalDuration: round(
      item.minAbnormalDuration === Infinity ? 0 : item.minAbnormalDuration,
      2,
    ),
    maxAbnormalDuration: round(item.maxAbnormalDuration, 2),
    maxAbnormalTime: item.maxAbnormalTime,
  })).sort(
    (a, b) =>
      b.abnormalCount - a.abnormalCount ||
      b.maxAbnormalDuration - a.maxAbnormalDuration,
  );
}
function emptyRow(
  timePeriod: string,
  meta: Pick<MonitorAbnormalSeriesRow, 'asinId' | 'asin' | 'country'>,
  totalDuration: number,
): MonitorAbnormalSeriesRow {
  return {
    timePeriod,
    ...meta,
    abnormalDuration: 0,
    totalDuration: round(totalDuration, 4),
    abnormalRatio: 0,
    brokenCount: 0,
    totalChecks: 0,
  };
}
function checkSize(size: number) {
  if (size > ROW_LIMIT) throw new MonitorAnalyticsResultLimitError();
}

/** Raw bucket estimates retain check counts. Their summary uses the rounded
 * bucket duration divided by broken checks, not an observed transition count. */
export function buildMonitorAbnormalFromBuckets(
  rows: readonly MonitorAbnormalBucketRow[],
  query: MonitorAbnormalQueryRange = {},
) {
  checkSize(rows.length);
  const timeGranularity = getMonitorAbnormalGranularity(query);
  const start = parseMonitorDate(query.startTime),
    end = parseMonitorDate(query.endTime);
  const summaryMap = new Map<string, SummaryAccumulator>();
  const data = rows.map((row) => {
    const brokenCount = Number(row.broken_count || 0),
      totalChecks = Number(row.total_checks || 0);
    const bucket = getMonitorBucketRange(row.time_period, timeGranularity);
    const hours =
      bucket.bucketStart && bucket.bucketEnd
        ? getMonitorDurationBucketHours(
            row.time_period,
            timeGranularity,
            start,
            end,
          )
        : timeGranularity === 'hour'
        ? 1
        : timeGranularity === 'week'
        ? 168
        : 24;
    const ratio = totalChecks > 0 ? clamp(brokenCount / totalChecks, 1) : 0;
    const item: MonitorAbnormalSeriesRow = {
      timePeriod: row.time_period,
      asinId: row.asin_id,
      asin: row.asin,
      country: row.country,
      abnormalDuration: round(clamp(hours * ratio, hours), 4),
      totalDuration: round(hours, 4),
      abnormalRatio: round(ratio * 100, 2),
      brokenCount,
      totalChecks,
    };
    if (item.asin || item.asinId)
      addSummary(
        summaryMap,
        {
          id: item.asinId,
          asin: item.asin || `ASIN-${item.asinId}`,
          country: item.country || '',
        },
        query,
        item.abnormalDuration,
        brokenCount,
        item.timePeriod,
      );
    return item;
  });
  const summary = finishSummary(summaryMap);
  if (query.includeSeries === '0')
    return { timeGranularity, data: [] as MonitorAbnormalSeriesRow[], summary };
  if (!start || !end) return { timeGranularity, data, summary };
  const timePeriods = periods(start, end, timeGranularity);
  // Legacy differentiates metadata by ASIN text but finds existing buckets by ID
  // and country. Keep that behavior when snapshots changed names/code casing.
  const metas = new Map<
    string,
    Pick<MonitorAbnormalSeriesRow, 'asinId' | 'asin' | 'country'>
  >();
  const existing = new Map<string, MonitorAbnormalSeriesRow>();
  for (const row of data) {
    const meta = {
      asinId: row.asinId,
      asin: row.asin,
      country: row.country || '',
    };
    if (row.asinId) metas.set(JSON.stringify(meta), meta);
    existing.set(`${row.timePeriod}|${row.asinId}|${row.country || ''}`, row);
  }
  checkSize(Math.max(1, metas.size) * timePeriods.length);
  const filled: MonitorAbnormalSeriesRow[] = [];
  for (const meta of metas.values())
    for (const period of timePeriods) {
      filled.push(
        existing.get(`${period}|${meta.asinId}|${meta.country || ''}`) ||
          emptyRow(
            period,
            meta,
            getMonitorDurationBucketHours(period, timeGranularity, start, end),
          ),
      );
    }
  if (!filled.length)
    for (const period of timePeriods)
      filled.push(
        emptyRow(
          period,
          { asinId: null, asin: null, country: null },
          getMonitorDurationBucketHours(period, timeGranularity, start, end),
        ),
      );
  return { timeGranularity, data: filled, summary };
}

/** The interval path counts observed broken intervals, including clipped/open
 * intervals. Empty interval input intentionally has no raw-path placeholders. */
export function buildMonitorAbnormalFromIntervals(
  rows: readonly MonitorStatusIntervalRow[],
  query: MonitorAbnormalQueryRange = {},
  now = new Date(),
) {
  checkSize(rows.length);
  const timeGranularity = getMonitorAbnormalGranularity(query);
  const start = parseMonitorDate(query.startTime),
    end = parseMonitorDate(query.endTime);
  const includeSeries = query.includeSeries !== '0';
  const timePeriods = includeSeries ? periods(start, end, timeGranularity) : [];
  const metas = new Map<
    string,
    Pick<MonitorAbnormalSeriesRow, 'asinId' | 'asin' | 'country'>
  >();
  for (const row of rows) {
    const asin = row.asin || row.asin_key || `ASIN-${row.asin_id || '-'}`;
    const key = `${row.asin_id || asin}|${row.country || ''}`;
    if (!metas.has(key))
      metas.set(key, { asinId: row.asin_id, asin, country: row.country || '' });
  }
  checkSize(metas.size * timePeriods.length);
  const summaryMap = new Map<string, SummaryAccumulator>();
  const series = new Map<string, MonitorAbnormalSeriesRow>();
  let work = 0;
  for (const row of rows) {
    const intervalStart = parseMonitorDate(row.interval_start),
      intervalEnd = parseMonitorDate(row.interval_end) || end || now;
    if (!intervalStart || !Number.isFinite(intervalEnd.getTime())) continue;
    const effectiveStart = new Date(
      Math.max(
        intervalStart.getTime(),
        start?.getTime() ?? intervalStart.getTime(),
      ),
    );
    const effectiveEnd = new Date(
      Math.min(intervalEnd.getTime(), end?.getTime() ?? intervalEnd.getTime()),
    );
    if (effectiveEnd <= effectiveStart) continue;
    const asin = row.asin || row.asin_key || `ASIN-${row.asin_id || '-'}`;
    const country = row.country || '';
    const key = `${row.asin_id || asin}|${country}`;
    const broken = Number(row.is_broken) === 1;
    if (broken)
      addSummary(
        summaryMap,
        { id: row.asin_id, asin, country },
        query,
        (effectiveEnd.getTime() - effectiveStart.getTime()) / HOUR,
        1,
        formatMonitorSqlDate(effectiveStart),
      );
    if (!includeSeries) continue;
    let cursor = floorMonitorDate(effectiveStart, timeGranularity);
    while (cursor && cursor < effectiveEnd) {
      if (++work > WORK_LIMIT) throw new MonitorAnalyticsResultLimitError();
      const next = addMonitorGranularity(cursor, timeGranularity);
      if (!next) break;
      const hours = Math.max(
        0,
        (Math.min(next.getTime(), effectiveEnd.getTime()) -
          Math.max(cursor.getTime(), effectiveStart.getTime())) /
          HOUR,
      );
      const period = formatMonitorPeriod(cursor, timeGranularity);
      const seriesKey = `${period}|${key}`;
      let item = series.get(seriesKey);
      if (!item) {
        checkSize(series.size + 1);
        item = emptyRow(period, { asinId: row.asin_id, asin, country }, 0);
        series.set(seriesKey, item);
      }
      item.totalDuration += hours;
      item.totalChecks++;
      if (broken) {
        item.abnormalDuration += hours;
        item.brokenCount++;
      }
      cursor = next;
    }
  }
  const data: MonitorAbnormalSeriesRow[] = [];
  for (const [key, meta] of metas)
    for (const period of timePeriods) {
      const current = series.get(`${period}|${key}`);
      if (!current) {
        data.push(
          emptyRow(
            period,
            meta,
            getMonitorDurationBucketHours(period, timeGranularity, start, end),
          ),
        );
        continue;
      }
      const totalDuration = round(current.totalDuration, 4),
        abnormalDuration = round(current.abnormalDuration, 4);
      data.push({
        ...current,
        totalDuration,
        abnormalDuration,
        abnormalRatio:
          totalDuration > 0
            ? round((abnormalDuration / totalDuration) * 100, 2)
            : 0,
      });
    }
  data.sort((a, b) =>
    `${a.timePeriod}|${a.country}|${a.asinId || a.asin}`.localeCompare(
      `${b.timePeriod}|${b.country}|${b.asinId || b.asin}`,
    ),
  );
  return { timeGranularity, data, summary: finishSummary(summaryMap) };
}
