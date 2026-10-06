import {
  batchDeleteSyncDataSchema,
  batchDeleteVariantGroupsRequestSchema,
  batchDeleteVariantGroupsResultSchema,
  competitorBatchDeleteResultSchema,
  type BatchDeleteVariantGroupsRequest,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';
import { isValidTaskId } from './tasks';

export type BatchDeleteCounts = ReturnType<
  typeof batchDeleteSyncDataSchema.parse
>;
export type CatalogBatchDeleteOutcome =
  | BatchDeleteCounts
  | { mode: 'async'; taskId: string; status: 'pending' | 'unknown' };

/** The current bulk backend trims IDs. Never select a different raw ID. */
export function isBulkDeleteId(id: string): boolean {
  return (
    !!id &&
    id === id.trim() &&
    [...id].length <= 50 &&
    ![...id].some(
      (character) =>
        character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    )
  );
}

export function batchDeleteCounts(value: unknown): BatchDeleteCounts | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = batchDeleteSyncDataSchema.safeParse({
    ...value,
    mode: 'sync',
  });
  if (!parsed.success) return null;
  const counts = parsed.data;
  if (
    ![
      counts.totalRequested,
      counts.deletedGroupCount,
      counts.deletedDirectAsinCount,
      counts.deletedNestedAsinCount,
    ].every((count) => Number.isSafeInteger(count) && count >= 0) ||
    counts.deletedGroupCount + counts.deletedDirectAsinCount >
      counts.totalRequested ||
    counts.skipped.groupIds.length + counts.skipped.asinIds.length >
      counts.totalRequested
  )
    return null;
  return counts;
}

export function summarizeBatchDelete(value: unknown): string {
  const counts = batchDeleteCounts(value);
  if (!counts) return '批量删除已结束，但统计回执无效；请核对目录与任务详情。';
  const skipped =
    counts.skipped.groupIds.length + counts.skipped.asinIds.length;
  const failed =
    value && typeof value === 'object' && 'failedCount' in value
      ? value.failedCount
      : undefined;
  return `请求 ${counts.totalRequested} 项，实际删除变体组 ${
    counts.deletedGroupCount
  } 个、直接 ASIN ${counts.deletedDirectAsinCount} 个、组内 ASIN ${
    counts.deletedNestedAsinCount
  } 个，跳过 ${skipped} 项${
    typeof failed === 'number' && failed > 0 ? `，失败分块 ${failed} 个` : ''
  }。`;
}

function uncertainTask(error: unknown): string | null {
  if (
    !(error instanceof ApiError) ||
    !['HTTP', 'BUSINESS'].includes(error.kind) ||
    (error.status ?? 0) < 500 ||
    !error.data ||
    typeof error.data !== 'object'
  )
    return null;
  const receipt = error.data as Record<string, unknown>;
  return typeof receipt.taskId === 'string' &&
    isValidTaskId(receipt.taskId) &&
    receipt.status === 'unknown'
    ? receipt.taskId
    : null;
}

export async function submitCatalogBatchDelete(
  http: Pick<HttpClient, 'request'>,
  domain: 'asin' | 'competitor',
  input: BatchDeleteVariantGroupsRequest,
  signal?: AbortSignal,
): Promise<CatalogBatchDeleteOutcome> {
  const parsed = batchDeleteVariantGroupsRequestSchema.safeParse(input);
  const ids = [...(input.groupIds ?? []), ...(input.asinIds ?? [])];
  if (
    !parsed.success ||
    !ids.length ||
    ids.length > 1000 ||
    ids.some((id) => !isBulkDeleteId(id))
  )
    throw new ApiError(
      'INVALID_INPUT',
      '请选择最多 1000 项；含前后空格的原始 ID 请使用单项删除。',
    );
  try {
    const response = await http.request(
      domain === 'competitor'
        ? '/api/v1/competitor/variant-groups/batch-delete'
        : '/api/v1/variant-groups/batch-delete',
      { method: 'POST', json: parsed.data, signal, timeoutMs: 30_000 },
      domain === 'competitor'
        ? competitorBatchDeleteResultSchema
        : batchDeleteVariantGroupsResultSchema,
    );
    if (response.success !== true || !response.data)
      throw new ApiError('INVALID_RESPONSE', '批量删除响应缺少数据');
    if (response.data.mode === 'sync') {
      const counts = batchDeleteCounts(response.data);
      if (!counts) throw new ApiError('INVALID_RESPONSE', '批量删除统计无效');
      return counts;
    }
    if (
      !isValidTaskId(response.data.taskId) ||
      response.data.status !== 'pending'
    )
      throw new ApiError('INVALID_RESPONSE', '批量删除任务回执无效');
    return { mode: 'async', taskId: response.data.taskId, status: 'pending' };
  } catch (error) {
    const taskId = uncertainTask(error);
    if (taskId) return { mode: 'async', taskId, status: 'unknown' };
    throw error;
  }
}
