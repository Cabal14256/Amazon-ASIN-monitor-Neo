import {
  batchCreateAsinsRequestSchema,
  competitorAsinSourceSchema,
  competitorCreateAsinRequestSchema,
  competitorDeleteAsinRequestSchema,
  competitorDeleteGroupRequestSchema,
  competitorFeishuNotifyRequestSchema,
  competitorGroupSourceSchema,
  competitorGroupUpsertRequestSchema,
  competitorGuardedUpdateAsinRequestSchema,
  competitorMoveAsinRequestSchema,
  competitorUpdateGroupRequestSchema,
} from '@asin-monitor/contracts';
import { MAX_ASIN_BATCH_CREATE_ITEMS } from '@asin-monitor/db';
import { z } from 'zod';

export class CompetitorWriteInputError extends Error {
  constructor(readonly code: 'input' | 'notify' | 'batch-empty' = 'input') {
    super('Invalid competitor write request');
  }
}
const text = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((value) => [...value].length <= max)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const required = (max: number) => text(max).refine((value) => !!value.trim());
// Snapshots describe persisted Legacy values, including empty or control
// whitespace. PostgreSQL varchar limits count characters and cannot store NUL.
const persistedText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((value) => [...value].length <= max)
    .refine((value) => !value.includes('\u0000'));
const groupSource = competitorGroupSourceSchema
  .extend({
    name: persistedText(255),
    country: persistedText(10),
    brand: persistedText(100),
    updateTime: z.string().max(50).nullable().optional(),
  })
  .strict();
const normalizedCode = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value))
    .transform((value) => value.trim().toUpperCase())
    .pipe(required(max));
const id = required(50);
const common = { country: normalizedCode(10), brand: required(100) };
// The actual Legacy controller accepts falsy type values as unspecified.
const asinType = competitorCreateAsinRequestSchema.shape.asinType.transform(
  (value): '1' | '2' | null => (value ? (String(value) as '1' | '2') : null),
);
const asinFields = {
  ...common,
  asin: normalizedCode(20),
  name: text(500).nullable().optional(),
  asinType,
};
const groupSchema = competitorGroupUpsertRequestSchema
  .extend({ ...common, name: required(255) })
  .strict();
const createSchema = competitorCreateAsinRequestSchema
  .extend({
    ...asinFields,
    parentId: id,
    expectedParent: groupSource.optional(),
  })
  .strict();
const updateSchema = competitorGuardedUpdateAsinRequestSchema
  .extend({
    ...asinFields,
    expectedSource: competitorAsinSourceSchema
      .extend({
        variantGroupId: id,
        asin: persistedText(20),
        name: persistedText(500).nullable(),
        country: persistedText(10),
        brand: persistedText(100).nullable(),
        asinType: z.enum(['1', '2']).nullable(),
        updateTime: z.string().max(50).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const updateGroupSchema = competitorUpdateGroupRequestSchema
  .extend({
    ...common,
    name: required(255),
    expectedSource: groupSource.optional(),
  })
  .strict();
const deleteAsinSchema = competitorDeleteAsinRequestSchema.extend({
  expectedSource: updateSchema.shape.expectedSource,
});
const moveSchema = competitorMoveAsinRequestSchema
  .extend({
    targetGroupId: id,
    expectedSourceGroup: id.optional(),
    expectedTargetSnapshot: groupSource.extend({ id }).strict().optional(),
  })
  .strict();
const deleteGroupSchema = competitorDeleteGroupRequestSchema
  .extend({
    expectedChildIds: z.array(id).max(5000).optional(),
    expectedSource: updateGroupSchema.shape.expectedSource,
  })
  .strict();
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 20
  )
    throw new CompetitorWriteInputError();
  const result = schema.safeParse(value);
  if (!result.success) throw new CompetitorWriteInputError();
  return result.data;
}
function normalizeName<T extends { name?: string | null }>(value: T) {
  return { ...value, name: value.name || null };
}
export const parseCompetitorGroupWrite = (value: unknown) =>
  parse(groupSchema, value);
export const parseCompetitorGroupUpdate = (value: unknown) =>
  parse(updateGroupSchema, value);
export const parseCompetitorAsinCreate = (value: unknown) =>
  normalizeName(parse(createSchema, value));
export const parseCompetitorAsinUpdate = (value: unknown) =>
  normalizeName(parse(updateSchema, value));
export const parseCompetitorAsinDelete = (value: unknown) =>
  parse(deleteAsinSchema, value ?? {});
export const parseCompetitorAsinMove = (value: unknown) =>
  parse(moveSchema, value);
export function parseCompetitorGroupDelete(value: unknown) {
  const result = parse(deleteGroupSchema, value ?? {});
  const { expectedChildIds } = result;
  if (
    expectedChildIds &&
    new Set(expectedChildIds).size !== expectedChildIds.length
  )
    throw new CompetitorWriteInputError();
  return result;
}
export function parseCompetitorBatchCreate(value: unknown): unknown[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.length)
    throw new CompetitorWriteInputError('batch-empty');
  return parse(
    batchCreateAsinsRequestSchema
      .extend({
        items: z.array(z.unknown()).min(1).max(MAX_ASIN_BATCH_CREATE_ITEMS),
      })
      .strict(),
    value,
  ).items;
}
export function parseCompetitorNotify(value: unknown): boolean {
  try {
    const { enabled } = parse(
      competitorFeishuNotifyRequestSchema.strict(),
      value,
    );
    return enabled === true || enabled === 1;
  } catch (error) {
    if (error instanceof CompetitorWriteInputError)
      throw new CompetitorWriteInputError('notify');
    throw error;
  }
}
export function parseCompetitorWriteId(value: unknown) {
  const result = id.safeParse(value);
  if (!result.success) throw new CompetitorWriteInputError();
  return result.data;
}
