import { z } from 'zod';

/**
 * WebSocket 协议契约（/ws）。
 * 对齐旧系统 server/src/services/websocketService.js：
 * 9 种服务端消息 + 4401/4403 关闭语义。
 */

export const WS_CLOSE_CODES = {
  /** 未认证 / token 无效 */
  UNAUTHORIZED: 4401,
  /** 会话失效 / 无权限 */
  FORBIDDEN: 4403,
} as const;

export const wsMessageTypeSchema = z.enum([
  'connected',
  'monitor_progress',
  'monitor_complete',
  'stats_update',
  'task_progress',
  'task_complete',
  'task_error',
  'task_cancelled',
  'pong',
]);
export type WsMessageType = z.infer<typeof wsMessageTypeSchema>;

const timestampSchema = z.string();

export const wsConnectedMessageSchema = z.object({
  type: z.literal('connected'),
  message: z.string(),
});

/** started 与 progress 共用同一消息类型，字段按阶段出现。 */
export const wsMonitorProgressMessageSchema = z
  .object({
    type: z.literal('monitor_progress'),
    status: z.enum(['started', 'progress']),
    countries: z.array(z.string()).optional(),
    batchInfo: z.string().nullable().optional(),
    country: z.string().optional(),
    current: z.number().optional(),
    total: z.number().optional(),
    progress: z.number().min(0).max(100).optional(),
    timestamp: timestampSchema,
    isCompetitor: z.boolean().optional(),
  })
  .passthrough();

export const wsMonitorCompleteMessageSchema = z
  .object({
    type: z.literal('monitor_complete'),
    success: z.boolean(),
    totalChecked: z.number(),
    totalBroken: z.number(),
    totalNormal: z.number(),
    duration: z.union([z.string(), z.number()]),
    countryResults: z.record(z.string(), z.unknown()),
    timestamp: timestampSchema,
    isCompetitor: z.boolean().optional(),
  })
  .passthrough();

/** 当前旧系统未主动发送 stats_update；保留扩展载荷以冻结消息名。 */
export const wsStatsUpdateMessageSchema = z
  .object({
    type: z.literal('stats_update'),
    data: z.unknown().optional(),
    timestamp: timestampSchema.optional(),
  })
  .passthrough();

export const wsTaskProgressMessageSchema = z.object({
  type: z.literal('task_progress'),
  taskId: z.string(),
  progress: z.number().min(0).max(100),
  message: z.string(),
  timestamp: timestampSchema,
});

export const wsTaskCompleteMessageSchema = z.object({
  type: z.literal('task_complete'),
  taskId: z.string(),
  downloadUrl: z.string(),
  filename: z.string(),
  timestamp: timestampSchema,
});

export const wsTaskErrorMessageSchema = z.object({
  type: z.literal('task_error'),
  taskId: z.string(),
  error: z.string(),
  timestamp: timestampSchema,
});

export const wsTaskCancelledMessageSchema = z.object({
  type: z.literal('task_cancelled'),
  taskId: z.string(),
  message: z.string(),
  timestamp: timestampSchema,
});

export const wsPongMessageSchema = z.object({ type: z.literal('pong') });

export const wsMessageSchema = z.discriminatedUnion('type', [
  wsConnectedMessageSchema,
  wsMonitorProgressMessageSchema,
  wsMonitorCompleteMessageSchema,
  wsStatsUpdateMessageSchema,
  wsTaskProgressMessageSchema,
  wsTaskCompleteMessageSchema,
  wsTaskErrorMessageSchema,
  wsTaskCancelledMessageSchema,
  wsPongMessageSchema,
]);
export type WsMessage = z.infer<typeof wsMessageSchema>;

/** 客户端上行消息（心跳） */
export const wsClientMessageSchema = z.object({
  type: z.literal('ping'),
});
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
