import { z } from 'zod';

import { resultSchema } from '../envelope';

/**
 * variant-check 域契约（4 端点）。
 * 来源：server/src/controllers/variantCheckController.js、
 * services/variantCheckResultMapper.js、services/variantCheckService.js
 * 实读（2026-08-24）。
 * 全部端点支持同步/异步双模式（useAsync；已认证默认异步、匿名默认同步）。
 */

/** 任务受理统一形态 */
export const variantCheckTaskDataSchema = z.object({
  taskId: z.string(),
  status: z.string(),
  taskType: z.string().optional(),
  total: z.number().optional(), // batch-check 异步受理回传组数
});
export type VariantCheckTaskData = z.infer<typeof variantCheckTaskDataSchema>;

/** 单 ASIN 变体视图（buildVariantViewFromResult 输出） */
export const variantViewSchema = z.object({
  asin: z.string().nullable(),
  title: z.string(),
  hasVariation: z.boolean(),
  isBroken: z.boolean(),
  parentAsin: z.string().nullable(),
  brotherAsins: z.array(z.string()),
  brand: z.string().nullable(),
  raw: z.unknown().nullable(),
});
export type VariantView = z.infer<typeof variantViewSchema>;

// ── 请求 ──

export const checkVariantGroupRequestSchema = z.object({
  forceRefresh: z.boolean().optional(),
  useAsync: z.boolean().optional(),
});
export type CheckVariantGroupRequest = z.infer<
  typeof checkVariantGroupRequestSchema
>;

export const batchCheckRequestSchema = z.object({
  groupIds: z.array(z.string()).nonempty('请提供变体组ID列表'),
  country: z.string().optional(),
  forceRefresh: z.boolean().optional(),
  useAsync: z.boolean().optional(),
});
export type BatchCheckRequest = z.infer<typeof batchCheckRequestSchema>;

const parentAsinCodeSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9]{9}$/, 'ASIN格式不正确'));

export const batchQueryParentAsinRequestSchema = z.object({
  asins: z.array(parentAsinCodeSchema).nonempty('请提供ASIN列表'),
  country: z.string().min(1, '请提供国家代码'),
  useAsync: z.boolean().optional(),
});
export type BatchQueryParentAsinRequest = z.infer<
  typeof batchQueryParentAsinRequestSchema
>;

// ── 响应 data ──

/** 变体组检查同步结果（mapVariantGroupResultWithVariantView 后） */
export const variantGroupCheckDataSchema = z
  .object({
    isBroken: z.boolean(),
    brokenASINs: z.array(z.record(z.string(), z.unknown())).optional(),
    brokenByType: z.record(z.string(), z.unknown()).optional(),
    groupStatus: z.record(z.string(), z.unknown()).optional(),
    groupSnapshot: z.record(z.string(), z.unknown()).optional(),
    details: z
      .object({
        results: z.array(
          z.object({ variantView: variantViewSchema.optional() }).passthrough(),
        ),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type VariantGroupCheckData = z.infer<typeof variantGroupCheckDataSchema>;
export const variantGroupCheckResultSchema = resultSchema(
  z.union([variantGroupCheckDataSchema, variantCheckTaskDataSchema]),
);

/** 单 ASIN 检查同步结果即 variantView；或任务受理 */
export const asinCheckResultSchema = resultSchema(
  z.union([variantViewSchema, variantCheckTaskDataSchema]),
);

/** 批量检查同步结果 */
export const batchCheckSyncDataSchema = z.object({
  total: z.number(),
  results: z.array(
    z
      .object({
        groupId: z.string(),
        success: z.boolean(),
        error: z.string().optional(),
      })
      .passthrough(),
  ),
});
export const batchCheckResultSchema = resultSchema(
  z.union([batchCheckSyncDataSchema, variantCheckTaskDataSchema]),
);

/** 父变体批量查询单项 */
export const parentAsinQueryItemSchema = z.object({
  asin: z.string(),
  hasParentAsin: z.boolean(),
  parentAsin: z.string().nullable(),
  parentTitle: z.string(),
  title: z.string(),
  brand: z.string().nullable(),
  hasVariants: z.boolean(),
  variantCount: z.number(),
  error: z.string().nullable(),
});
export type ParentAsinQueryItem = z.infer<typeof parentAsinQueryItemSchema>;
export const batchQueryParentAsinResultSchema = resultSchema(
  z.union([z.array(parentAsinQueryItemSchema), variantCheckTaskDataSchema]),
);
