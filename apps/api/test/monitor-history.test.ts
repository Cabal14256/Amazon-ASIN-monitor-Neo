import type { Env } from '@asin-monitor/config';
import {
  monitorHistoryDetailResultSchema,
  monitorHistoryListResultSchema,
  type MonitorHistoryRecord,
} from '@asin-monitor/contracts';
import {
  MonitorHistoryQueryError,
  type AuthSessionRecord,
  type AuthUserRecord,
  type MonitorHistoryQueryRepositoryPort,
  type MonitorHistoryQueryUnit,
} from '@asin-monitor/db';
import type { FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../src/auth/auth.types';
import type { AppLogger } from '../src/logger/app-logger.service';
import { MonitorHistoryModule } from '../src/monitor/monitor-history.module';
import {
  MONITOR_HISTORY_REPOSITORY,
  MonitorHistoryService,
} from '../src/monitor/monitor-history.service';
import { sessionApp } from './helpers/session-app';

function fixture() {
  const user: AuthUserRecord = {
    id: 'operator-107',
    username: 'operator-107',
    realName: null,
    status: 'ACTIVE',
    lockedUntil: null,
    forcePasswordChange: false,
    passwordExpiresAt: null,
    lastLoginTime: null,
    lastLoginIp: null,
    passwordChangedAt: null,
    failedLoginAttempts: 0,
    createTime: null,
    updateTime: null,
  };
  const session: AuthSessionRecord = {
    id: 'session-107',
    userId: user.id,
    status: 'ACTIVE',
    expiresAt: new Date('2099-01-01'),
    userAgent: null,
    ipAddress: null,
    rememberMe: false,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  };
  const permissions = ['monitor:read'];
  const record = {
    id: 107,
    check_result: '{"complete":true}',
    checkResult: '{"complete":true}',
    check_type: 'ASIN',
    checkType: 'ASIN',
    create_time: null,
    createTime: null,
  };
  const unit = {
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    listHistory: vi.fn(async () => ({ list: [record], total: 1 })),
    historyById: vi.fn(
      async (): Promise<MonitorHistoryRecord | null> => record,
    ),
  } as unknown as MonitorHistoryQueryUnit;
  const repository: MonitorHistoryQueryRepositoryPort = {
    read: vi.fn(async (action) => action(unit)),
  };
  const auth = {
    findUserById: vi.fn(async () => ({
      ...structuredClone(user),
      status: 'ACTIVE',
      forcePasswordChange: false,
      passwordExpiresAt: null,
    })),
    findSessionById: vi.fn(async () => ({
      ...structuredClone(session),
      status: 'ACTIVE',
      expiresAt: new Date('2099-01-01'),
    })),
    getPermissionCodes: vi.fn(async () => ['monitor:read']),
    getRoles: vi.fn(async () => [
      { id: 'reader-107', code: 'READONLY', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { user, session, permissions, unit, repository, auth };
}
describe('monitor history HTTP / current transaction authorization', () => {
  let f: ReturnType<typeof fixture>,
    app: Awaited<ReturnType<typeof sessionApp>>,
    headers: { authorization: string };
  const paths = ['/monitor-history', '/monitor-history/107'];
  async function start(env: NodeJS.ProcessEnv = {}) {
    app = await sessionApp(
      f.auth,
      env,
      (builder) =>
        builder
          .overrideProvider(MONITOR_HISTORY_REPOSITORY)
          .useValue(f.repository),
      [MonitorHistoryModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: f.user.id, sessionId: f.session.id },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  }
  beforeEach(async () => {
    f = fixture();
    await start();
  });
  afterEach(async () => {
    await app.app.close();
    vi.restoreAllMocks();
  });
  const get = (path = paths[0], auth = headers) =>
    app.http.inject({ method: 'GET', url: `/api/v1${path}`, headers: auth });
  it.each(paths)('requires login and monitor:read on %s', async (path) => {
    expect((await get(path, {} as never)).statusCode).toBe(401);
    f.auth.getPermissionCodes.mockResolvedValue([]);
    expect((await get(path)).statusCode).toBe(403);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it.each(paths)(
    'returns full frozen response and no-store on %s',
    async (path) => {
      const response = await get(path);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      (path === paths[0]
        ? monitorHistoryListResultSchema
        : monitorHistoryDetailResultSchema
      ).parse(response.json());
      expect(response.body).toContain('complete');
    },
  );
  it('passes the normalized Legacy filter values to a single read operation', async () => {
    expect(
      (
        await get(
          '/monitor-history?asin=B001,B002,B001&country=EU&asinType=MAIN_LINK&isBroken=1&current=2&pageSize=25',
        )
      ).statusCode,
    ).toBe(200);
    expect(f.unit.listHistory).toHaveBeenCalledWith({
      asin: ['B001', 'B002'],
      country: 'EU',
      asinType: 'MAIN_LINK',
      isBroken: true,
      current: 2,
      pageSize: 25,
    });
    expect(f.repository.read).toHaveBeenCalledTimes(1);
  });
  it.each([
    '/monitor-history?pageSize=101',
    '/monitor-history?country=US&country=UK',
    '/monitor-history?startTime=2026-02-30',
    '/monitor-history/9007199254740992',
    '/monitor-history/1e3',
  ])('rejects invalid values before history access %s', async (path) => {
    expect((await get(path)).statusCode).toBe(400);
    expect(f.unit.listHistory).not.toHaveBeenCalled();
    expect(f.unit.historyById).not.toHaveBeenCalled();
  });
  it.each(paths)(
    'enforces committed permission revocation despite the guard cache on %s',
    async (path) => {
      f.permissions.length = 0;
      expect((await get(path)).statusCode).toBe(403);
      expect(f.unit.listHistory).not.toHaveBeenCalled();
      expect(f.unit.historyById).not.toHaveBeenCalled();
    },
  );
  it.each([
    'account',
    'password',
    'password-expiry',
    'session',
    'session-expiry',
  ])('checks current %s under transaction locks', async (state) => {
    if (state === 'account') f.user.status = 'SUSPENDED';
    if (state === 'password') f.user.forcePasswordChange = true;
    if (state === 'password-expiry') f.user.passwordExpiresAt = new Date(0);
    if (state === 'session') f.session.status = 'REVOKED';
    if (state === 'session-expiry') f.session.expiresAt = new Date(0);
    expect((await get()).statusCode).toBe(403);
    expect(f.unit.listHistory).not.toHaveBeenCalled();
  });
  it('returns the existing missing history 404', async () => {
    vi.mocked(f.unit.historyById).mockResolvedValueOnce(null);
    const response = await get(paths[1]);
    expect(response.statusCode).toBe(404);
    expect(response.json().errorMessage).toBe('监控历史不存在');
  });
  it.each([
    { code: 'capacity', status: 429 },
    { code: 'too-large', status: 413 },
    { code: 'invalid-result', status: 500 },
  ] as const)(
    'returns $status for $code without partial data',
    async ({ code, status }) => {
      vi.mocked(f.repository.read).mockRejectedValueOnce(
        new MonitorHistoryQueryError(code),
      );
      const response = await get();
      expect(response.statusCode).toBe(status);
      expect(response.json().data).toBeUndefined();
      expect((await get()).statusCode).toBe(200);
    },
  );
  it('keeps driver payloads out of logs and responses', async () => {
    vi.mocked(f.repository.read).mockRejectedValueOnce(
      new Error('private-db-password-107'),
    );
    const response = await get();
    expect(response.statusCode).toBe(500);
    expect(
      response.body + JSON.stringify(app.logger.error.mock.calls),
    ).not.toContain('private-db-password');
  });
  it('bounds actual concurrent reads to two and restores admission on completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.repository.read).mockImplementation(async (action) => {
      await gate;
      return action(f.unit);
    });
    const first = get(),
      second = get();
    const pending = Promise.all([first, second]);
    try {
      await vi.waitFor(() =>
        expect(f.repository.read).toHaveBeenCalledTimes(2),
      );
      expect((await get()).statusCode).toBe(429);
    } finally {
      release();
    }
    expect((await pending).map((item) => item.statusCode)).toEqual([200, 200]);
    expect((await get()).statusCode).toBe(200);
  });
  it('rejects Legacy authority before accessing history data', async () => {
    await app.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture',
      DB_NAME: 'fixture',
    });
    expect((await get()).statusCode).toBe(503);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
});

describe('monitor history response delivery admission', () => {
  const responses: EventEmitter[] = [];
  function response() {
    const raw = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy(this: EventEmitter & { destroyed: boolean }) {
        this.destroyed = true;
        this.emit('close');
        return this;
      },
    });
    responses.push(raw);
    return { raw } as unknown as FastifyReply;
  }
  function serviceFixture() {
    const f = fixture();
    const principal = {
      userId: f.user.id,
      sessionId: f.session.id,
      user: f.user,
    } as AuthPrincipal;
    const service = new MonitorHistoryService(
      { AUTH_DATA_AUTHORITY: 'postgresql' } as Env,
      f.repository,
      { error: vi.fn() } as unknown as AppLogger,
    );
    return { ...f, principal, service };
  }
  afterEach(() => {
    for (const raw of responses.splice(0)) raw.emit('close');
    vi.useRealTimers();
  });
  it('holds both slots after SQL settles until delivery finishes, releasing each only once', async () => {
    const f = serviceFixture(),
      a = response(),
      b = response(),
      c = response();
    await f.service.list(f.principal, a, {});
    await f.service.list(f.principal, b, {});
    await expect(f.service.list(f.principal, c, {})).rejects.toMatchObject({
      status: 429,
    });
    a.raw.emit('finish');
    a.raw.emit('close');
    await expect(f.service.list(f.principal, c, {})).resolves.toMatchObject({
      total: 1,
    });
    await expect(
      f.service.list(f.principal, response(), {}),
    ).rejects.toMatchObject({ status: 429 });
    expect(a.raw.listenerCount('close')).toBe(0);
    expect(a.raw.listenerCount('finish')).toBe(0);
  });
  it('does not release a disconnected request until its database action settles', async () => {
    const f = serviceFixture(),
      a = response(),
      b = response();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.repository.read).mockImplementationOnce(async (action) => {
      await gate;
      return action(f.unit);
    });
    const pending = f.service
      .list(f.principal, a, {})
      .catch((error: unknown) => error);
    a.raw.emit('close');
    await f.service.list(f.principal, b, {});
    try {
      await expect(
        f.service.list(f.principal, response(), {}),
      ).rejects.toMatchObject({ status: 429 });
    } finally {
      release();
    }
    await expect(pending).resolves.toMatchObject({ status: 500 });
    await expect(
      f.service.list(f.principal, response(), {}),
    ).resolves.toMatchObject({ total: 1 });
  });
  it('closes stalled delivery at sixty seconds and restores admission', async () => {
    vi.useFakeTimers();
    const f = serviceFixture(),
      a = response(),
      b = response();
    await f.service.list(f.principal, a, {});
    await f.service.list(f.principal, b, {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.raw.destroyed).toBe(true);
    expect(b.raw.destroyed).toBe(true);
    await expect(
      f.service.list(f.principal, response(), {}),
    ).resolves.toMatchObject({ total: 1 });
  });
});
