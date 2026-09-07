import {
  errorStatsResultSchema,
  rateLimiterStatusResultSchema,
} from '@asin-monitor/contracts';
import type {
  AuthSessionRecord,
  AuthUserRecord,
  SpApiConfigurationRepositoryPort,
  SpApiConfigurationUnit,
} from '@asin-monitor/db';
import type { HttpInput, HttpResponse } from '@asin-monitor/sp-api';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationRedisClient } from '../src/redis/redis.service';
import {
  SP_API_CONFIG_ENV,
  SP_API_CONFIG_REPOSITORY,
} from '../src/sp-api-config/sp-api-config.service';
import { ApplicationSpApiRuntime } from '../src/sp-api-runtime/sp-api-runtime';
import {
  SP_API_QUOTA_ENV,
  SpApiHtmlHttpTransport,
  SpApiHttpTransport,
  SpApiRuntimeModule,
} from '../src/sp-api-runtime/sp-api-runtime.module';
import { sessionApp } from './helpers/session-app';

const id = 'status-operator-81',
  sessionId = 'status-session-81';
function data() {
  const user: AuthUserRecord = {
    id,
    username: id,
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
  const session: AuthSessionRecord = {
    id: sessionId,
    userId: id,
    userAgent: null,
    ipAddress: null,
    status: 'ACTIVE',
    rememberMe: false,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  const permissions = ['settings:read'];
  const unit = {
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => permissions),
  } as unknown as SpApiConfigurationUnit;
  const repository: SpApiConfigurationRepositoryPort = {
    transaction: vi.fn(async (operation) => operation(unit)),
    readConfiguration: vi.fn(async () => []),
  };
  const auth = {
    findUserById: vi.fn(async () =>
      structuredClone({
        ...user,
        status: 'ACTIVE',
        forcePasswordChange: false,
        passwordExpiresAt: null,
      }),
    ),
    findSessionById: vi.fn(async () =>
      structuredClone({
        ...session,
        status: 'ACTIVE',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      }),
    ),
    getPermissionCodes: vi.fn(async () => ['settings:read']),
    getRoles: vi.fn(async () => [
      { id: 'readonly-81', code: 'READONLY', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  const redis = {
    client: { status: 'end', get: vi.fn(async () => null), eval: vi.fn() },
    ping: vi.fn(async () => {
      throw new Error('Fixture Redis unavailable');
    }),
    get: vi.fn(async () => null),
    setex: vi.fn(),
    del: vi.fn(),
  };
  const transport = {
    request: vi.fn(
      async (input: HttpInput): Promise<HttpResponse> =>
        input.url.hostname === 'api.amazon.com'
          ? {
              statusCode: 200,
              body: '{"access_token":"fixture-access","token_type":"bearer","expires_in":3600}',
              headers: {},
            }
          : { statusCode: 503, body: 'fixture-private-payload', headers: {} },
    ),
    onApplicationShutdown: vi.fn(),
  };
  const htmlTransport = { request: vi.fn(), onApplicationShutdown: vi.fn() };
  return {
    user,
    session,
    permissions,
    unit,
    repository,
    auth,
    redis,
    transport,
    htmlTransport,
  };
}
describe('SP-API status HTTP / current permissions and actual host runtime', () => {
  let f: ReturnType<typeof data>,
    app: Awaited<ReturnType<typeof sessionApp>>,
    headers: { authorization: string };
  const paths = ['/rate-limiter/status', '/error-stats'];
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    app = await sessionApp(
      f.auth,
      overrides,
      (builder) =>
        builder
          .overrideProvider(SP_API_CONFIG_REPOSITORY)
          .useValue(f.repository)
          .overrideProvider(SP_API_CONFIG_ENV)
          .useValue({
            SP_API_LWA_CLIENT_ID: 'fixture-client',
            SP_API_LWA_CLIENT_SECRET: 'fixture-secret',
            SP_API_REFRESH_TOKEN: 'fixture-refresh',
          })
          .overrideProvider(SP_API_QUOTA_ENV)
          .useValue({ RATE_LIMITER_KEY_PREFIX: 'spapi:runtime:fixture-81' })
          .overrideProvider(ApplicationRedisClient)
          .useValue(f.redis)
          .overrideProvider(SpApiHttpTransport)
          .useValue(f.transport)
          .overrideProvider(SpApiHtmlHttpTransport)
          .useValue(f.htmlTransport),
      [SpApiRuntimeModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: id, sessionId },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  }
  beforeEach(async () => {
    f = data();
    await start();
  });
  afterEach(async () => {
    await app.app.close();
    vi.restoreAllMocks();
  });
  const get = (path: string, auth = headers) =>
    app.http.inject({ method: 'GET', url: `/api/v1${path}`, headers: auth });
  it.each(paths)('requires authentication on %s', async (path) => {
    expect((await get(path, {} as never)).statusCode).toBe(401);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it.each(paths)(
    'allows settings:read and prevents caching %s',
    async (path) => {
      const result = await get(path);
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      (path === '/error-stats'
        ? errorStatsResultSchema
        : rateLimiterStatusResultSchema
      ).parse(result.json());
    },
  );
  it('returns selected region/operation snapshots and errors from the exact injected runtime instance', async () => {
    const runtime = app.app.get(ApplicationSpApiRuntime);
    const snapshot = await get(
      '/rate-limiter/status?region=eu&operation=getCatalogItem',
    );
    expect(snapshot.statusCode).toBe(200);
    expect(Object.keys(snapshot.json().data)).toEqual(['EU']);
    expect(snapshot.json().data.EU).toMatchObject({
      name: 'EU:operation:getCatalogItem',
      mode: 'memory',
    });
    await expect(
      runtime.standard.call(
        'GET',
        '/catalog/2022-04-01/items/B000000001',
        'US',
        {},
        null,
        { maxRetries: 0 },
      ),
    ).rejects.toHaveProperty('statusCode', 503);
    const errors = await get('/error-stats?hours=0.5');
    errorStatsResultSchema.parse(errors.json());
    expect(errors.json().data).toMatchObject({
      total: 1,
      recent: { count: 1, hours: 0.5 },
      byType: { SERVER_ERROR: { count: 1 } },
    });
    expect(errors.headers['x-sp-api-statistics-scope']).toBe('api-process');
    expect(errors.headers['x-sp-api-statistics-unit']).toBe('upstream-attempt');
    expect(errors.body).not.toContain('fixture-private-payload');
    expect(errors.body).not.toContain('B000000001');
  });
  it.each([
    '/rate-limiter/status?region=CA',
    '/rate-limiter/status?operation=default',
    '/rate-limiter/status?region=US&region=EU',
    '/error-stats?hours=0',
    '/error-stats?hours=169',
    '/error-stats?hours=Infinity',
    '/error-stats?hours=1&hours=2',
  ])('rejects invalid/ambiguous filters %s', async (path) => {
    expect((await get(path)).statusCode).toBe(400);
  });
  it.each(paths)(
    'rejects current permission revocation despite the guard cached snapshot for %s',
    async (path) => {
      f.permissions.splice(0);
      const status = vi.spyOn(
        app.app.get(ApplicationSpApiRuntime),
        'getQuotaStatus',
      );
      expect((await get(path)).statusCode).toBe(403);
      expect(status).not.toHaveBeenCalled();
    },
  );
  it.each(['user', 'password', 'session', 'expiration'])(
    'rechecks current %s under the administration transaction',
    async (field) => {
      if (field === 'user') f.user.status = 'DISABLED';
      if (field === 'password') f.user.forcePasswordChange = true;
      if (field === 'session') f.session.status = 'REVOKED';
      if (field === 'expiration') f.session.expiresAt = new Date(0);
      expect((await get('/error-stats')).statusCode).toBe(403);
    },
  );
  it('rejects a caller without settings:read at the guard', async () => {
    f.auth.getPermissionCodes.mockResolvedValue([]);
    expect((await get('/error-stats')).statusCode).toBe(403);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('bounds pending status transactions and restores admission after actual completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.repository.transaction).mockImplementation(
      async (operation) => {
        await gate;
        return operation(f.unit);
      },
    );
    const pending = Array.from({ length: 8 }, () =>
      Promise.resolve(get('/error-stats')),
    );
    try {
      await vi.waitFor(() =>
        expect(f.repository.transaction).toHaveBeenCalledTimes(8),
      );
      expect((await get('/error-stats')).statusCode).toBe(429);
    } finally {
      release();
      await Promise.allSettled(pending);
    }
    expect((await get('/error-stats')).statusCode).toBe(200);
  });
  it('returns fixed failures without leaking driver payloads', async () => {
    vi.mocked(f.repository.transaction).mockRejectedValueOnce(
      new Error('postgresql://fixture-private/token'),
    );
    const response = await get('/rate-limiter/status');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      success: false,
      errorCode: 500,
      errorMessage: '服务器内部错误',
    });
    expect(JSON.stringify(app.logger.error.mock.calls)).not.toContain(
      'fixture-private',
    );
  });
  it('keeps PostgreSQL authority gate explicit and does not probe Redis in Legacy mode', async () => {
    await app.app.close();
    f = data();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture',
      DB_NAME: 'fixture',
    });
    expect((await get('/error-stats')).statusCode).toBe(503);
    expect(f.redis.ping).not.toHaveBeenCalled();
  });
  it('closes runtime clients before native transport application shutdown hooks', async () => {
    const runtime = app.app.get(ApplicationSpApiRuntime),
      order: string[] = [];
    const close = runtime.onModuleDestroy.bind(runtime);
    vi.spyOn(runtime, 'onModuleDestroy').mockImplementation(() => {
      order.push('runtime');
      close();
    });
    f.transport.onApplicationShutdown.mockImplementation(() => {
      order.push('spapi-transport');
    });
    f.htmlTransport.onApplicationShutdown.mockImplementation(() => {
      order.push('html-transport');
    });
    await app.app.close();
    expect(order[0]).toBe('runtime');
    expect(order).toContain('spapi-transport');
    expect(order).toContain('html-transport');
    await expect(
      runtime.standard.call(
        'GET',
        '/catalog/2022-04-01/items/B000000001',
        'US',
      ),
    ).rejects.toHaveProperty('code', 'CLOSED');
  });
});
