import { monitorAnalyticsDataSchemas } from '@asin-monitor/contracts';
import {
  MONITOR_ANALYTICS_OPERATIONS,
  MonitorAnalyticsQueryError,
  MonitorAnalyticsResultLimitError,
  type MonitorAnalyticsOperation,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MONITOR_ANALYTICS_META_OPERATIONS } from '../src/monitor/monitor-analytics-result';
import { MONITOR_ANALYTICS_REPOSITORY } from '../src/monitor/monitor-analytics.service';
import { MonitorHistoryModule } from '../src/monitor/monitor-history.module';
import { ApplicationRedisClient } from '../src/redis/redis.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';
import { sessionApp } from './helpers/session-app';

describe('monitor analytics / all fourteen HTTP routes and current authorization', () => {
  let f: ReturnType<typeof monitorAnalyticsFixture>,
    app: Awaited<ReturnType<typeof sessionApp>>;
  let headers: { authorization: string };
  async function start(env: NodeJS.ProcessEnv = {}) {
    app = await sessionApp(
      f.auth,
      env,
      (builder) =>
        builder
          .overrideProvider(MONITOR_ANALYTICS_REPOSITORY)
          .useValue(f.repository)
          .overrideProvider(ApplicationRedisClient)
          .useValue(f.redis),
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
  const path = (operation: MonitorAnalyticsOperation) =>
    '/api/v1/monitor-history/' +
    (operation === 'abnormal-duration-statistics' || operation === 'statistics'
      ? operation
      : `statistics/${operation}`);
  const get = (
    operation: MonitorAnalyticsOperation = 'by-time',
    query: Record<string, string> = {},
    auth: Record<string, string> = headers,
  ) =>
    app.http.inject({
      method: 'GET',
      url:
        path(operation) +
        '?' +
        new URLSearchParams({
          country: 'US',
          startTime: '2024-02-01',
          endTime: '2024-02-29 23:59:59',
          ...query,
        }),
      headers: auth,
    });
  async function cacheCount(outcome: 'hits' | 'misses', prefix: string) {
    const response = await app.http.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    const line = response.body
      .split('\n')
      .find((value) =>
        value.startsWith(
          `amazon_asin_monitor_cache_${outcome}_total{cache_key_prefix="${prefix}"} `,
        ),
      );
    return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
  }
  beforeEach(async () => {
    f = monitorAnalyticsFixture();
    await start();
  });
  afterEach(async () => {
    await app.app.close();
    vi.restoreAllMocks();
  });
  it.each(MONITOR_ANALYTICS_OPERATIONS)(
    'returns the complete %s envelope with no-store',
    async (operation) => {
      const response = await get(operation);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toContain('application/json');
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.errorCode).toBe(0);
      monitorAnalyticsDataSchemas[operation].parse(body.data);
      expect(body.meta !== undefined).toBe(
        MONITOR_ANALYTICS_META_OPERATIONS.has(operation),
      );
      if (body.meta)
        expect(body.meta).toEqual({
          source: 'raw',
          cacheHit: false,
          cacheTime: null,
          dataFreshness: 'fresh',
          lastUpdatedAt: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
          ),
          busyFallback: false,
          busyReason: null,
        });
    },
  );
  it.each(MONITOR_ANALYTICS_OPERATIONS)(
    'requires login and a current read grant for %s',
    async (operation) => {
      expect((await get(operation, {}, {})).statusCode).toBe(401);
      f.permissions.length = 0;
      expect((await get(operation)).statusCode).toBe(403);
      expect(f.unit.duration).not.toHaveBeenCalled();
      expect(f.redis.eval).not.toHaveBeenCalled();
    },
  );
  it.each(['monitor:read', 'analytics:read'])(
    'accepts either grant %s for statistics and peak, enforces the other eleven',
    async (permission) => {
      f.permissions.splice(0, f.permissions.length, permission);
      // A stale guard cache cannot veto a newly committed grant either.
      f.auth.getPermissionCodes.mockResolvedValue([]);
      for (const operation of MONITOR_ANALYTICS_OPERATIONS) {
        const allowed =
          ['statistics', 'peak-hours'].includes(operation) ||
          (operation === 'abnormal-duration-statistics'
            ? permission === 'monitor:read'
            : permission === 'analytics:read');
        expect((await get(operation)).statusCode, operation).toBe(
          allowed ? 200 : 403,
        );
      }
    },
  );
  it('checks current permissions before every cache hit and never reads cache after revocation', async () => {
    expect((await get()).json().meta.cacheHit).toBe(false);
    expect((await get()).json().meta).toMatchObject({
      source: 'cache+raw',
      cacheHit: true,
      dataFreshness: 'cached',
    });
    expect(f.unit.duration).toHaveBeenCalledTimes(1);
    expect(f.unit.lockOperator).toHaveBeenCalledTimes(2);
    const calls = f.redis.eval.mock.calls.length;
    f.permissions.length = 0;
    expect((await get()).statusCode).toBe(403);
    expect(f.redis.eval).toHaveBeenCalledTimes(calls);
  });
  it.each([
    ['by-time', 'statisticsByTime'],
    ['analytics-monthly-breakdown', 'statisticsByTime'],
    ['all-countries-summary', 'allCountriesSummary'],
    ['region-summary', 'regionSummary'],
    ['period-summary', 'periodSummary'],
    ['period-summary/details', 'periodSummaryDetails'],
    ['asin-by-country', 'asinStatisticsByCountry'],
    ['asin-by-variant-group', 'asinStatisticsByVariantGroup'],
  ] as const)(
    'exposes actual %s cache access under the fixed Legacy family %s',
    async (operation, prefix) => {
      expect((await get(operation)).statusCode).toBe(200);
      expect(await cacheCount('misses', prefix)).toBe(1);
      expect(await cacheCount('hits', prefix)).toBe(0);
      expect((await get(operation)).statusCode).toBe(200);
      expect(await cacheCount('misses', prefix)).toBe(1);
      expect(await cacheCount('hits', prefix)).toBe(1);
      const metrics = await app.http.inject({ method: 'GET', url: '/metrics' });
      const cacheLines = metrics.body
        .split('\n')
        .filter((line) =>
          /^amazon_asin_monitor_cache_(hits|misses)_total/.test(line),
        );
      expect(cacheLines.join('\n')).not.toContain(f.user.id);
      expect(cacheLines.join('\n')).not.toContain('2024-02');
      expect(cacheLines.join('\n')).not.toContain(':neo:');
      expect(cacheLines.join('\n')).not.toMatch(/[a-f0-9]{64}/);
    },
  );
  it('records nothing for rejected, uncached, disabled or explicitly bypassed access', async () => {
    f.permissions.length = 0;
    expect((await get()).statusCode).toBe(403);
    expect(await cacheCount('misses', 'statisticsByTime')).toBe(0);
    f.permissions.push('analytics:read', 'monitor:read');
    expect((await get('statistics')).statusCode).toBe(200);
    expect(await cacheCount('misses', 'statisticsByTime')).toBe(0);
    await app.app.close();
    await start({
      ANALYTICS_STATISTICS_BY_TIME_TTL_MS: '0',
      ANALYTICS_BENCHMARK_CACHE_BYPASS_ENABLED: '1',
    });
    expect((await get()).statusCode).toBe(200);
    expect(await cacheCount('misses', 'statisticsByTime')).toBe(0);
    const bypass = { ...headers, 'x-analytics-cache-bypass': '1' };
    expect((await get('all-countries-summary', {}, bypass)).statusCode).toBe(
      200,
    );
    expect(await cacheCount('misses', 'allCountriesSummary')).toBe(0);
    expect(await cacheCount('hits', 'allCountriesSummary')).toBe(0);
    expect(f.redis.eval).not.toHaveBeenCalled();
  });
  it.each(['malformed', 'expired', 'incomplete', 'oversized', 'redis-error'])(
    'counts one miss for %s and no second miss from a cache write',
    async (condition) => {
      expect((await get()).statusCode).toBe(200);
      const key = f.values.keys().next().value!;
      const valid = JSON.parse(f.values.get(key)!);
      if (condition === 'malformed') f.values.set(key, '{');
      if (condition === 'expired')
        f.values.set(key, JSON.stringify({ ...valid, expiresAt: 0 }));
      if (condition === 'incomplete')
        f.values.set(key, JSON.stringify({ ...valid, data: [{}] }));
      if (condition === 'oversized')
        f.values.set(key, 'x'.repeat(2 * 1024 * 1024 + 1));
      if (condition === 'redis-error')
        f.redis.eval.mockRejectedValue(
          new Error('secret-redis-auth-diagnostic'),
        );
      expect((await get()).statusCode).toBe(200);
      expect(await cacheCount('misses', 'statisticsByTime')).toBe(2);
      expect(await cacheCount('hits', 'statisticsByTime')).toBe(0);
      const metrics = await app.http.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.body).not.toContain('secret-redis-auth-diagnostic');
    },
  );
  it.each([
    'account',
    'password',
    'password-expiry',
    'session',
    'session-expiry',
  ])('rejects a cached result after current %s changes', async (state) => {
    expect((await get()).statusCode).toBe(200);
    if (state === 'account') f.user.status = 'SUSPENDED';
    if (state === 'password') f.user.forcePasswordChange = true;
    if (state === 'password-expiry') f.user.passwordExpiresAt = new Date(0);
    if (state === 'session') f.session.status = 'REVOKED';
    if (state === 'session-expiry') f.session.expiresAt = new Date(0);
    const calls = f.redis.eval.mock.calls.length;
    expect((await get()).statusCode).toBe(403);
    expect(f.redis.eval).toHaveBeenCalledTimes(calls);
  });
  it('keeps differing date ranges separate and recovers malformed/expired/incomplete cache data', async () => {
    await get();
    await get('by-time', { startTime: '2024-02-02' });
    expect(f.values.size).toBe(2);
    const key = f.values.keys().next().value!;
    for (const value of [
      '{',
      JSON.stringify({ ...JSON.parse(f.values.get(key)!), expiresAt: 0 }),
      JSON.stringify({ ...JSON.parse(f.values.get(key)!), data: [{}] }),
    ]) {
      f.values.set(key, value);
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json().meta.cacheHit).toBe(false);
    }
    expect(f.unit.duration).toHaveBeenCalledTimes(5);
  });
  it('falls back to SQL when Redis is unavailable without exposing connection details', async () => {
    f.redis.eval.mockRejectedValue(new Error('private-redis-password-109'));
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(
      response.body + JSON.stringify(app.logger.warn.mock.calls),
    ).not.toContain('private-redis');
  });
  it('honors bypass only for the three original routes and only when enabled', async () => {
    await get('all-countries-summary');
    const bypass = { ...headers, 'x-analytics-cache-bypass': ' 1 ' };
    expect(
      (await get('all-countries-summary', {}, bypass)).json().meta.cacheHit,
    ).toBe(true);
    await app.app.close();
    await start({ ANALYTICS_BENCHMARK_CACHE_BYPASS_ENABLED: '1' });
    const enabled = { ...headers, 'x-analytics-cache-bypass': '1' };
    for (const operation of [
      'all-countries-summary',
      'region-summary',
      'period-summary',
    ] as const) {
      await get(operation);
      expect((await get(operation, {}, enabled)).json().meta.cacheHit).toBe(
        false,
      );
    }
    await get();
    expect((await get('by-time', {}, enabled)).json().meta.cacheHit).toBe(true);
  });
  it('normalizes monthly fallback before its cache key and uses the monthly daily-source operation', async () => {
    const response = await get('analytics-monthly-breakdown', {
      month: '2024-02',
    });
    expect(response.json().data.rows).toHaveLength(29);
    expect(f.unit.duration).toHaveBeenCalledWith({
      operation: 'analytics-monthly-breakdown',
      country: 'US',
      month: '2024-02',
      startTime: '2024-02-01 00:00:00',
      endTime: '2024-02-29 23:59:59',
    });
    expect(response.json().meta).toBeUndefined();
  });
  it.each([
    {
      operation: 'peak-hours',
      query: { country: '' },
      message: '高峰期统计需要指定国家',
    },
    {
      operation: 'peak-mark-areas',
      query: { startTime: '' },
      message: '请提供开始时间和结束时间',
    },
    {
      operation: 'by-time',
      query: { startTime: '2024-02-30' },
      message: '统计查询参数无效',
    },
    {
      operation: 'period-summary',
      query: { pageSize: '101' },
      message: '统计查询参数无效',
    },
  ] as const)(
    'returns bounded 400 for $operation $query',
    async ({ operation, query, message }) => {
      const response = await get(
        operation,
        Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== undefined),
        ),
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        success: false,
        errorCode: 400,
        errorMessage: message,
      });
      expect(f.redis.eval).not.toHaveBeenCalled();
    },
  );
  it.each([
    { error: new MonitorAnalyticsQueryError('capacity'), status: 429 },
    { error: new MonitorAnalyticsResultLimitError(), status: 413 },
    { error: new MonitorAnalyticsQueryError('timeout'), status: 504 },
    {
      error: { cause: { code: '57014', message: 'private-sql-109' } },
      status: 504,
    },
    { error: new Error('private-database-109'), status: 500 },
  ])(
    'returns $status with no partial result or private driver payload',
    async ({ error, status }) => {
      vi.mocked(f.unit.duration).mockRejectedValueOnce(error);
      const response = await get();
      expect(response.statusCode).toBe(status);
      expect(response.json().data).toBeUndefined();
      expect(
        response.body +
          JSON.stringify([
            app.logger.warn.mock.calls,
            app.logger.error.mock.calls,
          ]),
      ).not.toContain('private-');
      expect((await get()).statusCode).toBe(200);
    },
  );
  it('rejects incomplete database results rather than returning a success with missing metrics', async () => {
    vi.mocked(f.unit.duration).mockResolvedValueOnce({
      data: [{}],
      source: 'raw',
    });
    expect((await get()).statusCode).toBe(500);
    expect(f.values.size).toBe(0);
  });
  it('reserves admission before session activity writes and shares the same slot with the data query', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.auth.touchSession.mockImplementation(() => gate);
    const pending = Promise.all([get(), get()]);
    try {
      await vi.waitFor(() =>
        expect(f.auth.touchSession).toHaveBeenCalledTimes(2),
      );
      const overloaded = await get();
      expect(overloaded.statusCode).toBe(429);
      expect(overloaded.headers['cache-control']).toBe('no-store');
      expect(f.auth.touchSession).toHaveBeenCalledTimes(2);
      expect(f.repository.read).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect((await pending).map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);
    expect((await get()).statusCode).toBe(200);
  });
});
