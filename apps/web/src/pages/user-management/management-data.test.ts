import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/http';
import {
  canAdminResetPassword,
  managementError,
  managementTime,
  managementWriteError,
  parseAdminResetForm,
  permissionDenied,
  statusForManagedUser,
  visibleManagementData,
} from './management-data';

describe('user management display boundaries', () => {
  it('uses Shanghai wall time and hides raw API error payloads', () => {
    expect(managementTime('2026-09-24T01:30:00Z')).toBe('2026-09-24 09:30:00');
    expect(managementTime(null)).toBe('未记录');
    expect(
      managementError(new ApiError('HTTP', 'raw personal data', 403)),
    ).toContain('没有执行');
    expect(
      managementError(new ApiError('HTTP', 'raw personal data', 503)),
    ).not.toContain('raw personal data');
  });

  it('explains known 400 rules while keeping arbitrary response content private', () => {
    expect(managementError(new ApiError('HTTP', '用户名已存在', 400))).toBe(
      '用户名已存在，请更换用户名。',
    );
    expect(
      managementError(
        new ApiError('HTTP', '新密码不能与最近 5 次使用过的密码相同', 400),
      ),
    ).toContain('最近 5 次');
    expect(
      managementError(
        new ApiError('HTTP', '系统至少需要保留一个启用中的管理员账户', 400),
      ),
    ).toContain('管理员');
    expect(
      managementError(
        new ApiError('HTTP', '当前角色必须保留权限: user:read', 400),
      ),
    ).not.toContain('user:read');
    expect(
      managementError(new ApiError('HTTP', 'raw secret: abc', 400)),
    ).not.toContain('abc');
  });

  it('fixes the current user to ACTIVE while allowing another user status change', () => {
    expect(statusForManagedUser('self', 'self', 'LOCKED')).toBe('ACTIVE');
    expect(statusForManagedUser('other', 'self', 'LOCKED')).toBe('LOCKED');
  });

  it('keeps privileged snapshots hidden after revocation until a newer read succeeds', () => {
    const old = {
      value: [{ username: 'previously authorized' }],
      generation: 0,
    };
    const fresh = { value: [{ username: 'newly authorized' }], generation: 1 };
    expect(permissionDenied(new ApiError('HTTP', 'denied', 403))).toBe(true);
    expect(permissionDenied(new ApiError('HTTP', 'expired', 401))).toBe(true);
    expect(permissionDenied(new ApiError('HTTP', 'unavailable', 503))).toBe(
      false,
    );
    expect(visibleManagementData(old, null, false)).toBe(old.value);
    expect(visibleManagementData(old, 1, false)).toBeUndefined();
    expect(visibleManagementData(old, 1, true)).toBeUndefined();
    expect(visibleManagementData(fresh, 1, false)).toBe(fresh.value);
    expect(visibleManagementData(fresh, 1, true)).toBeUndefined();
  });

  it('invalidates the entire management view after a denied write', () => {
    const report = vi.fn();
    expect(
      managementWriteError(new ApiError('HTTP', 'secret', 403), report),
    ).toContain('没有执行');
    expect(report).toHaveBeenCalledOnce();
    managementWriteError(new ApiError('HTTP', 'secret', 401), report);
    expect(report).toHaveBeenCalledTimes(2);
    managementWriteError(new ApiError('HTTP', 'conflict', 409), report);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('allows only another user to be reset with a confirmed valid password', () => {
    expect(canAdminResetPassword('user-1', 'user-1')).toBe(false);
    expect(canAdminResetPassword('user-2', null)).toBe(false);
    expect(canAdminResetPassword('user-2', 'user-1')).toBe(true);
    expect(
      parseAdminResetForm('StrongPass123!', 'StrongPass124!', true, true),
    ).toMatchObject({
      success: false,
      message: '两次输入的密码不一致。',
    });
    expect(parseAdminResetForm('weak', 'weak', true, true).success).toBe(false);
    expect(
      parseAdminResetForm('StrongPass123!', 'StrongPass123!', false, true),
    ).toEqual({
      success: true,
      data: {
        newPassword: 'StrongPass123!',
        forceChangeOnNextLogin: false,
        revokeAllSessions: true,
      },
    });
  });
});
