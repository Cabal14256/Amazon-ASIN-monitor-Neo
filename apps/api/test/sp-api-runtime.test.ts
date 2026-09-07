import { type SpApiConfigurationRow } from '@asin-monitor/db';
import {
  SpApiError,
  type HttpInput,
  type HttpResponse,
} from '@asin-monitor/sp-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationSpApiRuntime } from '../src/sp-api-runtime/sp-api-runtime';

const runtimes: ApplicationSpApiRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.onModuleDestroy());
  vi.useRealTimers();
});
function fixture() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const values = new Map<string, string | null>();
  const repository = {
    readConfiguration: vi.fn(
      async (): Promise<SpApiConfigurationRow[]> =>
        [...values].map(([configKey, configValue], index) => ({
          id: index + 1,
          configKey,
          configValue,
          description: null,
          createTime: null,
          updateTime: null,
        })),
    ),
  };
  const credentials = {
    lwaClientId: 'fixture-client',
    lwaClientSecret: 'fixture-secret',
    refreshToken: 'fixture-refresh',
  };
  const config = {
    useAwsSignature: false,
    regions: { US: credentials, EU: credentials },
  };
  const source = {
    get: vi.fn(async () => config),
    reload: vi.fn(async () => config),
  };
  const transport = {
    request: vi.fn(
      async (input: HttpInput): Promise<HttpResponse> => ({
        statusCode: 200,
        body: JSON.stringify(
          input.url.hostname === 'api.amazon.com'
            ? {
                access_token: 'fixture-access',
                token_type: 'bearer',
                expires_in: 3600,
              }
            : { asin: 'B000000001' },
        ),
        headers: {},
      }),
    ),
    close: vi.fn(),
  };
  const htmlTransport = {
    request: vi.fn(
      async (): Promise<HttpResponse> => ({
        statusCode: 200,
        body: '<input id="ASIN" value="B000000001"><span id="productTitle">Fixture product</span>',
        headers: { 'content-type': 'text/html' },
      }),
    ),
    close: vi.fn(),
  };
  const redis = {
    client: {
      status: 'end',
      get: vi.fn(async () => null),
      eval: vi.fn(async () => {
        throw new Error('Redis fixture disconnected');
      }),
    },
    ping: vi.fn(async () => {
      throw new Error('Redis fixture disconnected');
    }),
  };
  const options = {
    env: {
      AUTH_DATA_AUTHORITY: 'postgresql' as const,
      HEALTH_PROBE_TIMEOUT_MS: 500,
    },
    configEnv: {} as Record<string, unknown>,
    quotaEnv: {},
    repository,
    source,
    redis,
    logger,
    transport,
    htmlTransport,
  };
  const runtime = new ApplicationSpApiRuntime(options);
  runtimes.push(runtime);
  return {
    runtime,
    options,
    values,
    repository,
    source,
    transport,
    htmlTransport,
    redis,
    logger,
  };
}
const path = '/catalog/2022-04-01/items/B000000001';
describe('API-owned SP-API runtime composition', () => {
  it('constructs without I/O and exposes a single set of reusable clients/statistics', async () => {
    const f = fixture();
    expect(f.redis.ping).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
    await f.runtime.onModuleInit();
    expect(f.redis.ping).toHaveBeenCalledTimes(1);
    await expect(
      f.runtime.standard.call('GET', path, 'US'),
    ).resolves.toHaveProperty('data.asin', 'B000000001');
    expect(f.source.get).toHaveBeenCalledTimes(1);
    expect(f.runtime.errors.getErrorStats().total).toBe(0);
    expect(await f.runtime.getQuotaStatus('US')).toMatchObject({
      mode: 'memory',
      windows: { minute: { used: expect.any(Number) } },
    });
  });
  it('defaults both fallbacks off before credential/HTTP activity', async () => {
    const f = fixture();
    await expect(
      f.runtime.legacy.call('GET', path, 'US'),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(
      f.runtime.html.checkVariants('B000000001', 'US'),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(f.source.get).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
    expect(f.htmlTransport.request).not.toHaveBeenCalled();
    expect(f.runtime.errors.getErrorStats().total).toBe(0);
  });
  it('reads current database flags on each call with null/missing ENV fallback and explicit empty false', async () => {
    const f = fixture();
    const runtime = new ApplicationSpApiRuntime({
      ...f.options,
      configEnv: {
        ENABLE_HTML_SCRAPER_FALLBACK: '1',
        ENABLE_LEGACY_CLIENT_FALLBACK: 'true',
      },
    });
    runtimes.push(runtime);
    f.values.set('enable_html_scraper_fallback', null);
    await expect(
      runtime.html.checkVariants('B000000001', 'US'),
    ).resolves.toHaveProperty('hasVariants', false);
    f.values.set('enable_html_scraper_fallback', '');
    await expect(
      runtime.html.checkVariants('B000000001', 'US'),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    f.values.set('ENABLE_LEGACY_CLIENT_FALLBACK', '0');
    await expect(runtime.legacy.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    f.values.set('ENABLE_LEGACY_CLIENT_FALLBACK', 'true');
    await expect(runtime.legacy.call('GET', path, 'EU')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      runtime.legacy.call('GET', path, 'DE'),
    ).resolves.toHaveProperty('asin', 'B000000001');
    f.repository.readConfiguration.mockRejectedValueOnce(
      new Error('private-db-payload'),
    );
    await expect(
      runtime.html.checkVariants('B000000001', 'US'),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_ERROR' });
    expect(f.htmlTransport.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(
      'private-db-payload',
    );
  });
  it('records standard/Legacy attempts in the same instance while excluding HTML and logical risk checks', async () => {
    const f = fixture();
    f.values.set('ENABLE_LEGACY_CLIENT_FALLBACK', '1');
    f.values.set('ENABLE_HTML_SCRAPER_FALLBACK', 'true');
    f.transport.request.mockImplementation(async (input) =>
      input.url.hostname === 'api.amazon.com'
        ? {
            statusCode: 200,
            body: '{"access_token":"fixture-access","token_type":"bearer","expires_in":3600}',
            headers: {},
          }
        : { statusCode: 503, body: 'fixture-private', headers: {} },
    );
    await expect(
      f.runtime.standard.call('GET', path, 'US', {}, null, { maxRetries: 0 }),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(
      f.runtime.legacy.call('GET', path, 'DE'),
    ).rejects.toMatchObject({ statusCode: 503 });
    f.htmlTransport.request.mockResolvedValueOnce({
      statusCode: 503,
      body: '',
      headers: {},
    });
    await expect(
      f.runtime.html.checkVariants('B000000001', 'US'),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(f.runtime.errors.getErrorStats()).toMatchObject({
      total: 2,
      byType: { SERVER_ERROR: { count: 2 } },
    });
    expect(f.runtime.risk.getMetrics()).toMatchObject({
      totalRateLimitErrors: 0,
      totalSpApiErrors: 0,
      totalSuccessfulChecks: 0,
    });
  });
  it('stops all owned clients and readiness but leaves injected pools/transports under host ownership', async () => {
    const f = fixture();
    f.runtime.onModuleDestroy();
    await expect(
      f.runtime.standard.call('GET', path, 'US'),
    ).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(
      f.runtime.legacy.call('GET', path, 'US'),
    ).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(
      f.runtime.html.checkVariants('B000000001', 'US'),
    ).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(f.runtime.getQuotaStatus('US')).rejects.toMatchObject({
      code: 'CLOSED',
    });
    expect(f.transport.close).not.toHaveBeenCalled();
    expect(f.htmlTransport.close).not.toHaveBeenCalled();
  });
  it('does not activate requests or Redis when PostgreSQL is not authoritative', async () => {
    const f = fixture();
    const runtime = new ApplicationSpApiRuntime({
      ...f.options,
      env: { ...f.options.env, AUTH_DATA_AUTHORITY: 'legacy-mysql' },
    });
    runtimes.push(runtime);
    await runtime.onModuleInit();
    await expect(
      runtime.standard.call('GET', path, 'US'),
    ).rejects.toBeInstanceOf(SpApiError);
    expect(f.source.get).not.toHaveBeenCalled();
    expect(f.redis.ping).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
  });
});
