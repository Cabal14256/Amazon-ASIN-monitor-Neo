import {
  variantCheckJobSchema,
  variantCheckResultReferenceSchema,
  type VariantCheckJobData,
  type VariantCheckResultReference,
} from '@asin-monitor/contracts';
import {
  createVariantCheckOperation,
  parseVariantCheckOperation,
  VariantCheckError,
  type VariantCheckOperation,
} from '@asin-monitor/db';
import { normalizeCountry } from '@asin-monitor/sp-api';

export function parseVariantCheckJob(raw: unknown): VariantCheckJobData {
  const parsed = variantCheckJobSchema.safeParse(raw);
  if (!parsed.success) throw new VariantCheckError('invalid-input');
  const data = parsed.data;
  if ('country' in data.params && data.params.country)
    data.params.country = normalizeCountry(data.params.country);
  variantCheckJobOperation(data);
  return data;
}
export function variantCheckJobOperation(
  data: VariantCheckJobData,
  groupIndex?: number,
): VariantCheckOperation {
  const kind =
    data.taskSubType === 'asin-check'
      ? 'asin'
      : data.taskSubType === 'parent-asin-query'
      ? 'parent'
      : data.taskSubType === 'variant-group-check' || groupIndex !== undefined
      ? 'group'
      : 'batch';
  if (
    groupIndex !== undefined &&
    (data.taskSubType !== 'variant-group' ||
      !Number.isInteger(groupIndex) ||
      groupIndex < 0 ||
      groupIndex >= data.params.groupIds.length)
  )
    throw new VariantCheckError('invalid-input');
  const request =
    data.taskSubType === 'variant-group' && groupIndex !== undefined
      ? {
          groupId: data.params.groupIds[groupIndex],
          forceRefresh: data.params.forceRefresh,
        }
      : data.params;
  return createVariantCheckOperation(
    {
      taskId: data.taskId,
      userId: data.userId,
      taskCreatedAt: data.createdAt,
      taskType: data.taskType,
      taskSubType: data.taskSubType,
      expiresAt: data.expiresAt,
      resultKind: kind,
      step: groupIndex === undefined ? 'result' : `group-${groupIndex}`,
    },
    request,
  );
}
export function variantCheckResultReference(
  operation: VariantCheckOperation,
): VariantCheckResultReference {
  const value = parseVariantCheckOperation(operation);
  if (value.step !== 'result') throw new VariantCheckError('invalid-input');
  return {
    kind: 'variant-check-receipt',
    version: 1,
    operationKey: value.operationKey,
    requestHash: value.requestHash,
    expiresAt: value.expiresAt,
    resultKind: value.resultKind,
  };
}
/** Never trust the owner or task incarnation supplied by a result reference. */
export function variantCheckResultOperation(
  task: {
    taskId: string;
    userId: string | null;
    createdAt: string | null;
    taskType: string;
    taskSubType: string | null;
  },
  reference: unknown,
): VariantCheckOperation {
  const parsed = variantCheckResultReferenceSchema.safeParse(reference);
  if (!parsed.success) throw new VariantCheckError('invalid-result');
  const { kind: _kind, version: _version, ...fields } = parsed.data;
  return parseVariantCheckOperation({
    ...fields,
    taskId: task.taskId,
    userId: task.userId,
    taskCreatedAt: task.createdAt,
    taskType: task.taskType,
    taskSubType: task.taskSubType,
    step: 'result',
  });
}
