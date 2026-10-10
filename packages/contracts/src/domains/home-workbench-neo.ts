import { z } from 'zod';
import { resultSchema } from '../envelope';
import { isNeoBatchDeleteId } from './neo-batch-delete';

const boundedText = (maximum: number, minimum = 0) =>
  z.string().refine((value) => {
    const points = [...value];
    return (
      points.length >= minimum &&
      points.length <= maximum &&
      points.every((point) => {
        const code = point.codePointAt(0)!;
        return code < 0xd800 || code > 0xdfff;
      })
    );
  });
const inputText = (maximum: number, minimum = 1) =>
  boundedText(maximum, minimum).refine(
    (value) => !/[\x00-\x1f\x7f]/.test(value),
  );
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const queryNumber = (maximum: number, fallback: number) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
    z.number().int().min(1).max(maximum).default(fallback),
  );

/** Neo-only addition: the frozen Legacy endpoint inventory is unchanged. */
export const homeWorkbenchQuerySchema = z
  .object({
    country: inputText(10).optional(),
    site: inputText(100).optional(),
    brand: inputText(100, 0).optional(),
    keyword: inputText(100).optional(),
    facetKeyword: inputText(100).optional(),
    facetCurrent: queryNumber(51, 1),
    status: z.enum(['BROKEN', 'NORMAL']).optional(),
    current: queryNumber(1000, 1),
    pageSize: queryNumber(20, 10),
  })
  .strict()
  .refine((query) => (query.current - 1) * query.pageSize <= 10_000);
export type HomeWorkbenchQuery = z.infer<typeof homeWorkbenchQuerySchema>;

export const homeWorkbenchDaySchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    checks: count,
    brokenChecks: count,
    unknownChecks: count,
  })
  .strict()
  .refine((day) => day.brokenChecks + day.unknownChecks <= day.checks);
export type HomeWorkbenchDay = z.infer<typeof homeWorkbenchDaySchema>;
export const homeWorkbenchGroupSchema = z
  .object({
    id: z.string().refine(isNeoBatchDeleteId),
    name: boundedText(255),
    country: boundedText(10),
    site: boundedText(100),
    brand: boundedText(100),
    asinCount: count,
    isBroken: z.boolean(),
    lastCheckTime: z.string().datetime().nullable(),
    trend: z.array(homeWorkbenchDaySchema).length(7).nullable(),
  })
  .strict();
export type HomeWorkbenchGroup = z.infer<typeof homeWorkbenchGroupSchema>;
export const homeWorkbenchDataSchema = z
  .object({
    generatedAt: z.string().datetime(),
    days: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).length(7),
    current: z.number().int().min(1).max(1000),
    pageSize: z.number().int().min(1).max(20),
    total: count,
    list: z.array(homeWorkbenchGroupSchema).max(20),
    facets: z
      .array(
        z
          .object({
            country: boundedText(10),
            site: boundedText(100),
            brand: boundedText(100),
            totalGroups: count,
          })
          .strict(),
      )
      .max(200),
    facetsTruncated: z.boolean(),
    facetCurrent: z.number().int().min(1).max(51),
    trendsAuthorized: z.boolean(),
  })
  .strict()
  .superRefine((data, context) => {
    const instant = Date.parse(data.generatedAt);
    const today = Number.isFinite(instant)
      ? new Date(instant + 8 * 3_600_000).toISOString().slice(0, 10)
      : null;
    const calendar =
      today && /^\d{4}-\d{2}-\d{2}$/.test(today)
        ? Array.from({ length: 7 }, (_, index) =>
            new Date(
              Date.parse(`${today}T00:00:00Z`) + (index - 6) * 86_400_000,
            )
              .toISOString()
              .slice(0, 10),
          )
        : [];
    if (
      data.list.length > data.pageSize ||
      data.list.length > data.total ||
      (data.current - 1) * data.pageSize > 10_000 ||
      data.list.length >
        Math.max(0, data.total - (data.current - 1) * data.pageSize) ||
      new Set(data.list.map((group) => group.id)).size !== data.list.length ||
      data.days.some((day, index) => day !== calendar[index]) ||
      new Set(
        data.facets.map((facet) =>
          JSON.stringify([facet.country, facet.site, facet.brand]),
        ),
      ).size !== data.facets.length ||
      data.list.some((group) =>
        data.trendsAuthorized
          ? group.trend === null ||
            group.trend.some((point, index) => point.day !== data.days[index])
          : group.trend !== null,
      )
    )
      context.addIssue({ code: 'custom', message: '工作台范围或趋势绑定无效' });
  });
export type HomeWorkbenchData = z.infer<typeof homeWorkbenchDataSchema>;
export const homeWorkbenchResultSchema = resultSchema(homeWorkbenchDataSchema);
