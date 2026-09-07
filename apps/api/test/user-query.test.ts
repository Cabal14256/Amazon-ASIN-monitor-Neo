import {
  userDetailResultSchema,
  userListResultSchema,
} from '@asin-monitor/contracts';
import type {
  AuthUserRecord,
  UserQueryDetail,
  UserQueryRepositoryPort,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserQueryModule } from '../src/users/user-query.module';
import { USER_QUERY_REPOSITORY } from '../src/users/user-query.service';
import { sessionApp } from './helpers/session-app';

const operatorId = 'query-operator';
const sessionId = 'query-session';
const user: AuthUserRecord = {
  id: 'query-target',
  username: 'fixture-target',
  realName: null,
  status: 'ACTIVE',
  lastLoginTime: null,
  lastLoginIp: '192.0.2.59',
  passwordExpiresAt: null,
  passwordChangedAt: null,
  forcePasswordChange: false,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createTime: null,
  updateTime: null,
};
const role = { id: 'query-role', code: 'READONLY', name: '只读' };
function data(): UserQueryDetail {
  return {
    user: { ...user },
    roles: [role],
    permissions: ['asin:read'],
    statusHistory: [
      {
        id: 9n,
        userId: user.id,
        oldStatus: null,
        newStatus: 'ACTIVE',
        reason: null,
        changedBy: null,
        createdAt: null,
      },
    ],
  };
}
describe('Neo user query HTTP', () => {
  let fixture: Awaited<ReturnType<typeof sessionApp>>;
  let repository: UserQueryRepositoryPort;
  let detail: UserQueryDetail;
  let auth: NonNullable<Parameters<typeof sessionApp>[0]>;
  let headers: { authorization: string };
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    fixture = await sessionApp(
      auth,
      overrides,
      (builder) =>
        builder.overrideProvider(USER_QUERY_REPOSITORY).useValue(repository),
      [UserQueryModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: operatorId, sessionId },
        fixture.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  }
  beforeEach(async () => {
    detail = data();
    repository = {
      list: vi.fn(async () => ({
        users: [detail.user],
        total: 1,
        roles: [{ ...role, userId: user.id }],
      })),
      detail: vi.fn(async () => detail),
    };
    auth = {
      findUserById: vi.fn(async () => ({ ...user, id: operatorId })),
      findSessionById: vi.fn(async () => ({
        id: sessionId,
        userId: operatorId,
        status: 'ACTIVE',
        rememberMe: false,
        userAgent: null,
        ipAddress: null,
        createdAt: new Date(),
        lastActiveAt: new Date(),
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      })),
      getRoles: vi.fn(async () => [
        { id: 'admin', code: 'ADMIN', name: 'Admin' },
      ]),
      getPermissionCodes: vi.fn(async () => ['user:read']),
      revokeSession: vi.fn(),
      touchSession: vi.fn(),
      markPasswordChangeRequired: vi.fn(),
      listSessionsByUserId: vi.fn(async () => []),
      revokeOwnedSession: vi.fn(async () => true),
    };
    await start();
  });
  afterEach(async () => {
    await fixture.app.close();
    vi.restoreAllMocks();
  });
  const get = (path = '/users') =>
    fixture.http.inject({ method: 'GET', url: `/api/v1${path}`, headers });

  it.each(['/users', `/users/${user.id}`])(
    'requires a verified session at %s',
    async (path) => {
      expect(
        (await fixture.http.inject({ method: 'GET', url: `/api/v1${path}` }))
          .statusCode,
      ).toBe(401);
      expect(repository.list).not.toHaveBeenCalled();
      expect(repository.detail).not.toHaveBeenCalled();
    },
  );
  it('requires user:read even for ADMIN', async () => {
    vi.mocked(auth.getPermissionCodes).mockResolvedValue([
      'role:read',
      'user:write',
    ]);
    expect((await get()).statusCode).toBe(403);
    expect((await get(`/users/${user.id}`)).statusCode).toBe(403);
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('keeps Legacy authority on its existing user management entry', async () => {
    await fixture.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture-only',
      DB_NAME: 'fixture',
    });
    expect((await get()).statusCode).toBe(503);
    expect((await get(`/users/${user.id}`)).statusCode).toBe(503);
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('returns Legacy list/total and detail contracts with public fields, roles and nullable history', async () => {
    const list = await get();
    expect(list.statusCode).toBe(200);
    expect(userListResultSchema.parse(list.json()).data).toMatchObject({
      total: 1,
      list: [
        { id: user.id, create_time: null, update_time: null, roles: [role] },
      ],
    });
    expect(repository.list).toHaveBeenCalledWith({ current: 1, pageSize: 10 });
    const response = await get(`/users/${user.id}`);
    expect(response.statusCode).toBe(200);
    expect(userDetailResultSchema.parse(response.json()).data).toMatchObject({
      id: user.id,
      permissions: ['asin:read'],
      statusHistory: [{ id: 9, created_at: null }],
    });
    expect(response.json().data).not.toHaveProperty('password');
    expect(response.json().data).not.toHaveProperty('last_failed_login');
    expect(JSON.stringify(fixture.logger.info.mock.calls)).not.toContain(
      user.lastLoginIp,
    );
  });
  it('passes bounded search and persisted status filters without inventing pagination response fields', async () => {
    const response = await get(
      '/users?username=Fixture%25&status=LOCKED&current=2&pageSize=25',
    );
    expect(response.statusCode).toBe(200);
    expect(repository.list).toHaveBeenCalledWith({
      username: 'Fixture%',
      status: 'LOCKED',
      current: 2,
      pageSize: 25,
    });
    expect(response.json().data).not.toHaveProperty('current');
    expect((await get('/users?username=&status=')).statusCode).toBe(200);
  });
  it.each([
    'current=0',
    'current=-1',
    'current=1.2',
    'current=x',
    'current=9007199254740991&pageSize=100',
    'pageSize=101',
    'pageSize=0',
    'status=DISABLED',
    'username=%00',
    'current=1&current=2',
    'username=a&username=b',
    'unexpected=x',
  ])('rejects invalid query %s', async (query) => {
    expect((await get(`/users?${query}`)).statusCode).toBe(400);
    expect(repository.list).not.toHaveBeenCalled();
  });
  it.each([
    ['LOCKED', '2020-01-01T00:00:00Z', 'LOCKED'],
    ['ACTIVE', '2020-01-01T00:00:00Z', 'ACTIVE'],
    ['ACTIVE', '2099-01-01T00:00:00Z', 'LOCKED'],
    ['LOCKED', '2099-01-01T00:00:00Z', 'LOCKED'],
    ['SUSPENDED', null, 'SUSPENDED'],
  ])(
    'normalizes %s with lock expiry %s to %s',
    async (status, expiry, expected) => {
      detail.user.status = status!;
      detail.user.lockedUntil = expiry ? new Date(expiry) : null;
      detail.user.forcePasswordChange = null;
      expect((await get(`/users/${user.id}`)).json().data).toMatchObject({
        status: expected,
        force_password_change: false,
      });
    },
  );
  it('returns 404 for absent users and rejects malformed IDs before querying', async () => {
    vi.mocked(repository.detail).mockResolvedValue(undefined);
    expect((await get('/users/missing')).statusCode).toBe(404);
    vi.mocked(repository.detail).mockClear();
    expect((await get(`/users/${'x'.repeat(51)}`)).statusCode).toBe(400);
    expect((await get('/users/bad%00id')).statusCode).toBe(400);
    expect(repository.detail).not.toHaveBeenCalled();
  });
  it('fails rather than rounding a history bigint outside the safe integer range', async () => {
    detail.statusHistory[0].id = 9007199254740993n;
    expect((await get(`/users/${user.id}`)).statusCode).toBe(500);
  });
  it('redacts repository exceptions and returns a fixed failure envelope', async () => {
    vi.mocked(repository.list).mockRejectedValue(
      new Error('SQL password fixture@example.invalid'),
    );
    const response = await get('/users?username=private-fixture');
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('SQL password');
    const logs = JSON.stringify(fixture.logger.error.mock.calls);
    expect(logs).not.toContain('fixture@example.invalid');
    expect(logs).not.toContain('private-fixture');
  });
  it('rejects excess concurrent work and releases capacity after failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    vi.mocked(repository.list).mockImplementation(async () => {
      await gate;
      throw new Error('fixture timeout');
    });
    const pending = Array.from({ length: 8 }, () => get());
    try {
      await vi.waitFor(() => expect(repository.list).toHaveBeenCalledTimes(8));
      expect((await get()).statusCode).toBe(429);
    } finally {
      release();
    }
    expect(
      (await Promise.all(pending)).every(
        (response) => response.statusCode === 500,
      ),
    ).toBe(true);
    vi.mocked(repository.list).mockResolvedValue({
      users: [],
      total: 0,
      roles: [],
    });
    expect((await get()).statusCode).toBe(200);
  });
});
