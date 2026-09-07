import {
  SpApiClient,
  SpApiError,
  SpApiErrorStatistics,
  type HttpInput,
  type HttpResponse,
  type QuotaExecutor,
} from '@asin-monitor/sp-api';
import { describe, expect, it, vi } from 'vitest';
import { ObservedSpApiTransport } from '../src/sp-api-runtime/sp-api-observed-transport';

function fixture() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const errors = new SpApiErrorStatistics({ logger });
  const transport = {
    request: vi.fn(
      async (_input: HttpInput): Promise<HttpResponse> => ({
        statusCode: 200,
        body: '{}',
        headers: {},
      }),
    ),
  };
  const observed = new ObservedSpApiTransport(transport, errors);
  const input = (
    origin = 'https://sellingpartnerapi-na.amazon.com',
  ): HttpInput => ({
    url: new URL('/catalog/2022-04-01/items/B000000001', origin),
    method: 'GET',
    headers: { 'x-amz-access-token': 'fixture-private' },
    signal: new AbortController().signal,
  });
  return { logger, errors, transport, observed, input };
}
describe('actual upstream attempt statistics (API instance only)', () => {
  it.each([
    [400, 'INVALID_INPUT'],
    [401, 'AUTH_ERROR'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMIT'],
    [502, 'SERVER_ERROR'],
  ])(
    'records HTTP %i exactly once with only safe data',
    async (status, type) => {
      const f = fixture();
      f.transport.request.mockResolvedValueOnce({
        statusCode: status as number,
        body: '{"message":"fixture-private"}',
        headers: {},
      });
      await f.observed.request(f.input());
      const stats = f.errors.getErrorStats();
      expect(stats.total).toBe(1);
      expect(stats.byType[type].count).toBe(1);
      expect(JSON.stringify(stats)).not.toContain('fixture-private');
      expect(JSON.stringify(stats)).not.toContain('B000000001');
    },
  );
  it('counts EU transport failures and malformed successful JSON, without changing the response/error', async () => {
    const f = fixture(),
      error = new SpApiError('TIMEOUT');
    f.transport.request.mockRejectedValueOnce(error);
    await expect(
      f.observed.request(f.input('https://sellingpartnerapi-eu.amazon.com')),
    ).rejects.toBe(error);
    const response = {
      statusCode: 200,
      body: '<html>fixture-private</html>',
      headers: {},
    };
    f.transport.request.mockResolvedValueOnce(response);
    expect(await f.observed.request(f.input())).toBe(response);
    expect(f.errors.getErrorStats()).toMatchObject({
      total: 2,
      byRegion: { EU: { TIMEOUT: { count: 1 } } },
      byType: { UNKNOWN: { count: 1 } },
    });
  });
  it('does not count LWA, HTML, successful JSON, explicit cancellation or shutdown', async () => {
    const f = fixture();
    f.transport.request.mockResolvedValue({
      statusCode: 500,
      body: 'fixture-private',
      headers: {},
    });
    for (const host of [
      'https://api.amazon.com',
      'https://www.amazon.com',
      'https://sellingpartnerapi-na.amazon.com.evil.invalid',
    ])
      await f.observed.request(f.input(host));
    f.transport.request.mockResolvedValueOnce({
      statusCode: 200,
      body: '{}',
      headers: {},
    });
    await f.observed.request(f.input());
    for (const code of [
      'CANCELLED',
      'CLOSED',
      'CAPACITY',
      'INVALID_INPUT',
      'INVALID_CONFIG',
    ] as const) {
      f.transport.request.mockRejectedValueOnce(new SpApiError(code));
      await expect(f.observed.request(f.input())).rejects.toHaveProperty(
        'code',
        code,
      );
    }
    const abort = new AbortController();
    abort.abort(new SpApiError('CANCELLED'));
    await f.observed.request({ ...f.input(), signal: abort.signal });
    expect(f.errors.getErrorStats().total).toBe(0);
  });
  it('counts an active request deadline as TIMEOUT even when an ignoring dependency returns late', async () => {
    const f = fixture(),
      controller = new AbortController();
    f.transport.request.mockImplementationOnce(async () => {
      controller.abort(new SpApiError('TIMEOUT'));
      return { statusCode: 429, body: '{}', headers: {} };
    });
    await f.observed.request({ ...f.input(), signal: controller.signal });
    expect(f.errors.getErrorStats()).toMatchObject({
      total: 1,
      byType: { TIMEOUT: { count: 1 }, RATE_LIMIT: { count: 0 } },
    });
  });
  it('records one failed attempt for 429 then success, excluding the actual LWA request', async () => {
    const f = fixture();
    const creds = {
      lwaClientId: 'fixture-client',
      lwaClientSecret: 'fixture-secret',
      refreshToken: 'fixture-refresh',
    };
    const config = {
      useAwsSignature: false,
      regions: { US: creds, EU: creds },
    };
    const quota: QuotaExecutor = {
      execute: async (_context, task) => task(),
      observe() {},
    };
    const client = new SpApiClient({
      config: { get: async () => config, reload: async () => config },
      transport: f.observed,
      quota,
      logger: f.logger,
      sleep: async () => {},
    });
    f.transport.request
      .mockResolvedValueOnce({
        statusCode: 200,
        body: JSON.stringify({
          access_token: 'fixture-access',
          token_type: 'bearer',
          expires_in: 3600,
        }),
        headers: {},
      })
      .mockResolvedValueOnce({
        statusCode: 429,
        body: '{"errors":[{"code":"QuotaExceeded"}]}',
        headers: {},
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: '{"asin":"B000000001"}',
        headers: {},
      });
    try {
      await expect(
        client.call(
          'GET',
          '/catalog/2022-04-01/items/B000000001',
          'US',
          {},
          null,
          { maxRetries: 1 },
        ),
      ).resolves.toHaveProperty('data.asin', 'B000000001');
      expect(f.transport.request).toHaveBeenCalledTimes(3);
      expect(f.errors.getErrorStats()).toMatchObject({
        total: 1,
        byType: { RATE_LIMIT: { count: 1 } },
      });
    } finally {
      client.close();
    }
  });
});
