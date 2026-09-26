import {
  batchQueryParentAsinRequestSchema,
  batchQueryParentAsinResultSchema,
  parentAsinQueryItemSchema,
  variantCheckTaskDataSchema,
  type ParentAsinQueryItem,
  type VariantCheckTaskData,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const PARENT_QUERY_LIMIT = 32 * 1024 * 1024;
const PARENT_QUERY_OPTIONS = {
  timeoutMs: 120_000,
  maxResponseBytes: PARENT_QUERY_LIMIT,
} as const;

export function parseParentAsins(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，]+/)
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

export function validParentAsins(value: string): string[] {
  return parseParentAsins(value).filter((asin) =>
    /^[A-Z][A-Z0-9]{9}$/.test(asin),
  );
}

export function parseParentQueryItems(value: unknown): ParentAsinQueryItem[] {
  if (!Array.isArray(value))
    throw new ApiError('INVALID_RESPONSE', '父体查询结果格式无效');
  const parsed = value.map((item) => parentAsinQueryItemSchema.safeParse(item));
  if (parsed.some((item) => !item.success))
    throw new ApiError('INVALID_RESPONSE', '父体查询结果格式无效');
  return parsed.filter((item) => item.success).map((item) => item.data);
}

export function parentQueryCsv(
  items: readonly ParentAsinQueryItem[],
  country = 'US',
): string {
  const escape = (value: unknown) => {
    const text = String(value ?? '');
    const safe = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const headers = [
    'ASIN',
    '国家',
    '父体 ASIN',
    '父体标题',
    '产品标题',
    '品牌',
    '变体数',
    '状态',
    '错误',
  ];
  const rows = items.map((item) => [
    item.asin,
    country,
    item.parentAsin,
    item.parentTitle,
    item.title,
    item.brand,
    item.variantCount,
    item.error ? '失败' : '成功',
    item.error,
  ]);
  return (
    '\uFEFF' +
    [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n')
  );
}

export async function queryParentAsins(
  http: Pick<HttpClient, 'request'>,
  input: { asins: string[]; country: string },
  signal?: AbortSignal,
): Promise<ParentAsinQueryItem[] | VariantCheckTaskData> {
  const parsed = batchQueryParentAsinRequestSchema.safeParse({
    ...input,
    useAsync: true,
  });
  if (!parsed.success) throw new ApiError('INVALID_INPUT', '父体查询参数无效');
  let response;
  try {
    response = await http.request(
      '/api/v1/variant-check/batch-query-parent-asin',
      { method: 'POST', json: parsed.data, signal, ...PARENT_QUERY_OPTIONS },
      batchQueryParentAsinResultSchema,
    );
  } catch (error) {
    const pending =
      error instanceof ApiError
        ? variantCheckTaskDataSchema.safeParse(error.data)
        : undefined;
    if (pending?.success) return pending.data;
    throw error;
  }
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', '父体查询响应缺少数据');
  return Array.isArray(response.data)
    ? response.data.map((item) => parentAsinQueryItemSchema.parse(item))
    : response.data;
}
