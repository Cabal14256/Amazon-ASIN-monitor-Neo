import { z } from 'zod';

export const NEO_BATCH_DELETE_MAX_TARGETS = 1000;

/** A migrated catalog ID is a literal key, including every whitespace character.
 * Reject values PostgreSQL cannot encode and bound by database codepoints. */
export function isNeoBatchDeleteId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      ++length > 50 ||
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      return false;
  }
  return true;
}

export const neoBatchDeleteIdSchema = z.string().refine(isNeoBatchDeleteId, {
  message: '删除 ID 必须为 1 至 50 码点的原始可编码字符串',
});
const list = z.array(neoBatchDeleteIdSchema).max(NEO_BATCH_DELETE_MAX_TARGETS);
const targets = { groupIds: list.optional(), asinIds: list.optional() };
function validateCount(
  value: { groupIds?: string[]; asinIds?: string[] },
  ctx: z.RefinementCtx,
) {
  const count = (value.groupIds?.length ?? 0) + (value.asinIds?.length ?? 0);
  if (count === 0 || count > NEO_BATCH_DELETE_MAX_TARGETS)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `删除目标数量必须为 1 至 ${NEO_BATCH_DELETE_MAX_TARGETS}`,
      path: ['groupIds'],
    });
}

/** Neo boundary; the frozen Legacy v1 request schema remains unchanged. */
export const neoBatchDeleteTargetsSchema = z
  .object(targets)
  .strict()
  .superRefine(validateCount);
export const neoBatchDeleteVariantGroupsRequestSchema = z
  .object({ ...targets, useAsync: z.boolean().optional() })
  .strict()
  .superRefine(validateCount);
export type NeoBatchDeleteVariantGroupsRequest = z.infer<
  typeof neoBatchDeleteVariantGroupsRequestSchema
>;
