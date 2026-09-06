import { z } from 'zod';
import { resultSchema } from '../envelope';

/** Legacy wall time means UTC+8; explicit ISO offsets denote the same instant. */
function auditInstant(value: string): string | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value,
    );
  if (!match) return;
  const [, y, mo, d, h = '00', mi = '00', s = '00', fraction = '', zone] =
    match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(
    Number,
  );
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return;
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0')));
  if (
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() !== month - 1 ||
    wall.getUTCDate() !== day
  )
    return;
  let offset = 8 * 60;
  if (zone === 'Z') offset = 0;
  else if (zone) {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return;
    offset = (zone[0] === '-' ? -1 : 1) * (hours * 60 + minutes);
  }
  const instant = new Date(wall.getTime() - offset * 60_000);
  const beijingYear = new Date(
    instant.getTime() + 8 * 3600_000,
  ).getUTCFullYear();
  if (
    instant.getUTCFullYear() < 1 ||
    instant.getUTCFullYear() > 9999 ||
    beijingYear < 1 ||
    beijingYear > 9999
  )
    return;
  return instant.toISOString();
}

const auditDateTime = z
  .string()
  .max(35)
  .transform((value, ctx) => {
    if (value === '') return undefined;
    const instant = auditInstant(value);
    if (!instant) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '审计时间格式或日期无效',
      });
      return z.NEVER;
    }
    return instant;
  })
  .optional();

const filterText = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) =>
        ![...value].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ),
      '筛选值包含控制字符',
    )
    .transform((value) => value || undefined)
    .optional();
const rangeShape = { startTime: auditDateTime, endTime: auditDateTime };
const pageInteger = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d{1,16}$/)
      .transform(Number),
  ])
  .pipe(z.number().int().safe().positive());
function orderedRange(
  value: { startTime?: string; endTime?: string },
  ctx: z.RefinementCtx,
) {
  if (
    value.startTime &&
    value.endTime &&
    Date.parse(value.startTime) > Date.parse(value.endTime)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endTime'],
      message: '结束时间不能早于开始时间',
    });
  }
}

/** Keep the frozen Legacy schemas permissive; Neo HTTP validation is explicit. */
export const neoAuditStatisticsQuerySchema = z
  .object(rangeShape)
  .strict()
  .superRefine(orderedRange);
export const neoAuditLogListQuerySchema = z
  .object({
    ...rangeShape,
    userId: filterText(50),
    username: filterText(50),
    action: filterText(50),
    resource: filterText(100),
    resourceId: filterText(50),
    current: pageInteger.default(1),
    pageSize: pageInteger
      .refine((value) => value <= 100, '每页最多 100 条')
      .default(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    orderedRange(value, ctx);
    if (!Number.isSafeInteger((value.current - 1) * value.pageSize)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['current'],
        message: '分页偏移超出安全整数范围',
      });
    }
  });
export const neoAuditLogIdParamsSchema = z
  .object({
    id: z
      .string()
      .regex(/^[1-9]\d{0,15}$/, '审计标识无效')
      .transform(Number)
      .pipe(z.number().int().safe().positive()),
  })
  .strict();

export const neoAuditLogSchema = z
  .object({
    id: z.number().int().safe().positive(),
    userId: z.string().nullable(),
    username: z.string().nullable(),
    action: z.string(),
    resource: z.string().nullable(),
    resourceId: z.string().nullable(),
    resourceName: z.string().nullable(),
    method: z.string().nullable(),
    path: z.string().nullable(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    requestData: z.unknown().nullable(),
    responseStatus: z.number().nullable(),
    errorMessage: z.string().nullable(),
    createTime: z.string().optional(),
  })
  .strict();
export const neoAuditLogListDataSchema = z
  .object({
    list: z.array(neoAuditLogSchema),
    total: z.number().int().safe().nonnegative(),
    current: z.number().int().safe().positive(),
    pageSize: z.number().int().positive().max(100),
  })
  .strict();
export const neoAuditLogListResultSchema = resultSchema(
  neoAuditLogListDataSchema,
);
export const neoAuditLogDetailResultSchema = resultSchema(neoAuditLogSchema);
export type NeoAuditLog = z.infer<typeof neoAuditLogSchema>;
export type NeoAuditLogListData = z.infer<typeof neoAuditLogListDataSchema>;
export type NeoAuditLogListQuery = z.infer<typeof neoAuditLogListQuerySchema>;
export type NeoAuditStatisticsQuery = z.infer<
  typeof neoAuditStatisticsQuerySchema
>;
