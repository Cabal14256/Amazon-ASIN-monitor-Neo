import {
  opsOverviewResultSchema,
  refreshAnalyticsResultSchema,
} from '@asin-monitor/contracts';
import type { RoleRepositoryPort } from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionCacheService } from '../src/auth/permission-cache.service';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { OpsModule } from '../src/ops/ops.module';
import {
  OPS_QUEUE_FACTORY,
  OPS_ROLE_REPOSITORY,
  OpsRedisDeadlineError,
  withOpsRedisDeadline,
} from '../src/ops/ops.service';
import { ApplicationRedisClient } from '../src/redis/redis.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';
import { sessionApp } from './helpers/session-app';

describe('Neo operations HTTP', () => {
  let fixture: ReturnType<typeof monitorAnalyticsFixture>;
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let redis: {
    values: Map<string, string>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    disconnect(): void;
  };
  let headers: { authorization: string };
  let queueFactory: ReturnType<typeof vi.fn>;
  let scan: ReturnType<typeof vi.fn>;
  let unlink: ReturnType<typeof vi.fn>;
  let refreshClient: {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let database: {
    primaryPool: {
      query: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    fixture = monitorAnalyticsFixture();
    fixture.auth.getPermissionCodes.mockResolvedValue([
      'settings:read',
      'settings:write',
    ]);
    fixture.unit.operatorPermissionCodes.mockResolvedValue([
      'settings:read',
      'settings:write',
    ]);
    const roleRepository: RoleRepositoryPort = {
      read: vi.fn(async (operation) => operation(fixture.unit)),
      transaction: vi.fn(async (operation) => operation(fixture.unit)),
    };
    refreshClient = {
      query: vi.fn(async (sql: string) =>
        sql.includes('pg_try_advisory_lock')
          ? { rows: [{ acquired: true }] }
          : { rows: [] },
      ),
      release: vi.fn(),
    };
    queueFactory = vi.fn(() => ({
      waitUntilReady: vi.fn(async () => undefined),
      getJobCounts: vi.fn(async () => ({ waiting: 0, total: 0 })),
      isPaused: vi.fn(async () => false),
      close: vi.fn(async () => undefined),
    }));
    database = {
      primaryPool: {
        query: vi.fn(),
        connect: vi.fn(async () => refreshClient),
      },
    };
    const values = new Map<string, string>();
    redis = {
      values,
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
      },
      disconnect: () => undefined,
    };
    scan = vi.fn(async (_cursor: string, pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [
        '0',
        [...values.keys()].filter((key) => key.startsWith(prefix)),
      ] as [string, string[]];
    });
    unlink = vi.fn(async (...keys: string[]) => {
      let removed = 0;
      keys.forEach((key) => {
        if (values.delete(key)) removed++;
      });
      return removed;
    });
    const redisPort = {
      client: {},
      scan,
      unlink,
      get: (key: string) => redis.get(key),
      setex: async (key: string, _ttl: number, value: string) => {
        values.set(key, value);
      },
      del: async (...keys: string[]) => {
        keys.forEach((key) => values.delete(key));
        return keys.length;
      },
    } as unknown as ApplicationRedisClient;
    app = await sessionApp(
      fixture.auth,
      { BULL_PREFIX: 'ops-test', ANALYTICS_AGG_ENABLED: '1' },
      (builder) =>
        builder
          .overrideProvider(ApplicationDatabasePools)
          .useValue(database)
          .overrideProvider(ApplicationRedisClient)
          .useValue(redisPort)
          .overrideProvider(PermissionCacheService)
          .useValue({ getPermissions: fixture.auth.getPermissionCodes })
          .overrideProvider(OPS_QUEUE_FACTORY)
          .useValue(queueFactory)
          .overrideProvider(OPS_ROLE_REPOSITORY)
          .useValue(roleRepository),
      [OpsModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: fixture.user.id, sessionId: fixture.session.id },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  });

  afterEach(async () => {
    await app.app.close();
    redis.disconnect();
  });

  it('requires a current settings read grant and returns the typed overview', async () => {
    expect(
      (await app.http.inject({ method: 'GET', url: '/api/v1/ops/overview' }))
        .statusCode,
    ).toBe(401);
    const responsePromise = app.http.inject({
      method: 'GET',
      url: '/api/v1/ops/overview',
      headers,
    });
    await vi.waitFor(() => expect(queueFactory).toHaveBeenCalled(), {
      timeout: 1_000,
    });
    const response = await responsePromise;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const overview = opsOverviewResultSchema.parse(response.json());
    expect(overview.data.queues.monitor.isPaused).toBe(false);
    expect(queueFactory).toHaveBeenCalledTimes(2);
    expect(overview.data.cache).toMatchObject({
      activeEntries: 0,
      truncated: false,
    });
    fixture.unit.operatorPermissionCodes.mockResolvedValue([]);
    const revoked = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    expect(revoked.statusCode).toBe(403);
    expect(redis.values.size).toBe(0);
    fixture.auth.getPermissionCodes.mockResolvedValue([]);
    expect(
      (
        await app.http.inject({
          method: 'GET',
          url: '/api/v1/ops/overview',
          headers,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('clears the Neo analytics cache and bounds aggregate refresh input', async () => {
    await redis.set('ops-test:neo:analytics:v1:fixture', 'cached');
    await redis.set('ops-test:neo:analytics:v2:preserved', 'cached');
    await redis.set('other:neo:analytics:v1:preserved', 'cached');
    const clear = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    expect(clear.statusCode, clear.body).toBe(200);
    expect(clear.headers['cache-control']).toBe('no-store');
    expect(await redis.get('ops-test:neo:analytics:v1:fixture')).toBeNull();
    expect(await redis.get('ops-test:neo:analytics:v2:preserved')).toBe(
      'cached',
    );
    expect(await redis.get('other:neo:analytics:v1:preserved')).toBe('cached');
    expect(clear.json().data.prefixes).toEqual(['ops-test:neo:analytics:v1:']);
    expect(unlink).toHaveBeenCalledOnce();
    const afterClear = await app.http.inject({
      method: 'GET',
      url: '/api/v1/ops/overview',
      headers,
    });
    expect(afterClear.json().data.analyticsCache.lastClearedAt).toBe(
      clear.json().data.clearedAt,
    );

    const invalid = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/refresh',
      headers,
      payload: {
        startTime: '2026-01-01 00:00:00',
        endTime: '2026-03-01 00:00:00',
      },
    });
    expect(invalid.statusCode).toBe(400);
    const malformed = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/refresh',
      headers,
      payload: {
        startTime: '2026-02-30 00:00:00',
        endTime: '2026-03-01 00:00:00',
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(database.primaryPool.connect).not.toHaveBeenCalled();

    for (const payload of [
      { granularity: 0 },
      { startTime: 1 },
      { startTime: '2026-01-01 00:00:00', unsupported: true },
    ]) {
      const rejected = await app.http.inject({
        method: 'POST',
        url: '/api/v1/ops/analytics/refresh',
        headers,
        payload,
      });
      expect(rejected.statusCode).toBe(400);
    }
    expect(database.primaryPool.connect).not.toHaveBeenCalled();

    const refreshed = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/refresh',
      headers,
      payload: {
        granularity: 'day',
        startTime: '2026-01-01 00:00:00',
        endTime: '2026-01-02 00:00:00',
      },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(
      refreshAnalyticsResultSchema.parse(refreshed.json()).data,
    ).toMatchObject({
      refreshed: expect.any(Array),
      startTime: '2026-01-01 00:00:00',
      endTime: '2026-01-02 00:00:00',
    });
    expect(database.primaryPool.connect).toHaveBeenCalledOnce();
    expect(refreshed.headers['cache-control']).toBe('no-store');
    expect(
      refreshClient.query.mock.calls.filter(([sql]) =>
        String(sql).startsWith('CALL public.refresh_continuous_aggregate'),
      ),
    ).toHaveLength(3);
    refreshClient.query.mockImplementation(async (sql: string) =>
      sql.includes('pg_try_advisory_lock')
        ? { rows: [{ acquired: false }] }
        : { rows: [] },
    );
    const busy = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/refresh',
      headers,
    });
    expect(busy.statusCode, busy.body).toBe(409);
  });

  it('rechecks current grants before reads and writes, with no denied side effects', async () => {
    await redis.set('ops-test:neo:analytics:v1:fixture', 'cached');
    fixture.unit.operatorPermissionCodes.mockResolvedValue(['settings:read']);
    const clear = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    const refresh = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/refresh',
      headers,
    });
    expect(clear.statusCode).toBe(403);
    expect(refresh.statusCode).toBe(403);
    expect(scan).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(database.primaryPool.connect).not.toHaveBeenCalled();
    expect(await redis.get('ops-test:neo:analytics:v1:fixture')).toBe('cached');

    fixture.unit.operatorPermissionCodes.mockResolvedValue(['settings:write']);
    const overview = await app.http.inject({
      method: 'GET',
      url: '/api/v1/ops/overview',
      headers,
    });
    expect(overview.statusCode).toBe(403);
    expect(queueFactory).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it('stops a bounded cache scan before deleting anything', async () => {
    await redis.set('ops-test:neo:analytics:v1:fixture', 'cached');
    scan.mockResolvedValue(['1', ['ops-test:neo:analytics:v1:fixture']]);
    const clear = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    expect(clear.statusCode, clear.body).toBe(409);
    expect(scan).toHaveBeenCalledTimes(100);
    expect(unlink).not.toHaveBeenCalled();
    expect(await redis.get('ops-test:neo:analytics:v1:fixture')).toBe('cached');
    expect(
      [...redis.values.keys()].some((key) => key.includes('last-cleared-at')),
    ).toBe(false);

    const overview = await app.http.inject({
      method: 'GET',
      url: '/api/v1/ops/overview',
      headers,
    });
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().data.cache).toMatchObject({
      activeEntries: null,
      truncated: true,
    });

    scan.mockResolvedValue([
      '0',
      Array.from(
        { length: 10_001 },
        (_, index) => `ops-test:neo:analytics:v1:${index}`,
      ),
    ]);
    const tooManyKeys = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    expect(tooManyKeys.statusCode).toBe(409);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('only unlinks the literal Neo analytics prefix from returned scan keys', async () => {
    await redis.set('ops-test:neo:analytics:v1:fixture', 'cached');
    await redis.set('ops-other:neo:analytics:v1:preserved', 'cached');
    scan.mockResolvedValue([
      '0',
      [
        'ops-test:neo:analytics:v1:fixture',
        'ops-other:neo:analytics:v1:preserved',
      ],
    ]);
    const response = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(scan).toHaveBeenCalledWith('0', 'ops-test:neo:analytics:v1:*', 200);
    expect(unlink).toHaveBeenCalledWith('ops-test:neo:analytics:v1:fixture');
    expect(await redis.get('ops-other:neo:analytics:v1:preserved')).toBe(
      'cached',
    );
  });

  it('escapes Redis glob characters in the configured namespace', async () => {
    app.env.BULL_PREFIX = 'ops[test]*?\\';
    const key = `${app.env.BULL_PREFIX}:neo:analytics:v1:fixture`;
    await redis.set(key, 'cached');
    scan.mockImplementation(async (_cursor: string, pattern: string) => {
      expect(pattern).toBe('ops\\[test\\]\\*\\?\\\\:neo:analytics:v1:*');
      return ['0', [key]];
    });
    const response = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(unlink).toHaveBeenCalledWith(key);
    expect(await redis.get(key)).toBeNull();
  });

  it('reports Redis and database failures without leaking their messages', async () => {
    scan.mockRejectedValueOnce(new Error('redis-password-private'));
    const failedScan = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    expect(failedScan.statusCode).toBe(503);
    expect(failedScan.body).not.toContain('redis-password-private');
    expect(unlink).not.toHaveBeenCalled();

    await redis.set('ops-test:neo:analytics:v1:fixture', 'cached');
    unlink.mockRejectedValueOnce(new Error('redis-token-private'));
    const failedUnlink = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    expect(failedUnlink.statusCode).toBe(503);
    expect(failedUnlink.body).not.toContain('redis-token-private');
    expect(
      [...redis.values.keys()].some((key) => key.includes('last-cleared-at')),
    ).toBe(false);

    refreshClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired: true }] };
      if (sql.startsWith('CALL')) throw new Error('db-secret-private');
      return { rows: [] };
    });
    const failedRefresh = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/refresh',
      headers,
    });
    expect(failedRefresh.statusCode).toBe(503);
    expect(failedRefresh.body).not.toContain('db-secret-private');
    expect(refreshClient.query).toHaveBeenCalledWith('RESET statement_timeout');
    expect(refreshClient.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
    );
    expect(refreshClient.release).toHaveBeenCalledWith(false);
    expect(JSON.stringify(app.logger.error.mock.calls)).not.toMatch(
      /redis-password-private|redis-token-private|db-secret-private/,
    );
  });

  it('bounds the whole refresh across all aggregate targets', async () => {
    let now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
    refreshClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired: true }] };
      if (sql.startsWith('CALL')) now += 120_001;
      return { rows: [] };
    });
    try {
      const response = await app.http.inject({
        method: 'POST',
        url: '/api/v1/ops/analytics/refresh',
        headers,
        payload: { granularity: 'day' },
      });
      expect(response.statusCode, response.body).toBe(503);
      expect(
        refreshClient.query.mock.calls.filter(([sql]) =>
          String(sql).startsWith('CALL public.refresh_continuous_aggregate'),
        ),
      ).toHaveLength(1);
      expect(refreshClient.query).toHaveBeenCalledWith(
        'RESET statement_timeout',
      );
      expect(refreshClient.release).toHaveBeenCalledWith(false);
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe('Ops Redis command deadline', () => {
  it('returns at the deadline even if an issued command remains pending', async () => {
    vi.useFakeTimers();
    try {
      const operation = vi.fn(() => new Promise<string>(() => undefined));
      const result = withOpsRedisDeadline(Date.now() + 5_000, operation);
      const rejection = expect(result).rejects.toBeInstanceOf(
        OpsRedisDeadlineError,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not dispatch a command after its deadline', async () => {
    const operation = vi.fn(async () => 'late');
    await expect(
      withOpsRedisDeadline(Date.now() - 1, operation),
    ).rejects.toBeInstanceOf(OpsRedisDeadlineError);
    expect(operation).not.toHaveBeenCalled();
  });
});
