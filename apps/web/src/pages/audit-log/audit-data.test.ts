import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import {
  auditAccessError,
  auditAccessReducer,
  auditAction,
  auditDeletedDetailError,
  auditError,
  auditResource,
  auditResponseStatus,
  auditTime,
  auditVisibleDetail,
  auditVisibleList,
} from './audit-data';

describe('audit log display boundaries', () => {
  it('keeps unknown business labels and status distinct from missing values', () => {
    expect(auditAction('RESET_PASSWORD')).toBe('重置密码');
    expect(auditAction('FUTURE_ACTION')).toBe('FUTURE_ACTION');
    expect(auditResource('variant_group')).toBe('变体组');
    expect(auditResource('future_resource')).toBe('future_resource');
    expect(auditResource(null)).toBe('未记录');
    expect(auditResponseStatus(null)).toEqual({
      label: '未记录',
      badge: 'unknown',
    });
    expect(auditResponseStatus(200).badge).toBe('success');
    expect(auditResponseStatus(403).badge).toBe('danger');
    expect(auditResponseStatus(503).badge).toBe('warning');
    expect(auditTime('2026-09-24T01:30:00Z')).toBe('2026-09-24 09:30:00');
  });

  it.each([
    [400, '筛选或分页'],
    [401, '重新登录'],
    [403, '没有审计读取权限'],
    [404, '已不存在'],
    [503, '繁忙'],
    [504, '超时'],
  ])('explains API %s without showing its raw payload', (status, message) => {
    expect(auditError(new ApiError('HTTP', 'raw payload', status))).toContain(
      message,
    );
  });

  it('hides an old list after detail read revocation until a fresh authorized read', () => {
    const oldList = [{ id: 7, username: 'previously authorized' }];
    const revoked = new ApiError('HTTP', 'forbidden', 403);
    expect(auditAccessError(revoked)).toBe(revoked);
    expect(auditVisibleList(oldList, null, revoked)).toBeUndefined();
    expect(auditVisibleList(oldList, revoked, null)).toBeUndefined();
    expect(
      auditVisibleList(oldList, new ApiError('HTTP', 'missing', 404)),
    ).toBe(oldList);
    expect(auditVisibleList(oldList, null, null)).toBe(oldList);
  });

  it('keeps a denied list hidden through transient failures until a fresh success', () => {
    const revoked = new ApiError('HTTP', 'forbidden', 403);
    const initial = { error: null, generation: 0 };
    const blocked = auditAccessReducer(initial, {
      type: 'list-revoked',
      error: revoked,
      generation: 1,
    });
    expect(blocked).toEqual({ error: revoked, generation: 1 });
    expect(auditVisibleList([{ id: 7 }], blocked.error)).toBeUndefined();
    expect(
      auditAccessReducer(blocked, { type: 'list-succeeded', generation: 0 }),
    ).toBe(blocked);
    expect(
      auditAccessReducer(blocked, { type: 'list-succeeded', generation: 1 }),
    ).toEqual({ error: null, generation: 1 });
    const detailBlocked = auditAccessReducer(blocked, {
      type: 'detail-revoked',
      error: revoked,
      generation: 2,
    });
    expect(
      auditAccessReducer(detailBlocked, {
        type: 'list-succeeded',
        generation: 1,
      }),
    ).toBe(detailBlocked);
  });

  it('does not reveal a deleted detail after a transient retry failure', () => {
    const missing = new ApiError('HTTP', 'removed', 404);
    const temporary = new ApiError('HTTP', 'offline', 503);
    expect(auditDeletedDetailError(missing)).toBe(missing);
    expect(auditDeletedDetailError(temporary)).toBeNull();
    expect(auditVisibleDetail({ id: 7 }, null, missing)).toBeUndefined();
    expect(auditVisibleDetail({ id: 7 }, missing, temporary)).toBeUndefined();
    expect(auditVisibleDetail({ id: 7 }, null, temporary)).toEqual({ id: 7 });
  });
});
