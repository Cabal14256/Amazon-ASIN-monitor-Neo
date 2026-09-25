import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { UserManagementApi } from './user-management';

const clients: HttpClient[] = [];
function setup() {
  const session = sessionFixture();
  const fetcher = vi.fn<typeof fetch>();
  const http = new HttpClient({
    baseURL: 'https://api.test/gateway/api/',
    pageOrigin: 'https://app.test',
    session: session.store,
    fetch: fetcher,
  });
  clients.push(http);
  return { api: new UserManagementApi(http), fetcher };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

const user = {
  id: 'user-1',
  username: 'alice',
  real_name: 'Alice',
  status: 'ACTIVE',
  force_password_change: false,
  roles: [{ id: 'reader-role', code: 'READONLY', name: '只读' }],
};
const role = {
  id: 'reader-role',
  code: 'READONLY',
  name: '只读',
  description: null,
  permissions: [
    {
      id: 'permission-1',
      code: 'user:read',
      name: '查看用户',
      resource: 'user',
      action: 'read',
    },
  ],
};

describe('Neo user management API boundary', () => {
  it('reads user pages and details through normalized, contract-checked URLs', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { list: [user], total: 11 } }),
    );
    const list = await f.api.users({
      username: 'ali',
      current: 2,
      pageSize: 10,
    });
    expect(list.total).toBe(11);
    const url = String(f.fetcher.mock.calls[0][0]);
    expect(url).toContain('/gateway/api/v1/users?');
    expect(url).not.toContain('/api/api/');
    expect(new URL(url).searchParams.get('username')).toBe('ali');
    expect(new URL(url).searchParams.get('current')).toBe('2');

    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { ...user, statusHistory: [], permissions: ['user:read'] },
      }),
    );
    expect((await f.api.user('user-1')).id).toBe('user-1');
    expect(f.fetcher.mock.calls[1][0]).toBe(
      'https://api.test/gateway/api/v1/users/user-1',
    );
    await expect(f.api.user('../user-1')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid user pagination and mismatched detail responses', async () => {
    const f = setup();
    await expect(
      f.api.users({ current: 1, pageSize: 101 }),
    ).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { list: [user], total: 1, current: 2 },
      }),
    );
    await expect(
      f.api.users({ current: 1, pageSize: 10 }),
    ).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: user }),
    );
    await expect(f.api.user('user-2')).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });

  it('reads roles and grouped permissions, then validates a permission update', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [role] }),
    );
    expect((await f.api.roles())[0].code).toBe('READONLY');
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [{ id: role.id, code: role.code, name: role.name }],
      }),
    );
    expect((await f.api.allRoles()).length).toBe(1);
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: role }),
    );
    expect((await f.api.role('reader-role')).id).toBe('reader-role');
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { list: role.permissions, grouped: { user: role.permissions } },
      }),
    );
    expect((await f.api.permissions()).grouped.user).toHaveLength(1);
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { roleId: 'reader-role' } }),
    );
    await f.api.assignPermissions('reader-role', {
      permissionIds: ['permission-1'],
    });
    expect(String(f.fetcher.mock.calls[4][0])).toBe(
      'https://api.test/gateway/api/v1/roles/reader-role/permissions',
    );
    expect(f.fetcher.mock.calls[4][1]?.method).toBe('PUT');
    expect(String(f.fetcher.mock.calls[4][1]?.body)).toContain('permission-1');
  });

  it('submits user mutations without exposing passwords in URLs or errors', async () => {
    const f = setup();
    const password = 'StrongPass123!';
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: user }),
    );
    await f.api.createUser({
      username: 'alice',
      password,
      roleIds: ['reader-role'],
      forcePasswordChange: true,
    });
    const createUrl = String(f.fetcher.mock.calls[0][0]);
    expect(createUrl).toBe('https://api.test/gateway/api/v1/users');
    expect(createUrl).not.toContain(password);
    expect(f.fetcher.mock.calls[0][1]?.method).toBe('POST');

    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: user }),
    );
    await f.api.updateUser('user-1', {
      status: 'INACTIVE',
      roleIds: ['reader-role'],
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, message: '已重置' }),
    );
    await f.api.resetPassword('user-1', {
      newPassword: password,
      forceChangeOnNextLogin: true,
      revokeAllSessions: true,
    });
    expect(String(f.fetcher.mock.calls[2][0])).not.toContain(password);
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, message: '已删除' }),
    );
    await f.api.deleteUser('user-1');
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          totalRequested: 2,
          deletedCount: 1,
          skipped: [{ userId: 'user-2', reason: 'ADMIN' }],
          failed: [],
        },
      }),
    );
    const batch = await f.api.batchDelete({ userIds: ['user-1', 'user-2'] });
    expect(batch.deletedCount).toBe(1);
    expect(batch.skipped).toHaveLength(1);

    await expect(
      f.api.createUser({
        username: 'alice',
        password: 'weak',
        roleIds: ['reader-role'],
        forcePasswordChange: true,
      }),
    ).rejects.not.toThrow('weak');
    expect(f.fetcher).toHaveBeenCalledTimes(5);
  });
});
