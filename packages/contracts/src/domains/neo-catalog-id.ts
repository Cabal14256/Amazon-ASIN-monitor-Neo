import { z } from 'zod';

/** A PostgreSQL varchar(50) catalog key is literal, including whitespace.
 * Never normalize before checking or addressing a migrated record. */
export function isNeoCatalogId(value: unknown): value is string {
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

export const neoCatalogIdSchema = z.string().refine(isNeoCatalogId, {
  message: '目录 ID 必须为 1 至 50 码点的原始可编码字符串',
});
