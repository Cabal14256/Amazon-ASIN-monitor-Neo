import { z } from 'zod';

import { resultSchema } from '../envelope';

/**
 * asin 域契约（16 端点：变体组 CRUD + ASIN CRUD + 通知/人工异常 + 导入）。
 * 来源：server/src/controllers/asinController.js、models/VariantGroup.js、
 * services/batchDeleteService.js、services/asinBatchCreateService.js、
 * services/importService.js 实读（2026-08-24）。
 * 注意：DB 0/1 标记字段宽松接受 number/boolean；驼峰与下划线字段并存。
 */

const dateTimeString = z.string();
/** MySQL TINYINT(1) 语义字段：0/1（历史数据也可能为 null） */
const flag01 = z.union([z.literal(0), z.literal(1), z.boolean(), z.null()]);
/** 飞书通知开关仅接受控制器支持的布尔或数字 0/1。 */
const feishuEnabledInput = z.union([z.boolean(), z.literal(0), z.literal(1)]);
/** 人工异常兼容 parseMarkedBroken 的布尔、数字与字符串 0/1。 */
const manualBrokenInput = z.union([
  z.boolean(),
  z.literal(0),
  z.literal(1),
  z.literal('0'),
  z.literal('1'),
]);

function isMarkedBroken(value: z.infer<typeof manualBrokenInput>): boolean {
  return value === true || value === 1 || value === '1';
}

/** ASIN 类型：'1' 主链 / '2' 副评 */
export const asinTypeSchema = z
  .union([z.literal('1'), z.literal('2'), z.literal(1), z.literal(2)])
  .nullable()
  .optional();

/** 装饰后 ASIN（mapDecoratedAsin 输出，变体组 children 元素） */
export const decoratedAsinSchema = z
  .object({
    id: z.string(),
    asin: z.string(),
    name: z.string().nullable().optional(),
    asinType: asinTypeSchema,
    country: z.string(),
    site: z.string().nullable().optional(),
    brand: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    isBroken: z.boolean().optional(),
    variantStatus: z.string().optional(),
    autoIsBroken: flag01.optional(),
    autoVariantStatus: z.string().nullable().optional(),
    manualBroken: flag01.optional(),
    manualBrokenScope: z.string().optional(),
    manualBrokenReason: z.string().nullable().optional(),
    manualBrokenUpdatedAt: dateTimeString.nullable().optional(),
    manualBrokenUpdatedBy: z.string().nullable().optional(),
    selfManualBroken: flag01.optional(),
    selfManualBrokenReason: z.string().nullable().optional(),
    selfManualBrokenUpdatedAt: dateTimeString.nullable().optional(),
    selfManualBrokenUpdatedBy: z.string().nullable().optional(),
    manualExcludedFromGroup: flag01.optional(),
    manualExcludedReason: z.string().nullable().optional(),
    manualExcludedUpdatedAt: dateTimeString.nullable().optional(),
    manualExcludedUpdatedBy: z.string().nullable().optional(),
    inheritedManualBroken: flag01.optional(),
    inheritedManualBrokenReason: z.string().nullable().optional(),
    inheritedManualBrokenUpdatedAt: dateTimeString.nullable().optional(),
    inheritedManualBrokenUpdatedBy: z.string().nullable().optional(),
    statusSource: z.string().optional(),
    createTime: dateTimeString.optional(),
    updateTime: dateTimeString.optional(),
    lastCheckTime: dateTimeString.nullable().optional(),
    feishuNotifyEnabled: flag01.optional(),
  })
  .passthrough();
export type DecoratedAsin = z.infer<typeof decoratedAsinSchema>;

/** 变体组（列表项含 children 与驼峰别名） */
export const variantGroupSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    country: z.string(),
    site: z.string(),
    brand: z.string(),
    is_broken: flag01.optional(),
    variant_status: z.string().nullable().optional(),
    manual_broken: flag01.optional(),
    manual_broken_reason: z.string().nullable().optional(),
    manual_broken_updated_at: dateTimeString.nullable().optional(),
    manual_broken_updated_by: z.string().nullable().optional(),
    feishu_notify_enabled: flag01.optional(),
    create_time: dateTimeString.optional(),
    update_time: dateTimeString.optional(),
    last_check_time: dateTimeString.nullable().optional(),
    // ── 列表组装附加字段 ──
    asin_count: z.number().optional(),
    children: z.array(decoratedAsinSchema).optional(),
    isBroken: z.boolean().optional(),
    variantStatus: z.string().optional(),
    autoIsBroken: flag01.optional(),
    autoVariantStatus: z.string().nullable().optional(),
    manualBroken: flag01.optional(),
    manualBrokenReason: z.string().nullable().optional(),
    manualBrokenUpdatedAt: dateTimeString.nullable().optional(),
    manualBrokenUpdatedBy: z.string().nullable().optional(),
    statusSource: z.string().optional(),
    createTime: dateTimeString.optional(),
    updateTime: dateTimeString.optional(),
    lastCheckTime: dateTimeString.nullable().optional(),
    feishuNotifyEnabled: flag01.optional(),
  })
  .passthrough();
