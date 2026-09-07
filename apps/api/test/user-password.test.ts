import { messageResultSchema } from '@asin-monitor/contracts';
import type {
  AccountUserRecord,
  AuthSessionRecord,
  UserPasswordRepositoryPort,
  UserPasswordUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserAdministrationModule } from '../src/users/user-administration.module';
import {
  USER_PASSWORD_COMPARER,
  USER_PASSWORD_HASHER,
  USER_PASSWORD_REPOSITORY,
} from '../src/users/user-password.service';
import { sessionApp } from './helpers/session-app';

const operatorId = 'operator-63';
const targetId = 'target-63';
const sessionId = 'session-63';
const original = 'Fixture-Original-63';
const replacement = 'Fixture-Replacement-63';
function data() {
  const user: AccountUserRecord = {
    id: targetId,
    username: targetId,
    password: `hash:${original}`,
    realName: null,
    status: 'ACTIVE',
    lastLoginTime: null,
    lastLoginIp: null,
    passwordExpiresAt: null,
    passwordChangedAt: null,
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastFailedLogin: null,
    createTime: null,
    updateTime: null,
  };
  const operator = { ...user, id: operatorId, username: operatorId };
  const session: AuthSessionRecord = {
    id: sessionId,
    userId: operatorId,
    userAgent: null,
    ipAddress: null,
    status: 'ACTIVE',
    rememberMe: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActiveAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  const history: string[] = [];
  const unit: UserPasswordUnit = {
    listRoles: vi.fn(async () => []),
    findRole: vi.fn(),
    listPermissions: vi.fn(async () => []),
    listRolePermissions: vi.fn(async () => []),
    usersWithRole: vi.fn(async () => []),
    replacePermissions: vi.fn(),
    lockOperator: vi.fn(async () => operator),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => ['user:write']),
    credentials: {
      lockUser: vi.fn(async () => user),
      recentPasswords: vi.fn(async () => history),
      savePreviousPassword: vi.fn(),
      updatePassword: vi.fn(),
    },
    revokeAllSessions: vi.fn(),
  };
  const repository: UserPasswordRepositoryPort = {
    transaction: vi.fn(async (operation) => operation(unit)),
  };
  const auth = {
    findUserById: vi.fn(async () => structuredClone({ ...operator })),
    findSessionById: vi.fn(async () => structuredClone(session)),
    getPermissionCodes: vi.fn(async () => ['user:write']),
    getRoles: vi.fn(async () => [
      { id: 'admin-63', code: 'ADMIN', name: '管理员' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  const hash = vi.fn(async (password: string) => `hash:${password}`);
  const compare = vi.fn(
    async (password: string, hash: string) => hash === `hash:${password}`,
  );
  return {
    user,
    operator,
    session,
    history,
    unit,
    repository,
    auth,
    hash,
    compare,
  };
}

describe('Neo administrator password reset HTTP', () => {
  let f: ReturnType<typeof data>;
  let fixture: Awaited<ReturnType<typeof sessionApp>>;
  let headers: { authorization: string };
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    fixture = await sessionApp(
      f.auth,
      overrides,
      (builder) =>
        builder
          .overrideProvider(USER_PASSWORD_REPOSITORY)
          .useValue(f.repository)
          .overrideProvider(USER_PASSWORD_HASHER)
          .useValue(f.hash)
          .overrideProvider(USER_PASSWORD_COMPARER)
          .useValue(f.compare),
      [UserAdministrationModule],
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
    f = data();
    await start();
  });
  afterEach(async () => {
    await fixture.app.close();
    vi.restoreAllMocks();
  });
  const reset = (
    payload: object = { newPassword: replacement },
    id = targetId,
    requestHeaders = headers,
  ) =>
    fixture.http.inject({
      method: 'PUT',
      url: `/api/v1/users/${encodeURIComponent(id)}/password`,
      headers: requestHeaders,
      payload,
    });

  it('requires authentication before password work', async () => {
    expect(
      (await reset(undefined, targetId, {} as typeof headers)).statusCode,
    ).toBe(401);
    expect(f.hash).not.toHaveBeenCalled();
  });
  it('requires user:write even when the caller has the ADMIN role', async () => {
    f.auth.getPermissionCodes.mockResolvedValue(['user:read', 'user:delete']);
    expect((await reset()).statusCode).toBe(403);
    expect(f.hash).not.toHaveBeenCalled();
  });
  it('rejects an untrusted Origin before password work', async () => {
    expect(
      (
        await reset(undefined, targetId, {
          ...headers,
          origin: 'https://untrusted.example',
        } as typeof headers)
      ).statusCode,
    ).toBe(403);
    expect(f.hash).not.toHaveBeenCalled();
  });
  it('rejects Legacy authority without opening a write transaction', async () => {
    await fixture.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture-only',
      DB_NAME: 'fixture',
    });
    expect((await reset()).statusCode).toBe(503);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { newPassword: 'short' },
    { newPassword: 'onlylowercase' },
    { newPassword: replacement, forceChangeOnNextLogin: 'false' },
    { newPassword: replacement, revokeAllSessions: 0 },
    { newPassword: `Password63${'x'.repeat(1024)}` },
    { newPassword: 'Password63\0' },
  ])('rejects invalid input without CPU/DB work: %j', async (payload) => {
    expect((await reset(payload)).statusCode).toBe(400);
    expect(f.hash).not.toHaveBeenCalled();
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it.each([operatorId, 'x'.repeat(51), 'bad\u001f-id'])(
    'rejects self or invalid target %s',
    async (id) => {
      expect((await reset(undefined, id)).statusCode).toBe(400);
      expect(f.hash).not.toHaveBeenCalled();
    },
  );
  it('uses a message envelope, configured expiry and defaults; strips unrelated fields', async () => {
    await fixture.app.close();
    await start({ PASSWORD_EXPIRE_DAYS: '30' });
    const response = await reset({
      newPassword: replacement,
      password: 'injected',
      userId: operatorId,
      status: 'SUSPENDED',
    });
    expect(response.statusCode).toBe(200);
    expect(messageResultSchema.parse(response.json()).message).toBe(
      '密码修改成功，用户会话已全部下线，下次登录需修改密码',
    );
    expect(response.json()).not.toHaveProperty('data');
    const call = vi.mocked(f.unit.credentials.updatePassword).mock.calls[0];
    expect(call).toEqual([
      targetId,
      `hash:${replacement}`,
      expect.any(Date),
      expect.any(Date),
      true,
    ]);
    expect(call[3].getTime() - call[2].getTime()).toBe(30 * 86_400_000);
    expect(f.unit.credentials.savePreviousPassword).toHaveBeenCalledWith(
      targetId,
      `hash:${original}`,
      call[2],
    );
    expect(f.unit.revokeAllSessions).toHaveBeenCalledWith(targetId, call[2]);
    expect(response.body).not.toContain(replacement);
    expect(JSON.stringify(fixture.logger.info.mock.calls)).not.toContain(
      replacement,
    );
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    'honors forceChange=%s / revokeAll=%s independently',
    async (forceChangeOnNextLogin, revokeAllSessions) => {
      const response = await reset({
        newPassword: replacement,
        forceChangeOnNextLogin,
        revokeAllSessions,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().message).toBe('密码修改成功');
      expect(
        vi.mocked(f.unit.credentials.updatePassword).mock.calls[0][4],
      ).toBe(forceChangeOnNextLogin);
      expect(f.unit.revokeAllSessions).toHaveBeenCalledTimes(
        revokeAllSessions ? 1 : 0,
      );
    },
  );
  it.each(['missing', 'username', 'current', 'history'])(
    'rejects %s target/password before side effects',
    async (kind) => {
      if (kind === 'missing')
        vi.mocked(f.unit.credentials.lockUser).mockResolvedValue(undefined);
      if (kind === 'username') f.user.username = replacement.toUpperCase();
      if (kind === 'current') f.user.password = `hash:${replacement}`;
      if (kind === 'history') f.history.push(`hash:${replacement}`);
      expect((await reset()).statusCode).toBe(kind === 'missing' ? 404 : 400);
      expect(f.unit.credentials.savePreviousPassword).not.toHaveBeenCalled();
      expect(f.unit.credentials.updatePassword).not.toHaveBeenCalled();
      expect(f.unit.revokeAllSessions).not.toHaveBeenCalled();
    },
  );
  it.each(['permission', 'session', 'status', 'policy'])(
    'rechecks %s after HTTP authentication and lock acquisition',
    async (kind) => {
      vi.mocked(f.repository.transaction).mockImplementation(
        async (operation) => {
          if (kind === 'permission')
            vi.mocked(f.unit.operatorPermissionCodes).mockResolvedValue([]);
          if (kind === 'session') f.session.status = 'REVOKED';
          if (kind === 'status') f.operator.status = 'SUSPENDED';
          if (kind === 'policy') f.operator.forcePasswordChange = true;
          return operation(f.unit);
        },
      );
      expect((await reset()).statusCode).toBe(403);
      expect(f.unit.credentials.lockUser).not.toHaveBeenCalled();
    },
  );
  it('sanitizes unexpected failures and releases service capacity', async () => {
    f.hash.mockRejectedValueOnce(new Error(`secret=${replacement}`));
    const response = await reset();
    expect(response.statusCode).toBe(500);
    expect(response.json().errorMessage).toBe('服务器内部错误');
    expect(JSON.stringify(fixture.logger.error.mock.calls)).not.toContain(
      replacement,
    );
    expect((await reset()).statusCode).toBe(200);
  });
  it('bounds concurrent admitted work through hashing and releases it on completion', async () => {
    let release!: (value: string) => void;
    const barrier = new Promise<string>((resolve) => {
      release = resolve;
    });
    f.hash.mockImplementation(() => barrier);
    const pending = Array.from({ length: 8 }, () => Promise.resolve(reset()));
    try {
      await vi.waitFor(() => expect(f.hash).toHaveBeenCalledTimes(8));
      expect((await reset()).statusCode).toBe(429);
    } finally {
      release('fixture-bounded-hash');
    }
    expect(
      (await Promise.all(pending)).every(
        (response) => response.statusCode === 200,
      ),
    ).toBe(true);
    expect((await reset()).statusCode).toBe(200);
  });
});
