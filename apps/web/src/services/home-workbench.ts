import {
  homeWorkbenchQuerySchema,
  homeWorkbenchResultSchema,
  type HomeWorkbenchData,
  type HomeWorkbenchQuery,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

export const HOME_WORKBENCH_QUERY_KEY = ['home-workbench'] as const;
export async function getHomeWorkbench(
  http: Pick<HttpClient, 'request'>,
  query: HomeWorkbenchQuery,
  signal?: AbortSignal,
): Promise<HomeWorkbenchData> {
  const parsed = homeWorkbenchQuerySchema.safeParse(query);
  if (!parsed.success)
    return Promise.reject(new ApiError('INVALID_INPUT', '首页筛选范围无效'));
  // An empty brand is an exact catalog facet, distinct from an omitted filter.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const response = await http.request(
    `/api/v1/dashboard/workbench?${params}`,
    {
      signal,
      timeoutMs: 12_000,
      maxResponseBytes: 512 * 1024,
    },
    homeWorkbenchResultSchema,
  );
  if (
    !response.success ||
    !response.data ||
    response.data.current !== parsed.data.current ||
    response.data.pageSize !== parsed.data.pageSize ||
    response.data.facetCurrent !== parsed.data.facetCurrent
  )
    throw new ApiError('INVALID_RESPONSE', '首页工作台响应与当前页不一致');
  return response.data;
}
