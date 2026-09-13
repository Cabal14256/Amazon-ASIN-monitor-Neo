import {
  DashboardQueryError,
  mapDashboardData,
  MonitorAnalyticsQueryError,
  type DashboardQueryRepositoryPort,
  type DashboardQueryUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardModule } from '../src/dashboard/dashboard.module';
import { DASHBOARD_REPOSITORY } from '../src/dashboard/dashboard.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';
import { sessionApp } from './helpers/session-app';

function data(total = 0) {
  return mapDashboardData({
    overview: {
      totalGroups: String(total),
      totalASINs: '0',
      brokenGroups: '0',
      brokenASINs: '0',
      todayChecks: '0',
      todayBroken: '0',
    },
    brokenGroups: [],
    brokenASINs: [],
    recentActivities: [],
    groupsByCountry: total
      ? [{ country: 'US', total: String(total), broken: '0' }]
      : [],
    asinsByCountry: [],
    todayByCountry: [],
  });
}

describe('dashboard / authenticated complete HTTP response and cache lifetime', () => {
  let f: ReturnType<typeof monitorAnalyticsFixture>,
    app: Awaited<ReturnType<typeof sessionApp>>,
    unit: DashboardQueryUnit,
    repository: DashboardQueryRepositoryPort,
    headers: { authorization: string };
  async function start(env: NodeJS.ProcessEnv = {}) {
    app = await sessionApp(
      f.auth,
      env,
      (builder) =>
        builder.overrideProvider(DASHBOARD_REPOSITORY).useValue(repository),
      [DashboardModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: f.user.id, sessionId: f.session.id },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  }
  const get = (auth: Record<string, string> = headers) =>
    app.http.inject({
      method: 'GET',
      url: '/api/v1/dashboard',
      headers: auth,
    });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T10:00:00Z'));
    f = monitorAnalyticsFixture();
    f.auth.getPermissionCodes.mockResolvedValue([]);
    f.auth.getRoles.mockResolvedValue([]);
    unit = {
      lockOperator: f.unit.lockOperator,
      lockSession: f.unit.lockSession,
      dashboard: vi.fn(async () => data()),
    };
    repository = { read: vi.fn(async (action) => action(unit)) };
    await start();
  });
  afterEach(async () => {
    await app.app.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('requires login, accepts no domain grants, returns the full Legacy envelope and no-store', async () => {
    expect((await get({})).statusCode).toBe(401);
    expect(unit.dashboard).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      const response = await get();
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual({
        success: true,
        data: data(),
        errorCode: 0,
      });
    }
    expect(unit.dashboard).toHaveBeenCalledTimes(1);
    expect(unit.lockOperator).toHaveBeenCalledTimes(2);
    expect(unit.lockSession).toHaveBeenCalledTimes(2);
    expect(f.unit.operatorPermissionCodes).not.toHaveBeenCalled();
  });
  it.each([
    'account',
    'locked',
    'password',
    'password-expiry',
    'session',
    'session-expiry',
    'missing-user',
    'missing-session',
  ])(
    'rejects a cached result after current %s changes despite stale guard data',
    async (state) => {
      expect((await get()).statusCode).toBe(200);
      if (state === 'account') f.user.status = 'SUSPENDED';
      if (state === 'locked') {
        f.user.status = 'LOCKED';
        f.user.lockedUntil = new Date('2099-01-01');
      }
      if (state === 'password') f.user.forcePasswordChange = true;
      if (state === 'password-expiry') f.user.passwordExpiresAt = new Date(0);
      if (state === 'session') f.session.status = 'REVOKED';
      if (state === 'session-expiry') f.session.expiresAt = new Date(0);
      if (state === 'missing-user')
        vi.mocked(unit.lockOperator).mockResolvedValue(undefined);
      if (state === 'missing-session')
        vi.mocked(unit.lockSession).mockResolvedValue(undefined);
      const response = await get();
      expect(response.statusCode, response.body).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(unit.dashboard).toHaveBeenCalledTimes(1);
    },
  );
  it('expires at exactly thirty seconds and checks authorization even before expiry', async () => {
    await get();
    vi.mocked(unit.dashboard).mockResolvedValue(data(2));
    vi.setSystemTime(new Date('2026-09-13T10:00:29.999Z'));
    expect((await get()).json().data).toEqual(data());
    vi.setSystemTime(new Date('2026-09-13T10:00:30.000Z'));
    expect((await get()).json().data).toEqual(data(2));
    expect(unit.dashboard).toHaveBeenCalledTimes(2);
    expect(unit.lockOperator).toHaveBeenCalledTimes(3);
  });
  it('does not reuse yesterday totals across UTC+8 midnight', async () => {
    vi.setSystemTime(new Date('2026-09-13T15:59:59Z'));
    // Mint a token at the new test clock rather than using an expired token.
    await app.app.close();
    await start();
    await get();
    vi.mocked(unit.dashboard).mockResolvedValue(data(3));
    vi.setSystemTime(new Date('2026-09-13T16:00:00Z'));
    expect((await get()).json().data).toEqual(data(3));
    expect(unit.dashboard).toHaveBeenCalledTimes(2);
  });
  it('invalidates a cache generated in the future after a wall clock rollback', async () => {
    await get();
    vi.mocked(unit.dashboard).mockResolvedValue(data(4));
    vi.setSystemTime(new Date('2026-09-13T09:59:59Z'));
    expect((await get()).json().data).toEqual(data(4));
    expect(unit.dashboard).toHaveBeenCalledTimes(2);
  });
  it('never publishes a result from a transaction that fails to commit', async () => {
    vi.mocked(repository.read).mockImplementationOnce(async (action) => {
      await action(unit);
      throw new Error('private connection details');
    });
    const failed = await get();
    expect(failed.statusCode).toBe(500);
    vi.mocked(unit.dashboard).mockResolvedValue(data(5));
    expect((await get()).json().data).toEqual(data(5));
    expect(unit.dashboard).toHaveBeenCalledTimes(2);
    expect(
      failed.body + JSON.stringify(app.logger.error.mock.calls),
    ).not.toContain('private connection');
  });
  it('does not let an older slow query replace a newer cached snapshot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(unit.dashboard).mockImplementationOnce(async () => {
      await gate;
      return data(1);
    });
    vi.mocked(unit.dashboard).mockResolvedValue(data(2));
    const first = get().then((value) => value);
    try {
      await vi.waitFor(() => expect(unit.dashboard).toHaveBeenCalledTimes(1));
      expect((await get()).json().data).toEqual(data(2));
    } finally {
      release();
    }
    expect((await first).json().data).toEqual(data(1));
    expect((await get()).json().data).toEqual(data(2));
    expect(unit.dashboard).toHaveBeenCalledTimes(2);
  });
  it('rejects the third pending request before authentication and recovers capacity', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(unit.dashboard).mockImplementation(async () => {
      await gate;
      return data();
    });
    const pending = [
      get().then((value) => value),
      get().then((value) => value),
    ];
    try {
      await vi.waitFor(() => expect(unit.dashboard).toHaveBeenCalledTimes(2));
      const authCalls = f.auth.touchSession.mock.calls.length;
      const third = await get();
      expect(third.statusCode).toBe(429);
      expect(third.json().errorMessage).toBe('仪表盘查询繁忙，请稍后重试');
      expect(f.auth.touchSession).toHaveBeenCalledTimes(authCalls);
    } finally {
      release();
    }
    expect(
      (await Promise.all(pending)).map((response) => response.statusCode),
    ).toEqual([200, 200]);
    expect((await get()).statusCode).toBe(200);
  });
  it.each([
    ['capacity', new MonitorAnalyticsQueryError('capacity'), 429],
    ['timeout', new MonitorAnalyticsQueryError('timeout'), 504],
    ['statement', { cause: { code: '57014', message: 'private SQL' } }, 504],
    ['lock', { code: '55P03', message: 'private SQL' }, 504],
    ['oversized', new DashboardQueryError('too-large'), 413],
    ['malformed', new DashboardQueryError('result'), 500],
  ])(
    'maps %s failures to a bounded sanitized response',
    async (_, error, status) => {
      vi.mocked(unit.dashboard).mockRejectedValue(error);
      const response = await get();
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        success: false,
        errorCode: status,
        errorMessage: expect.any(String),
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(
        response.body +
          JSON.stringify(app.logger.error.mock.calls) +
          JSON.stringify(app.logger.warn.mock.calls),
      ).not.toContain('private SQL');
    },
  );
  it('rejects a malformed repository response before serialization and caching', async () => {
    const malformed = data();
    Reflect.deleteProperty(malformed, 'overview');
    vi.mocked(unit.dashboard).mockResolvedValueOnce(malformed);
    expect((await get()).statusCode).toBe(500);
    expect((await get()).json().data).toEqual(data());
  });
  it('requires PostgreSQL authority before reading business data', async () => {
    await app.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: '',
      DB_NAME: 'fixture',
    });
    expect((await get()).statusCode).toBe(503);
    expect(repository.read).not.toHaveBeenCalled();
  });
});
