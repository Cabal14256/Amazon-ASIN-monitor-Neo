import {
  monitorHistoryDetailResultSchema,
  monitorHistoryListResultSchema,
  type MonitorHistoryListData,
  type MonitorHistoryListQuery,
  type MonitorHistoryRecord,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

// The repository bounds the complete aliased history payload at 64 MiB.
const RESPONSE_LIMIT = 64 * 1024 * 1024;

function requireData<T>(
  response: { success?: boolean; data?: T },
  message: string,
): T {
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', message);
  return response.data;
}

/** The API accepts only positive, safe decimal IDs. */
export function historyId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new ApiError('INVALID_INPUT', '监控历史标识无效');
  return String(value);
}

/** Bounded read matching the server's history response budget. */
export async function getMonitorHistory(
  http: Pick<HttpClient, 'request'>,
  query: MonitorHistoryListQuery,
  signal?: AbortSignal,
): Promise<MonitorHistoryListData> {
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
    throw new ApiError('INVALID_INPUT', '监控历史分页参数无效');
  const response = await http.request(
    '/api/v1/monitor-history',
    { query, signal, timeoutMs: 120_000, maxResponseBytes: RESPONSE_LIMIT },
    monitorHistoryListResultSchema,
  );
  const data = requireData(response, '监控历史列表响应缺少数据');
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
    throw new ApiError('INVALID_RESPONSE', '监控历史列表响应契约不匹配');
  return data;
}

export async function getMonitorHistoryDetail(
  http: Pick<HttpClient, 'request'>,
  id: number,
  signal?: AbortSignal,
): Promise<MonitorHistoryRecord> {
  const response = await http.request(
    `/api/v1/monitor-history/${historyId(id)}`,
    { signal, timeoutMs: 120_000, maxResponseBytes: RESPONSE_LIMIT },
    monitorHistoryDetailResultSchema,
  );
  const record = requireData(response, '监控历史详情响应缺少数据');
  if (record.id !== id)
    throw new ApiError('INVALID_RESPONSE', '监控历史详情标识不匹配');
  return record;
}
