import {
  monitorAnalyticsDataSchemas,
  monitorStatisticsQuerySchema,
  peakHoursStatisticsQuerySchema,
  resultSchema,
  type MonitorStatisticsQuery,
  type PeakHoursStatisticsQuery,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

// Match the complete Neo analytics response budget, including the envelope.
const READ_OPTIONS = {
  timeoutMs: 120_000,
  maxResponseBytes: 32 * 1024 * 1024,
} as const;
function safeCount(value: number | string): boolean {
  if (typeof value === 'string' && !/^\d+(?:\.0+)?$/.test(value)) return false;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0;
}
const metric = (value: number) => Number.isFinite(value) && value >= 0;
const rate = (value: number) => metric(value) && value <= 100;

// Some shared Legacy count/rate fields remain loose. Refine the actual Neo
// schemas locally before counts reach UI arithmetic; retain valid SQL strings.
const statisticsResult = resultSchema(
  monitorAnalyticsDataSchemas.statistics.refine(
    (data) =>
      [
        data.totalChecks,
        data.brokenCount,
        data.normalCount,
        data.groupCount,
        data.asinCount,
      ].every(safeCount) &&
      Number.isSafeInteger(data.groupCount + data.asinCount) &&
      rate(data.ratioAllAsin) &&
      rate(data.ratioAllTime),
  ),
);
const peakHoursResult = resultSchema(
  monitorAnalyticsDataSchemas['peak-hours'].refine(
    (data) =>
      [
        data.peakBroken,
        data.peakTotal,
        data.offPeakBroken,
        data.offPeakTotal,
      ].every(safeCount) &&
      [
        data.peakDurationHours,
        data.peakAbnormalDurationHours,
        data.offPeakDurationHours,
        data.offPeakAbnormalDurationHours,
      ].every(metric) &&
      [
        data.peakRate,
        data.offPeakRate,
        data.peakDurationRate,
        data.offPeakDurationRate,
      ].every(rate),
  ),
);

export type MonitorStatistics = ReturnType<
  typeof monitorAnalyticsDataSchemas.statistics.parse
>;
export type MonitorPeakHoursStatistics = ReturnType<
  (typeof monitorAnalyticsDataSchemas)['peak-hours']['parse']
>;

function requireData<T>(
  response: { success?: boolean; data?: T },
  message: string,
): T {
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', message);
  return response.data;
}

/** Only the statistics contract's own fields are sent, never a history page query. */
export async function getMonitorStatistics(
  http: Pick<HttpClient, 'request'>,
  query: MonitorStatisticsQuery,
  signal?: AbortSignal,
): Promise<MonitorStatistics> {
  const parsed = monitorStatisticsQuerySchema.safeParse(query);
  if (!parsed.success)
    throw new ApiError('INVALID_INPUT', '监控统计查询参数无效');
  const response = await http.request(
    '/api/v1/monitor-history/statistics',
    { query: parsed.data, signal, ...READ_OPTIONS },
    statisticsResult,
  );
  return requireData(response, '监控统计响应缺少数据');
}

/** Peak hours are scoped by country, check type and time, not a group or ASIN ID. */
export async function getPeakHoursStatistics(
  http: Pick<HttpClient, 'request'>,
  query: PeakHoursStatisticsQuery,
  signal?: AbortSignal,
): Promise<MonitorPeakHoursStatistics> {
  const parsed = peakHoursStatisticsQuerySchema.safeParse(query);
  if (!parsed.success)
    throw new ApiError('INVALID_INPUT', '高低峰统计查询参数无效');
  const response = await http.request(
    '/api/v1/monitor-history/statistics/peak-hours',
    { query: parsed.data, signal, ...READ_OPTIONS },
    peakHoursResult,
  );
  return requireData(response, '高低峰统计响应缺少数据');
}
