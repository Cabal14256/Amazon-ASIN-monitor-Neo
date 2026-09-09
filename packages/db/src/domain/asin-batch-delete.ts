import { z } from 'zod';

export const MAX_ASIN_BATCH_DELETE_TARGETS = 1000;
const jobIds = z
  .array(z.string().min(1).max(100))
  .max(MAX_ASIN_BATCH_DELETE_TARGETS);
export const asinBatchDeleteTaskDataSchema = z
  .object({
    taskId: z.string().uuid(),
    taskType: z.literal('batch-delete'),
    taskSubType: z.literal('variant-group-delete'),
    domain: z.literal('asin'),
    title: z.literal('批量删除变体组'),
    userId: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    groupIds: jobIds,
    asinIds: jobIds,
  })
  .strict()
  .superRefine((data, ctx) => {
    try {
      const normalized = parseBatchDeleteRequest({
        groupIds: data.groupIds,
        asinIds: data.asinIds,
      });
      if (
        JSON.stringify(normalized.groupIds) !== JSON.stringify(data.groupIds) ||
        JSON.stringify(normalized.asinIds) !== JSON.stringify(data.asinIds)
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid batch deletion targets',
      });
    }
  });
export type AsinBatchDeleteTaskData = z.infer<
  typeof asinBatchDeleteTaskDataSchema
