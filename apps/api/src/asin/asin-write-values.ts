import {
  createAsinRequestSchema,
  feishuNotifyRequestSchema,
  moveAsinRequestSchema,
  updateAsinRequestSchema,
  variantGroupUpsertRequestSchema,
} from '@asin-monitor/contracts';
import { z } from 'zod';

export class AsinWriteInputError extends Error {
  constructor() {
    super('Invalid ASIN write request');
  }
}
const text = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((value) => [...value].length <= max)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const required = (max: number) =>
  text(max).refine((value) => value.trim().length > 0);
const id = required(50);
const common = {
  country: required(10),
  site: required(100),
  brand: required(100),
};
const groupSchema = variantGroupUpsertRequestSchema
  .extend({ ...common, name: required(255) })
  .strict();
const asinFields = {
  ...common,
  asin: required(20),
  name: text(500).nullable().optional(),
};
const createSchema = createAsinRequestSchema
  .extend({ ...asinFields, parentId: id })
  .strict();
const updateSchema = updateAsinRequestSchema.extend(asinFields).strict();
const moveSchema = moveAsinRequestSchema.extend({ targetGroupId: id }).strict();
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 20
  )
    throw new AsinWriteInputError();
  const result = schema.safeParse(value);
  if (!result.success) throw new AsinWriteInputError();
  return result.data;
}
export function parseVariantGroupWrite(value: unknown) {
  return parse(groupSchema, value);
}
export function parseAsinNotify(value: unknown): boolean {
  const { enabled } = parse(feishuNotifyRequestSchema.strict(), value);
  return enabled === true || enabled === 1;
}
function normalizeAsin<
  T extends { name?: string | null; asinType?: string | number | null },
>(value: T) {
  return {
    ...value,
    name: value.name || null,
    asinType:
      value.asinType == null ? null : (String(value.asinType) as '1' | '2'),
  };
}
export function parseAsinCreate(value: unknown) {
  return normalizeAsin(parse(createSchema, value));
}
export function parseAsinUpdate(value: unknown) {
  return normalizeAsin(parse(updateSchema, value));
}
export function parseAsinMove(value: unknown) {
  return parse(moveSchema, value);
}
export function parseAsinWriteId(value: unknown) {
  const result = id.safeParse(value);
  if (!result.success) throw new AsinWriteInputError();
  return result.data;
}
