import { describe, expect, it } from 'vitest';

import {
  ENDPOINTS,
  isPermissionCode,
  PERMISSION_CODES,
  permissionCodeSchema,
  WS_CLOSE_CODES,
  wsClientMessageSchema,
  wsMessageSchema,
  wsMessageTypeSchema,
} from '../src';

describe('权限码常量', () => {
  it('冻结数据库种子的 14 个权限码', () => {
    expect(PERMISSION_CODES).toHaveLength(14);
    expect(permissionCodeSchema.parse('settings:write')).toBe('settings:write');
    expect(isPermissionCode('role:write')).toBe(true);
    expect(isPermissionCode('tasks:write')).toBe(false);
  });

  it('端点注册表引用的权限均存在于常量表', () => {
    for (const endpoint of ENDPOINTS.filter((item) => item.permission)) {
      expect(
        isPermissionCode(endpoint.permission),
        `${endpoint.method} ${endpoint.path}: ${endpoint.permission}`,
      ).toBe(true);
    }
  });
});

describe('WebSocket 协议', () => {
  it('冻结 9 种服务端消息与两个鉴权关闭码', () => {
    expect(wsMessageTypeSchema.options).toHaveLength(9);
    expect(WS_CLOSE_CODES).toEqual({ UNAUTHORIZED: 4401, FORBIDDEN: 4403 });
  });

  it('按消息类型校验字段级 payload', () => {
    expect(
      wsMessageSchema.parse({
        type: 'monitor_progress',
        status: 'progress',
        country: 'US',
        current: 5,
        total: 10,
        progress: 50,
        timestamp: '2026-08-24T18:00:00+08:00',
      }).type,
    ).toBe('monitor_progress');

    expect(() =>
      wsMessageSchema.parse({
        type: 'task_complete',
        taskId: 'task-1',
        timestamp: '2026-08-24T18:00:00+08:00',
      }),
    ).toThrow();

    expect(
      wsMessageSchema.parse({
        type: 'task_complete',
        taskId: 'task-2',
        downloadUrl: null,
        filename: null,
        timestamp: '2026-08-24T18:00:00+08:00',
      }).type,
    ).toBe('task_complete');
  });

  it('客户端只接受 ping 心跳', () => {
    expect(wsClientMessageSchema.parse({ type: 'ping' }).type).toBe('ping');
    expect(() => wsClientMessageSchema.parse({ type: 'pong' })).toThrow();
  });
});
