import { z } from 'zod';

import { resultSchema } from '../envelope';
import {
  batchCreateAsinsResultSchema,
  batchDeleteVariantGroupsResultSchema,
  deleteAsinResultSchema,
  deleteVariantGroupResultSchema,
  importExcelResultSchema,
} from './asin';
import { monitorHistoryRecordSchema } from './monitor';
import { variantCheckTaskDataSchema } from './variantCheck';

/**
 * competitor 三域契约（competitor-asin 14 + competitor-monitor 3 +
 * competitor-variant-check 3，共 20 端点）。
 * 来源：server/src/controllers/competitorAsinController.js、
 * competitorMonitorController.js、competitorVariantCheckController.js、
 * models/CompetitorVariantGroup.js、models/CompetitorMonitorHistory.js
 * 实读（2026-08-24）。
 * 与主营 asin 域差异：无 site 字段；children 无人工异常装饰；
 * feishuNotifyEnabled 默认 0；监控不含统计端点。
 */

const dateTimeString = z.string();

/** 竞对 ASIN 子节点（CompetitorVariantGroup.findAll children 元素） */
export const competitorAsinChildSchema = z
  .object({
    id: z.string(),
    asin: z.string(),
    name: z.string().nullable().optional(),
    asinType: z.union([z.string(), z.number()]).nullable().optional(),
    country: z.string(),
    brand: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    isBroken: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
    variantStatus: z.string().nullable().optional(),
    createTime: dateTimeString.optional(),
    updateTime: dateTimeString.optional(),
    lastCheckTime: dateTimeString.nullable().optional(),
    feishuNotifyEnabled: z
      .union([z.literal(0), z.literal(1), z.boolean()])
      .optional(),
  })
  .passthrough();
export type CompetitorAsinChild = z.infer<typeof competitorAsinChildSchema>;

/** 竞对变体组（无 site） */
export const competitorVariantGroupSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    country: z.string(),
    brand: z.string(),
    is_broken: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
    variant_status: z.string().nullable().optional(),
    feishu_notify_enabled: z
      .union([z.literal(0), z.literal(1), z.boolean(), z.null()])
      .optional(),
    create_time: dateTimeString.optional(),
    update_time: dateTimeString.optional(),
    last_check_time: dateTimeString.nullable().optional(),
    asin_count: z.number().optional(),
    children: z.array(competitorAsinChildSchema).optional(),
    isBroken: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
    variantStatus: z.string().optional(),
    createTime: dateTimeString.optional(),
    updateTime: dateTimeString.optional(),
    lastCheckTime: dateTimeString.nullable().optional(),
    feishuNotifyEnabled: z
      .union([z.literal(0), z.literal(1), z.boolean()])
      .optional(),
  })
  .passthrough();
export type CompetitorVariantGroup = z.infer<
  typeof competitorVariantGroupSchema
>;

/** 竞对 ASIN 记录（create/update/move/feishu-notify 返回 data） */
export const competitorAsinRecordSchema = z
  .object({
    id: z.string(),
    asin: z.string(),
    name: z.string().nullable().optional(),
    country: z.string(),
    brand: z.string().nullable().optional(),
    variant_group_id: z.string().nullable().optional(),
    asin_type: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();
export type CompetitorAsinRecord = z.infer<typeof competitorAsinRecordSchema>;

// ── 请求 ──

export const competitorGroupListQuerySchema = z.object({
  keyword: z.string().optional(),
  country: z.string().optional(),
  variantStatus: z.enum(['BROKEN', 'NORMAL']).optional(),
  current: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});
export type CompetitorGroupListQuery = z.infer<
  typeof competitorGroupListQuerySchema
>;

export const competitorGroupUpsertRequestSchema = z.object({
  name: z.string().min(1, 'name 为必填项'),
  country: z.string().min(1, 'country 为必填项'),
  brand: z.string().min(1, 'brand 为必填项'),
});
export type CompetitorGroupUpsertRequest = z.infer<
  typeof competitorGroupUpsertRequestSchema
>;

export const competitorCreateAsinRequestSchema = z.object({
  asin: z.string().min(1, 'asin 为必填项'),
  name: z.string().nullable().optional(),
  country: z.string().min(1, 'country 为必填项'),
  brand: z.string().min(1, 'brand 为必填项'),
  parentId: z.string().min(1, 'parentId 为必填项'),
  asinType: z
    .union([z.literal('1'), z.literal('2'), z.literal(1), z.literal(2)])
    .nullable()
    .optional(),
});
export type CompetitorCreateAsinRequest = z.infer<
  typeof competitorCreateAsinRequestSchema
>;

export const competitorUpdateAsinRequestSchema = z.object({
  asin: z.string().min(1, 'asin 为必填项'),
  name: z.string().nullable().optional(),
  country: z.string().min(1, 'country 为必填项'),
  brand: z.string().min(1, 'brand 为必填项'),
  asinType: z
    .union([z.literal('1'), z.literal('2'), z.literal(1), z.literal(2)])
    .nullable()
    .optional(),
});
export type CompetitorUpdateAsinRequest = z.infer<
  typeof competitorUpdateAsinRequestSchema
>;

export const competitorMoveAsinRequestSchema = z.object({
  targetGroupId: z.string().min(1, '目标变体组ID为必填项'),
});
export type CompetitorMoveAsinRequest = z.infer<
  typeof competitorMoveAsinRequestSchema
>;

export const competitorFeishuNotifyRequestSchema = z.object({
  enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]),
});
export type CompetitorFeishuNotifyRequest = z.infer<
  typeof competitorFeishuNotifyRequestSchema
