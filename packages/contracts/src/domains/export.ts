import { z } from 'zod';

import { resultSchema } from '../envelope';

/**
 * export 域契约（9 端点）。
 * 来源：server/src/controllers/exportController.js 实读（2026-08-24）。
 * 关键结论：
 * - 8 个 GET /export/* 端点为双流端点：useProgress=true 走 SSE
 *   （text/event-stream，决策 D5 标记 deprecatedInNeo），否则直接下载
 *   xlsx 文件流；均无 JSON data 契约。
 * - POST /export/analytics-monthly-breakdown 与同名 GET 共用实现
 *   （req.method 取 body/query），同样为流端点。
 * - 新异步导出走 POST /tasks/export（tasks 域）。
 * 本文件仅登记流端点的查询参数形状，供端点注册表与测试引用。
 */

/** GET /export/variant-group、/export/asin 系列表导出 query */
export const listExportQuerySchema = z.object({
  keyword: z.string().optional(),
  country: z.string().optional(),
  variantStatus: z.string().optional(),
  useProgress: z.union([z.literal('true'), z.literal('false')]).optional(),
});
export type ListExportQuery = z.infer<typeof listExportQuerySchema>;

/** GET /export/monitor-history、/export/competitor-monitor-history query */
export const historyExportQuerySchema = z.object({
  variantGroupId: z.string().optional(),
  asinId: z.string().optional(),
  asin: z.string().optional(),
  country: z.string().optional(),
  checkType: z.string().optional(),
  isBroken: z.union([z.string(), z.number()]).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  useProgress: z.union([z.literal('true'), z.literal('false')]).optional(),
});
export type HistoryExportQuery = z.infer<typeof historyExportQuerySchema>;

/** GET/POST /export/analytics-monthly-breakdown 参数 */
export const monthlyBreakdownExportParamsSchema = z.object({
  country: z.string().optional(),
  month: z.string().optional(), // YYYY-MM
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  useProgress: z.union([z.literal('true'), z.literal('false')]).optional(),
});
export type MonthlyBreakdownExportParams = z.infer<
  typeof monthlyBreakdownExportParamsSchema
>;

/** GET /export/parent-asin-query query（asins 为逗号分隔字符串） */
export const parentAsinQueryExportQuerySchema = z.object({
  asins: z.string().min(1, '请提供ASIN列表'),
  country: z.string().min(1, '请提供国家代码'),
  useProgress: z.union([z.literal('true'), z.literal('false')]).optional(),
});
export type ParentAsinQueryExportQuery = z.infer<
  typeof parentAsinQueryExportQuerySchema
>;

/** SSE 进度模式错误帧（sendError 写出的 JSON 行） */
export const exportSseErrorSchema = z.object({
  type: z.literal('error').optional(),
  errorMessage: z.string().optional(),
  message: z.string().optional(),
});
export type ExportSseError = z.infer<typeof exportSseErrorSchema>;

/** 流端点占位结果（无 JSON data；保留信封供错误场景解析） */
export const exportStreamResultSchema = resultSchema(z.unknown());
