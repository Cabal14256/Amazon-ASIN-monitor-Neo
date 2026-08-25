import { z } from 'zod';

/**
 * WebSocket 协议契约（/ws）。
 * 对齐旧系统 server/src/services/websocketService.js：
 * 9 种服务端消息 + 4401/4403 关闭语义。
 * P0-T1 将补全各消息 payload 的字段级 schema。
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

export const wsMessageSchema = z
  .object({
    type: wsMessageTypeSchema,
    data: z.unknown().optional(),
  })
  .passthrough();
export type WsMessage = z.infer<typeof wsMessageSchema>;

/** 客户端上行消息（心跳） */
export const wsClientMessageSchema = z.object({
  type: z.literal('ping'),
});
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
