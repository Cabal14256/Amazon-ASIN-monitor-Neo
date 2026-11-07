import { z } from 'zod';

import { resultSchema } from '../envelope';

/**
 * tasks 域契约（5 端点：创建导出任务 + 任务中心四端点）。
 * 来源：server/src/controllers/taskController.js、
 * exportController.js createExportTask 实读（2026-08-24）。
 * 注意：GET /tasks/:taskId/download 为文件流（非 JSON），契约仅登记。
 */

// ── 实体 ──

/** 任务中心任务（sanitizeTaskForResponse 输出） */
export const taskInfoSchema = z.object({
  taskId: z.string(),
  taskType: z.string(),
  taskSubType: z.string().nullable(),
  title: z.string(),
  status: z.string(), // pending/processing/completed/failed/cancelled
  progress: z.number(),
  message: z.string(),
  error: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelRequestedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  canCancel: z.boolean(),
  filename: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  result: z.unknown().nullable(),
});
export type TaskInfo = z.infer<typeof taskInfoSchema>;

// ── 请求 ──

/** POST /tasks/export：导出类型全集 */
export const EXPORT_TYPES = [
  'asin',
  'monitor-history',
  'variant-group',
  'competitor-asin',
  'competitor-variant-group',
  'competitor-monitor-history',
  'analytics-monthly-breakdown',
  'parent-asin-query',
] as const;
export const createExportTaskRequestSchema = z.object({
  exportType: z.enum(EXPORT_TYPES),
  params: z.record(z.string(), z.unknown()).optional(),
});
/** First Neo export consumer. Other known export types remain unsupported. */
export const asinExportParamsSchema = z
  .object({
    keyword: z
      .string()
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]*$/u)
      .optional(),
    country: z
      .string()
      .max(10)
      .regex(/^[^\x00-\x1f\x7f]*$/u)
      .optional(),
    variantStatus: z
      .union([z.enum(['BROKEN', 'NORMAL']), z.literal('')])
      .optional(),
    layout: z.enum(['task', 'detailed']).optional(),
  })
  .strict();
export type AsinExportParams = z.infer<typeof asinExportParamsSchema>;
export const variantGroupExportParamsSchema = asinExportParamsSchema
  .omit({ layout: true })
  .default({});
export type VariantGroupExportParams = z.infer<
  typeof variantGroupExportParamsSchema
>;
export const asinExportTaskRequestSchema = z
  .object({
    exportType: z.literal('asin'),
    params: asinExportParamsSchema.default({}),
  })
  .strict();
export const asinExportJobDataSchema = z
  .object({
    taskId: z.string().uuid(),
    taskType: z.literal('export'),
    taskSubType: z.literal('asin'),
    exportType: z.literal('asin'),
    userId: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    params: asinExportParamsSchema,
  })
  .strict();
export type AsinExportJobData = z.infer<typeof asinExportJobDataSchema>;
export const variantGroupExportTaskRequestSchema = z
  .object({
    exportType: z.literal('variant-group'),
    params: variantGroupExportParamsSchema,
  })
  .strict();
export const variantGroupExportJobDataSchema = z
  .object({
    taskId: z.string().uuid(),
    taskType: z.literal('export'),
    taskSubType: z.literal('variant-group'),
    exportType: z.literal('variant-group'),
    userId: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    params: variantGroupExportParamsSchema,
  })
  .strict();
export type VariantGroupExportJobData = z.infer<
  typeof variantGroupExportJobDataSchema
>;
export const competitorCatalogExportParamsSchema = asinExportParamsSchema
  .omit({ layout: true })
  .default({});
export const competitorAsinExportTaskRequestSchema = z
  .object({
    exportType: z.literal('competitor-asin'),
    params: competitorCatalogExportParamsSchema,
  })
  .strict();
export const competitorVariantGroupExportTaskRequestSchema = z
  .object({
    exportType: z.literal('competitor-variant-group'),
    params: competitorCatalogExportParamsSchema,
  })
  .strict();
