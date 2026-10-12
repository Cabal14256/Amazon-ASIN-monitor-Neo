import {
  batchCheckRequestSchema,
  batchCheckResultSchema,
  competitorCheckResultSchema,
  variantCheckTaskDataSchema,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';
import { isValidTaskId } from './tasks';

type TaskReceipt = {
  kind: 'task';
  taskId: string;
  status: 'pending' | 'unknown';
};
type Subtype =
  | 'variant-group'
  | 'competitor-variant-group-check'
  | 'competitor-asin-check';

/** JSON identifiers retain migrated case, Unicode and ordinary spaces. */
export function isCheckGroupId(id: string): boolean {
  return (
    Boolean(id) &&
    [...id].length <= 50 &&
    ![...id].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  );
}
function receipt(
  value: unknown,
  subtype: Subtype,
  status: TaskReceipt['status'],
  total?: number,
): TaskReceipt | null {
  const parsed = variantCheckTaskDataSchema.safeParse(value);
  if (
    !parsed.success ||
    !isValidTaskId(parsed.data.taskId) ||
    parsed.data.status !== status ||
    (parsed.data.taskType !== undefined && parsed.data.taskType !== subtype) ||
    (total !== undefined &&
      parsed.data.total !== undefined &&
      parsed.data.total !== total)
  )
    return null;
  return { kind: 'task', taskId: parsed.data.taskId, status };
}
async function submit(
  send: () => Promise<{ success?: boolean; data?: unknown }>,
  subtype: Subtype,
  total?: number,
): Promise<TaskReceipt> {
  try {
    const response = await send();
    const parsed =
      response.success === true
        ? receipt(response.data, subtype, 'pending', total)
        : null;
    if (!parsed)
      throw new ApiError(
        'INVALID_RESPONSE',
        '异步检查任务回执无效，请先核实任务中心。',
      );
    return parsed;
  } catch (error) {
    const uncertain =
      error instanceof ApiError && error.status === 500
        ? receipt(error.data, subtype, 'unknown', total)
        : null;
    if (uncertain) return uncertain;
    throw error;
  }
}
export async function checkSelectedGroups(
  http: Pick<HttpClient, 'request'>,
  groupIds: string[],
  options: { forceRefresh: boolean },
  signal?: AbortSignal,
): Promise<TaskReceipt> {
  if (
    !groupIds.length ||
    groupIds.length > 1000 ||
    groupIds.some((id) => !isCheckGroupId(id)) ||
    new Set(groupIds).size !== groupIds.length
  )
    throw new ApiError('INVALID_INPUT', '请选择 1–1000 个不同的有效变体组。');
  const input = batchCheckRequestSchema.parse({
    groupIds,
    forceRefresh: options.forceRefresh,
    useAsync: true,
  });
  return submit(
    () =>
      http.request(
        '/api/v1/variant-groups/batch-check',
        {
          method: 'POST',
          json: input,
          signal,
          timeoutMs: 30_000,
          maxResponseBytes: 1024 * 1024,
        },
        batchCheckResultSchema,
      ),
    'variant-group',
    groupIds.length,
  );
}
function segment(id: string): string {
  if (
    !isCheckGroupId(id) ||
    !id.trim() ||
    id === '.' ||
    id === '..' ||
    /[\\/?#]/.test(id)
  )
    throw new ApiError('INVALID_INPUT', '竞品 ASIN 或变体组 ID 无效。');
  return encodeURIComponent(id);
}
async function checkCompetitor(
  http: Pick<HttpClient, 'request'>,
  kind: 'group' | 'asin',
  id: string,
  options: { forceRefresh: boolean },
  signal?: AbortSignal,
): Promise<TaskReceipt> {
  const path = `/api/v1/competitor/${
    kind === 'group' ? 'variant-groups' : 'asins'
  }/${segment(id)}/check`;
  return submit(
    () =>
      http.request(
        path,
        {
          method: 'POST',
          json: { forceRefresh: options.forceRefresh, useAsync: true },
          signal,
          timeoutMs: 30_000,
          maxResponseBytes: 1024 * 1024,
        },
        competitorCheckResultSchema,
      ),
    kind === 'group'
      ? 'competitor-variant-group-check'
      : 'competitor-asin-check',
  );
}
export const checkCompetitorGroup = (
  http: Pick<HttpClient, 'request'>,
  id: string,
  options: { forceRefresh: boolean },
  signal?: AbortSignal,
) => checkCompetitor(http, 'group', id, options, signal);
export const checkCompetitorAsin = (
  http: Pick<HttpClient, 'request'>,
  id: string,
  options: { forceRefresh: boolean },
  signal?: AbortSignal,
) => checkCompetitor(http, 'asin', id, options, signal);
