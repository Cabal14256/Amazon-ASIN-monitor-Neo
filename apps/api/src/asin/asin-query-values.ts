import { variantGroupListQuerySchema } from '@asin-monitor/contracts';
import type { AsinGroupQuery } from '@asin-monitor/db';
import { z } from 'zod';

export class AsinQueryInputError extends Error {
  constructor() {
    super('Invalid ASIN query');
  }
}
const boundedText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const querySchema = variantGroupListQuerySchema.extend({
  keyword: boundedText(200).optional(),
  country: boundedText(10).optional(),
  variantStatus: z
    .union([z.enum(['BROKEN', 'NORMAL']), z.literal('')])
    .optional(),
  current: z.coerce.number().int().positive().safe().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(10),
});
export function parseAsinGroupQuery(value: unknown): AsinGroupQuery {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 20 ||
    Object.values(value).some((item) => typeof item !== 'string')
  )
    throw new AsinQueryInputError();
  const raw = value as Record<string, string>;
  // Legacy controller treats empty pagination values as omitted.
  const parsed = querySchema.safeParse({
    ...raw,
    current: raw.current || undefined,
    pageSize: raw.pageSize || undefined,
  });
  if (!parsed.success) throw new AsinQueryInputError();
  const offset = (parsed.data.current - 1) * parsed.data.pageSize;
  if (!Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new AsinQueryInputError();
  return {
    ...parsed.data,
    variantStatus: parsed.data.variantStatus || undefined,
  };
}
export function parseAsinGroupId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value].length > 50 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new AsinQueryInputError();
  return value;
}