export type VariantGroup = z.infer<typeof variantGroupSchema>;

/** ASIN 实体（create/update/move/feishu-notify/manual-broken 返回 data） */
export const asinRecordSchema = z
  .object({
    id: z.string(),
    asin: z.string(),
    name: z.string().nullable().optional(),
    country: z.string(),
    site: z.string().nullable().optional(),
    brand: z.string().nullable().optional(),
    variant_group_id: z.string().nullable().optional(),
    asin_type: asinTypeSchema,
  })
  .passthrough();
export type AsinRecord = z.infer<typeof asinRecordSchema>;

// ── 请求 ──

export const variantGroupListQuerySchema = z.object({
  keyword: z.string().optional(),
  country: z.string().optional(),
  variantStatus: z.enum(['BROKEN', 'NORMAL']).optional(),
  current: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});
export type VariantGroupListQuery = z.infer<typeof variantGroupListQuerySchema>;

export const variantGroupUpsertRequestSchema = z.object({
  name: z.string().min(1, 'name 为必填项'),
  country: z.string().min(1, 'country 为必填项'),
  site: z.string().min(1, 'site 为必填项'),
  brand: z.string().min(1, 'brand 为必填项'),
});
export type VariantGroupUpsertRequest = z.infer<
  typeof variantGroupUpsertRequestSchema
>;

export const batchDeleteVariantGroupsRequestSchema = z
  .object({
    groupIds: z.array(z.string()).optional(),
    asinIds: z.array(z.string()).optional(),
    useAsync: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const hasTarget = [
      ...(value.groupIds ?? []),
      ...(value.asinIds ?? []),
    ].some((id) => id.trim().length > 0);
    if (!hasTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '请提供变体组ID或ASIN ID列表',
        path: ['groupIds'],
      });
    }
  });
export type BatchDeleteVariantGroupsRequest = z.infer<
  typeof batchDeleteVariantGroupsRequestSchema
>;

export const feishuNotifyRequestSchema = z.object({
  enabled: feishuEnabledInput,
});
export type FeishuNotifyRequest = z.infer<typeof feishuNotifyRequestSchema>;

/** 变体组人工异常：仅 markedBroken + reason */
export const groupManualBrokenRequestSchema = z
  .object({
    markedBroken: manualBrokenInput,
    reason: z.string().max(500, '原因长度不能超过500个字符').optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (isMarkedBroken(value.markedBroken) && !value.reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '人工标记异常时必须填写原因',
        path: ['reason'],
      });
    }
  });
export type GroupManualBrokenRequest = z.infer<
  typeof groupManualBrokenRequestSchema
>;

/** ASIN 人工异常：四动作或 markedBroken 兼容 */
export const ASIN_MANUAL_BROKEN_ACTIONS = [
  'MARK_BROKEN',
  'CLEAR_SELF_MANUAL',
  'EXCLUDE_GROUP_MANUAL',
  'CLEAR_GROUP_EXCLUSION',
] as const;
type AsinManualBrokenAction = (typeof ASIN_MANUAL_BROKEN_ACTIONS)[number];

function normalizeManualBrokenAction(
  value: unknown,
): AsinManualBrokenAction | undefined {
  const normalized =
    typeof value === 'string' ? value.trim().toUpperCase() : '';
  return ASIN_MANUAL_BROKEN_ACTIONS.find((action) => action === normalized);
}

const optionalManualBrokenInput = z.preprocess(
  (value) => (manualBrokenInput.safeParse(value).success ? value : undefined),
  manualBrokenInput.optional(),
);

export const asinManualBrokenRequestSchema = z
  .object({
    action: z.preprocess(
      (value) => normalizeManualBrokenAction(value),
      z.enum(ASIN_MANUAL_BROKEN_ACTIONS).optional(),
    ),
    markedBroken: optionalManualBrokenInput,
    reason: z.string().max(500, '原因长度不能超过500个字符').optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const action =
      value.action ??
      (value.markedBroken === undefined
        ? undefined
        : isMarkedBroken(value.markedBroken)
        ? 'MARK_BROKEN'
        : 'CLEAR_SELF_MANUAL');

    if (!action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'action参数无效，或 markedBroken 参数必须是布尔值或0/1',
        path: ['action'],
      });
      return;
    }

    if (
      (action === 'MARK_BROKEN' || action === 'EXCLUDE_GROUP_MANUAL') &&
      !value.reason?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '当前操作必须填写原因',
        path: ['reason'],
      });
    }
  });
export type AsinManualBrokenRequest = z.infer<
  typeof asinManualBrokenRequestSchema
>;

