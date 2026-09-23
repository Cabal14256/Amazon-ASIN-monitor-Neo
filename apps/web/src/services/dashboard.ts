import {
  dashboardResultSchema,
  type DashboardData,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

/** The response is validated before any dashboard data reaches the view. */
export async function getDashboard(
  http: Pick<HttpClient, 'request'>,
  signal?: AbortSignal,
): Promise<DashboardData> {
  const response = await http.request(
    '/api/v1/dashboard',
    { signal },
    dashboardResultSchema,
  );
  if (!response.success || !response.data)
    throw new ApiError('INVALID_RESPONSE', '仪表盘响应缺少数据');
  return response.data;
}
