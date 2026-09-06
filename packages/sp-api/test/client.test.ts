import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpApiClient } from '../src/client';
import { isCatalogItemNotFoundError, pause, SpApiError } from '../src/errors';
import type { HttpInput } from '../src/types';
import { deferred, fixture, path, response, tokenResponse } from './fixtures';

const clients: SpApiClient[] = [];
const setup = () => {
  const f = fixture();
  clients.push(f.client);
  return f;
};
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
});

describe('shared client attempts, quota and safe boundaries', () => {
  it('classifies the actual normalized route so dot segments/encoding cannot select default quota', async () => {
    const f = setup();
    await f.client.call(
      'GET',
      '/extra/../catalog/2022-04-01/items/%42000000001',
      'US',
    );
    expect(f.execute.mock.calls[0][0].operation).toBe('getCatalogItem');
    expect(f.transport.request.mock.calls[1][0].url.pathname).toBe(
      '/catalog/2022-04-01/items/%42000000001',
    );
    await expect(f.client.call('GET', '/bad/%ZZ', 'US')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it('requires an explicit quota executor; no unlimited production fallback', () => {
    const f = setup();
    expect(
      () =>
        new SpApiClient({
          config: f.source,
          transport: f.transport,
          logger: f.logger,
          quota: undefined!,
        }),
    ).toThrow('INVALID_CONFIG');
  });
  it('charges and observes each actual response exactly once including the retried 429', async () => {
    const f = setup();
    f.transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        response({ errors: [{ code: 'QuotaExceeded' }] }, 429, {
          'Retry-After': '3',
          'x-amzn-RateLimit-Limit': '2.5',
        }),
      )
      .mockResolvedValueOnce(
        response({ ok: true }, 200, {
          'x-amzn-ratelimit-limit': '4',
          'x-amzn-requestid': 'fixture-id-1',
        }),
      );
    const result = await f.client.call('GET', path, 'DE', {}, undefined, {
      priority: 1,
    });
    expect(result).toEqual({
      data: { ok: true },
      metadata: {
        region: 'EU',
        operation: 'getCatalogItem',
        statusCode: 200,
        rateLimit: 4,
        requestId: 'fixture-id-1',
      },
    });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(
      f.execute.mock.calls.map(([ctx]) => [
        ctx.region,
        ctx.operation,
        ctx.priority,
      ]),
    ).toEqual([
      ['EU', 'getCatalogItem', 1],
      ['EU', 'getCatalogItem', 1],
    ]);
    expect(
      f.observe.mock.calls.map(([m]) => [m.statusCode, m.rateLimit]),
    ).toEqual([
      [429, 2.5],
      [200, 4],
    ]);
    expect(f.sleep).toHaveBeenCalledWith(3000, expect.any(AbortSignal));
    const input = f.transport.request.mock.calls[2][0];
    expect(input.url.origin).toBe('https://sellingpartnerapi-eu.amazon.com');
    expect(input.headers['x-amz-access-token']).toBe('fixture-access-token');
    expect(input.headers['x-amz-date']).toBe('20260905T000000Z');
    expect(input.headers.authorization).toBeUndefined();
  });
  it('caps default retries at five and re-enters the quota executor each time', async () => {
    const f = setup();
    f.transport.request.mockImplementation(async (input) =>
      input.url.hostname === 'api.amazon.com'
        ? tokenResponse()
        : response({}, 429),
    );
    await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(f.execute).toHaveBeenCalledTimes(6);
    expect(f.observe).toHaveBeenCalledTimes(6);
    expect(f.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      2000, 4000, 8000, 16000, 30000,
    ]);
  });
  it.each([401, 404, 500, 502, 503])(
    'does not retry non-quota HTTP %s',
    async (status) => {
      const f = setup();
      f.transport.request
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          response({ errors: [{ code: 'InternalFailure' }] }, status),
        );
      await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
        statusCode: status,
      });
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.observe).toHaveBeenCalledTimes(1);
      expect(f.sleep).not.toHaveBeenCalled();
    },
  );
  it('only returns a terminal NOT_FOUND error with both required signals', async () => {
    const f = setup();
    f.transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        response(
          {
            errors: [
              { code: 'NOT_FOUND', message: 'sensitive supplier payload' },
            ],
          },
          404,
        ),
      );
    const error = await f.client
      .call('GET', path, 'US')
      .catch((error: unknown) => error);
    expect(isCatalogItemNotFoundError(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain('sensitive');
    expect(String(error)).not.toContain('supplier');
  });
  it('retries an explicit quota code even when Amazon uses a non-429 status', async () => {
    const f = setup();
    f.transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        response({ errors: [{ code: 'TooManyRequests' }] }, 400),
      )
      .mockResolvedValueOnce(response());
    await f.client.call('GET', path, 'US');
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it.each(['0', '-1', 'NaN', 'Infinity', '10001', '0.5 secret', ['2', '4']])(
    'ignores unsafe rate metadata %j',
    async (header) => {
      const f = setup();
      f.transport.request
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          response({}, 200, {
            'x-amzn-ratelimit-limit': header,
            'x-amzn-requestid': 'unsafe@email.invalid',
          }),
        );
      const result = await f.client.call('GET', path, 'US');
      expect(result.metadata).not.toHaveProperty('rateLimit');
      expect(result.metadata).not.toHaveProperty('requestId');
    },
  );
  it('does not replay a completed response if quota observation fails', async () => {
    const f = setup();
    f.observe.mockRejectedValue(new Error('fixture-secret'));
    await expect(f.client.call('GET', path, 'US')).resolves.toHaveProperty(
      'data',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).toHaveBeenCalledWith('SP-API 配额观察失败', {
      region: 'US',
      operation: 'getCatalogItem',
    });
  });
  it('rejects malformed successful JSON but observes that response', async () => {
    const f = setup();
    f.transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: '<html>secret</html>',
      });
    await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(f.observe).toHaveBeenCalledTimes(1);
  });
  it('uses bounded operation labels and never logs credentials, URLs or response payloads', async () => {
    const f = setup();
    f.transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(
        new Error('fixture-secret fixture-access-token raw-payload'),
      );
    await expect(
      f.client.call('GET', '/private/customer-123', 'US'),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_ERROR' });
    const logs = JSON.stringify(
      Object.values(f.logger).flatMap((fn) => fn.mock.calls),
    );
    for (const value of [
      'fixture-secret',
      'fixture-access-token',
      'raw-payload',
      'customer-123',
      'refresh',
    ])
      expect(logs).not.toContain(value);
    expect(f.execute.mock.calls[0][0].operation).toBe('default');
  });
  it('sends a stable JSON body with optional AWS credentials and never repeats /api', async () => {
    const f = setup();
    f.config.useAwsSignature = true;
    Object.assign(f.config.regions.US, {
      accessKeyId: 'fixture-key',
      secretAccessKey: 'fixture-signing',
      sessionToken: 'fixture-session',
    });
    await f.client.call(
      'POST',
      '/catalog/2022-04-01/items',
      'US',
      {},
      { identifiers: ['B000000001'] },
    );
    const input = f.transport.request.mock.calls[1][0];
    expect(input.body).toBe('{"identifiers":["B000000001"]}');
    expect(input.headers['content-type']).toBe('application/json');
    expect(input.headers['x-amz-security-token']).toBe('fixture-session');
    expect(input.headers.authorization).toMatch(
      /Credential=fixture-key\/20260905\/us-east-1\/execute-api/,
    );
    expect(input.url.href).not.toContain('/api/api');
  });
  it('rejects invalid methods/options/body before quota or network activity', async () => {
    const f = setup();
    for (const options of [
      { maxRetries: 6 },
      { timeoutMs: 0 },
      { priority: 9 },
      { initialDelayMs: -1 },
    ]) {
      await expect(
        f.client.call('GET', path, 'US', {}, undefined, options as never),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(f.client.call('TRACE', path, 'US')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      f.client.call('POST', path, 'US', {}, 'x'.repeat(1024 * 1024)),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      f.client.call('POST', path, 'US', {}, cyclic),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
  });
});

describe('actual-work cancellation and admission', () => {
  it('never starts HTTP after a cancelled queue entry is eventually dispatched', async () => {
    const f = setup();
    const release = deferred<void>();
    const done = deferred<void>();
    f.execute.mockImplementation(async (_ctx, task) => {
      await release.promise;
      try {
        return await task();
      } finally {
        done.resolve();
      }
    });
    const controller = new AbortController();
    const result = f.client
      .call('GET', path, 'US', {}, undefined, { signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort(new Error('private abort reason'));
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    release.resolve();
    await done.promise;
    expect(f.transport.request).not.toHaveBeenCalled();
  });
  it('cancels the retry delay and does not submit another attempt', async () => {
    const f = setup();
    const sleeping = deferred<void>();
    f.sleep.mockImplementation((ms, signal) => {
      sleeping.resolve();
      return pause(ms, signal);
    });
    f.transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response({}, 429));
    const controller = new AbortController();
    const result = f.client
      .call('GET', path, 'US', {}, undefined, { signal: controller.signal })
      .catch((error: unknown) => error);
    await sleeping.promise;
    controller.abort();
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('retains all 64 slots after caller deadlines if an injected queue ignores cancellation', async () => {
    vi.useFakeTimers();
    const f = setup();
    const gate = deferred<void>();
    f.execute.mockImplementation(async (_ctx, task) => {
      await gate.promise;
      return task();
    });
    const outcomes = Array.from({ length: 64 }, () =>
      f.client
        .call('GET', path, 'US', {}, undefined, { timeoutMs: 10 })
        .catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(
      (await Promise.all(outcomes)).every(
        (error) => error instanceof SpApiError && error.code === 'TIMEOUT',
      ),
    ).toBe(true);
    await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'CAPACITY',
    });
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.client.call('GET', path, 'US')).resolves.toHaveProperty(
      'data',
    );
    expect(f.transport.request).toHaveBeenCalledTimes(2);
  });
  it('close aborts current transport I/O, rejects new calls and does not own the transport', async () => {
    const f = setup();
    const started = deferred<HttpInput>();
    f.transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockImplementationOnce(async (input) => {
        started.resolve(input);
        await pause(60000, input.signal);
        return response();
      });
    const outcome = f.client
      .call('GET', path, 'US')
      .catch((error: unknown) => error);
    const active = await started.promise;
    f.client.close();
    expect(await outcome).toMatchObject({ code: 'CLOSED' });
    expect(active.signal.aborted).toBe(true);
    await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'CLOSED',
    });
    await expect(
      f.transport.request({ ...active, signal: new AbortController().signal }),
    ).resolves.toHaveProperty('statusCode', 200);
  });
});