export const createAsinRequestSchema = z.object({
  asin: z.string().min(1, 'asin 为必填项'),
  name: z.string().nullable().optional(),
  country: z.string().min(1, 'country 为必填项'),
  site: z.string().min(1, 'site 为必填项'),
  brand: z.string().min(1, 'brand 为必填项'),
  parentId: z.string().min(1, 'parentId 为必填项'),
  asinType: asinTypeSchema,
});
export type CreateAsinRequest = z.infer<typeof createAsinRequestSchema>;

export const updateAsinRequestSchema = z.object({
  asin: z.string().min(1, 'ASIN 为必填项'),
  name: z.string().nullable().optional(),
  country: z.string().min(1, '国家为必填项'),
  site: z.string().min(1, '站点为必填项'),
  brand: z.string().min(1, '品牌为必填项'),
  asinType: asinTypeSchema,
});
export type UpdateAsinRequest = z.infer<typeof updateAsinRequestSchema>;

export const moveAsinRequestSchema = z.object({
  targetGroupId: z.string().min(1, '目标变体组ID为必填项'),
});
export type MoveAsinRequest = z.infer<typeof moveAsinRequestSchema>;

/** 批量创建入项（normalizeItems 后字段） */
export const batchCreateAsinItemSchema = z
  .object({
    asin: z.string().min(1),
    name: z.string().nullable().optional(),
    asinType: asinTypeSchema,
    country: z.string().min(1),
    site: z.string().nullable().optional(),
    brand: z.string().nullable().optional(),
    parentId: z.string().optional(),
    variantGroupId: z.string().optional(),
  })
  .passthrough();
export const batchCreateAsinsRequestSchema = z.object({
  items: z.array(batchCreateAsinItemSchema).nonempty('items不能为空'),
});
export type BatchCreateAsinsRequest = z.infer<
  typeof batchCreateAsinsRequestSchema
>;

// ── 响应 data ──

/** GET /variant-groups data（含 totalASINs） */
export const variantGroupListDataSchema = z.object({
  list: z.array(variantGroupSchema),
  total: z.number(),
  totalASINs: z.number().optional(),
  current: z.number(),
  pageSize: z.number(),
});
export type VariantGroupListData = z.infer<typeof variantGroupListDataSchema>;
export const variantGroupListResultSchema = resultSchema(
  variantGroupListDataSchema,
);

export const variantGroupResultSchema = resultSchema(variantGroupSchema);
export const asinRecordResultSchema = resultSchema(asinRecordSchema);

/** 批量删除同步结果 */
export const batchDeleteSyncDataSchema = z.object({
  mode: z.literal('sync'),
  totalRequested: z.number(),
  deletedGroupCount: z.number(),
  deletedDirectAsinCount: z.number(),
  deletedNestedAsinCount: z.number(),
  skipped: z.object({
    groupIds: z.array(z.string()),
    asinIds: z.array(z.string()),
  }),
});
/** 批量删除异步受理结果 */
export const batchDeleteAsyncDataSchema = z.object({
  mode: z.literal('async'),
  taskId: z.string(),
  status: z.string(),
  totalRequested: z.number(),
  estimatedAsinCount: z.number().optional(),
});
export const batchDeleteVariantGroupsResultSchema = resultSchema(
  z.union([batchDeleteSyncDataSchema, batchDeleteAsyncDataSchema]),
);

/** 批量创建 ASIN 结果 */
export const batchCreateAsinsDataSchema = z.object({
  total: z.number(),
  successCount: z.number(),
  failedCount: z.number(),
  results: z.array(
    z
      .object({
        index: z.number(),
        asin: z.string().nullable().optional(),
        country: z.string().nullable().optional(),
        success: z.boolean(),
        message: z.string().optional(),
      })
      .passthrough(),
  ),
  errors: z.array(
    z
      .object({
        index: z.number().optional(),
        asin: z.string().nullable().optional(),
        message: z.string(),
      })
      .passthrough(),
  ),
});
export type BatchCreateAsinsData = z.infer<typeof batchCreateAsinsDataSchema>;
export const batchCreateAsinsResultSchema = resultSchema(
  batchCreateAsinsDataSchema,
);

/** Excel 导入同步结果 */
export const importResultDataSchema = z.object({
  total: z.number(),
  processedCount: z.number(),
  successCount: z.number(),
  failedCount: z.number(),
  missingCount: z.number(),
  verificationPassed: z.boolean(),
  errors: z
    .array(z.object({ row: z.number(), message: z.string() }).passthrough())
    .optional(),
});
/** Excel 导入异步受理结果 */
export const importTaskDataSchema = z.object({
  taskId: z.string(),
  status: z.string(),
});
/** Excel 解析/导入异常时控制器仍返回的结构化 data。 */
export const importFailureDataSchema = z.object({
  successCount: z.number(),
  failedCount: z.number(),
  errors: z.array(z.object({ message: z.string() }).passthrough()),
});
export const importExcelResultSchema = resultSchema(
  z.union([
    importResultDataSchema,
    importTaskDataSchema,
    importFailureDataSchema,
  ]),
);
