import {
  messageResultSchema,
  sessionListResultSchema,
} from '@asin-monitor/contracts';
import type { AuthSessionRecord, AuthUserRecord } from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationService } from '../src/auth/authentication.service';
import { SessionService } from '../src/auth/session.service';
import { sessionApp } from './helpers/session-app';

const userId = 'session-owner';
const currentId = '00000000-0000-0000-0000-000000000051';
const otherId = '00000000-0000-0000-0000-000000000052';
function session(id: string, owner = userId): AuthSessionRecord {
  return {
    id,
    userId: owner,
    userAgent: 'fixture-agent',
    ipAddress: '192.0.2.51',
    status: 'ACTIVE',
    rememberMe: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    lastActiveAt: new Date('2026-09-01T01:00:00Z'),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
}
const user: AuthUserRecord = {
  id: userId,
  username: 'fixture-user',
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
};
function repositoryFixture() {
  const rows = [
    session(currentId),
    session(otherId),
    {
      ...session('legacy-session-fixture'),
      status: 'REVOKED',
      expiresAt: null,
    },
    session('foreign-session', 'other-owner'),
  ];
  return {
    rows,
    findSessionById: vi.fn(async (id: string) =>
      rows.find((row) => row.id === id),
    ),
    findUserById: vi.fn(async () => user),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    getPermissionCodes: vi.fn(async () => []),
    getRoles: vi.fn(async () => []),
    listSessionsByUserId: vi.fn(async (id: string) =>
      rows.filter((row) => row.userId === id),
    ),
    revokeOwnedSession: vi.fn(async (id: string, owner: string) => {
      const row = rows.find((item) => item.id === id && item.userId === owner);
      if (!row) return false;
      row.status = 'REVOKED';
      return true;
    }),
  };
}
describe('Neo own-session HTTP management', () => {
  let fixture: Awaited<ReturnType<typeof sessionApp>>;
  let repository: ReturnType<typeof repositoryFixture>;
  let token: string;
  let headers: { authorization: string };
  beforeEach(async () => {
    repository = repositoryFixture();
    fixture = await sessionApp(repository);
    token = jwt.sign({ userId, sessionId: currentId }, fixture.env.JWT_SECRET, {
      expiresIn: '1h',
    });
    headers = { authorization: `Bearer ${token}` };
  });
  afterEach(async () => {
    await fixture.app.close();
  });
  it.each([
    ['GET', '/sessions'],
    ['POST', '/logout'],
    ['POST', '/sessions/revoke'],
  ] as const)('requires authentication for %s %s', async (method, suffix) => {
    const response = await fixture.http.inject({
      method,
      url: `/api/v1/auth${suffix}`,
    });
    expect(response.statusCode).toBe(401);
    expect(repository.listSessionsByUserId).not.toHaveBeenCalled();
    expect(repository.revokeOwnedSession).not.toHaveBeenCalled();
  });
  it('returns only the authenticated owner, with Legacy fields and historical session states', async () => {
    const response = await fixture.http.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions?userId=other-owner',
      headers,
    });
    expect(response.statusCode).toBe(200);
    const data = sessionListResultSchema.parse(response.json()).data!;
    expect(data).toHaveLength(3);
    expect(data.every((row) => row.user_id === userId)).toBe(true);
    expect(data[0]).toMatchObject({
      created_at: '2026-09-01T00:00:00.000Z',
      remember_me: true,
      ip_address: '192.0.2.51',
    });
    expect(data[2]).toMatchObject({ status: 'REVOKED', expires_at: null });
    expect(repository.listSessionsByUserId).toHaveBeenCalledExactlyOnceWith(
      userId,
    );
    expect(JSON.stringify(data)).not.toContain('password');
  });
  it.each(['missing', 'foreign-session'])(
    'does not expose or revoke an inaccessible session %s',
    async (sessionId) => {
      const response = await fixture.http.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke',
        headers,
        payload: { sessionId, userId: 'other-owner' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        errorMessage: '会话不存在或已被拒绝',
      });
      expect(repository.revokeOwnedSession).toHaveBeenCalledExactlyOnceWith(
        sessionId,
        userId,
      );
      expect(
        repository.rows.find((row) => row.id === 'foreign-session')!.status,
      ).toBe('ACTIVE');
    },
  );
  it.each([
    {},
    [],
    { sessionId: '' },
    { sessionId: 51 },
    { sessionId: null },
    { sessionId: 'x'.repeat(37) },
  ])('rejects malformed revoke input %j', async (payload) => {
    const response = await fixture.http.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(repository.revokeOwnedSession).not.toHaveBeenCalled();
  });
  it('revokes another owned session idempotently and keeps the current session active', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fixture.http.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke',
        headers,
        payload: { sessionId: otherId },
      });
      expect(response.statusCode).toBe(200);
      expect(messageResultSchema.parse(response.json())).toEqual({
        success: true,
        errorCode: 0,
        message: '已踢出会话',
      });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(repository.rows[0].status).toBe('ACTIVE');
    expect(repository.rows[1].status).toBe('REVOKED');
  });
  it('self-revocation causes subsequent HTTP and shared WS authentication to fail', async () => {
    const response = await fixture.http.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke',
      headers,
      payload: { sessionId: currentId },
    });
    expect(response.statusCode).toBe(200);
    const denied = await fixture.http.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers,
    });
    expect(denied.statusCode).toBe(403);
    await expect(
      fixture.app.get(AuthenticationService).authenticateToken(token),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('clears both configured cookies only after successful logout and ignores untrusted forwarded protocol', async () => {
    const response = await fixture.http.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...headers, 'x-forwarded-proto': 'https' },
    });
    expect(response.statusCode).toBe(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain(`${fixture.env.AUTH_COOKIE_NAME}=`);
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[1]).toContain(`${fixture.env.AUTH_HINT_COOKIE_NAME}=`);
    expect(cookies[1]).not.toContain('HttpOnly');
    for (const cookie of cookies) {
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
      expect(cookie).not.toContain('Secure');
    }
    expect(repository.revokeOwnedSession).toHaveBeenCalledExactlyOnceWith(
      currentId,
      userId,
    );
  });
  it.each(['/logout', '/sessions/revoke'])(
    'rejects a foreign Origin before %s mutates sessions',
    async (suffix) => {
      const response = await fixture.http.inject({
        method: 'POST',
        url: `/api/v1/auth${suffix}`,
        headers: { ...headers, origin: 'https://untrusted.invalid' },
        payload: { sessionId: otherId },
      });
      expect(response.statusCode).toBe(403);
      expect(repository.revokeOwnedSession).not.toHaveBeenCalled();
    },
  );
  it('clears custom production cookies with Secure attributes matching login', async () => {
    await fixture.app.close();
    fixture = await sessionApp(repository, {
      NODE_ENV: 'production',
      AUTH_COOKIE_NAME: 'neo_auth_fixture',
      AUTH_HINT_COOKIE_NAME: 'neo_hint_fixture',
    });
    const response = await fixture.http.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers,
    });
    expect(response.statusCode).toBe(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies[0]).toContain('neo_auth_fixture=');
    expect(cookies[1]).toContain('neo_hint_fixture=');
    expect(cookies.every((cookie) => cookie.includes('Secure'))).toBe(true);
  });
  it.each(['/logout', '/sessions/revoke', '/sessions'])(
    'sanitizes repository failures from %s and does not clear cookies',
    async (suffix) => {
      const error = new Error('fixture-secret SELECT session-private-data');
      repository.revokeOwnedSession.mockRejectedValue(error);
      repository.listSessionsByUserId.mockRejectedValue(error);
      const response = await fixture.http.inject({
        method: suffix === '/sessions' ? 'GET' : 'POST',
        url: `/api/v1/auth${suffix}`,
        headers,
        ...(suffix === '/sessions' ? {} : { payload: { sessionId: otherId } }),
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        success: false,
        errorCode: 500,
        errorMessage: '服务器内部错误',
      });
      expect(response.headers['set-cookie']).toBeUndefined();
      const output = JSON.stringify([
        response.json(),
        ...Object.values(fixture.logger).map((log) => log.mock.calls),
      ]);
      expect(output).not.toContain('fixture-secret');
      expect(output).not.toContain(currentId);
      expect(output).not.toContain('session-private-data');
    },
  );
  it('bounds pending session operations and resumes admission after failure', async () => {
    let finish!: (value: AuthSessionRecord[]) => void;
    repository.listSessionsByUserId.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const service = fixture.app.get(SessionService);
    const pending = Array.from({ length: 8 }, () => service.list(userId));
    await expect(service.list(userId)).rejects.toMatchObject({ status: 503 });
    finish([]);
    await Promise.all(pending);
    await expect(service.list(userId)).resolves.toEqual([]);
  });
});