export const competitorAsinExportJobDataSchema = asinExportJobDataSchema.extend(
  {
    exportType: z.literal('competitor-asin'),
    taskSubType: z.literal('competitor-asin'),
    params: competitorCatalogExportParamsSchema,
  },
);
export const competitorVariantGroupExportJobDataSchema =
  variantGroupExportJobDataSchema.extend({
    exportType: z.literal('competitor-variant-group'),
    taskSubType: z.literal('competitor-variant-group'),
    params: competitorCatalogExportParamsSchema,
  });
export type CompetitorAsinExportJobData = z.infer<
  typeof competitorAsinExportJobDataSchema
>;
export type CompetitorVariantGroupExportJobData = z.infer<
  typeof competitorVariantGroupExportJobDataSchema
>;
export const parentAsinExportParamsSchema = z
  .object({
    asins: z
      .array(z.string().regex(/^[A-Z][A-Z0-9]{9}$/))
      .min(1)
      .max(1000),
    country: z.enum(['US', 'UK', 'DE', 'FR', 'IT', 'ES']),
  })
  .strict();
/** Legacy export accepts comma/newline text, filters invalid tokens and keeps
 * normalized duplicates in their original order. The queued form is canonical. */
export const parentAsinExportTaskRequestSchema = z
  .object({
    exportType: z.literal('parent-asin-query'),
    params: z
      .object({
        asins: z
          .string()
          .max(20_000)
          .transform((value) =>
            value
              .split(/[,\n]/)
              .map((asin) => asin.trim().toUpperCase())
              .filter((asin) => /^[A-Z][A-Z0-9]{9}$/.test(asin)),
          ),
        country: z
          .string()
          .max(10)
          .transform((value) => value.trim().toUpperCase()),
      })
      .strict()
      .pipe(parentAsinExportParamsSchema),
  })
  .strict();
export const parentAsinExportJobDataSchema = asinExportJobDataSchema.extend({
  exportType: z.literal('parent-asin-query'),
  taskSubType: z.literal('parent-asin-query'),
  params: parentAsinExportParamsSchema,
});
export type ParentAsinExportJobData = z.infer<
  typeof parentAsinExportJobDataSchema
>;
export const catalogExportJobDataSchema = z.union([
  asinExportJobDataSchema,
  variantGroupExportJobDataSchema,
  competitorAsinExportJobDataSchema,
  competitorVariantGroupExportJobDataSchema,
  parentAsinExportJobDataSchema,
]);
export type CatalogExportJobData = z.infer<typeof catalogExportJobDataSchema>;
export const CATALOG_EXPORT_TYPES = [
  'asin',
  'variant-group',
  'competitor-asin',
  'competitor-variant-group',
  'parent-asin-query',
] as const;
export const asinExportArtifactSchema = z
  .object({
    taskId: z.string().uuid(),
    key: z.string().regex(/^export-[0-9a-f-]{36}\.xlsx$/),
    bytes: z.number().int().positive().max(268_435_456),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((value) => value.key === `export-${value.taskId}.xlsx`);
export type AsinExportArtifact = z.infer<typeof asinExportArtifactSchema>;
export type CreateExportTaskRequest = z.infer<
  typeof createExportTaskRequestSchema
>;

/** GET /tasks query */
export const taskListQuerySchema = z.object({
  status: z.string().optional(), // 'all' | pending | processing | completed | failed | cancelled
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

// ── 响应 data ──

/** POST /tasks/export data */
export const createExportTaskDataSchema = z.object({
  taskId: z.string(),
  exportType: z.string(),
  status: z.string(),
});
export const createExportTaskResultSchema = resultSchema(
  createExportTaskDataSchema,
);

/** GET /tasks data */
export const taskListResultSchema = resultSchema(z.array(taskInfoSchema));

/** GET /tasks/:taskId、POST /tasks/:taskId/cancel data */
export const taskInfoResultSchema = resultSchema(taskInfoSchema);

/**
 * GET /tasks/:taskId/download：文件流（Content-Disposition attachment），
 * 无 JSON 契约；错误时可能返回 JSON 信封。
 */
export const taskDownloadResultSchema = resultSchema(z.unknown());
