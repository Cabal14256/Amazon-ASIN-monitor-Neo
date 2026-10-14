import { formatBeijing, formatBeijingNow } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import { historyWallTime } from '../monitor-history/history-data';

export const COUNTRIES = [
  { value: '', label: '全部国家' },
  { value: 'US', label: '美国 / US' },
  { value: 'EU', label: '欧洲 / EU' },
  { value: 'UK', label: '英国 / UK' },
  { value: 'DE', label: '德国 / DE' },
  { value: 'FR', label: '法国 / FR' },
  { value: 'IT', label: '意大利 / IT' },
  { value: 'ES', label: '西班牙 / ES' },
] as const;

export type AnalyticsFilters = {
  country: string;
  startTime: string;
  endTime: string;
  groupBy: 'hour' | 'day' | 'week' | 'month';
};

export type PeriodIdentity = { country: string; site: string; brand: string };
export type PeriodFilters = { site: string; brand: string };
export type DurationSummaryGranularity = 'hour' | 'day';
const MAX_ANALYTICS_MONTHS = 12;

export type AbnormalSeriesPoint = {
  timePeriod: string;
  abnormalDuration: number;
  totalDuration: number;
};

export function analyticsCountryQuery(filters: AnalyticsFilters) {
  return {
    country: filters.country || undefined,
    startTime: filters.startTime,
    endTime: filters.endTime,
  };
}

export function overviewStatisticsQuery(filters: AnalyticsFilters) {
  return { ...analyticsCountryQuery(filters), checkType: 'ASIN' };
}

export function durationSummaryQuery(
  filters: AnalyticsFilters,
  timeSlotGranularity: DurationSummaryGranularity,
) {
  return {
    startTime: filters.startTime,
    endTime: filters.endTime,
    timeSlotGranularity,
  };
}

export function peakHoursQuery(filters: AnalyticsFilters) {
  return {
    ...analyticsCountryQuery(filters),
    country: filters.country || 'US',
  };
}

export function periodDetailsQuery(
  filters: AnalyticsFilters,
  period: PeriodIdentity,
  granularity: DurationSummaryGranularity,
) {
  return {
    country: period.country,
    site: period.site,
    brand: period.brand,
    startTime: filters.startTime,
    endTime: filters.endTime,
    timeSlotGranularity: granularity,
  };
}

export function periodSummaryQuery(
  filters: AnalyticsFilters,
  periodFilters: PeriodFilters,
  page: number,
  granularity: DurationSummaryGranularity,
) {
  return {
    ...analyticsCountryQuery(filters),
    site: periodFilters.site.trim() || undefined,
    brand: periodFilters.brand.trim() || undefined,
    timeSlotGranularity: granularity,
    current: page,
    pageSize: 20,
  };
}

export function sumAbnormalSeriesByPeriod(
  rows: readonly AbnormalSeriesPoint[],
) {
  const periods = new Map<
    string,
    { timePeriod: string; abnormalDuration: number; totalDuration: number }
  >();
  for (const row of rows) {
    const period = periods.get(row.timePeriod) ?? {
      timePeriod: row.timePeriod,
      abnormalDuration: 0,
      totalDuration: 0,
    };
    period.abnormalDuration += row.abnormalDuration;
    period.totalDuration += row.totalDuration;
    periods.set(row.timePeriod, period);
  }
  return [...periods.values()]
    .sort((left, right) => left.timePeriod.localeCompare(right.timePeriod))
    .map((period) => ({
      ...period,
      abnormalRatio:
        period.totalDuration > 0
          ? (period.abnormalDuration / period.totalDuration) * 100
          : 0,
    }));
}

export function monthlyRowsInRange<T extends { date: string }>(
  rows: readonly T[],
  startTime: string,
  endTime: string,
) {
  const startDay = startTime.slice(0, 10);
  const endDay = endTime.slice(0, 10);
  return rows.filter((row) => row.date >= startDay && row.date <= endDay);
}

export function monthsInRange(startTime: string, endTime: string) {
  const [startYear, startMonth] = startTime.slice(0, 7).split('-').map(Number);
  const [endYear, endMonth] = endTime.slice(0, 7).split('-').map(Number);
  const start = startYear * 12 + startMonth - 1;
  const end = endYear * 12 + endMonth - 1;
  const months: string[] = [];
  for (let value = start; value <= end; value++) {
    months.push(
      `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, '0')}`,
    );
  }
  return months;
}

export function monthlyIntersectionQuery(
  filters: AnalyticsFilters,
  month: string,
) {
  const [year, number] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const monthStart = `${month}-01 00:00:00`;
  const monthEnd = `${month}-${String(lastDay).padStart(2, '0')} 23:59:59`;
  return {
    country: filters.country || undefined,
    month,
    startTime: filters.startTime > monthStart ? filters.startTime : monthStart,
    endTime: filters.endTime < monthEnd ? filters.endTime : monthEnd,
  };
}

