import {
  batchCreateAsinsRequestSchema,
  competitorCreateAsinRequestSchema,
  competitorFeishuNotifyRequestSchema,
  competitorGroupUpsertRequestSchema,
  competitorMoveAsinRequestSchema,
  competitorUpdateAsinRequestSchema,
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
  .extend({ ...asinFields, parentId: id })
  .strict();
const updateSchema = competitorUpdateAsinRequestSchema
  .extend(asinFields)
  .strict();
const moveSchema = competitorMoveAsinRequestSchema
  .extend({ targetGroupId: id })
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
export const parseCompetitorAsinCreate = (value: unknown) =>
  normalizeName(parse(createSchema, value));
export const parseCompetitorAsinUpdate = (value: unknown) =>
  normalizeName(parse(updateSchema, value));
export const parseCompetitorAsinMove = (value: unknown) =>
  parse(moveSchema, value);
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
