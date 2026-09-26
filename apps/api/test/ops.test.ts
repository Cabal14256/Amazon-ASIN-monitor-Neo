import { opsOverviewResultSchema } from '@asin-monitor/contracts';
import type { RoleRepositoryPort } from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionCacheService } from '../src/auth/permission-cache.service';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { OpsModule } from '../src/ops/ops.module';
import { OPS_QUEUE_FACTORY, OPS_ROLE_REPOSITORY } from '../src/ops/ops.service';
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
    const redisPort = {
      client: {},
      eval: (
        script: string,
        keys: readonly string[],
        args: readonly (string | number)[],
      ) => {
        const prefix = String(args[0] ?? '').replace(/\*$/, '');
        const matched = [...values.keys()].filter((key) =>
          key.startsWith(prefix),
        );
        if (script.includes('DEL')) {
          matched.forEach((key) => values.delete(key));
          return Promise.resolve(matched.length);
        }
        return Promise.resolve(matched.length);
      },
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
    const clear = await app.http.inject({
      method: 'POST',
      url: '/api/v1/ops/analytics/cache/clear',
      headers,
    });
    expect(clear.statusCode, clear.body).toBe(200);
    expect(clear.headers['cache-control']).toBe('no-store');
    expect(await redis.get('ops-test:neo:analytics:v1:fixture')).toBeNull();
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
    expect(database.primaryPool.connect).toHaveBeenCalledOnce();
    expect(refreshed.headers['cache-control']).toBe('no-store');
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
});
