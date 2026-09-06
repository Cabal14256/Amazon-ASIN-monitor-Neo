import {
  messageResultSchema,
  updateProfileResultSchema,
} from '@asin-monitor/contracts';
import type {
  AccountRepositoryPort,
  AccountUnit,
  AccountUserRecord,
  AuthSessionRecord,
} from '@asin-monitor/db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_REPOSITORY,
  AccountService,
  hashPassword,
  PASSWORD_HASHER,
} from '../src/auth/account.service';
import { comparePassword, PASSWORD_COMPARER } from '../src/auth/login.service';
import { sessionApp } from './helpers/session-app';

const original = 'Fixture-Original-53';
const replacement = 'Fixture-Replacement-53';
const userId = 'account-fixture';
const currentId = 'legacy-account-session';
function repositoryFixture() {
  let user: AccountUserRecord = {
    id: userId,
    username: 'fixture53',
    password: `hash:${original}`,
    realName: null,
    status: 'ACTIVE',
    lastLoginTime: null,
    lastLoginIp: null,
    passwordExpiresAt: new Date('2000-01-01T00:00:00Z'),
    passwordChangedAt: null,
    forcePasswordChange: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastFailedLogin: null,
    createTime: null,
    updateTime: null,
  };
  const current: AuthSessionRecord = {
    id: currentId,
    userId,
    userAgent: null,
    ipAddress: null,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    rememberMe: false,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActiveAt: new Date('2026-01-01T00:00:00Z'),
  };
  const history: string[] = [];
  const unit: AccountUnit = {
    lockUser: vi.fn(async () => structuredClone(user)),
    lockSession: vi.fn(async () => current),
    recentPasswords: vi.fn(async () => [...history]),
    savePreviousPassword: vi.fn(async () => undefined),
    updatePassword: vi.fn(async () => undefined),
    revokeOtherSessions: vi.fn(async () => undefined),
    updateProfile: vi.fn(async (_id, realName, now) => ({
      ...user,
      realName,
      updateTime: now,
    })),
    access: vi.fn(async () => ({
      permissions: ['asin:read'],
      roles: [{ id: 'role-fixture', code: 'operator', name: 'Operator' }],
    })),
  };
  const accounts: AccountRepositoryPort = {
    transaction: vi.fn(async (operation) => operation(unit)),
  };
  const auth = {
    findSessionById: vi.fn(async () => structuredClone(current)),
    findUserById: vi.fn(async () => structuredClone(user)),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    getPermissionCodes: vi.fn(async () => []),
    getRoles: vi.fn(async () => []),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  const compare = vi.fn(
    async (password: string, hash: string) => hash === `hash:${password}`,
  );
  const hash = vi.fn(async (password: string) => `hash:${password}`);
  return {
    unit,
    accounts,
    auth,
    compare,
    hash,
    history,
    current,
    get user() {
      return user;
    },
    setUser(patch: Partial<AccountUserRecord>) {
      user = { ...user, ...patch };
    },
  };
}

describe('Neo own account HTTP operations', () => {
  let f: ReturnType<typeof repositoryFixture>;
  let fixture: Awaited<ReturnType<typeof sessionApp>>;
  let headers: { authorization: string };
  const start = async (overrides: NodeJS.ProcessEnv = {}) => {
    fixture = await sessionApp(f.auth, overrides, (builder) =>
      builder
        .overrideProvider(ACCOUNT_REPOSITORY)
        .useValue(f.accounts)
        .overrideProvider(PASSWORD_COMPARER)
        .useValue(f.compare)
        .overrideProvider(PASSWORD_HASHER)
        .useValue(f.hash),
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId, sessionId: currentId },
        fixture.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  };
  beforeEach(async () => {
    f = repositoryFixture();
    await start();
  });
  afterEach(async () => {
    await fixture.app.close();
    vi.restoreAllMocks();
  });
  const change = (
    payload: unknown = { oldPassword: original, newPassword: replacement },
  ) =>
    fixture.http.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers,
      payload: payload as object,
    });
  const profile = (payload: unknown = { real_name: 'Fixture' }) =>
    fixture.http.inject({
      method: 'PUT',
      url: '/api/v1/auth/profile',
      headers,
      payload: payload as object,
    });

  it.each([
    ['PUT', '/profile'],
    ['POST', '/change-password'],
  ] as const)('requires a session for %s %s', async (method, path) => {
    const response = await fixture.http.inject({
      method,
      url: `/api/v1/auth${path}`,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(f.accounts.transaction).not.toHaveBeenCalled();
  });
  it('updates only the principal profile, strips unrecognized fields and returns a public contract', async () => {
    const response = await profile({
      real_name: '示例资料',
      userId: 'another-owner',
      password: 'injected',
      status: 'SUSPENDED',
      roles: ['admin'],
    });
    expect(response.statusCode).toBe(200);
    const data = updateProfileResultSchema.parse(response.json()).data!;
    expect(data.user).toMatchObject({
      id: userId,
      real_name: '示例资料',
      status: 'ACTIVE',
      force_password_change: true,
    });
    expect(data.permissions).toEqual(['asin:read']);
    expect(data.roles).toEqual(['operator']);
    expect(f.unit.lockUser).toHaveBeenCalledWith(userId);
    expect(f.unit.updateProfile).toHaveBeenCalledWith(
      userId,
      '示例资料',
      expect.any(Date),
    );
    expect(response.body).not.toContain('hash:');
    expect(response.headers['set-cookie']).toBeUndefined();
  });
  it.each([
    {},
    { real_name: null },
    { real_name: 1 },
    { real_name: 'x'.repeat(101) },
    { real_name: 'bad\0name' },
    { roles: ['admin'] },
  ])(
    'rejects invalid profile %j before opening a transaction',
    async (payload) => {
      expect((await profile(payload)).statusCode).toBe(400);
      expect(f.accounts.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['', '😀'.repeat(100)])(
    'accepts clearing the name and up to 100 PostgreSQL characters',
    async (name) => {
      expect((await profile({ real_name: name })).statusCode).toBe(200);
    },
  );
  it.each([
    {},
    { oldPassword: '', newPassword: replacement },
    { oldPassword: original, newPassword: '12345678' },
    { oldPassword: original, newPassword: 'password123' },
    { oldPassword: original, newPassword: 'ABC123 456' },
    {
      oldPassword: original,
      newPassword: replacement,
      revokeOtherSessions: 'false',
    },
    { oldPassword: 'x'.repeat(1025), newPassword: replacement },
    { oldPassword: original, newPassword: `Ab1${'x'.repeat(1024)}` },
  ])(
    'rejects invalid password input %j without opening a transaction',
    async (payload) => {
      expect((await change(payload)).statusCode).toBe(400);
      expect(f.accounts.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      'wrong old password',
      { oldPassword: 'wrong', newPassword: replacement },
      '原密码错误',
    ],
    [
      'current password',
      { oldPassword: original, newPassword: original },
      '新密码不能与当前密码相同',
    ],
    [
      'username ignoring case',
      { oldPassword: original, newPassword: 'FIXTURE53' },
      '密码不能与用户名相同',
    ],
  ])('rejects %s without writes', async (_label, input, message) => {
    const response = await change(input);
    expect(response.statusCode).toBe(400);
    expect(response.json().errorMessage).toBe(message);
    expect(f.unit.updatePassword).not.toHaveBeenCalled();
    expect(f.unit.savePreviousPassword).not.toHaveBeenCalled();
  });
  it('rejects reuse of any of the five previous hashes', async () => {
    f.history.push(
      'hash:1',
      'hash:2',
      'hash:3',
      'hash:4',
      `hash:${replacement}`,
    );
    const response = await change();
    expect(response.statusCode).toBe(400);
    expect(response.json().errorMessage).toContain('最近 5 次');
    expect(f.hash).not.toHaveBeenCalled();
    expect(f.unit.savePreviousPassword).not.toHaveBeenCalled();
  });
  it.each([undefined, true, false])(
    'changes password with revokeOtherSessions=%s and preserves current session',
    async (revokeOtherSessions) => {
      const before = Date.now();
      const response = await change({
        oldPassword: original,
        newPassword: replacement,
        revokeOtherSessions,
      });
      expect(response.statusCode).toBe(200);
      expect(messageResultSchema.parse(response.json()).success).toBe(true);
      expect(f.hash).toHaveBeenCalledWith(replacement);
      const [, hash, now, expiresAt] = vi.mocked(f.unit.updatePassword).mock
        .calls[0];
      expect(hash).toBe(`hash:${replacement}`);
      expect(now.getTime()).toBeGreaterThanOrEqual(before);
      expect(expiresAt.getTime() - now.getTime()).toBe(90 * 86_400_000);
      expect(f.unit.savePreviousPassword).toHaveBeenCalledWith(
        userId,
        `hash:${original}`,
        now,
      );
      if (revokeOtherSessions !== false)
        expect(f.unit.revokeOtherSessions).toHaveBeenCalledWith(
          userId,
          currentId,
          now,
        );
      else expect(f.unit.revokeOtherSessions).not.toHaveBeenCalled();
      expect(response.headers['set-cookie']).toBeUndefined();
    },
  );
  it('honors configured expiry days', async () => {
    await fixture.app.close();
    await start({ PASSWORD_EXPIRE_DAYS: '30' });
    expect((await change()).statusCode).toBe(200);
    const [, , now, expiresAt] = vi.mocked(f.unit.updatePassword).mock.calls[0];
    expect(expiresAt.getTime() - now.getTime()).toBe(30 * 86_400_000);
  });
  it('blocks both writes in Legacy authority mode', async () => {
    await fixture.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: '',
      DB_NAME: 'fixture',
    });
    expect((await change()).statusCode).toBe(503);
    expect((await profile()).statusCode).toBe(503);
    expect(f.accounts.transaction).not.toHaveBeenCalled();
  });
  it('rejects a foreign Origin for both endpoints', async () => {
    for (const [method, path] of [
      ['PUT', '/profile'],
      ['POST', '/change-password'],
    ] as const) {
      const response = await fixture.http.inject({
        method,
        url: `/api/v1/auth${path}`,
        headers: { ...headers, origin: 'https://foreign.invalid' },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    }
    expect(f.accounts.transaction).not.toHaveBeenCalled();
  });
  it('rechecks a user disabled while waiting for the transaction lock', async () => {
    vi.mocked(f.unit.lockUser).mockResolvedValue({
      ...f.user,
      status: 'SUSPENDED',
    });
    expect((await change()).statusCode).toBe(403);
    expect(f.compare).not.toHaveBeenCalled();
  });
  it.each(['REVOKED', 'EXPIRED', 'MISSING'])(
    'rechecks a session that becomes %s after the HTTP guard',
    async (state) => {
      vi.mocked(f.unit.lockSession).mockResolvedValue(
        state === 'MISSING'
          ? undefined
          : {
              ...f.current,
              ...(state === 'REVOKED'
                ? { status: 'REVOKED' }
                : { expiresAt: new Date('2000-01-01T00:00:00Z') }),
            },
      );
      expect((await change()).statusCode).toBe(403);
      expect(f.compare).not.toHaveBeenCalled();
    },
  );
  it('returns a missing account error without a mutation', async () => {
    vi.mocked(f.unit.lockUser).mockResolvedValue(undefined);
    expect((await profile()).statusCode).toBe(404);
    expect(f.unit.updateProfile).not.toHaveBeenCalled();
  });
  it('does not expose a dependency exception or any submitted secret in logs', async () => {
    vi.mocked(f.unit.updatePassword).mockRejectedValue(
      new Error(`SQL fixture hash:${original} ${replacement}`),
    );
    const response = await change();
    expect(response.statusCode).toBe(500);
    expect(response.json().errorMessage).toBe('服务器内部错误');
    const logged = JSON.stringify(fixture.logger.error.mock.calls);
    expect(logged).toContain('account_transaction_failed');
    for (const sensitive of [original, replacement, 'SQL', 'hash:']) {
      expect(logged).not.toContain(sensitive);
      expect(response.body).not.toContain(sensitive);
    }
  });
  it('caps in-flight account transactions and admits new requests after settlement', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.accounts.transaction).mockImplementation(async (operation) => {
      await pending;
      return operation(f.unit);
    });
    const service = fixture.app.get(AccountService);
    const principal = {
      userId,
      sessionId: currentId,
      user: { ...f.user, status: 'ACTIVE' as const, forcePasswordChange: true },
    };
    const tasks = Array.from({ length: 8 }, () =>
      service.updateProfile(principal, { real_name: 'Fixture' }),
    );
    await expect(
      service.updateProfile(principal, { real_name: 'Fixture' }),
    ).rejects.toMatchObject({ status: 429 });
    release();
    await Promise.all(tasks);
    await expect(
      service.updateProfile(principal, { real_name: 'Fixture' }),
    ).resolves.toBeDefined();
  });
});

describe('shared password CPU capacity', () => {
  afterEach(() => vi.restoreAllMocks());
  it('uses cost 10 for new hashes', async () => {
    const hash = await hashPassword(replacement);
    expect(bcrypt.getRounds(hash)).toBe(10);
    expect(await comparePassword(replacement, hash)).toBe(true);
  });
  it('shares all eight slots with login and keeps them until comparisons actually finish', async () => {
    const hash = await bcrypt.hash(original, 4);
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    vi.spyOn(bcrypt, 'compare').mockImplementation(() => pending);
    const tasks = Array.from({ length: 8 }, () =>
      comparePassword(original, hash),
    );
    try {
      await expect(hashPassword(replacement)).rejects.toMatchObject({
        status: 429,
      });
    } finally {
      release(true);
      await Promise.all(tasks);
    }
    expect(bcrypt.getRounds(await hashPassword(replacement))).toBe(10);
  });
});
