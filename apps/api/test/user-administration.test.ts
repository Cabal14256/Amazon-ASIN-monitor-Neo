import {
  batchDeleteResultSchema,
  createUserResultSchema,
  messageResultSchema,
  updateUserResultSchema,
} from '@asin-monitor/contracts';
import type {
  AuthSessionRecord,
  AuthUserRecord,
  UserAdministrationRepositoryPort,
  UserAdministrationUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionCacheService } from '../src/auth/permission-cache.service';
import { UserAdministrationModule } from '../src/users/user-administration.module';
import {
  USER_ADMINISTRATION_HASHER,
  USER_ADMINISTRATION_REPOSITORY,
} from '../src/users/user-administration.service';
import { sessionApp } from './helpers/session-app';

const operatorId = 'operator-61';
const targetId = 'target-61';
const sessionId = 'session-61';
const adminRole = { id: 'admin-role', code: 'ADMIN', name: '管理员' };
const readerRole = { id: 'reader-role', code: 'READONLY', name: '只读' };
const user = (id: string): AuthUserRecord => ({
  id,
  username: id,
  realName: null,
  status: 'ACTIVE',
  lastLoginTime: null,
  lastLoginIp: null,
  passwordExpiresAt: null,
  passwordChangedAt: null,
  forcePasswordChange: false,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createTime: null,
  updateTime: null,
});
function data() {
  const users = new Map(
    [operatorId, targetId, 'second-target'].map((id) => [id, user(id)]),
  );
  const assignments = new Map([
    [operatorId, [adminRole.id]],
    [targetId, [readerRole.id]],
    ['second-target', [readerRole.id]],
  ]);
  const allRoles = [adminRole, readerRole];
  const roleRows = (id: string) =>
    allRoles.filter((role) => assignments.get(id)?.includes(role.id));
  const session: AuthSessionRecord = {
    id: sessionId,
    userId: operatorId,
    userAgent: null,
    ipAddress: null,
    status: 'ACTIVE',
    rememberMe: false,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  const unit: UserAdministrationUnit = {
    listRoles: vi.fn(async () => []),
    findRole: vi.fn(),
    listPermissions: vi.fn(async () => []),
    listRolePermissions: vi.fn(async () => []),
    lockOperator: vi.fn(async (id) => users.get(id)),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => ['user:write', 'user:delete']),
    usersWithRole: vi.fn(async () => []),
    replacePermissions: vi.fn(),
    lockUser: vi.fn(async (id) => users.get(id)),
    findPublicUser: vi.fn(async (id) => users.get(id)),
    usernameExists: vi.fn(async (name) =>
      [...users.values()].some(
        (row) => row.username.toLowerCase() === name.toLowerCase(),
      ),
    ),
    rolesByIds: vi.fn(async (ids) =>
      allRoles.filter((role) => ids.includes(role.id)),
    ),
    rolesForUser: vi.fn(async (id) => roleRows(id)),
    createUser: vi.fn(async (input) => {
      users.set(input.id, {
        ...user(input.id),
        username: input.username,
        realName: input.realName,
        forcePasswordChange: input.forcePasswordChange,
        passwordExpiresAt: input.passwordExpiresAt,
        passwordChangedAt: input.now,
      });
    }),
    replaceRoles: vi.fn(async (id, ids) => {
      assignments.set(id, ids);
    }),
    updateName: vi.fn(async (id, name) => {
      users.get(id)!.realName = name;
    }),
    changeStatus: vi.fn(async (id, _old, status) => {
      users.get(id)!.status = status;
    }),
    countActiveAdmins: vi.fn(
      async (exclude) =>
        [...users.values()].filter(
          (row) =>
            row.id !== exclude &&
            row.status === 'ACTIVE' &&
            assignments.get(row.id)?.includes(adminRole.id),
        ).length,
    ),
    deleteUser: vi.fn(async (id) => {
      users.delete(id);
    }),
    attemptUserOperation: vi.fn(async (operation) => ({
      ok: true,
      value: await operation(),
    })),
  };
  const repository: UserAdministrationRepositoryPort = {
    transaction: vi.fn(async (operation) => operation(unit)),
  };
  const auth = {
    findUserById: vi.fn(async () => user(operatorId)),
    findSessionById: vi.fn(async () => structuredClone(session)),
    getPermissionCodes: vi.fn(async () => ['user:write', 'user:delete']),
    getRoles: vi.fn(async () => [adminRole]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { users, assignments, unit, repository, auth, session };
}

describe('Neo user administration HTTP', () => {
  let f: ReturnType<typeof data>;
  let fixture: Awaited<ReturnType<typeof sessionApp>>;
  let headers: { authorization: string };
  const hash = vi.fn(async () => 'fixture-hash-never-returned');
  let invalidate: ReturnType<typeof vi.spyOn>;
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    fixture = await sessionApp(
      f.auth,
      overrides,
      (builder) =>
        builder
          .overrideProvider(USER_ADMINISTRATION_REPOSITORY)
          .useValue(f.repository)
          .overrideProvider(USER_ADMINISTRATION_HASHER)
          .useValue(hash),
      [UserAdministrationModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: operatorId, sessionId },
        fixture.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
    invalidate = vi
      .spyOn(fixture.app.get(PermissionCacheService), 'clearPostgresCaches')
      .mockResolvedValue();
  }
  beforeEach(async () => {
    f = data();
    hash.mockClear();
    await start();
  });
  afterEach(async () => {
    await fixture.app.close();
    vi.restoreAllMocks();
  });
  const createBody = {
    username: 'new-user-61',
    password: 'FixturePassword61',
    roleIds: [readerRole.id],
  };
  const request = (
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: object,
  ) => fixture.http.inject({ method, url: `/api/v1${path}`, headers, payload });
  const create = (body: object = createBody) => request('POST', '/users', body);
  const update = (body: object, id = targetId) =>
    request('PUT', `/users/${id}`, body);
  const remove = (id = targetId) => request('DELETE', `/users/${id}`);
  const batch = (ids: string[]) =>
    request('POST', '/users/batch-delete', { userIds: ids });
  const routes = [
    ['POST', '/users'],
    ['PUT', `/users/${targetId}`],
    ['DELETE', `/users/${targetId}`],
    ['POST', '/users/batch-delete'],
  ] as const;

  it.each(routes)('requires a session for %s %s', async (method, path) => {
    expect(
      (
        await fixture.http.inject({
          method,
          url: `/api/v1${path}`,
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it.each(routes)(
    'rejects an untrusted Origin for %s %s',
    async (method, path) => {
      expect(
        (
          await fixture.http.inject({
            method,
            url: `/api/v1${path}`,
            headers: { ...headers, origin: 'https://untrusted.example' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(f.repository.transaction).not.toHaveBeenCalled();
    },
  );
  it('separates write and delete permissions without an implicit ADMIN bypass', async () => {
    f.auth.getPermissionCodes.mockResolvedValue(['user:read']);
    expect((await create()).statusCode).toBe(403);
    expect((await update({})).statusCode).toBe(403);
    expect((await remove()).statusCode).toBe(403);
    f.auth.getPermissionCodes.mockResolvedValue(['user:write']);
    expect((await update({ real_name: 'Fixture' })).statusCode).toBe(200);
    expect((await batch([targetId])).statusCode).toBe(403);
  });
  it('leaves all writes with the existing Legacy authority', async () => {
    await fixture.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture-only',
      DB_NAME: 'fixture',
    });
    for (const action of [
      () => create(),
      () => update({}),
      () => remove(),
      () => batch([targetId]),
    ])
      expect((await action()).statusCode).toBe(503);
    expect(hash).not.toHaveBeenCalled();
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('creates a public user with validated deduplicated roles, hashing and password defaults', async () => {
    const response = await create({
      ...createBody,
      roleIds: [readerRole.id, readerRole.id, ''],
      id: 'injected',
    });
    expect(response.statusCode).toBe(200);
    const created = createUserResultSchema.parse(response.json()).data!;
    expect(created.id).not.toBe('injected');
    expect(created).toMatchObject({
      username: createBody.username,
      force_password_change: true,
      roles: [readerRole],
    });
    expect(hash).toHaveBeenCalledWith(createBody.password);
    const input = vi.mocked(f.unit.createUser).mock.calls[0][0];
    expect(input.passwordExpiresAt.getTime() - input.now.getTime()).toBe(
      90 * 86_400_000,
    );
    expect(response.body).not.toContain('fixture-hash-never-returned');
    expect(JSON.stringify(fixture.logger.info.mock.calls)).not.toContain(
      createBody.password,
    );
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it.each([
    {},
    { ...createBody, username: ' ' },
    { ...createBody, username: 'x'.repeat(51) },
    { ...createBody, password: 'weak' },
    { ...createBody, roleIds: [] },
    { ...createBody, roleIds: ['missing'] },
    { ...createBody, real_name: 'x'.repeat(101) },
    { ...createBody, roleIds: Array(101).fill(readerRole.id) },
  ])('rejects invalid creation without persisting %j', async (body) => {
    expect((await create(body)).statusCode).toBe(400);
    expect(f.unit.createUser).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
  it('rejects duplicate usernames and handles a concurrent unique constraint without exposing SQL', async () => {
    expect(
      (await create({ ...createBody, username: targetId.toUpperCase() }))
        .statusCode,
    ).toBe(400);
    vi.mocked(f.repository.transaction).mockRejectedValue({
      cause: {
        code: '23505',
        constraint: 'uq_users_username_ci',
        detail: 'fixture secret SQL',
      },
    });
    const response = await create();
    expect(response.statusCode).toBe(400);
    expect(response.json().errorMessage).toBe('用户名已存在');
    expect(response.body).not.toContain('fixture secret');
  });
  it('updates name, status and roles together and returns the resulting public user', async () => {
    const response = await update({
      real_name: '改名',
      status: 'SUSPENDED',
      statusReason: 'fixture reason',
      roleIds: [readerRole.id],
    });
    expect(response.statusCode).toBe(200);
    expect(updateUserResultSchema.parse(response.json()).data).toMatchObject({
      real_name: '改名',
      status: 'SUSPENDED',
      roles: [readerRole],
    });
    expect(f.unit.changeStatus).toHaveBeenCalledWith(
      targetId,
      'ACTIVE',
      'SUSPENDED',
      'fixture reason',
      operatorId,
      expect.any(Date),
    );
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('protects the operator from removing their ADMIN role or disabling/deleting themselves', async () => {
    expect(
      (await update({ roleIds: [readerRole.id] }, operatorId)).statusCode,
    ).toBe(400);
    expect((await update({ status: 'INACTIVE' }, operatorId)).statusCode).toBe(
      400,
    );
    expect((await remove(operatorId)).statusCode).toBe(400);
    expect(f.unit.replaceRoles).not.toHaveBeenCalled();
    expect(f.unit.deleteUser).not.toHaveBeenCalled();
  });
  it('preserves the last ACTIVE administrator for status, role, single and bulk deletion changes', async () => {
    f.assignments.set(operatorId, [readerRole.id]);
    f.assignments.set(targetId, [adminRole.id]);
    expect((await update({ status: 'INACTIVE' })).statusCode).toBe(400);
    expect((await update({ roleIds: [readerRole.id] })).statusCode).toBe(400);
    expect((await remove()).statusCode).toBe(400);
    const response = await batch([targetId]);
    expect(batchDeleteResultSchema.parse(response.json()).data).toMatchObject({
      deletedCount: 0,
      skipped: [{ userId: targetId }],
    });
    expect(f.unit.deleteUser).not.toHaveBeenCalled();
  });
  it.each(['user', 'session', 'permission', 'password'] as const)(
    'rechecks %s inside the write transaction',
    async (condition) => {
      if (condition === 'user')
        vi.mocked(f.unit.lockOperator).mockResolvedValue({
          ...user(operatorId),
          status: 'INACTIVE',
        });
      if (condition === 'session')
        vi.mocked(f.unit.lockSession).mockResolvedValue({
          ...f.session,
          status: 'REVOKED',
        });
      if (condition === 'permission')
        vi.mocked(f.unit.operatorPermissionCodes).mockResolvedValue([]);
      if (condition === 'password')
        vi.mocked(f.unit.lockOperator).mockResolvedValue({
          ...user(operatorId),
          forcePasswordChange: true,
        });
      expect((await update({ real_name: 'attempt' })).statusCode).toBe(403);
      expect(f.unit.updateName).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    },
  );
  it('returns the Legacy delete message and clears caches only after the transaction succeeds', async () => {
    const response = await remove();
    expect(response.statusCode).toBe(200);
    expect(messageResultSchema.parse(response.json()).message).toBe('删除成功');
    expect(f.users.has(targetId)).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
    vi.mocked(f.repository.transaction).mockRejectedValue(
      new Error('fixture SQL secret'),
    );
    invalidate.mockClear();
    const failed = await remove('second-target');
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('fixture SQL');
    expect(invalidate).not.toHaveBeenCalled();
  });
  it('preserves batch input order, trims and deduplicates IDs, and distinguishes self/missing skips', async () => {
    const response = await batch([
      operatorId,
      ` ${targetId} `,
      targetId,
      'missing',
      'second-target',
    ]);
    expect(response.statusCode).toBe(200);
    expect(batchDeleteResultSchema.parse(response.json()).data).toMatchObject({
      totalRequested: 4,
      deletedCount: 2,
      skipped: [{ userId: operatorId }, { userId: 'missing' }],
      failed: [],
    });
  });
  it('does not consume an administrator deletion allowance for a recovered failed candidate', async () => {
    f.assignments.set(operatorId, [readerRole.id]);
    f.assignments.set(targetId, [adminRole.id]);
    f.assignments.set('second-target', [adminRole.id]);
    vi.mocked(f.unit.attemptUserOperation).mockResolvedValueOnce({ ok: false });
    const response = await batch([targetId, 'second-target']);
    expect(batchDeleteResultSchema.parse(response.json()).data).toMatchObject({
      deletedCount: 1,
      skipped: [],
      failed: [{ userId: targetId, message: '删除失败' }],
    });
    expect(f.users.has(targetId)).toBe(true);
    expect(f.users.has('second-target')).toBe(false);
  });
  it('fails the whole request if the savepoint cannot recover the transaction', async () => {
    vi.mocked(f.unit.attemptUserOperation).mockRejectedValue(
      new Error('fixture closed connection'),
    );
    expect((await batch([targetId, 'second-target'])).statusCode).toBe(500);
    expect(invalidate).not.toHaveBeenCalled();
  });
  it('bounds batch size and rejects invalid update fields and absent users', async () => {
    expect((await batch(Array(101).fill(targetId))).statusCode).toBe(400);
    expect((await update({ roleIds: [] })).statusCode).toBe(400);
    expect((await update({ statusReason: 'x'.repeat(256) })).statusCode).toBe(
      400,
    );
    expect(await update({}, 'missing')).toMatchObject({ statusCode: 404 });
    expect((await remove('missing')).statusCode).toBe(404);
  });
});
