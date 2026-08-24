import { describe, expect, it } from 'vitest';

import {
  actionStatisticsResultSchema,
  auditLogListResultSchema,
  auditLogSchema,
} from '../src/domains/audit';
import { messageResultSchema } from '../src/domains/auth';
import {
  permissionListResultSchema,
  roleListResultSchema,
} from '../src/domains/roles';
import {
  batchDeleteResultSchema,
  createUserRequestSchema,
  userDetailResultSchema,
  userListResultSchema,
} from '../src/domains/users';

/**
 * users / roles / audit 域契约测试。
 * 断言关键形状与旧系统实读一致（userController.js / roleController.js /
 * auditLogController.js + AuditLog.js）。
 */

describe('users 域', () => {
  it('用户列表 data 含 list/total，列表项带 roles 摘要', () => {
    const parsed = userListResultSchema.parse({
      success: true,
      data: {
        list: [
          {
            id: 1,
            username: 'admin',
            status: 'ACTIVE',
            force_password_change: false,
            roles: [{ id: 'r1', code: 'ADMIN', name: '管理员' }],
          },
        ],
        total: 1,
      },
    });
    expect(parsed.data?.list[0].roles?.[0].code).toBe('ADMIN');
  });

  it('创建用户要求 roleIds 非空', () => {
    expect(() =>
      createUserRequestSchema.parse({
        username: 'a',
        password: 'b',
        roleIds: [],
      }),
    ).toThrow();
  });

  it('用户详情 data 带 permissions 字符串数组与 statusHistory', () => {
    const parsed = userDetailResultSchema.parse({
      success: true,
      data: {
        id: 2,
        username: 'u2',
        status: 'LOCKED',
        force_password_change: true,
        permissions: ['asin:read'],
        statusHistory: [{ new_status: 'LOCKED', reason: '连续失败' }],
      },
    });
    expect(parsed.data?.permissions).toContain('asin:read');
  });

  it('批量删除 data 含 skipped/failed 明细', () => {
    const parsed = batchDeleteResultSchema.parse({
      success: true,
      data: {
        totalRequested: 3,
        deletedCount: 2,
        skipped: [{ userId: 1, reason: '不能删除自己' }],
        failed: [],
      },
    });
    expect(parsed.data?.skipped[0].userId).toBe(1);
  });
});

describe('roles 域', () => {
  it('角色列表项带 permissions 摘要', () => {
    const parsed = roleListResultSchema.parse({
      success: true,
      data: [
        {
          id: 'r1',
          code: 'ADMIN',
          name: '管理员',
          permissions: [
            {
              id: 'p1',
              code: 'asin:read',
              name: '查看 ASIN',
              resource: 'asin',
              action: 'read',
            },
          ],
        },
      ],
    });
    expect(parsed.data?.[0].permissions?.[0].resource).toBe('asin');
  });

  it('权限列表 data 含 list 与 grouped', () => {
    const parsed = permissionListResultSchema.parse({
      success: true,
      data: {
        list: [
          {
            id: 'p1',
            code: 'asin:read',
            name: '查看',
            resource: 'asin',
            action: 'read',
          },
        ],
        grouped: {
          asin: [
            {
              id: 'p1',
              code: 'asin:read',
              name: '查看',
              resource: 'asin',
              action: 'read',
            },
          ],
        },
      },
    });
    expect(parsed.data?.grouped.asin).toHaveLength(1);
  });
});

describe('audit 域', () => {
  it('审计列表 data 为 PageInfo 形态，行含驼峰别名', () => {
    const parsed = auditLogListResultSchema.parse({
      success: true,
      errorCode: 0,
      data: {
        list: [
          {
            id: 1,
            action: 'LOGIN',
            user_id: 5,
            userId: 5,
            ipAddress: '127.0.0.1',
            requestData: { a: 1 },
            createTime: '2026-08-24 10:00:00',
          },
        ],
        total: 1,
        current: 1,
        pageSize: 10,
      },
    });
    expect(parsed.data?.list[0].userId).toBe(5);
  });

  it('requestData 解析失败时允许字符串', () => {
    const parsed = auditLogSchema.parse({
      id: 2,
      action: 'X',
      requestData: 'not-json',
    });
    expect(parsed.requestData).toBe('not-json');
  });

  it('action 统计为 [{action,count}]', () => {
    const parsed = actionStatisticsResultSchema.parse({
      success: true,
      data: [{ action: 'LOGIN', count: 42 }],
    });
    expect(parsed.data?.[0].count).toBe(42);
  });

  it('message 变体（删除用户等）可解析', () => {
    const parsed = messageResultSchema.parse({
      success: true,
      message: '删除成功',
    });
    expect(parsed.message).toBe('删除成功');
  });
});
