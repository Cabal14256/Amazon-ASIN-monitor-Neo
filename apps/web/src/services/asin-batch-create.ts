import {
  batchCreateAsinsRequestSchema,
  batchCreateAsinsResultSchema,
  type BatchCreateAsinsRequest,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

export const validBatchCreateText = (
  value: unknown,
  maximum: number,
  required = false,
) =>
  value == null
    ? !required
    : typeof value === 'string' &&
      [...value].length <= maximum &&
      ![...value].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) &&
      (!required || value.trim().length > 0);

export interface AsinBatchCreateInput {
  items: BatchCreateAsinsRequest['items'][number][];
}

/** Synchronous batch results must account for every submitted row. */
export async function batchCreateAsins(
  http: Pick<HttpClient, 'request'>,
  input: AsinBatchCreateInput,
  signal?: AbortSignal,
) {
  const parsed = batchCreateAsinsRequestSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.items.length > 1000 ||
    parsed.data.items.some(
      (item) =>
        !/^[A-Z0-9]{10}$/.test(item.asin) ||
        !validBatchCreateText(item.country, 10, true) ||
        item.country !== item.country.trim().toUpperCase() ||
        !validBatchCreateText(item.site, 100, true) ||
        !validBatchCreateText(item.brand, 100, true) ||
        !validBatchCreateText(item.parentId, 50, true) ||
        !validBatchCreateText(item.name, 500),
    )
  )
    throw new ApiError(
      'INVALID_INPUT',
      '请检查批量 ASIN 表单，最多提交 1000 个有效编码。',
    );
  const items = parsed.data.items;
  const response = await http.request(
    '/api/v1/asins/batch-create',
    { method: 'POST', json: { items }, signal, timeoutMs: 120_000 },
    batchCreateAsinsResultSchema,
  );
  const result = response.data;
  const seen = new Set<number>();
  const errorIndices = new Set<number>();
  if (
    response.success !== true ||
    !result ||
    ![result.total, result.successCount, result.failedCount].every(
      (count) => Number.isInteger(count) && count >= 0,
    ) ||
    result.total !== items.length ||
    result.total !== result.successCount + result.failedCount ||
    result.results.length !== result.total ||
    result.errors.length !== result.failedCount ||
    result.results.filter((row) => row.success).length !==
      result.successCount ||
    result.results.some((row) => {
      const item = items[row.index];
      if (
        !Number.isInteger(row.index) ||
        seen.has(row.index) ||
        !item ||
        row.asin !== item.asin ||
        row.country !== item.country ||
        (!row.success && !row.message?.trim())
      )
        return true;
      seen.add(row.index);
      return false;
    }) ||
    result.errors.some((error) => {
      const row = result.results.find((item) => item.index === error.index);
      if (
        error.index === undefined ||
        !Number.isInteger(error.index) ||
        errorIndices.has(error.index) ||
        !row ||
        row.success ||
        error.message !== row.message ||
        (error.asin != null && error.asin !== row.asin)
      )
        return true;
      errorIndices.add(error.index);
      return false;
    })
  )
    throw new ApiError(
      'INVALID_RESPONSE',
      '批量创建响应无法对应全部提交项，请核实目录，勿直接重发。',
    );
  return {
    ...result,
    results: [...result.results].sort((a, b) => a.index - b.index),
  };
}
