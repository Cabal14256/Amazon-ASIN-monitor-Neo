import { z } from 'zod';

import { resultSchema } from '../envelope';

/** 飞书配置域（6 端点）。 */
export const feishuConfigSchema = z
  .object({
    id: z.number(),
    country: z.string(),
    webhookUrl: z.string().optional(),
    webhook_url: z.string().optional(),
    enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]),
    createTime: z.string().nullable().optional(),
    updateTime: z.string().nullable().optional(),
    create_time: z.string().nullable().optional(),
    update_time: z.string().nullable().optional(),
  })
  .passthrough();
export type FeishuConfig = z.infer<typeof feishuConfigSchema>;

/** POST 与 PUT 均读取 body.country；旧 PUT 控制器不会回退到路径参数。 */
export const upsertFeishuConfigRequestSchema = z.object({
  country: z.string().min(1),
  webhookUrl: z.string().min(1),
  enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
});
export type UpsertFeishuConfigRequest = z.infer<
  typeof upsertFeishuConfigRequestSchema
>;

export const toggleFeishuConfigRequestSchema = z.object({
  enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]),
});
export type ToggleFeishuConfigRequest = z.infer<
  typeof toggleFeishuConfigRequestSchema
>;

export const feishuConfigListResultSchema = resultSchema(
  z.array(feishuConfigSchema),
);
/** toggle(false) 的旧实现会因 findByCountry 只查 enabled=1 而返回 null。 */
export const feishuConfigResultSchema = resultSchema(
  feishuConfigSchema.nullable(),
);
export const deleteFeishuConfigResultSchema = resultSchema(
  z.literal('删除成功'),
);