>;

/** 竞对批量检查请求 */
export const competitorBatchCheckRequestSchema = z.object({
  groupIds: z.array(z.string()).nonempty('请提供竞品变体组ID列表'),
  country: z.string().optional(),
  forceRefresh: z.boolean().optional(),
  useAsync: z.boolean().optional(),
});
export type CompetitorBatchCheckRequest = z.infer<
  typeof competitorBatchCheckRequestSchema
>;

// ── 响应 data ──

/** GET /competitor/variant-groups data（含 totalASINs） */
export const competitorGroupListDataSchema = z.object({
  list: z.array(competitorVariantGroupSchema),
  total: z.number(),
  totalASINs: z.number().optional(),
  current: z.number(),
  pageSize: z.number(),
});
export type CompetitorGroupListData = z.infer<
  typeof competitorGroupListDataSchema
>;
export const competitorGroupListResultSchema = resultSchema(
  competitorGroupListDataSchema,
);

export const competitorGroupResultSchema = resultSchema(
  competitorVariantGroupSchema,
);
export const competitorAsinRecordResultSchema = resultSchema(
  competitorAsinRecordSchema,
);

export const competitorDeleteGroupResultSchema = deleteVariantGroupResultSchema;
export const competitorDeleteAsinResultSchema = deleteAsinResultSchema;

// 批量删除 / 批量创建 / Excel 导入与主营同构，直接复用 asin 域 schema
export {
  batchCreateAsinsResultSchema as competitorBatchCreateResultSchema,
  batchDeleteVariantGroupsResultSchema as competitorBatchDeleteResultSchema,
  importExcelResultSchema as competitorImportExcelResultSchema,
};

/** 竞对监控历史行额外包含从检查结果提取的父 ASIN。 */
export const competitorMonitorHistoryRecordSchema =
  monitorHistoryRecordSchema.extend({
    parentAsin: z.string().nullable(),
  });

/** 竞对监控历史列表 data */
export const competitorMonitorHistoryListDataSchema = z.object({
  list: z.array(competitorMonitorHistoryRecordSchema),
  total: z.number().nullable(),
  current: z.number(),
  pageSize: z.number(),
});
export const competitorMonitorHistoryListResultSchema = resultSchema(
  competitorMonitorHistoryListDataSchema,
);
export const competitorMonitorHistoryDetailResultSchema = resultSchema(
  competitorMonitorHistoryRecordSchema,
);

/** 竞对变体检查同步结果（服务返回 {isBroken, brokenASINs, details}） */
export const competitorCheckDataSchema = z
  .object({
    isBroken: z.boolean(),
    brokenASINs: z.array(z.record(z.string(), z.unknown())).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export const competitorCheckResultSchema = resultSchema(
  competitorCheckDataSchema,
);

/** 竞对批量检查：同步结果或异步受理 */
export const competitorBatchCheckSyncDataSchema = z.object({
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
export const competitorBatchCheckResultSchema = resultSchema(
  z.union([competitorBatchCheckSyncDataSchema, variantCheckTaskDataSchema]),
);
