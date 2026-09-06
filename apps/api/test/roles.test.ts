import {
  allRolesResultSchema,
  assignPermissionsResultSchema,
  permissionListResultSchema,
  roleDetailResultSchema,
  roleListResultSchema,
} from '@asin-monitor/contracts';
import type {
  AuthSessionRecord,
  AuthUserRecord,
  PermissionRecord,
  RoleRecord,
  RoleRepositoryPort,
  RoleWriteUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionCacheService } from '../src/auth/permission-cache.service';
import { RoleModule } from '../src/roles/role.module';
import { ROLE_REPOSITORY } from '../src/roles/role.service';
import { sessionApp } from './helpers/session-app';

const userId = 'role-operator';
const sessionId = 'role-session';
const roleId = 'role-target';
const critical = [
  'user:read',
  'user:write',
  'user:delete',
  'role:read',
  'role:write',
  'audit:read',
];
function fixtureRepository() {
  const user: AuthUserRecord = {
    id: userId,
    username: 'role-fixture',
    status: 'ACTIVE',
    realName: null,
    lastLoginTime: null,
    lastLoginIp: null,
    passwordExpiresAt: null,
    passwordChangedAt: null,
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createTime: null,
    updateTime: null,
  };
  const session: AuthSessionRecord = {
    id: sessionId,
    userId,
    userAgent: null,
    ipAddress: null,
    status: 'ACTIVE',
    rememberMe: false,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  const role: RoleRecord = {
    id: roleId,
    code: 'TARGET',
    name: '目标角色',
    description: null,
    createTime: null,
    updateTime: null,
  };
  const permissions: PermissionRecord[] = critical.map((code, index) => ({
    id: `p${index}`,
    code,
    name: code,
    resource: code.split(':')[0],
    action: code.split(':')[1],
    description: null,
    createTime: null,
  }));
  permissions.push({
    id: 'p-null',
    code: 'custom:read',
    name: '空资源权限',
    resource: null,
    action: null,
    description: null,
    createTime: null,
  });
  let assigned = ['p3'];
  const unit: RoleWriteUnit = {
    listRoles: vi.fn(async () => [role]),
    findRole: vi.fn(async (id) => (id === roleId ? role : undefined)),
    listPermissions: vi.fn(async () => permissions),
    listRolePermissions: vi.fn(async () =>
      permissions
        .filter((row) => assigned.includes(row.id))
        .map((row) => ({ ...row, roleId })),
    ),
    lockOperator: vi.fn(async () => ({
      id: userId,
      status: user.status,
      lockedUntil: null,
      forcePasswordChange: false,
      passwordExpiresAt: null,
    })),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => ['role:write']),
    usersWithRole: vi.fn(async () => ['another-user']),
    replacePermissions: vi.fn(async (_role, ids) => {
      assigned = ids;
    }),
  };
  const repository: RoleRepositoryPort = {
    read: vi.fn(async (operation) => operation(unit)),
    transaction: vi.fn(async (operation) => operation(unit)),
  };
  const auth = {
    findSessionById: vi.fn(async () => structuredClone(session)),
    findUserById: vi.fn(async () => structuredClone(user)),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    getPermissionCodes: vi.fn(async () => ['role:read', 'role:write']),
    getRoles: vi.fn(async () => [
      { id: 'operator-role', code: 'ADMIN', name: '管理员' },
    ]),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { unit, repository, auth, user, session, role, permissions };
}

describe('Neo role management HTTP', () => {
  let f: ReturnType<typeof fixtureRepository>;
  let fixture: Awaited<ReturnType<typeof sessionApp>>;
  let headers: { authorization: string };
  let invalidate: ReturnType<typeof vi.spyOn>;
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    fixture = await sessionApp(
      f.auth,
      overrides,
      (builder) =>
        builder.overrideProvider(ROLE_REPOSITORY).useValue(f.repository),
      [RoleModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId, sessionId },
        fixture.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
    invalidate = vi
      .spyOn(fixture.app.get(PermissionCacheService), 'clearPostgresCaches')
      .mockResolvedValue();
  }
  beforeEach(async () => {
    f = fixtureRepository();
    await start();
  });
  afterEach(async () => {
    await fixture.app.close();
    vi.restoreAllMocks();
  });
  const get = (path: string) =>
    fixture.http.inject({ method: 'GET', url: `/api/v1${path}`, headers });
  const assign = (payload: unknown = { permissionIds: ['p3'] }) =>
    fixture.http.inject({
      method: 'PUT',
      url: `/api/v1/roles/${roleId}/permissions`,
      headers,
      payload: payload as object,
    });

  it.each(['/roles', `/roles/${roleId}`, '/permissions', '/users/roles/all'])(
    'requires authentication for %s',
    async (path) => {
      expect(
        (await fixture.http.inject({ method: 'GET', url: `/api/v1${path}` }))
          .statusCode,
      ).toBe(401);
      expect(f.repository.read).not.toHaveBeenCalled();
    },
  );
  it('requires a session for assignment', async () => {
    expect(
      (
        await fixture.http.inject({
          method: 'PUT',
          url: `/api/v1/roles/${roleId}/permissions`,
          payload: { permissionIds: [] },
        })
      ).statusCode,
    ).toBe(401);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('returns all four read contracts including nullable database fields and resource fallback', async () => {
    const list = await get('/roles');
    expect(list.statusCode).toBe(200);
    expect(
      roleListResultSchema.parse(list.json()).data?.[0].permissions?.[0].code,
    ).toBe('role:read');
    expect(
      roleDetailResultSchema.parse((await get(`/roles/${roleId}`)).json()).data
        ?.create_time,
    ).toBeNull();
    expect(
      allRolesResultSchema.parse((await get('/users/roles/all')).json())
        .data?.[0].id,
    ).toBe(roleId);
    const permissions = permissionListResultSchema.parse(
      (await get('/permissions')).json(),
    ).data!;
    expect(permissions.grouped.other[0]).toMatchObject({
      resource: null,
      action: null,
    });
    expect(list.body).not.toContain('role-operator');
  });
  it('does not implicitly grant ADMIN a permission absent from the permission set', async () => {
    f.auth.getPermissionCodes.mockResolvedValue([]);
    expect((await get('/roles')).statusCode).toBe(403);
    expect((await assign()).statusCode).toBe(403);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('separates role read from role write', async () => {
    f.auth.getPermissionCodes.mockResolvedValue(['role:read']);
    expect((await get('/roles')).statusCode).toBe(200);
    expect((await assign()).statusCode).toBe(403);
  });
  it('leaves the Legacy authority on its existing role management entry', async () => {
    await fixture.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture-only',
      DB_NAME: 'fixture',
    });
    expect((await get('/roles')).statusCode).toBe(503);
    expect((await assign()).statusCode).toBe(503);
    expect(f.repository.read).not.toHaveBeenCalled();
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('returns 404 for an absent role', async () => {
    expect((await get('/roles/missing')).statusCode).toBe(404);
    f.unit.findRole = vi.fn(async () => undefined);
    expect((await assign()).statusCode).toBe(404);
    expect(invalidate).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { permissionIds: 'p3' },
    { permissionIds: [42] },
    { permissionIds: ['bad\0id'] },
    { permissionIds: Array(1001).fill('p3') },
  ])('rejects invalid assignment %j', async (payload) => {
    expect((await assign(payload)).statusCode).toBe(400);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('rejects unknown permissions without changing assignments', async () => {
    expect((await assign({ permissionIds: ['missing'] })).statusCode).toBe(400);
    expect(f.unit.replacePermissions).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
  it('deduplicates and filters empty IDs while atomically replacing all assignments', async () => {
    const result = await assign({
      permissionIds: ['p3', 'p3', '', 'p4'],
      userId: 'injected',
    });
    expect(result.statusCode).toBe(200);
    expect(
      assignPermissionsResultSchema
        .parse(result.json())
        .data?.permissions?.map((row) => row.code),
    ).toEqual(['role:read', 'role:write']);
    expect(f.unit.replacePermissions).toHaveBeenCalledWith(roleId, [
      'p3',
      'p4',
    ]);
    expect(f.unit.lockOperator).toHaveBeenCalledWith(userId);
    expect(f.unit.lockSession).toHaveBeenCalledWith(userId, sessionId);
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('allows clearing another role but retains six critical permissions on an operator role', async () => {
    expect((await assign({ permissionIds: [] })).statusCode).toBe(200);
    vi.mocked(f.unit.usersWithRole).mockResolvedValue([userId]);
    const denied = await assign({ permissionIds: ['p3'] });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().errorMessage).toContain('role:write');
    expect(
      (
        await assign({
          permissionIds: critical.map((_code, index) => `p${index}`),
        })
      ).statusCode,
    ).toBe(200);
  });
  it.each(['user', 'session', 'permission', 'password'] as const)(
    'rechecks %s inside the transaction after HTTP authentication',
    async (cause) => {
      if (cause === 'user')
        vi.mocked(f.unit.lockOperator).mockResolvedValue({
          id: userId,
          status: 'DISABLED',
          lockedUntil: null,
          forcePasswordChange: false,
          passwordExpiresAt: null,
        });
      if (cause === 'session')
        vi.mocked(f.unit.lockSession).mockResolvedValue({
          ...f.session,
          status: 'REVOKED',
        });
      if (cause === 'permission')
        vi.mocked(f.unit.operatorPermissionCodes).mockResolvedValue([]);
      if (cause === 'password')
        vi.mocked(f.unit.lockOperator).mockResolvedValue({
          id: userId,
          status: 'ACTIVE',
          lockedUntil: null,
          forcePasswordChange: true,
          passwordExpiresAt: null,
        });
      expect((await assign()).statusCode).toBe(403);
      expect(f.unit.replacePermissions).not.toHaveBeenCalled();
    },
  );
  it('rejects an untrusted write origin', async () => {
    expect(
      (
        await fixture.http.inject({
          method: 'PUT',
          url: `/api/v1/roles/${roleId}/permissions`,
          headers: { ...headers, origin: 'https://untrusted.example' },
          payload: { permissionIds: [] },
        })
      ).statusCode,
    ).toBe(403);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('hides repository failures and does not invalidate before transaction success', async () => {
    vi.mocked(f.repository.transaction).mockRejectedValue(
      new Error('SQL secret fixture'),
    );
    const result = await assign();
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('SQL secret');
    expect(JSON.stringify(fixture.logger.error.mock.calls)).not.toContain(
      'SQL secret',
    );
    expect(invalidate).not.toHaveBeenCalled();
  });
});
