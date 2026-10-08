import {
  competitorAsinRecordResultSchema,
  competitorCreateAsinRequestSchema,
  competitorDeleteAsinRequestSchema,
  competitorDeleteAsinResultSchema,
  competitorDeleteGroupRequestSchema,
  competitorDeleteGroupResultSchema,
  competitorGroupListResultSchema,
  competitorGroupResultSchema,
  competitorGroupUpsertRequestSchema,
  competitorGuardedUpdateAsinRequestSchema,
  competitorMoveAsinRequestSchema,
  competitorUpdateGroupRequestSchema,
  type BatchDeleteVariantGroupsRequest,
  type CompetitorAsinSource,
  type CompetitorCreateAsinRequest,
  type CompetitorGroupListData,
  type CompetitorGroupListQuery,
  type CompetitorGroupSource,
  type CompetitorGroupUpsertRequest,
  type CompetitorGuardedUpdateAsinRequest,
  type CompetitorMoveAsinRequest,
  type CompetitorUpdateGroupRequest,
  type CompetitorVariantGroup,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';
import { submitCatalogBatchDelete } from './catalog-batch-delete';

export function batchDeleteCompetitorGroups(
  http: Pick<HttpClient, 'request'>,
  input: BatchDeleteVariantGroupsRequest,
  signal?: AbortSignal,
) {
  return submitCatalogBatchDelete(http, 'competitor', input, signal);
}

const RESPONSE_LIMIT = 32 * 1024 * 1024;
const GROUPS = '/api/v1/competitor/variant-groups';
const ASINS = '/api/v1/competitor/asins';
const GROUP_OPTIONS = { timeoutMs: 120_000, maxResponseBytes: RESPONSE_LIMIT };

function segment(id: string): string {
  if (
    !id.trim() ||
    id === '.' ||
    id === '..' ||
    [...id].length > 50 ||
    /[\\/?#]/.test(id) ||
    [...id].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new ApiError('INVALID_INPUT', '竞品 ASIN 或变体组 ID 无效');
  // Migrated IDs retain their original case, accents and PADSPACE suffix.
  return encodeURIComponent(id);
}

function body<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError('INVALID_INPUT', '请检查竞品 ASIN 表单');
  return parsed.data;
}

function data<T>(response: { success?: boolean; data?: T }): T {
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', '竞品 ASIN 写入响应缺少数据');
  return response.data;
}

export async function getCompetitorGroups(
  http: Pick<HttpClient, 'request'>,
  query: CompetitorGroupListQuery,
  signal?: AbortSignal,
): Promise<CompetitorGroupListData> {
  const response = await http.request(
    GROUPS,
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
    `${GROUPS}/${segment(id)}`,
    { signal, timeoutMs: 30_000, maxResponseBytes: RESPONSE_LIMIT },
    competitorGroupResultSchema,
  );
  if (!response.success || !response.data)
    throw new ApiError('INVALID_RESPONSE', '竞品变体组详情响应缺少数据');
  return response.data;
}

export async function createCompetitorGroup(
  http: Pick<HttpClient, 'request'>,
  input: CompetitorGroupUpsertRequest,
) {
  return data(
    await http.request(
      GROUPS,
      {
        method: 'POST',
        json: body(competitorGroupUpsertRequestSchema, input),
        ...GROUP_OPTIONS,
      },
      competitorGroupResultSchema,
    ),
  );
}

export async function updateCompetitorGroup(
  http: Pick<HttpClient, 'request'>,
  id: string,
  input: CompetitorUpdateGroupRequest,
) {
  return data(
    await http.request(
      `${GROUPS}/${segment(id)}`,
      {
        method: 'PUT',
        json: body(competitorUpdateGroupRequestSchema, input),
        ...GROUP_OPTIONS,
      },
      competitorGroupResultSchema,
    ),
  );
}

export async function deleteCompetitorGroup(
  http: Pick<HttpClient, 'request'>,
  id: string,
  expectedChildIds: string[],
  expectedSource?: CompetitorGroupSource,
) {
  return data(
    await http.request(
      `${GROUPS}/${segment(id)}`,
      {
        method: 'DELETE',
        json: body(competitorDeleteGroupRequestSchema, {
          expectedChildIds,
          expectedSource,
        }),
      },
      competitorDeleteGroupResultSchema,
    ),
  );
}

export async function createCompetitorAsin(
  http: Pick<HttpClient, 'request'>,
  input: CompetitorCreateAsinRequest,
) {
  return data(
    await http.request(
      ASINS,
      { method: 'POST', json: body(competitorCreateAsinRequestSchema, input) },
      competitorAsinRecordResultSchema,
    ),
  );
}

export async function updateCompetitorAsin(
  http: Pick<HttpClient, 'request'>,
  id: string,
  input: CompetitorGuardedUpdateAsinRequest,
) {
  return data(
    await http.request(
      `${ASINS}/${segment(id)}`,
      {
        method: 'PUT',
        json: body(competitorGuardedUpdateAsinRequestSchema, input),
      },
      competitorAsinRecordResultSchema,
    ),
  );
}

export async function moveCompetitorAsin(
  http: Pick<HttpClient, 'request'>,
  id: string,
  input: CompetitorMoveAsinRequest,
) {
  return data(
    await http.request(
      `${ASINS}/${segment(id)}/move`,
      { method: 'POST', json: body(competitorMoveAsinRequestSchema, input) },
      competitorAsinRecordResultSchema,
    ),
  );
}

export async function deleteCompetitorAsin(
  http: Pick<HttpClient, 'request'>,
  id: string,
  expectedSource?: CompetitorAsinSource,
) {
  return data(
    await http.request(
      `${ASINS}/${segment(id)}`,
      {
        method: 'DELETE',
        json: expectedSource
          ? body(competitorDeleteAsinRequestSchema, { expectedSource })
          : undefined,
      },
      competitorDeleteAsinResultSchema,
    ),
  );
}
