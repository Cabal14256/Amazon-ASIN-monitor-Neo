import {
  asinRecordResultSchema,
  createAsinRequestSchema,
  deleteAsinResultSchema,
  deleteVariantGroupResultSchema,
  moveAsinRequestSchema,
  updateAsinRequestSchema,
  variantGroupListResultSchema,
  variantGroupResultSchema,
  variantGroupUpsertRequestSchema,
  type CreateAsinRequest,
  type MoveAsinRequest,
  type UpdateAsinRequest,
  type VariantGroup,
  type VariantGroupListData,
  type VariantGroupListQuery,
  type VariantGroupUpsertRequest,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const ASIN_RESPONSE_LIMIT = 32 * 1024 * 1024;
const GROUPS = '/api/v1/variant-groups';
const ASINS = '/api/v1/asins';

function segment(id: string): string {
  if (
    !id ||
    id === '.' ||
    id === '..' ||
    id.trim() !== id ||
    [...id].length > 50 ||
    /[\\/?#]/.test(id) ||
    [...id].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new ApiError('INVALID_INPUT', 'ASIN 或变体组 ID 无效');
  return encodeURIComponent(id);
}

function body<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('INVALID_INPUT', '请检查 ASIN 表单');
  return parsed.data;
}

function data<T>(response: { success?: boolean; data?: T }): T {
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', 'ASIN 写入响应缺少数据');
  return response.data;
}

/** Neo read routes share the request layer's normalized /api prefix. */
export async function getVariantGroups(
  http: Pick<HttpClient, 'request'>,
  query: VariantGroupListQuery,
  signal?: AbortSignal,
): Promise<VariantGroupListData> {
  const response = await http.request(
    GROUPS,
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
    `${GROUPS}/${segment(id)}`,
    { signal, timeoutMs: 120_000, maxResponseBytes: ASIN_RESPONSE_LIMIT },
    variantGroupResultSchema,
  );
  if (!response.success || !response.data)
    throw new ApiError('INVALID_RESPONSE', '变体组详情响应缺少数据');
  return response.data;
}

export async function createVariantGroup(
  http: Pick<HttpClient, 'request'>,
  input: VariantGroupUpsertRequest,
) {
  return data(
    await http.request(
      GROUPS,
      {
        method: 'POST',
        json: body(variantGroupUpsertRequestSchema, input),
      },
      variantGroupResultSchema,
    ),
  );
}

export async function updateVariantGroup(
  http: Pick<HttpClient, 'request'>,
  id: string,
  input: VariantGroupUpsertRequest,
) {
  return data(
    await http.request(
      `${GROUPS}/${segment(id)}`,
      {
        method: 'PUT',
        json: body(variantGroupUpsertRequestSchema, input),
      },
      variantGroupResultSchema,
    ),
  );
}

export async function deleteVariantGroup(
  http: Pick<HttpClient, 'request'>,
  id: string,
) {
  return data(
    await http.request(
      `${GROUPS}/${segment(id)}`,
      {
        method: 'DELETE',
      },
      deleteVariantGroupResultSchema,
    ),
  );
}

export async function createAsin(
  http: Pick<HttpClient, 'request'>,
  input: CreateAsinRequest,
) {
  return data(
    await http.request(
      ASINS,
      {
        method: 'POST',
        json: body(createAsinRequestSchema, input),
      },
      asinRecordResultSchema,
    ),
  );
}

export async function updateAsin(
  http: Pick<HttpClient, 'request'>,
  id: string,
  input: UpdateAsinRequest,
) {
  return data(
    await http.request(
      `${ASINS}/${segment(id)}`,
      {
        method: 'PUT',
        json: body(updateAsinRequestSchema, input),
      },
      asinRecordResultSchema,
    ),
  );
}

export async function moveAsin(
  http: Pick<HttpClient, 'request'>,
  id: string,
  input: MoveAsinRequest,
) {
  return data(
    await http.request(
      `${ASINS}/${segment(id)}/move`,
      {
        method: 'POST',
        json: body(moveAsinRequestSchema, input),
      },
      asinRecordResultSchema,
    ),
  );
}

export async function deleteAsin(
  http: Pick<HttpClient, 'request'>,
  id: string,
) {
  return data(
    await http.request(
      `${ASINS}/${segment(id)}`,
      {
        method: 'DELETE',
      },
      deleteAsinResultSchema,
    ),
  );
}
