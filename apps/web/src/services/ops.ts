import {
  clearAnalyticsCacheResultSchema,
  opsOverviewResultSchema,
  refreshAnalyticsRequestSchema,
  refreshAnalyticsResultSchema,
  type RefreshAnalyticsRequest,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const OPS_OPTIONS = {
  timeoutMs: 120_000,
  maxResponseBytes: 8 * 1024 * 1024,
} as const;

function data<T>(
  response: { success?: boolean; data?: T },
  message: string,
): T {
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', message);
  return response.data;
}

export async function getOpsOverview(
  http: Pick<HttpClient, 'request'>,
  signal?: AbortSignal,
) {
  const response = await http.request(
    '/api/v1/ops/overview',
    { signal, ...OPS_OPTIONS },
    opsOverviewResultSchema,
  );
  return data(response, '运维概览响应缺少数据');
}

export async function clearAnalyticsCache(http: Pick<HttpClient, 'request'>) {
  const response = await http.request(
    '/api/v1/ops/analytics/cache/clear',
    { method: 'POST', ...OPS_OPTIONS },
    clearAnalyticsCacheResultSchema,
  );
  return data(response, '缓存清理响应缺少数据');
}

export async function refreshAnalytics(
  http: Pick<HttpClient, 'request'>,
  input: RefreshAnalyticsRequest = {},
) {
  const parsed = refreshAnalyticsRequestSchema.safeParse(input);
  if (!parsed.success) throw new ApiError('INVALID_INPUT', '聚合刷新参数无效');
  const response = await http.request(
    '/api/v1/ops/analytics/refresh',
    { method: 'POST', json: parsed.data, ...OPS_OPTIONS },
    refreshAnalyticsResultSchema,
  );
  return data(response, '聚合刷新响应缺少数据');
}
