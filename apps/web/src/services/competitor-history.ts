import {
  competitorMonitorHistoryDetailResultSchema,
  competitorMonitorHistoryListResultSchema,
  type MonitorHistoryListQuery,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';
import { historyId } from './monitor-history';

export type CompetitorHistoryListQuery = Pick<
  MonitorHistoryListQuery,
  | 'variantGroupId'
  | 'asinId'
  | 'asin'
  | 'country'
  | 'checkType'
  | 'isBroken'
  | 'startTime'
  | 'endTime'
  | 'current'
  | 'pageSize'
>;

// The repository bounds the complete aliased history payload at 64 MiB.
const RESPONSE_LIMIT = 64 * 1024 * 1024;
const PATH = '/api/v1/competitor/monitor-history';

export async function getCompetitorHistory(
  http: Pick<HttpClient, 'request'>,
  query: CompetitorHistoryListQuery,
  signal?: AbortSignal,
) {
  const current = query.current ?? 1;
  const pageSize = query.pageSize ?? 10;
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    (current - 1) * pageSize > 1_000_000
  )
    throw new ApiError('INVALID_INPUT', '竞品监控历史分页参数无效');
  const response = await http.request(
    PATH,
    { query, signal, timeoutMs: 120_000, maxResponseBytes: RESPONSE_LIMIT },
    competitorMonitorHistoryListResultSchema,
  );
  const data = response.success === true ? response.data : undefined;
  if (!data)
    throw new ApiError('INVALID_RESPONSE', '竞品监控历史列表响应缺少数据');
  if (
    data.current !== current ||
    data.pageSize !== pageSize ||
    data.list.length > pageSize ||
    (data.total !== null &&
      (!Number.isSafeInteger(data.total) || data.total < 0)) ||
    data.list.some(
      (record) => !Number.isSafeInteger(record.id) || record.id <= 0,
    )
  )
    throw new ApiError('INVALID_RESPONSE', '竞品监控历史列表响应契约不匹配');
  return data;
}

export async function getCompetitorHistoryDetail(
  http: Pick<HttpClient, 'request'>,
  id: number,
  signal?: AbortSignal,
) {
  const response = await http.request(
    `${PATH}/${historyId(id)}`,
    { signal, timeoutMs: 120_000, maxResponseBytes: RESPONSE_LIMIT },
    competitorMonitorHistoryDetailResultSchema,
  );
  const record = response.success === true ? response.data : undefined;
  if (!record)
    throw new ApiError('INVALID_RESPONSE', '竞品监控历史详情响应缺少数据');
  if (record.id !== id)
    throw new ApiError('INVALID_RESPONSE', '竞品监控历史详情标识不匹配');
  return record;
}
