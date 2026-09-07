import {
  spApiConfigRecordSchema,
  spApiDisplayConfigSchema,
} from '@asin-monitor/contracts';
import type {
  AuthSessionRecord,
  AuthUserRecord,
  SpApiConfigurationRepositoryPort,
  SpApiConfigurationRow,
  SpApiConfigurationUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationSpApiConfigSource,
  SpApiConfigModule,
} from '../src/sp-api-config/sp-api-config.module';
import {
  SP_API_CONFIG_ENV,
  SP_API_CONFIG_REPOSITORY,
} from '../src/sp-api-config/sp-api-config.service';
import { sessionApp } from './helpers/session-app';

const id = 'config-operator-71';
const sessionId = 'config-session-71';
const secret = 'fixture-only-secret-71';
const key = 'SP_API_LWA_CLIENT_SECRET';
const configEnv = {
  SP_API_LWA_CLIENT_ID: 'fixture-client-71',
  SP_API_LWA_CLIENT_SECRET: 'env-fixture-secret-71',
  SP_API_REFRESH_TOKEN: 'fixture-refresh-71',
};
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
  const row: SpApiConfigurationRow = {
    id: 1,
    configKey: key,
    configValue: secret,
    description: 'Fixture',
    createTime: new Date('2026-09-07T01:00:00Z'),
    updateTime: new Date('2026-09-07T02:00:00Z'),
  };
  const rows = new Map([[key, row]]);
  const permissions = ['settings:read', 'settings:write'];
  const unit: SpApiConfigurationUnit = {
    listRoles: vi.fn(async () => []),
    findRole: vi.fn(),
    listPermissions: vi.fn(async () => []),
    listRolePermissions: vi.fn(async () => []),
    usersWithRole: vi.fn(async () => []),
    replacePermissions: vi.fn(),
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    listConfiguration: vi.fn(async () => [...rows.values()]),
    findConfiguration: vi.fn(async (value) => rows.get(value)),
    upsertConfiguration: vi.fn(
      async (
        changes: Parameters<SpApiConfigurationUnit['upsertConfiguration']>[0],
      ) =>
        changes.map((change, index) => {
          const result = { ...row, id: index + 1, ...change };
          rows.set(change.configKey, result);
          return result;
        }),
    ),
  };
  const repository: SpApiConfigurationRepositoryPort = {
    transaction: vi.fn(async (operation) => operation(unit)),
    readConfiguration: vi.fn(async () => [...rows.values()]),
  };
  // Guard sees a cached pre-change snapshot; the configuration transaction must
  // independently verify current user/session/permissions before returning data.
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
    getPermissionCodes: vi.fn(async () => ['settings:read', 'settings:write']),
    getRoles: vi.fn(async () => [
      { id: 'readonly-71', code: 'READONLY', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { user, session, rows, permissions, unit, repository, auth };
}

describe('SP-API configuration HTTP and host source', () => {
  let f: ReturnType<typeof data>;
  let fixture: Awaited<ReturnType<typeof sessionApp>>;
  let headers: { authorization: string };
  const body = { configs: [{ configKey: key, configValue: secret }] };
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    fixture = await sessionApp(
      f.auth,
      overrides,
      (builder) =>
        builder
          .overrideProvider(SP_API_CONFIG_REPOSITORY)
          .useValue(f.repository)
          .overrideProvider(SP_API_CONFIG_ENV)
          .useValue(configEnv),
      [SpApiConfigModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: id, sessionId },
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
  const request = (method: 'GET' | 'PUT', suffix = '', payload?: object) =>
    fixture.http.inject({
      method,
      url: `/api/v1/sp-api-configs${suffix}`,
      headers,
      payload,
    });

  it.each([
    ['GET', ''],
    ['GET', `/${key}`],
    ['PUT', ''],
  ] as const)(
    'prevents caching sensitive responses for %s %s',
    async (method, suffix) => {
      const result = await request(
        method,
        suffix,
        method === 'PUT' ? body : undefined,
      );
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
    },
  );
  it('bounds pending management transactions and restores admission after actual completion', async () => {
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
      Promise.resolve(request('GET')),
    );
    try {
      await vi.waitFor(() =>
        expect(f.repository.transaction).toHaveBeenCalledTimes(8),
      );
      expect((await request('GET')).statusCode).toBe(429);
      expect(f.repository.transaction).toHaveBeenCalledTimes(8);
    } finally {
      release();
      await Promise.allSettled(pending);
    }
    expect((await request('GET')).statusCode).toBe(200);
  });

  it.each([
    ['GET', ''],
    ['GET', `/${key}`],
    ['PUT', ''],
  ] as const)('requires authentication for %s %s', async (method, suffix) => {
    const result = await fixture.http.inject({
      method,
      url: `/api/v1/sp-api-configs${suffix}`,
      payload: method === 'PUT' ? body : undefined,
    });
    expect(result.statusCode).toBe(401);
    expect(f.repository.transaction).not.toHaveBeenCalled();
    expect(result.body).not.toContain(secret);
  });
  it('returns the nineteen legacy display records, dates and ENV fallback for an authorized writer regardless of role name', async () => {
    const result = await request('GET');
    expect(result.statusCode).toBe(200);
    const rows = spApiDisplayConfigSchema.array().parse(result.json().data);
    expect(rows).toHaveLength(19);
    expect(rows.find((row) => row.configKey === key)).toMatchObject({
      configValue: secret,
      displayValue: 'fixt****t-71',
      hasValue: true,
      updateTime: '2026-09-07T02:00:00.000Z',
    });
    expect(
      rows.find((row) => row.configKey === 'SP_API_LWA_CLIENT_ID')?.configValue,
    ).toBe(configEnv.SP_API_LWA_CLIENT_ID);
    expect(
      rows.find((row) => row.configKey === 'MONITOR_US_SCHEDULE_MINUTES')
        ?.configValue,
    ).toBe('30');
  });
  it('withholds raw database and ENV secrets after write permission is revoked, despite a cached guard grant', async () => {
    f.permissions.splice(1);
    const result = await request('GET');
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain(secret);
    expect(result.body).not.toContain(configEnv.SP_API_REFRESH_TOKEN);
    expect(
      result
        .json()
        .data.find((row: { configKey: string }) => row.configKey === key),
    ).toMatchObject({
      configValue: '',
      displayValue: 'fixt****t-71',
      hasValue: true,
    });
    expect((await request('GET', `/${key.toLowerCase()}`)).statusCode).toBe(
      403,
    );
    expect(f.unit.findConfiguration).not.toHaveBeenCalled();
    expect((await request('PUT', '', body)).statusCode).toBe(403);
    expect(f.unit.upsertConfiguration).not.toHaveBeenCalled();
  });
  it('permits a reader to fetch a non-sensitive stored setting and preserves database empty text', async () => {
    f.permissions.splice(1);
    f.rows.set('MONITOR_US_SCHEDULE_MINUTES', {
      ...f.rows.get(key)!,
      configKey: 'MONITOR_US_SCHEDULE_MINUTES',
      configValue: '',
    });
    const result = await request('GET', '/monitor_us_schedule_minutes');
    expect(result.statusCode).toBe(200);
    expect(spApiConfigRecordSchema.parse(result.json().data).config_value).toBe(
      '',
    );
  });
  it.each([
    'read permission',
    'disabled user',
    'expired password',
    'forced password',
    'revoked session',
    'expired session',
  ])('rechecks %s inside the transaction', async (scenario) => {
    if (scenario === 'read permission') f.permissions.splice(0);
    if (scenario === 'disabled user') f.user.status = 'DISABLED';
    if (scenario === 'expired password') f.user.passwordExpiresAt = new Date(0);
    if (scenario === 'forced password') f.user.forcePasswordChange = true;
    if (scenario === 'revoked session') f.session.status = 'REVOKED';
    if (scenario === 'expired session') f.session.expiresAt = new Date(0);
    const result = await request('GET');
    expect(result.statusCode).toBe(403);
    expect(f.unit.listConfiguration).not.toHaveBeenCalled();
    expect(result.body).not.toContain(secret);
  });
  it('enforces route permissions before opening a configuration transaction', async () => {
    f.auth.getPermissionCodes.mockResolvedValue([]);
    expect((await request('GET')).statusCode).toBe(403);
    expect((await request('PUT', '', body)).statusCode).toBe(403);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it.each(['/SP_API_UNKNOWN', '/SP_API_EU_SESSION_TOKEN', '/bad-key'])(
    'rejects missing or malformed key %s',
    async (suffix) => {
      expect((await request('GET', suffix)).statusCode).toBe(
        suffix === '/bad-key' ? 400 : 404,
      );
    },
  );
  it('normalizes a bulk update and preserves ordered snake_case records', async () => {
    const result = await request('PUT', '', {
      configs: [
        { configKey: ' sp_api_lwa_client_secret ', configValue: ` ${secret} ` },
        { configKey: 'COMPETITOR_MONITOR_ENABLED', configValue: false },
      ],
    });
    expect(result.statusCode).toBe(200);
    expect(
      spApiConfigRecordSchema
        .array()
        .parse(result.json().data)
        .map((row) => [row.config_key, row.config_value]),
    ).toEqual([
      [key, secret],
      ['COMPETITOR_MONITOR_ENABLED', 'false'],
    ]);
    expect(f.unit.upsertConfiguration).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fixture.logger)).not.toContain(secret);
  });
  it.each([
    { configs: [{ configKey: key }] },
    { configs: [{ configKey: key, configValue: 'x'.repeat(4097) }] },
    {
      configs: [
        { configKey: key, configValue: 'a' },
        { configKey: key.toLowerCase(), configValue: 'b' },
      ],
    },
    { configs: [{ configKey: 'UNMANAGED_KEY', configValue: secret }] },
  ])('rejects invalid bulk input without writes', async (payload) => {
    expect((await request('PUT', '', payload)).statusCode).toBe(400);
    expect(f.unit.upsertConfiguration).not.toHaveBeenCalled();
  });
  it('rejects a foreign Origin and accepts the configured Origin', async () => {
    const result = await fixture.http.inject({
      method: 'PUT',
      url: '/api/v1/sp-api-configs',
      headers: { ...headers, origin: 'https://invalid.example' },
      payload: body,
    });
    expect(result.statusCode).toBe(403);
    expect(f.unit.upsertConfiguration).not.toHaveBeenCalled();
    expect(
      (
        await fixture.http.inject({
          method: 'PUT',
          url: '/api/v1/sp-api-configs',
          headers: { ...headers, origin: fixture.env.CORS_ORIGIN },
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
  });
  it('maps driver failures to a fixed error without returning or logging SQL parameters', async () => {
    vi.mocked(f.repository.transaction).mockRejectedValue(
      new Error(`SELECT configuration secret=${secret}`),
    );
    const result = await request('GET');
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain(secret);
    expect(JSON.stringify(fixture.logger.error.mock.calls)).not.toContain(
      secret,
    );
    expect(fixture.logger.error).toHaveBeenCalledWith(
      'SP-API 配置管理请求失败',
      'SpApiConfigService',
      { operation: 'list', reason: 'configuration_operation_failed' },
    );
  });
  it('fails closed in Legacy authority and prevents the internal source from reading Neo credentials', async () => {
    await fixture.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture-only',
      DB_NAME: 'fixture_71',
    });
    expect((await request('GET')).statusCode).toBe(503);
    expect(f.repository.transaction).not.toHaveBeenCalled();
    await expect(
      fixture.app
        .get(ApplicationSpApiConfigSource)
        .get(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_ERROR' });
    expect(f.repository.readConfiguration).not.toHaveBeenCalled();
  });
  it('the host source reads current stored credentials independently of UI redaction and closes with the module', async () => {
    const source = fixture.app.get(ApplicationSpApiConfigSource);
    const signal = new AbortController().signal;
    expect((await source.get(signal)).regions.US.lwaClientSecret).toBe(secret);
    f.rows.get(key)!.configValue = 'rotated-fixture-secret-71';
    expect((await source.reload(signal)).regions.US.lwaClientSecret).toBe(
      'rotated-fixture-secret-71',
    );
    vi.mocked(f.repository.readConfiguration).mockRejectedValue(
      new Error(secret),
    );
    await expect(source.get(signal)).rejects.toMatchObject({
      code: 'DEPENDENCY_ERROR',
    });
    source.onModuleDestroy();
    await expect(source.get(signal)).rejects.toMatchObject({ code: 'CLOSED' });
  });
});
