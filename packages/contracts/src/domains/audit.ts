import { z } from 'zod';

import { resultSchema } from '../envelope';

/**
 * audit 域契约（4 端点：/audit-logs 列表、详情、action 统计、resource 统计）。
 * 来源：server/src/controllers/auditLogController.js、models/AuditLog.js
 * 实读（2026-08-24）。
 * 注意：模型层把下划线字段复制为驼峰别名，但原始下划线字段也随 `...log` 透传；
 * 契约两侧都保留（宽松），Neo 实现时只允许驼峰。
 */

const dateTimeString = z.string();

/** 审计日志行（findAll / findById 归一化后形态） */
export const auditLogSchema = z
  .object({
    id: z.number(),
    user_id: z.number().nullable().optional(),
    username: z.string().nullable().optional(),
    action: z.string(),
    resource: z.string().nullable().optional(),
    resource_id: z.string().nullable().optional(),
    resource_name: z.string().nullable().optional(),
    method: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    ip_address: z.string().nullable().optional(),
    user_agent: z.string().nullable().optional(),
    /** 原始 JSON 字符串（详情端点额外提供解析后的 requestData） */
    request_data: z.string().nullable().optional(),
    response_status: z.number().nullable().optional(),
    error_message: z.string().nullable().optional(),
    create_time: dateTimeString.optional(),
    // ── 驼峰别名（模型层补充） ──
    userId: z.number().nullable().optional(),
    resourceId: z.string().nullable().optional(),
    resourceName: z.string().nullable().optional(),
    ipAddress: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
    /** JSON.parse 成功为对象/数组，失败保留原字符串 */
    requestData: z.unknown().nullable().optional(),
    responseStatus: z.number().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
    createTime: dateTimeString.optional(),
  })
  .passthrough();
export type AuditLog = z.infer<typeof auditLogSchema>;

// ── 请求 ──

/** GET /audit-logs query */
export const auditLogListQuerySchema = z.object({
  userId: z.coerce.number().optional(),
  username: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  resourceId: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  current: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});
export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;

/** 统计端点 query */
export const auditStatisticsQuerySchema = z.object({
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});
export type AuditStatisticsQuery = z.infer<typeof auditStatisticsQuerySchema>;

// ── 响应 data ──

/** GET /audit-logs data（PageInfo 形态） */
export const auditLogListDataSchema = z.object({
  list: z.array(auditLogSchema),
  total: z.number(),
  current: z.number(),
  pageSize: z.number(),
});
export type AuditLogListData = z.infer<typeof auditLogListDataSchema>;
export const auditLogListResultSchema = resultSchema(auditLogListDataSchema);

/** GET /audit-logs/:id data */
export const auditLogDetailResultSchema = resultSchema(auditLogSchema);

/** GET /audit-logs/statistics/actions data */
export const actionStatisticsSchema = z.array(
  z.object({ action: z.string(), count: z.number() }),
);
export const actionStatisticsResultSchema = resultSchema(
  actionStatisticsSchema,
);

/** GET /audit-logs/statistics/resources data */
export const resourceStatisticsSchema = z.array(
  z.object({ resource: z.string().nullable(), count: z.number() }),
);
export const resourceStatisticsResultSchema = resultSchema(
  resourceStatisticsSchema,
);
