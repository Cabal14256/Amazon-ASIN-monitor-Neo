import { formatBeijing, formatBeijingNow } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import { historyWallTime } from '../monitor-history/history-data';

export const COUNTRIES = [
  { value: '', label: '全部国家' },
  { value: 'US', label: '美国 / US' },
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
