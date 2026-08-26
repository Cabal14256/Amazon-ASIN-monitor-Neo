import { describe, expect, it } from 'vitest';

import { z } from 'zod';
import {
  pageInfoSchema,
  pageQuerySchema,
  resultSchema,
  WS_CLOSE_CODES,
  wsMessageSchema,
  wsMessageTypeSchema,
} from '../src/index';

describe('信封契约（对齐 api-compat.d.ts）', () => {
  it('Result 接受完整信封', () => {
    const schema = resultSchema(z.object({ id: z.number() }));
    const r = schema.parse({ success: true, data: { id: 1 } });
    expect(r.data?.id).toBe(1);
  });

  it('Result 容忍历史端点的缺省字段', () => {
    const schema = resultSchema(z.unknown());
    expect(() => schema.parse({})).not.toThrow();
    expect(() => schema.parse({ message: 'ok' })).not.toThrow();
  });

  it('PageInfo 字段全可选且 list 元素受类型约束', () => {
    const schema = pageInfoSchema(z.string());
    expect(schema.parse({ total: 0 })).toEqual({ total: 0 });
    expect(
      schema.parse({ list: ['a'], current: 1, pageSize: 20 }).list,
    ).toEqual(['a']);
    expect(() => schema.parse({ list: [1] })).toThrow();
  });

  it('pageQuery 支持字符串数字（ProTable 行为）', () => {
    expect(pageQuerySchema.parse({ current: '2', pageSize: '50' })).toEqual({
      current: 2,
      pageSize: 50,
    });
  });
});

describe('WS 协议契约（对齐 websocketService.js）', () => {
  it('恰好覆盖 9 种服务端消息', () => {
    expect(wsMessageTypeSchema.options).toEqual([
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
  });

  it('非法消息类型被拒绝', () => {
    expect(() => wsMessageSchema.parse({ type: 'unknown_type' })).toThrow();
  });

  it('按旧系统实际字段校验任务进度消息', () => {
    expect(
      wsMessageSchema.parse({
        type: 'task_progress',
        taskId: 'task-1',
        progress: 42,
        message: 'running',
        timestamp: '2026-08-25T17:30:00+08:00',
      }),
    ).toMatchObject({
      type: 'task_progress',
      taskId: 'task-1',
      progress: 42,
      message: 'running',
      timestamp: '2026-08-25T17:30:00+08:00',
    });
  });

  it('关闭语义 4401/4403 固定', () => {
    expect(WS_CLOSE_CODES.UNAUTHORIZED).toBe(4401);
    expect(WS_CLOSE_CODES.FORBIDDEN).toBe(4403);
  });
});
