import {
  competitorGroupListResultSchema,
  competitorGroupResultSchema,
  type CompetitorGroupListData,
  type CompetitorGroupListQuery,
  type CompetitorVariantGroup,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const RESPONSE_LIMIT = 32 * 1024 * 1024;

export async function getCompetitorGroups(
  http: Pick<HttpClient, 'request'>,
  query: CompetitorGroupListQuery,
  signal?: AbortSignal,
): Promise<CompetitorGroupListData> {
  const response = await http.request(
    '/api/v1/competitor/variant-groups',
    { query, signal, timeoutMs: 30_000, maxResponseBytes: RESPONSE_LIMIT },
    competitorGroupListResultSchema,
  );
  if (!response.success || !response.data)
    throw new ApiError('INVALID_RESPONSE', '竞品 ASIN 列表响应缺少数据');
  return response.data;
}

export async function getCompetitorGroup(
  http: Pick<HttpClient, 'request'>,
  id: string,
  signal?: AbortSignal,
): Promise<CompetitorVariantGroup> {
  const response = await http.request(
    `/api/v1/competitor/variant-groups/${encodeURIComponent(id)}`,
    { signal, timeoutMs: 30_000, maxResponseBytes: RESPONSE_LIMIT },
    competitorGroupResultSchema,
  );
  if (!response.success || !response.data)
    throw new ApiError('INVALID_RESPONSE', '竞品变体组详情响应缺少数据');
  return response.data;
}
