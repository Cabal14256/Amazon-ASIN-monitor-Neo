import {
  analyticsResultSchema,
  monitorAnalyticsDataSchemas,
  type AbnormalDurationQuery,
  type AggregateSummaryQuery,
  type AsinStatisticsByCountryQuery,
  type AsinStatisticsByVariantGroupQuery,
  type MonitorAnalyticsData,
  type MonitorStatisticsQuery,
  type MonthlyBreakdownQuery,
  type PeakHoursStatisticsQuery,
  type PeakMarkAreasQuery,
  type PeriodSummaryDetailsQuery,
  type PeriodSummaryQuery,
  type StatisticsByCountryQuery,
  type StatisticsByTimeQuery,
  type StatisticsByVariantGroupQuery,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient, type QueryParams } from '../lib/http';

const ANALYTICS_RESPONSE_LIMIT = 32 * 1024 * 1024;
const REQUEST_OPTIONS = {
  timeoutMs: 120_000,
  maxResponseBytes: ANALYTICS_RESPONSE_LIMIT,
} as const;

type AnalyticsKey = keyof typeof monitorAnalyticsDataSchemas;
type WaitingAnalyticsRequest = {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
};
let activeAnalyticsRequests = 0;
const waitingAnalyticsRequests: WaitingAnalyticsRequest[] = [];

function releaseSlot(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waitingAnalyticsRequests.shift();
    if (next) {
      if (next.abort) next.signal?.removeEventListener('abort', next.abort);
      next.resolve(releaseSlot());
    } else {
      activeAnalyticsRequests--;
    }
  };
}

function acquireSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted)
    return Promise.reject(new ApiError('CANCELLED', '请求已取消'));
  if (activeAnalyticsRequests < 2) {
    activeAnalyticsRequests++;
    return Promise.resolve(releaseSlot());
  }
  return new Promise((resolve, reject) => {
    const waiter: WaitingAnalyticsRequest = { signal, resolve, reject };
    waiter.abort = () => {
      const index = waitingAnalyticsRequests.indexOf(waiter);
      if (index >= 0) waitingAnalyticsRequests.splice(index, 1);
      reject(new ApiError('CANCELLED', '请求已取消'));
    };
    signal?.addEventListener('abort', waiter.abort, { once: true });
    waitingAnalyticsRequests.push(waiter);
  });
}

function queryParams(query: object): QueryParams {
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(',') : value,
    ]),
  ) as QueryParams;
}

function data<T>(response: { success?: boolean; data?: T }, label: string): T {
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', `${label}响应缺少数据`);
  return response.data;
}

async function request<K extends AnalyticsKey>(
  http: Pick<HttpClient, 'request'>,
  operation: K,
  path: string,
  query: object,
  signal?: AbortSignal,
): Promise<MonitorAnalyticsData<K>> {
  const release = await acquireSlot(signal);
  try {
    const response = await http.request(
      path,
      { ...REQUEST_OPTIONS, query: queryParams(query), signal },
      analyticsResultSchema(monitorAnalyticsDataSchemas[operation]),
    );
    return data(response, `分析${operation}`) as MonitorAnalyticsData<K>;
  } finally {
    release();
  }
}

export function getMonitorStatistics(
  http: Pick<HttpClient, 'request'>,
  query: MonitorStatisticsQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'statistics',
    '/api/v1/monitor-history/statistics',
    query,
    signal,
  );
}

export function getStatisticsByTime(
  http: Pick<HttpClient, 'request'>,
  query: StatisticsByTimeQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'by-time',
    '/api/v1/monitor-history/statistics/by-time',
    query,
    signal,
  );
}

export function getStatisticsByCountry(
  http: Pick<HttpClient, 'request'>,
  query: StatisticsByCountryQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'by-country',
    '/api/v1/monitor-history/statistics/by-country',
    query,
    signal,
  );
}

export function getStatisticsByVariantGroup(
  http: Pick<HttpClient, 'request'>,
  query: StatisticsByVariantGroupQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'by-variant-group',
    '/api/v1/monitor-history/statistics/by-variant-group',
    query,
    signal,
  );
}

export function getPeakHoursStatistics(
  http: Pick<HttpClient, 'request'>,
  query: PeakHoursStatisticsQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'peak-hours',
    '/api/v1/monitor-history/statistics/peak-hours',
    query,
    signal,
  );
}

export function getMonthlyBreakdown(
  http: Pick<HttpClient, 'request'>,
  query: MonthlyBreakdownQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'analytics-monthly-breakdown',
    '/api/v1/monitor-history/statistics/analytics-monthly-breakdown',
    query,
    signal,
  );
}

export function getPeakMarkAreas(
  http: Pick<HttpClient, 'request'>,
  query: PeakMarkAreasQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'peak-mark-areas',
    '/api/v1/monitor-history/statistics/peak-mark-areas',
    query,
    signal,
  );
}

export function getAllCountriesSummary(
  http: Pick<HttpClient, 'request'>,
  query: AggregateSummaryQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'all-countries-summary',
    '/api/v1/monitor-history/statistics/all-countries-summary',
    query,
    signal,
  );
}

export function getRegionSummary(
  http: Pick<HttpClient, 'request'>,
  query: AggregateSummaryQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'region-summary',
    '/api/v1/monitor-history/statistics/region-summary',
    query,
    signal,
  );
}

export function getPeriodSummary(
  http: Pick<HttpClient, 'request'>,
  query: PeriodSummaryQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'period-summary',
    '/api/v1/monitor-history/statistics/period-summary',
    query,
    signal,
  );
}

export function getPeriodSummaryDetails(
  http: Pick<HttpClient, 'request'>,
  query: PeriodSummaryDetailsQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'period-summary/details',
    '/api/v1/monitor-history/statistics/period-summary/details',
    query,
    signal,
  );
}

export function getAsinStatisticsByCountry(
  http: Pick<HttpClient, 'request'>,
  query: AsinStatisticsByCountryQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'asin-by-country',
    '/api/v1/monitor-history/statistics/asin-by-country',
    query,
    signal,
  );
}

export function getAsinStatisticsByVariantGroup(
  http: Pick<HttpClient, 'request'>,
  query: AsinStatisticsByVariantGroupQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'asin-by-variant-group',
    '/api/v1/monitor-history/statistics/asin-by-variant-group',
    query,
    signal,
  );
}

export function getAbnormalDurationStatistics(
  http: Pick<HttpClient, 'request'>,
  query: AbnormalDurationQuery,
  signal?: AbortSignal,
) {
  return request(
    http,
    'abnormal-duration-statistics',
    '/api/v1/monitor-history/abnormal-duration-statistics',
    query,
    signal,
  );
}