>;
export const DEFAULT_BATCH_DELETE_LIMITS = {
  syncMaxItems: 50,
  syncMaxAsins: 500,
  chunkSize: 50,
} as const;
export interface BatchDeleteLimits {
  syncMaxItems: number;
  syncMaxAsins: number;
  chunkSize: number;
}
export interface BatchDeleteIds {
  groupIds: string[];
  asinIds: string[];
}
export interface BatchDeleteRequest extends BatchDeleteIds {
  useAsync?: boolean;
}
export interface BatchDeleteCounts {
  totalRequested: number;
  deletedGroupCount: number;
  deletedDirectAsinCount: number;
  deletedNestedAsinCount: number;
  skipped: BatchDeleteIds;
}
export interface BatchDeleteAnalysis extends BatchDeleteCounts {
  domain: 'asin';
  taskSubType: 'variant-group';
  requestedGroupIds: string[];
  requestedAsinIds: string[];
  groupIds: string[];
  directAsinIds: string[];
  directAsinGroupIds: string[];
  estimatedAsinCount: number;
}
export class BatchDeleteInputError extends Error {
  constructor(readonly code: 'input' | 'capacity' = 'input') {
    super('Invalid ASIN batch deletion request');
  }
}
export function normalizeBatchDeleteMode(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const mode = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(mode)) return true;
  if (['false', '0', 'no', 'off'].includes(mode)) return false;
  return undefined;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    let id: string;
    try {
      id = String(item || '').trim();
    } catch {
      throw new BatchDeleteInputError();
    }
    if (!id) continue;
    if (id.length > 100 || [...id].length > 50 || /[\x00-\x1f\x7f]/.test(id))
      throw new BatchDeleteInputError();
    result.add(id);
  }
  return [...result];
}
/** Preserve Legacy scalar coercion, trimming and deduplication, within storage/queue bounds. */
export function parseBatchDeleteRequest(value: unknown): BatchDeleteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BatchDeleteInputError();
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => !['groupIds', 'asinIds', 'useAsync'].includes(key),
    )
  )
    throw new BatchDeleteInputError();
  const count =
    (Array.isArray(raw.groupIds) ? raw.groupIds.length : 0) +
    (Array.isArray(raw.asinIds) ? raw.asinIds.length : 0);
  if (count > MAX_ASIN_BATCH_DELETE_TARGETS)
    throw new BatchDeleteInputError('capacity');
  const groupIds = ids(raw.groupIds),
    asinIds = ids(raw.asinIds);
  if (!groupIds.length && !asinIds.length) throw new BatchDeleteInputError();
  const useAsync = normalizeBatchDeleteMode(raw.useAsync);
  return { groupIds, asinIds, ...(useAsync === undefined ? {} : { useAsync }) };
}
/** Query adapters supply current rows; ordering and overlap follow the requested ID lists. */
export function buildBatchDeleteAnalysis(
  requested: BatchDeleteIds,
  existingGroupIds: string[],
  asinRows: { id: string; variantGroupId: string }[],
  nestedCount: number,
): BatchDeleteAnalysis {
  if (!Number.isSafeInteger(nestedCount) || nestedCount < 0)
    throw new Error('Invalid batch delete count');
  const groups = new Set(existingGroupIds);
  const groupIds = requested.groupIds.filter((id) => groups.has(id));
  const selectedGroups = new Set(groupIds),
    asins = new Map(asinRows.map((row) => [row.id, row]));
  const direct = requested.asinIds.flatMap((id) => {
    const row = asins.get(id);
    return row && !selectedGroups.has(row.variantGroupId) ? [row] : [];
  });
  return {
    domain: 'asin',
    taskSubType: 'variant-group',
    totalRequested: requested.groupIds.length + requested.asinIds.length,
    requestedGroupIds: [...requested.groupIds],
    requestedAsinIds: [...requested.asinIds],
    groupIds,
    directAsinIds: direct.map((row) => row.id),
    directAsinGroupIds: [...new Set(direct.map((row) => row.variantGroupId))],
    skipped: {
      groupIds: requested.groupIds.filter((id) => !groups.has(id)),
      asinIds: requested.asinIds.filter((id) => !asins.has(id)),
    },
    deletedGroupCount: groupIds.length,
    deletedDirectAsinCount: direct.length,
    deletedNestedAsinCount: nestedCount,
    estimatedAsinCount: nestedCount + direct.length,
  };
}
export function useAsyncBatchDelete(
  analysis: Pick<BatchDeleteAnalysis, 'totalRequested' | 'estimatedAsinCount'>,
  mode: boolean | undefined,
  limits: BatchDeleteLimits,
): boolean {
  return (
    mode ??
    (analysis.totalRequested > limits.syncMaxItems ||
      analysis.estimatedAsinCount > limits.syncMaxAsins)
  );
}
export function batchDeleteSyncResult(result: BatchDeleteCounts) {
  return {
    mode: 'sync' as const,
    totalRequested: result.totalRequested,
    deletedGroupCount: result.deletedGroupCount,
    deletedDirectAsinCount: result.deletedDirectAsinCount,
    deletedNestedAsinCount: result.deletedNestedAsinCount,
    skipped: {
      groupIds: [...result.skipped.groupIds],
      asinIds: [...result.skipped.asinIds],
    },
  };
}
export function splitBatchDeletePlan(
  analysis: Pick<BatchDeleteAnalysis, 'groupIds' | 'directAsinIds'>,
  chunkSize: number,
): BatchDeleteIds[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 500)
    throw new Error('Invalid batch delete chunk size');
  const chunks: BatchDeleteIds[] = [];
  for (let i = 0; i < analysis.groupIds.length; i += chunkSize)
    chunks.push({
      groupIds: analysis.groupIds.slice(i, i + chunkSize),
      asinIds: [],
    });
  for (let i = 0; i < analysis.directAsinIds.length; i += chunkSize)
    chunks.push({
      groupIds: [],
      asinIds: analysis.directAsinIds.slice(i, i + chunkSize),
    });
  return chunks;
}
export interface BatchDeleteAggregate
  extends Omit<BatchDeleteCounts, 'skipped'> {
  skipped: { groupIds: Set<string>; asinIds: Set<string> };
  failedCount: number;
  failedSamples: {
    index: number;
    groupCount: number;
    asinCount: number;
    error: string;
  }[];
}
export function createBatchDeleteAggregate(
  totalRequested: number,
): BatchDeleteAggregate {
  return {
    totalRequested,
    deletedGroupCount: 0,
    deletedDirectAsinCount: 0,
    deletedNestedAsinCount: 0,
    skipped: { groupIds: new Set(), asinIds: new Set() },
    failedCount: 0,
    failedSamples: [],
  };
}
export function addBatchDeleteResult(
  target: BatchDeleteAggregate,
  result: BatchDeleteCounts,
) {
  target.deletedGroupCount += result.deletedGroupCount;
  target.deletedDirectAsinCount += result.deletedDirectAsinCount;
  target.deletedNestedAsinCount += result.deletedNestedAsinCount;
  result.skipped.groupIds.forEach((id) => target.skipped.groupIds.add(id));
  result.skipped.asinIds.forEach((id) => target.skipped.asinIds.add(id));
}
export function batchDeleteTaskResult(result: BatchDeleteAggregate) {
  const skipped = {
    groupIds: [...result.skipped.groupIds],
    asinIds: [...result.skipped.asinIds],
  };
  const skippedCount = skipped.groupIds.length + skipped.asinIds.length;
  const warnings: string[] = [];
  if (skippedCount)
    warnings.push(`有 ${skippedCount} 个删除目标不存在或已被删除`);
  if (result.failedCount)
    warnings.push(`有 ${result.failedCount} 个删除分块失败`);
  return {
    mode: 'async' as const,
    totalRequested: result.totalRequested,
    deletedGroupCount: result.deletedGroupCount,
    deletedDirectAsinCount: result.deletedDirectAsinCount,
    deletedNestedAsinCount: result.deletedNestedAsinCount,
    skippedCount,
    skipped,
    failedCount: result.failedCount,
    failedSamples: result.failedSamples,
    total: result.totalRequested,
    summary: `共 ${result.totalRequested} 项，删除变体组 ${result.deletedGroupCount} 个，直接删除 ASIN ${result.deletedDirectAsinCount} 个，组内级联 ASIN ${result.deletedNestedAsinCount} 个，跳过 ${skippedCount} 个`,
    verificationPassed: result.failedCount === 0,
    warnings,
  };
}
