import { z } from 'zod';
import { parentAsinCodeSchema } from './variantCheck';

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\x00-\x1f\x7f]+$/u);
const identity = {
  taskId: z.string().uuid(),
  userId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\x00-\x1f\x7f]+$/u),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};
/** Private BullMQ payload. Queue kind and business subtype remain distinct. */
export const variantCheckJobSchema = z.discriminatedUnion('taskSubType', [
  z
    .object({
      ...identity,
      taskType: z.literal('variant-check'),
      taskSubType: z.literal('asin-check'),
      params: z
        .object({ asinId: identifier, forceRefresh: z.boolean() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...identity,
      taskType: z.literal('variant-check'),
      taskSubType: z.literal('variant-group-check'),
      params: z
        .object({ groupId: identifier, forceRefresh: z.boolean() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...identity,
      taskType: z.literal('variant-check'),
      taskSubType: z.literal('parent-asin-query'),
      params: z
        .object({
          asins: z.array(parentAsinCodeSchema).min(1).max(1000),
          country: z.string().min(1).max(10),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...identity,
      taskType: z.literal('batch-check'),
      taskSubType: z.literal('variant-group'),
      params: z
        .object({
          groupIds: z.array(identifier).min(1).max(1000),
          forceRefresh: z.boolean(),
          country: z.string().max(10).optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type VariantCheckJobData = z.infer<typeof variantCheckJobSchema>;

/** Complete results live in PostgreSQL; this small reference fits task metadata
 * and queue completion notifications without copying upstream payloads into Redis. */
export const variantCheckResultReferenceSchema = z
  .object({
    kind: z.literal('variant-check-receipt'),
    version: z.literal(1),
    operationKey: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime(),
    resultKind: z.enum(['asin', 'group', 'parent', 'batch']),
  })
  .strict();
export type VariantCheckResultReference = z.infer<
  typeof variantCheckResultReferenceSchema
>;
