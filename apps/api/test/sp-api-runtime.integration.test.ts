import {
  errorStatsResultSchema,
  rateLimiterStatusResultSchema,
} from '@asin-monitor/contracts';
import type { SpApiConfigurationRepositoryPort } from '@asin-monitor/db';
import { type HttpInput, type HttpResponse } from '@asin-monitor/sp-api';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ApplicationSpApiConfigSource } from '../src/sp-api-config/sp-api-config.module';
import { SP_API_CONFIG_REPOSITORY } from '../src/sp-api-config/sp-api-config.service';
import { ApplicationSpApiRuntime } from '../src/sp-api-runtime/sp-api-runtime';
import {
  SP_API_QUOTA_ENV,
  SpApiHtmlHttpTransport,
  SpApiHttpTransport,
  SpApiRuntimeModule,
} from '../src/sp-api-runtime/sp-api-runtime.module';
import { spApiConfigApp } from './helpers/sp-api-config-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'API SP-API runtime / real PostgreSQL and Redis, fixture-only upstream',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>>,
      runtime: ApplicationSpApiRuntime,
      headers: { authorization: string },
      operatorId: string;
    const prefix = `spapi:runtime81:${randomUUID()}`;
    const asin = 'B000000001',
      path = `/catalog/2022-04-01/items/${asin}`;
    const native = {
      request: vi.fn(
        async (input: HttpInput): Promise<HttpResponse> =>
          input.url.hostname === 'api.amazon.com'
            ? {
                statusCode: 200,
                body: '{"access_token":"fixture-runtime-token","token_type":"bearer","expires_in":3600}',
                headers: {},
              }
            : { statusCode: 200, body: JSON.stringify({ asin }), headers: {} },
      ),
    };
    const html = {
      request: vi.fn(
        async (): Promise<HttpResponse> => ({
          statusCode: 200,
          body: `<input id="ASIN" value="${asin}"><span id="productTitle">Fixture product</span>`,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    };
    beforeAll(async () => {
      f = await spApiConfigApp({
        imports: [SpApiRuntimeModule],
        configure: (builder) =>
          builder
            .overrideProvider(SP_API_QUOTA_ENV)
            .useValue({ RATE_LIMITER_KEY_PREFIX: prefix })
            .overrideProvider(SpApiHttpTransport)
            .useValue(native)
            .overrideProvider(SpApiHtmlHttpTransport)
            .useValue(html),
      });
      runtime = f.app.get(ApplicationSpApiRuntime);
      expect(f.redis.client.status).toBe('ready');
    });
    afterAll(async () => {
      try {
        if (runtime) runtime.onModuleDestroy();
        if (f) {
          await f.redis.ping();
          const keys = new Set<string>();
          let cursor = '0',
            pages = 0;
          do {
            if (++pages > 100)
              throw new Error('Unexpected runtime fixture Redis scan size');
            const [next, found] = await f.redis.client.scan(
              cursor,
              'MATCH',
              `${prefix}:*`,
              'COUNT',
              100,
            );
            cursor = next;
            for (const key of found) {
              if (!key.startsWith(`${prefix}:`))
                throw new Error('Unexpected runtime fixture Redis key');
              keys.add(key);
            }
            if (keys.size > 64)
              throw new Error('Unexpected runtime fixture key cardinality');
          } while (cursor !== '0');
          if (keys.size) await f.redis.del(...keys);
        }
      } finally {
        try {
          if (f) await f.close();
        } finally {
          vi.restoreAllMocks();
        }
      }
    });
    async function user(role = 'writer-71') {
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u81-${userId}`, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [userId, role],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      return {
        userId,
        headers: {
          authorization: `Bearer ${jwt.sign(
            { userId, sessionId },
            f.env.JWT_SECRET,
            { expiresIn: '1h' },
          )}`,
        },
      };
    }
    beforeEach(async () => {
      await f.pools.primaryPool.query('DELETE FROM sp_api_config');
      const actor = await user();
      operatorId = actor.userId;
      headers = actor.headers;
      runtime.errors.resetStats();
      native.request.mockClear();
      html.request.mockClear();
    });
    const get = (suffix: string, auth = headers) =>
      f.http.inject({ method: 'GET', url: `/api/v1${suffix}`, headers: auth });
    const write = (values: Record<string, string>) =>
      f.http.inject({
        method: 'PUT',
        url: '/api/v1/sp-api-configs',
        headers,
        payload: {
          configs: Object.entries(values).map(([configKey, configValue]) => ({
            configKey,
            configValue,
          })),
        },
      });
    it('serves both contracts for real settings:read sessions using the connected singleton', async () => {
      const reader = await user('reader-71');
      const status = await get('/rate-limiter/status', reader.headers);
      expect(status.statusCode).toBe(200);
      rateLimiterStatusResultSchema.parse(status.json());
      expect(status.json().data).toMatchObject({
        US: { mode: 'redis-distributed', redisAvailable: true },
        EU: { redisAvailable: true },
      });
      expect(status.headers['cache-control']).toBe('no-store');
      const errors = await get('/error-stats', reader.headers);
      expect(errors.statusCode).toBe(200);
      errorStatsResultSchema.parse(errors.json());
      expect(errors.headers['x-sp-api-statistics-scope']).toBe('api-process');
      expect((await get('/error-stats', {} as never)).statusCode).toBe(401);
    });
    it('uses the real shared Redis quota and reports a failed actual upstream attempt without its payload', async () => {
      native.request.mockImplementationOnce(async (input) =>
        input.url.hostname === 'api.amazon.com'
          ? {
              statusCode: 200,
              body: '{"access_token":"fixture-runtime-token","token_type":"bearer","expires_in":3600}',
              headers: {},
            }
          : {
              statusCode: 429,
              body: '{"errors":[{"code":"QuotaExceeded","message":"fixture-private"}]}',
              headers: {},
            },
      );
      // This is the first Catalog call in this suite; LWA precedes it.
      native.request.mockResolvedValueOnce({
        statusCode: 429,
        body: '{"errors":[{"code":"QuotaExceeded","message":"fixture-private"}]}',
        headers: {},
      });
      await expect(
        runtime.standard.call('GET', path, 'US', {}, null, { maxRetries: 0 }),
      ).rejects.toHaveProperty('statusCode', 429);
      const errors = await get('/error-stats');
      expect(errors.json().data).toMatchObject({
        total: 1,
        byType: { RATE_LIMIT: { count: 1 } },
      });
      expect(errors.body).not.toContain('fixture-private');
      expect(errors.body).not.toContain(asin);
      const quota = await get(
        '/rate-limiter/status?region=US&operation=getCatalogItem',
      );
      expect(quota.statusCode).toBe(200);
      expect(quota.json().data.US).toMatchObject({
        mode: 'redis-distributed',
        windows: { minute: { used: 1 } },
      });
    });
    it('reads committed fallback flags on every call and does not count successful HTML as SP-API', async () => {
      expect(
        (
          await write({
            ENABLE_LEGACY_CLIENT_FALLBACK: 'true',
            ENABLE_HTML_SCRAPER_FALLBACK: '1',
          })
        ).statusCode,
      ).toBe(200);
      await expect(runtime.legacy.call('GET', path, 'DE')).resolves.toEqual({
        asin,
      });
      await expect(
        runtime.html.checkVariants(asin, 'US'),
      ).resolves.toHaveProperty('hasVariants', false);
      expect(
        (await write({ ENABLE_LEGACY_CLIENT_FALLBACK: '' })).statusCode,
      ).toBe(200);
      const count = native.request.mock.calls.length;
      await expect(
        runtime.legacy.call('GET', path, 'DE'),
      ).rejects.toHaveProperty('code', 'INVALID_CONFIG');
      expect(native.request).toHaveBeenCalledTimes(count);
      expect((await get('/error-stats')).json().data.total).toBe(0);
      expect(html.request).toHaveBeenCalledTimes(1);
    });
    it('fails closed on real SQL flag-read timeout without making or counting an upstream request', async () => {
      expect(
        (await write({ ENABLE_HTML_SCRAPER_FALLBACK: 'true' })).statusCode,
      ).toBe(200);
      const connection = await f.pools.primaryPool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          'LOCK TABLE sp_api_config IN ACCESS EXCLUSIVE MODE',
        );
        await expect(
          runtime.html.checkVariants(asin, 'US'),
        ).rejects.toHaveProperty('code', 'DEPENDENCY_ERROR');
        expect(html.request).not.toHaveBeenCalled();
        expect(runtime.errors.getErrorStats().total).toBe(0);
      } finally {
        try {
          await connection.query('ROLLBACK');
        } finally {
          connection.release();
        }
      }
      await expect(
        runtime.html.checkVariants(asin, 'US'),
      ).resolves.toHaveProperty('hasVariants', false);
    });
    it('honors a committed RBAC revocation after the actual Redis permission cache was primed', async () => {
      expect((await get('/error-stats')).statusCode).toBe(200);
      const connection = await f.pools.primaryPool.connect();
      let pending: PromiseLike<{ statusCode: number }> | undefined;
      try {
        await connection.query('BEGIN');
        await connection.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        await connection.query('DELETE FROM user_roles WHERE user_id=$1', [
          operatorId,
        ]);
        pending = get('/error-stats').then((response) => response);
        await vi.waitFor(
          async () => {
            const result = await connection.query(
              "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))",
            );
            expect(result.rows[0].count).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 20 },
        );
        await connection.query('COMMIT');
        expect((await pending).statusCode).toBe(403);
      } finally {
        try {
          await connection.query('ROLLBACK');
        } finally {
          connection.release();
          await pending;
        }
      }
    });
    it('reconnects the real host Redis client and retains memory consumption in the same runtime after recovery', async () => {
      const recovery = new ApplicationSpApiRuntime({
        env: f.env,
        configEnv: {},
        quotaEnv: {
          RATE_LIMITER_KEY_PREFIX: `${prefix}:recovery`,
          SP_API_RATE_LIMIT_PER_MINUTE: 1,
          SP_API_RATE_LIMIT_PER_HOUR: 1,
        },
        repository: f.app.get<SpApiConfigurationRepositoryPort>(
          SP_API_CONFIG_REPOSITORY,
        ),
        source: f.app.get(ApplicationSpApiConfigSource),
        redis: f.redis,
        logger: f.logger,
        transport: native,
        htmlTransport: html,
      });
      const ping = vi
        .spyOn(f.redis, 'ping')
        .mockRejectedValue(new Error('Fixture temporary connection outage'));
      f.redis.client.disconnect(false);
      try {
        await vi.waitFor(() => expect(f.redis.client.status).toBe('end'), {
          timeout: 1000,
        });
        await expect(
          recovery.standard.call('GET', path, 'US'),
        ).resolves.toHaveProperty('data.asin', asin);
        expect(await recovery.getQuotaStatus('US')).toMatchObject({
          mode: 'memory',
        });
        ping.mockRestore();
        const restored = await recovery.getQuotaStatus('US');
        expect(f.redis.client.status).toBe('ready');
        expect(restored.mode).toBe('redis-distributed');
        expect(restored.windows.minute.used).toBeGreaterThan(0);
      } finally {
        ping.mockRestore();
        recovery.onModuleDestroy();
        await f.redis.ping();
      }
    });
  },
);
