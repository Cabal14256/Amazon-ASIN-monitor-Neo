import {
  variantGroupListResultSchema,
  variantGroupResultSchema,
  type VariantGroup,
  type VariantGroupListData,
  type VariantGroupListQuery,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const ASIN_RESPONSE_LIMIT = 32 * 1024 * 1024;

/** Neo read routes share the request layer's normalized /api prefix. */
export async function getVariantGroups(
  http: Pick<HttpClient, 'request'>,
  query: VariantGroupListQuery,
  signal?: AbortSignal,
): Promise<VariantGroupListData> {
  const response = await http.request(
    '/api/v1/variant-groups',
    {
      query,
      signal,
      timeoutMs: 120_000,
      maxResponseBytes: ASIN_RESPONSE_LIMIT,
    },
    variantGroupListResultSchema,
  );
  if (!response.success || !response.data)
    throw new ApiError('INVALID_RESPONSE', 'ASIN 列表响应缺少数据');
  return response.data;
}

export async function getVariantGroup(
  http: Pick<HttpClient, 'request'>,
  id: string,
  signal?: AbortSignal,
): Promise<VariantGroup> {
  // Segment encoding prevents a record identifier from changing the route.
  const response = await http.request(
    `/api/v1/variant-groups/${encodeURIComponent(id)}`,
    { signal, timeoutMs: 120_000, maxResponseBytes: ASIN_RESPONSE_LIMIT },
    variantGroupResultSchema,
  );
  if (!response.success || !response.data)
    throw new ApiError('INVALID_RESPONSE', '变体组详情响应缺少数据');
  return response.data;
}
