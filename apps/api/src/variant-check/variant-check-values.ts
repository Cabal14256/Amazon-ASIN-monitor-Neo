import {
  variantCheckJobSchema,
  type VariantCheckJobData,
} from '@asin-monitor/contracts';
import { VariantCheckError } from '@asin-monitor/db';
import { normalizeCountry } from '@asin-monitor/sp-api';

export type CheckSubType = VariantCheckJobData['taskSubType'];
type RequestOf<T> = T extends VariantCheckJobData
  ? Pick<T, 'taskType' | 'taskSubType' | 'params'>
  : never;
export type CheckRequest = RequestOf<VariantCheckJobData>;
export function checkRequestObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new VariantCheckError('invalid-input');
  return value as Record<string, unknown>;
}
function booleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (!['string', 'number'].includes(typeof value)) return undefined;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return undefined;
}
export function useAsyncCheck(
  body: Record<string, unknown>,
  query: Record<string, unknown>,
  authenticated: boolean,
): boolean {
  return (
    booleanFlag(body.useAsync) ?? booleanFlag(query.useAsync) ?? authenticated
  );
}
export function parseCheckRequest(
  type: CheckSubType,
  id: unknown,
  body: Record<string, unknown>,
  query: Record<string, unknown>,
): CheckRequest {
  try {
    if (type === 'asin-check')
      return {
        taskType: 'variant-check',
        taskSubType: type,
        params: variantCheckJobSchema.options[0].shape.params.parse({
          asinId: id,
          forceRefresh:
            query.forceRefresh !== 'false' && body.forceRefresh !== false,
        }),
      };
    if (type === 'variant-group-check')
      return {
        taskType: 'variant-check',
        taskSubType: type,
        params: variantCheckJobSchema.options[1].shape.params.parse({
          groupId: id,
          forceRefresh:
            query.forceRefresh !== 'false' && body.forceRefresh !== false,
        }),
      };
    if (type === 'parent-asin-query') {
      const params = variantCheckJobSchema.options[2].shape.params.parse({
        asins: body.asins,
        country: body.country,
      });
      params.country = normalizeCountry(params.country);
      return { taskType: 'variant-check', taskSubType: type, params };
    }
    if (type === 'variant-group')
      return {
        taskType: 'batch-check',
        taskSubType: type,
        params: variantCheckJobSchema.options[3].shape.params.parse({
          groupIds: body.groupIds,
          forceRefresh: body.forceRefresh !== false,
          ...(body.country === undefined ? {} : { country: body.country }),
        }),
      };
  } catch {
    throw new VariantCheckError('invalid-input');
  }
  throw new VariantCheckError('invalid-input');
}
export const checkTaskTitle: Record<CheckSubType, string> = {
  'asin-check': 'ASIN检查',
  'variant-group-check': '变体组检查',
  'parent-asin-query': '父体查询',
  'variant-group': '批量变体检查',
};
