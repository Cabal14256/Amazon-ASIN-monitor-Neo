import {
  batchCheckSyncDataSchema,
  parentAsinQueryItemSchema,
  variantGroupCheckDataSchema,
  variantViewSchema,
} from '@asin-monitor/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VariantCheckError } from './variant-check';

export const VARIANT_CHECK_RECEIPT_MAX_BYTES = 32 * 1024 * 1024;
const operationSchema = z
  .object({
    operationKey: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    taskId: z.string().uuid(),
    userId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]+$/u),
    taskCreatedAt: z.string().datetime(),
    taskType: z.enum(['variant-check', 'batch-check']),
    taskSubType: z.enum([
      'asin-check',
      'variant-group-check',
      'parent-asin-query',
      'variant-group',
    ]),
    step: z.string().regex(/^(result|group-(?:0|[1-9]\d{0,2}))$/),
    resultKind: z.enum(['asin', 'group', 'parent', 'batch']),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type VariantCheckOperation = z.infer<typeof operationSchema>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function operationKey(
  value: Omit<VariantCheckOperation, 'operationKey' | 'requestHash'>,
): string {
  // The request hash is deliberately excluded: replacing a queued payload must
  // conflict with the same operation, not silently create a second write.
  return sha(
    JSON.stringify([
      value.taskId,
      value.userId,
      value.taskCreatedAt,
      value.taskType,
      value.taskSubType,
      value.step,
    ]),
  );
}
function canonicalRequest(value: unknown): string {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 16)
      throw new VariantCheckError('invalid-input');
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item))
      return item.map((child) => visit(child, depth + 1));
    if (
      item &&
      typeof item === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [
            key,
            visit((item as Record<string, unknown>)[key], depth + 1),
          ]),
      );
    throw new VariantCheckError('invalid-input');
  };
  const json = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(json) > 128 * 1024)
    throw new VariantCheckError('invalid-input');
  return json;
}
export function createVariantCheckOperation(
  identity: Omit<VariantCheckOperation, 'operationKey' | 'requestHash'>,
  request: unknown,
): VariantCheckOperation {
  return parseVariantCheckOperation({
    ...identity,
    operationKey: operationKey(identity),
    requestHash: sha(canonicalRequest(request)),
  });
}
export function parseVariantCheckOperation(
  value: unknown,
): VariantCheckOperation {
  const parsed = operationSchema.safeParse(value);
  if (!parsed.success) throw new VariantCheckError('invalid-input');
  const result = parsed.data;
  const created = Date.parse(result.taskCreatedAt),
    expires = Date.parse(result.expiresAt);
  const pair = `${result.taskType}/${result.taskSubType}/${result.resultKind}`;
  if (
    result.operationKey !== operationKey(result) ||
    new Date(created).toISOString() !== result.taskCreatedAt ||
    new Date(expires).toISOString() !== result.expiresAt ||
    expires <= created ||
    expires - created > 31_536_000_000 ||
    ![
      'variant-check/asin-check/asin',
      'variant-check/variant-group-check/group',
      'variant-check/parent-asin-query/parent',
      'batch-check/variant-group/group',
      'batch-check/variant-group/batch',
    ].includes(pair) ||
    (result.resultKind === 'group' && result.taskType === 'batch-check'
      ? result.step === 'result'
      : result.step !== 'result')
  )
    throw new VariantCheckError('invalid-input');
  return result;
}
export function assertVariantCheckOperationRequest(
  operation: VariantCheckOperation,
  request: unknown,
): void {
  if (
    parseVariantCheckOperation(operation).requestHash !==
    sha(canonicalRequest(request))
  )
    throw new VariantCheckError('operation-mismatch');
}
export function decodeVariantCheckReceiptResult(
  value: unknown,
  kind: VariantCheckOperation['resultKind'],
): unknown {
  try {
    const raw = JSON.stringify(value);
    if (!raw || Buffer.byteLength(raw) > VARIANT_CHECK_RECEIPT_MAX_BYTES)
      throw new VariantCheckError('capacity');
    const detached: unknown = JSON.parse(raw);
    const schema =
      kind === 'asin'
        ? variantViewSchema
        : kind === 'group'
        ? variantGroupCheckDataSchema.required({
            groupSnapshot: true,
            details: true,
            brokenASINs: true,
            brokenByType: true,
          })
        : kind === 'parent'
        ? z.array(parentAsinQueryItemSchema).max(1000)
        : batchCheckSyncDataSchema.passthrough();
    if (!schema.safeParse(detached).success)
      throw new VariantCheckError('invalid-result');
    // Validate without dropping any frozen raw or passthrough business fields.
    return detached;
  } catch (error) {
    if (error instanceof VariantCheckError) throw error;
    throw new VariantCheckError('invalid-result');
  }
}