/** Cancel queued and active sibling requests as soon as one month fails. */
export async function loadMonthlyRows<T>(
  months: readonly string[],
  load: (month: string, signal: AbortSignal) => Promise<readonly T[]>,
  signal?: AbortSignal,
): Promise<T[]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const rows: (readonly T[])[] = Array(months.length);
    let next = 0;
    // Do not enqueue every month in the shared REST admission queue. Its slot
    // release happens before this caller observes a failed response; a queued
    // sibling could otherwise reach fetch in that gap.
    const worker = async () => {
      while (next < months.length) {
        if (controller.signal.aborted)
          throw new ApiError('CANCELLED', '请求已取消');
        const index = next++;
        try {
          rows[index] = await load(months[index], controller.signal);
        } catch (error) {
          abort();
          throw error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(2, months.length) }, worker),
    );
    return rows.flatMap((monthRows) => [...monthRows]);
  } catch (error) {
    abort();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export function initialAnalyticsFilters(): AnalyticsFilters {
  const endTime = formatBeijingNow('YYYY-MM-DDTHH:mm');
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const startTime = formatBeijing(start, 'YYYY-MM-DDTHH:mm');
  return { country: '', startTime, endTime, groupBy: 'day' };
}

export function applyAnalyticsFilters(
  filters: AnalyticsFilters,
): { ok: true; value: AnalyticsFilters } | { ok: false; error: string } {
  const startTime = historyWallTime(filters.startTime);
  const endTime = historyWallTime(filters.endTime);
  if (!startTime || !endTime)
    return { ok: false, error: '请输入有效的上海时间范围。' };
  if (startTime > endTime)
    return { ok: false, error: '结束时间应不早于开始时间。' };
  if (monthsInRange(startTime, endTime).length > MAX_ANALYTICS_MONTHS)
    return { ok: false, error: '分析范围最多可跨 12 个自然月。' };
  return {
    ok: true,
    value: { ...filters, startTime, endTime },
  };
}

export function metric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function integerMetric(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}

export function percent(value: unknown): string {
  const amount = metric(value);
  return `${Math.round(Math.min(100, Math.max(0, amount)) * 10) / 10}%`;
}

export function hours(value: unknown): string {
  return `${metric(value).toFixed(1)} h`;
}

export function count(value: unknown): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(
    integerMetric(value),
  );
}

export function overviewAsinMetric(summary: {
  asinCount?: number;
  totalAsinsDedup?: number;
  brokenAsinsDedup?: number;
}) {
  if (summary.brokenAsinsDedup === undefined)
    return {
      label: '监控 ASIN',
      value: count(summary.asinCount),
      hint: '当前筛选范围',
    };
  return {
    label: '受影响 ASIN',
    value: count(summary.brokenAsinsDedup),
    hint: `监控 ASIN ${count(summary.totalAsinsDedup)}`,
  };
}

export function periodPageCount(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function periodDetailPageRows<T>(rows: readonly T[], page: number) {
  return rows.slice((page - 1) * 50, page * 50);
}

export function abnormalSummaryPageRows<T>(rows: readonly T[], page: number) {
  return rows.slice((page - 1) * 50, page * 50);
}

export function variantGroupHistoryHref(
  value: unknown,
  canReadMonitor: boolean,
): string | null {
  if (!canReadMonitor) return null;
  const id =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : null;
  if (
    !id?.trim() ||
    [...id].length > 50 ||
    [...id].some(
      (char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127,
    )
  )
    return null;
  return `/monitor-history?type=group&id=${encodeURIComponent(id)}`;
}

export function selectOverviewSummary<Selected, Global>(
  country: string,
  selected: Selected | undefined,
  global: Global | undefined,
): Selected | Global | undefined {
  return country ? selected : global ?? selected;
}

export function latestPeakIntervals<T>(intervals: readonly T[]): T[] {
  return intervals.slice(-8);
}

export function dateLabel(value: unknown): string {
  if (typeof value !== 'string' || !value) return '未标记';
  return value.replace('T', ' ').replace(' 00:00:00', '');
}

export function analyticsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return '当前账号没有数据分析读取权限，请联系管理员。';
    if (error.status === 413) return '统计结果过大，请缩小时间范围后重试。';
    if (error.status === 429) return '统计查询繁忙，请稍后重试。';
    if (error.status === 503) return 'Neo 数据源尚未切换，请稍后重试。';
    return error.message;
  }
  return '分析数据暂不可用，请稍后重试。';
}

export function rowText(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return '未记录';
}

export function maxMetric(
  rows: readonly Record<string, unknown>[],
  key: string,
) {
  return Math.max(1, ...rows.map((row) => metric(row[key])));
}
