import {
  displayFeishuConfiguration,
  FeishuConfigurationError,
  feishuRegion,
  type FeishuConfigurationRepositoryPort,
  type FeishuConfigurationRow,
  type FeishuConfigurationUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuConfigModule } from '../src/feishu-config/feishu-config.module';
import { FEISHU_CONFIGURATION_REPOSITORY } from '../src/feishu-config/feishu-config.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';
import { sessionApp } from './helpers/session-app';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
describe('Feishu configuration / six HTTP endpoints and current settings authorization', () => {
  let f: ReturnType<typeof monitorAnalyticsFixture>,
    app: Awaited<ReturnType<typeof sessionApp>>,
    unit: FeishuConfigurationUnit,
    repository: FeishuConfigurationRepositoryPort,
    records: Map<string, FeishuConfigurationRow>,
    headers: { authorization: string };
  const makeRow = (id: number, country: string): FeishuConfigurationRow => ({
    id,
    country,
    webhookUrl: `https://example.invalid/private-hook-115/${country}`,
    enabled: true,
    createTime: new Date('2026-09-13T00:00:00Z'),
    updateTime: null,
  });
  async function start(env: NodeJS.ProcessEnv = {}) {
    app = await sessionApp(
      f.auth,
      env,
      (builder) =>
        builder
          .overrideProvider(FEISHU_CONFIGURATION_REPOSITORY)
          .useValue(repository),
      [FeishuConfigModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: f.user.id, sessionId: f.session.id },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  }
  const request = (
    method: Method = 'GET',
    path = '',
    body?: unknown,
    auth: Record<string, string> = headers,
  ) =>
    app.http.inject({
      method,
      url: '/api/v1/feishu-configs' + path,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...auth,
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
  const body = {
    country: 'EU',
    webhookUrl: 'https://example.invalid/private-hook-115/updated',
    enabled: false,
  };
  const routes: [Method, string, unknown?][] = [
    ['GET', ''],
    ['GET', '/EU'],
    ['POST', '', body],
    ['PUT', '/US', body],
    ['DELETE', '/US'],
    ['PATCH', '/US/toggle', { enabled: true }],
  ];
  beforeEach(async () => {
    f = monitorAnalyticsFixture();
    f.permissions.splice(
      0,
      f.permissions.length,
      'settings:read',
      'settings:write',
    );
    // A stale route-level permission cache must neither grant nor veto access.
    f.auth.getPermissionCodes.mockResolvedValue([]);
    records = new Map([
      ['eu', makeRow(2, 'EU')],
      ['us', makeRow(1, 'US')],
    ]);
    unit = {
      lockOperator: f.unit.lockOperator,
      lockSession: f.unit.lockSession,
      operatorPermissionCodes: f.unit.operatorPermissionCodes,
      list: vi.fn(async () =>
        [...records.values()].filter((row) =>
          ['US', 'EU'].includes(row.country),
        ),
      ),
      find: vi.fn(async (country) => {
        const row = records.get(feishuRegion(country).trim().toLowerCase());
        return row?.enabled === true ? row : undefined;
      }),
      upsert: vi.fn(async (change) => {
        const key = change.country.trim().toLowerCase(),
          previous = records.get(key);
        const row = {
          ...(previous ?? makeRow(3, change.country)),
          webhookUrl: change.webhookUrl,
          enabled: change.enabled,
        };
        records.set(key, row);
        return row;
      }),
      delete: vi.fn(async (country) => {
        records.delete(country.trim().toLowerCase());
      }),
      toggle: vi.fn(async (country, enabled) => {
        const row = records.get(country.trim().toLowerCase());
        if (row) row.enabled = enabled;
        return unit.find(country);
      }),
    };
    repository = { transaction: vi.fn(async (action) => action(unit)) };
    await start();
  });
  afterEach(async () => {
    await app.app.close();
    vi.restoreAllMocks();
  });
  it.each(routes)(
    'requires authentication before %s %s',
    async (method, path, payload) => {
      const response = await request(method, path, payload, {});
      expect(response.statusCode, response.body).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(repository.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(routes)(
    'rejects missing current settings permission before %s %s',
    async (method, path, payload) => {
      f.permissions.length = 0;
      const response = await request(method, path, payload);
      expect(response.statusCode, response.body).toBe(403);
      expect(
        [unit.list, unit.find, unit.upsert, unit.delete, unit.toggle].every(
          (fn) => vi.mocked(fn).mock.calls.length === 0,
        ),
      ).toBe(true);
    },
  );
  it('returns complete camel/list and snake/detail records with no-store', async () => {
    const list = await request(),
      detail = await request('GET', '/UK');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({
      success: true,
      errorCode: 0,
      data: [...records.values()].map((row) =>
        displayFeishuConfiguration(row, 'camel', true),
      ),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toEqual({
      success: true,
      errorCode: 0,
      data: displayFeishuConfiguration(records.get('eu')!, 'snake', true),
    });
    expect(list.headers['cache-control']).toBe('no-store');
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(unit.lockOperator).toHaveBeenCalledTimes(2);
  });
  it('masks complete webhook values for read-only settings users and denies their writes', async () => {
    f.permissions.splice(0, f.permissions.length, 'settings:read');
    for (const path of ['', '/EU']) {
      const response = await request('GET', path);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('***REDACTED***');
      expect(response.body).not.toContain('private-hook-115');
    }
    expect((await request('POST', '', body)).statusCode).toBe(403);
    expect(unit.upsert).not.toHaveBeenCalled();
  });
  it('returns 200 for POST and ignores PUT path country in favor of body.country', async () => {
    for (const [method, path] of [
      ['POST', ''],
      ['PUT', '/US'],
    ] as const) {
      const response = await request(method, path, body);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        errorCode: 0,
        data: displayFeishuConfiguration(records.get('eu')!, 'camel', true),
      });
      expect(response.json().data.enabled).toBe(0);
      expect(response.json().data.country).toBe('EU');
    }
    expect(unit.upsert).toHaveBeenLastCalledWith(body);
    expect(records.get('us')!.enabled).toBe(true);
  });
  it('keeps write-only settings grant sufficient for a write and its full response', async () => {
    f.permissions.splice(0, f.permissions.length, 'settings:write');
    const response = await request('POST', '', {
      country: 'EU',
      webhookUrl: body.webhookUrl,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      webhookUrl: body.webhookUrl,
      enabled: 1,
    });
    expect((await request()).statusCode).toBe(403);
  });
  it('commits disable before the enabled-only lookup produces the Legacy 404', async () => {
    let committed = false;
    vi.mocked(repository.transaction).mockImplementation(async (action) => {
      const result = await action(unit);
      committed = true;
      return result;
    });
    const response = await request('PATCH', '/US/toggle', { enabled: false });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      success: false,
      errorCode: 404,
      errorMessage: '配置不存在',
    });
    expect(committed).toBe(true);
    expect(records.get('us')!.enabled).toBe(false);
    expect((await request('GET', '/US')).statusCode).toBe(404);
    expect(
      (await request('GET'))
        .json()
        .data.find((row: { country: string }) => row.country === 'US').enabled,
    ).toBe(0);
  });
  it('returns the complete enabled toggle row and keeps delete idempotent without EU mapping', async () => {
    const toggle = await request('PATCH', '/US/toggle', { enabled: 1 });
    expect(toggle.statusCode).toBe(200);
    expect(toggle.json().data).toEqual(
      displayFeishuConfiguration(records.get('us')!, 'snake', true),
    );
    for (let i = 0; i < 2; i++) {
      const result = await request('DELETE', '/UK');
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        success: true,
        errorCode: 0,
        data: '删除成功',
      });
    }
    expect(unit.delete).toHaveBeenLastCalledWith('UK');
    expect(records.has('eu')).toBe(true);
  });
  it.each([
    'account',
    'password',
    'password-expiry',
    'session',
    'session-expiry',
  ])(
    'rechecks current %s state on reads and writes despite stale guard data',
    async (state) => {
      expect((await request()).statusCode).toBe(200);
      if (state === 'account') f.user.status = 'SUSPENDED';
      if (state === 'password') f.user.forcePasswordChange = true;
      if (state === 'password-expiry') f.user.passwordExpiresAt = new Date(0);
      if (state === 'session') f.session.status = 'REVOKED';
      if (state === 'session-expiry') f.session.expiresAt = new Date(0);
      expect((await request()).statusCode).toBe(403);
      expect((await request('POST', '', body)).statusCode).toBe(403);
      expect(unit.list).toHaveBeenCalledTimes(1);
      expect(unit.upsert).not.toHaveBeenCalled();
    },
  );
  it.each(routes.filter(([method]) => method !== 'GET'))(
    'rejects an untrusted origin on %s %s',
    async (method, path, payload) => {
      const response = await request(method, path, payload, {
        ...headers,
        origin: 'https://outside.invalid',
      });
      expect(response.statusCode).toBe(403);
      expect(repository.transaction).not.toHaveBeenCalled();
    },
  );
  it('accepts the configured origin and preserves exact missing-field/toggle messages', async () => {
    expect(
      (
        await request('POST', '', body, {
          ...headers,
          origin: app.env.CORS_ORIGIN,
        })
      ).statusCode,
    ).toBe(200);
    const missing = await request('POST', '', { country: 'US' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().errorMessage).toBe('country 和 webhookUrl 为必填项');
    const invalid = await request('PATCH', '/US/toggle', { enabled: 'false' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().errorMessage).toBe('enabled参数必须是布尔值或0/1');
  });
  it('rejects invalid storage widths/types before changing data', async () => {
    for (const payload of [
      { ...body, webhookUrl: 'x'.repeat(501) },
      { ...body, enabled: null },
      { ...body, country: 'x'.repeat(11) },
      { ...body, webhookUrl: 'private\0payload' },
    ])
      expect((await request('POST', '', payload)).statusCode).toBe(400);
    expect(unit.upsert).not.toHaveBeenCalled();
  });
  it('never logs credentials or driver details after a failed transaction', async () => {
    vi.mocked(repository.transaction).mockRejectedValue(
      new Error(body.webhookUrl),
    );
    const response = await request('POST', '', body);
    expect(response.statusCode).toBe(500);
    expect(
      response.body + JSON.stringify(app.logger.error.mock.calls),
    ).not.toContain('private-hook-115');
    expect(app.logger.info).not.toHaveBeenCalled();
  });
  it('rejects invalid repository output and restores capacity', async () => {
    vi.mocked(unit.list).mockResolvedValueOnce([
      makeRow(1, 'US'),
      makeRow(2, 'EU'),
      makeRow(3, 'US'),
    ]);
    expect((await request()).statusCode).toBe(500);
    expect((await request()).statusCode).toBe(200);
  });
  it('bounds concurrent configuration requests and recovers after completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(unit.list).mockImplementation(async () => {
      await gate;
      return [...records.values()];
    });
    const pending = Array.from({ length: 8 }, () =>
      request().then((value) => value),
    );
    try {
      await vi.waitFor(() => expect(unit.list).toHaveBeenCalledTimes(8));
      expect((await request()).statusCode).toBe(429);
    } finally {
      release();
    }
    expect(
      (await Promise.all(pending)).every(
        (response) => response.statusCode === 200,
      ),
    ).toBe(true);
    expect((await request()).statusCode).toBe(200);
  });
  it('maps repository admission failure to 429 without exposing internal reasons', async () => {
    vi.mocked(repository.transaction).mockRejectedValue(
      new FeishuConfigurationError('capacity'),
    );
    expect((await request()).statusCode).toBe(429);
  });
  it('requires PostgreSQL authority before configuration I/O', async () => {
    await app.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: '',
      DB_NAME: 'fixture',
    });
    expect((await request()).statusCode).toBe(503);
    expect(repository.transaction).not.toHaveBeenCalled();
  });
});
