import {
  neoAuditLogDetailResultSchema,
  neoAuditLogListQuerySchema,
  neoAuditLogListResultSchema,
  type NeoAuditLogListQuery,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const PATH = '/api/v1/audit-logs';

export function auditLogId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0 || String(value).length > 16)
    throw new ApiError('INVALID_INPUT', '审计记录标识无效');
  return String(value);
}

export async function getAuditLogs(
  http: Pick<HttpClient, 'request'>,
  query: NeoAuditLogListQuery,
  signal?: AbortSignal,
) {
  if (!neoAuditLogListQuerySchema.safeParse(query).success)
    throw new ApiError('INVALID_INPUT', '审计筛选或分页参数无效');
  const response = await http.request(
    PATH,
    { query, signal, timeoutMs: 60_000 },
    neoAuditLogListResultSchema,
  );
  const data = response.success === true ? response.data : undefined;
  if (!data) throw new ApiError('INVALID_RESPONSE', '审计列表响应缺少数据');
  if (
    data.current !== query.current ||
    data.pageSize !== query.pageSize ||
    data.list.length > query.pageSize ||
    data.list.some((row) => !Number.isSafeInteger(row.id) || row.id <= 0)
  )
    throw new ApiError('INVALID_RESPONSE', '审计列表响应契约不匹配');
  return data;
}

export async function getAuditLogDetail(
  http: Pick<HttpClient, 'request'>,
  id: number,
  signal?: AbortSignal,
) {
  const response = await http.request(
    `${PATH}/${auditLogId(id)}`,
    { signal, timeoutMs: 60_000 },
    neoAuditLogDetailResultSchema,
  );
  const row = response.success === true ? response.data : undefined;
  if (!row) throw new ApiError('INVALID_RESPONSE', '审计详情响应缺少数据');
  if (row.id !== id)
    throw new ApiError('INVALID_RESPONSE', '审计详情标识不匹配');
  return row;
}
