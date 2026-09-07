import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpApiClient } from '../src/client';
import { isCatalogItemNotFoundError } from '../src/errors';
import { buildLegacyAmazonUrl, LegacySpApiClient } from '../src/legacy-client';
import { SpApiQuotaExecutor } from '../src/quota-executor';
import {
  getMarketplaceId,
  getRegionByCountry,
  identifyOperation,
  REGION_SETTINGS,
} from '../src/request';
import type {
  HttpInput,
  HttpResponse,
  QuotaExecutor,
  SpApiConfig,
} from '../src/types';
import { deferred, response, tokenResponse } from './fixtures';

const asin = 'B000000001',
  path = `/catalog/2022-04-01/items/${asin}`;
const clients: LegacySpApiClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
  vi.useRealTimers();
});
function fixture() {
  const config: SpApiConfig = {
    useAwsSignature: true,
    regions: {
      US: {
        lwaClientId: 'fixture-client',
        lwaClientSecret: 'fixture-secret',
        refreshToken: 'fixture-refresh',
      },
      EU: {
        lwaClientId: 'fixture-eu-client',
        lwaClientSecret: 'fixture-eu-secret',
        refreshToken: 'fixture-eu-refresh',
      },
    },
  };
  const source = {
    get: vi.fn(async () => config),
    reload: vi.fn(async () => config),
  };
  const transport = {
    request: vi.fn(
      async (input: HttpInput): Promise<HttpResponse> =>
        input.url.hostname === 'api.amazon.com'
          ? tokenResponse()
          : response({ asin }),
    ),
    close: vi.fn(),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const execute = vi.fn(
    async (_context: unknown, task: () => Promise<unknown>) => task(),
  );
  const quota: QuotaExecutor = {
    execute: <T>(context: unknown, task: () => Promise<T>) =>
      execute(context, task) as Promise<T>,
    observe: vi.fn(),
  };
  const isEnabled = vi.fn(async () => true);
  const options = { config: source, transport, logger, quota, isEnabled };
  const client = new LegacySpApiClient(options);
  clients.push(client);
  return {
    client,
    options,
    config,
    source,
    transport,
    logger,
    execute,
    quota,
    isEnabled,
  };
}
function actualLegacy() {
  const f = fixture();
  const captured: {
    hostname: string;
    path: string;
    method: string;
    headers: Record<string, string>;
  }[] = [];
  const acquire = vi.fn(async () => {}),
    schedule = vi.fn(async (task: () => Promise<unknown>, _options: unknown) =>
      task(),
    );
  const module = {
    exports: {} as {
      callLegacySPAPI(
        method: string,
        path: string,
        country: string,
        query?: object,
        body?: unknown,
        options?: object,
      ): Promise<unknown>;
    },
  };
  runInNewContext(
    readFileSync(
      resolve(__dirname, '../../../server/src/services/legacySPAPIClient.js'),
      'utf8',
    ),
    {
      module,
      URL,
      require(name: string) {
        if (name === 'https')
          return {
            request(
              options: (typeof captured)[number],
              callback: (res: EventEmitter & { statusCode: number }) => void,
            ) {
              captured.push(options);
              const req = new EventEmitter() as EventEmitter & {
                write(value: string): void;
                end(): void;
              };
              req.write = () => {};
              req.end = () => {
                const res = Object.assign(new EventEmitter(), {
                  statusCode: 200,
                });
                callback(res);
                res.emit('data', JSON.stringify({ asin }));
                res.emit('end');
              };
              return req;
            },
          };
        if (name === '../config/sp-api')
          return {
            getAccessToken: async () => 'fixture-access-token',
            getMarketplaceId,
            getRegionByCountry,
            SP_API_CONFIG: {
              regionConfigs: f.config.regions,
              endpoints: {
                US: REGION_SETTINGS.US.endpoint,
                EU: REGION_SETTINGS.EU.endpoint,
              },
            },
          };
        if (name === '../utils/logger') return f.logger;
        if (name === './rateLimiter')
          return { PRIORITY: { SCHEDULED: 2 }, acquire };
        if (name === './spApiScheduler') return { schedule };
        if (name === './spApiOperationIdentifier') return { identifyOperation };
        throw new Error('Unexpected Legacy client fixture dependency');
      },
    },
  );
  return {
    ...f,
    legacy: module.exports.callLegacySPAPI,
    captured,
    acquire,
    schedule,
  };
}
describe('shared Legacy fallback / actual Legacy HTTP behavior', () => {
  it.each(['US', 'UK', 'DE', 'FR', 'IT', 'ES'])(
    'preserves %s endpoint, repeated query keys, simplified headers and priority',
    async (country) => {
      const f = actualLegacy();
      const query = {
        includedData: ['summaries', 'relationships'],
        marketplaceIds: [getMarketplaceId(country)],
      };
      const old = await f.legacy('GET', path, country, query, null, {
        priority: 1,
      });
      expect(
        await f.client.call('GET', path, country, query, null, { priority: 1 }),
      ).toEqual(old);
      const input = f.transport.request.mock.calls.find(
        ([input]) => input.url.hostname !== 'api.amazon.com',
      )![0];
      expect(input.url.hostname).toBe(f.captured[0].hostname);
      expect(input.url.pathname + input.url.search).toBe(f.captured[0].path);
      expect(input.headers).toEqual(f.captured[0].headers);
      expect(f.execute.mock.calls[0][0]).toMatchObject({
        region: getRegionByCountry(country),
        operation: 'getCatalogItem',
        priority: 1,
      });
      expect(f.acquire).toHaveBeenCalledWith(
        getRegionByCountry(country),
        1,
        1,
        'getCatalogItem',
      );
    },
  );
  it('keeps a prebuilt query and ignores an additional query just as Legacy did', async () => {
    const f = actualLegacy();
    const route = `${path}?includedData=summaries&includedData=relationships`;
    await f.legacy('GET', route, 'US', { ignored: 'value' });
    const url = buildLegacyAmazonUrl('US', route, { ignored: 'value' });
    expect(url.pathname + url.search).toBe(f.captured[0].path);
  });
  it('defaults disabled and requires an explicitly current true flag before credentials or token I/O', async () => {
    const f = fixture();
    const client = new LegacySpApiClient({
      ...f.options,
      isEnabled: undefined,
    });
    clients.push(client);
    await expect(client.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    expect(f.source.get).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('never signs even with AWS enabled and keys available; does not mutate the configured source', async () => {
    const f = fixture();
    Object.assign(f.config.regions.US, {
      accessKeyId: 'fixture-aws',
      secretAccessKey: 'fixture-signing',
      sessionToken: 'fixture-session',
    });
    await f.client.call(
      'POST',
      '/catalog/2022-04-01/items',
      'US',
      {},
      { identifiers: [asin] },
    );
    const request = f.transport.request.mock.calls[1][0];
    expect(request.headers).toEqual({
      'x-amz-access-token': 'fixture-access-token',
      'user-agent': 'Amazon-ASIN-Monitor/1.0 (Language=Node.js)',
      'content-type': 'application/json',
    });
    expect(JSON.parse(request.body!)).toEqual({ identifiers: [asin] });
    expect(f.config.useAwsSignature).toBe(true);
    expect(f.config.regions.US.sessionToken).toBe('fixture-session');
    expect(JSON.stringify(f.logger.debug.mock.calls)).not.toContain('fixture-');
  });
  it('uses the shared quota once per Catalog attempt, does not retry 429, and observes safe metadata', async () => {
    const f = fixture();
    f.transport.request.mockImplementation(async (input) =>
      input.url.hostname === 'api.amazon.com'
        ? tokenResponse()
        : response({ errors: [{ code: 'QuotaExceeded' }] }, 429, {
            'x-amzn-ratelimit-limit': '0.5',
          }),
    );
    await expect(
      f.client.call('GET', path, 'US', {}, null, { maxRetries: 5 } as never),
    ).rejects.toMatchObject({
      statusCode: 429,
      amazonCodes: ['QuotaExceeded'],
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.transport.request).toHaveBeenCalledTimes(2);
    expect(f.quota.observe).toHaveBeenCalledWith({
      region: 'US',
      operation: 'getCatalogItem',
      statusCode: 429,
      rateLimit: 0.5,
    });
  });
  it('keeps strict 404+NOT_FOUND and rejects HTML success bodies without raw payload leaks', async () => {
    const f = fixture();
    f.transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        response({ errors: [{ code: 'NOT_FOUND' }] }, 404),
      );
    const error = await f.client
      .call('GET', path, 'US')
      .catch((error) => error);
    expect(isCatalogItemNotFoundError(error)).toBe(true);
    f.transport.request.mockResolvedValueOnce({
      ...response(),
      body: '<html>fixture-private</html>',
    });
    await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'SP-API INVALID_RESPONSE',
    });
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(
      'fixture-private',
    );
  });
  it('rereads enable/config on cached-token calls and does not use stale values after a read fails', async () => {
    const f = fixture();
    await f.client.call('GET', path, 'US');
    f.isEnabled.mockResolvedValueOnce(false);
    await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    f.source.get.mockRejectedValueOnce(new Error('private-database-error'));
    await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'DEPENDENCY_ERROR',
    });
    expect(f.transport.request).toHaveBeenCalledTimes(2);
    expect(f.isEnabled).toHaveBeenCalledTimes(3);
  });
  it('rotates configuration through the shared one-time LWA 401 recovery', async () => {
    const f = fixture();
    const updated: SpApiConfig = {
      ...f.config,
      regions: {
        ...f.config.regions,
        US: { ...f.config.regions.US, refreshToken: 'fixture-rotated' },
      },
    };
    f.source.reload.mockResolvedValueOnce(updated);
    f.transport.request
      .mockResolvedValueOnce(response({ error: 'invalid_client' }, 401))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response({ asin }));
    await expect(f.client.call('GET', path, 'US')).resolves.toEqual({ asin });
    expect(f.source.reload).toHaveBeenCalledTimes(1);
    expect(
      new URLSearchParams(f.transport.request.mock.calls[1][0].body).get(
        'refresh_token',
      ),
    ).toBe('fixture-rotated');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('cancels a waiting enable read before any credential or HTTP work', async () => {
    const f = fixture(),
      began = deferred<void>(),
      pending = deferred<boolean>();
    f.isEnabled.mockImplementationOnce(async () => {
      began.resolve();
      return pending.promise;
    });
    const controller = new AbortController();
    const outcome = f.client
      .call('GET', path, 'US', {}, null, { signal: controller.signal })
      .catch((error) => error);
    await began.promise;
    controller.abort();
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    pending.resolve(true);
    await vi.waitFor(() => expect(f.source.get).not.toHaveBeenCalled());
    expect(f.transport.request).not.toHaveBeenCalled();
  });
  it('bounds query keys, values, array entries and URL size while preventing parameter injection', () => {
    const url = buildLegacyAmazonUrl('US', path, {
      'a&token': ' x + y ',
      includedData: ['summaries', 'relationships'],
    });
    expect(url.searchParams.get('a&token')).toBe(' x + y ');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.getAll('includedData')).toEqual([
      'summaries',
      'relationships',
    ]);
    for (const query of [
      null,
      [],
      { a: {} },
      { a: Infinity },
      { a: 'x'.repeat(4097) },
      { a: Array(257).fill('x') },
      Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [`key${i}`, 'x']),
      ),
      { a: Array(8).fill('x'.repeat(4096)) },
    ])
      expect(() => buildLegacyAmazonUrl('US', path, query as never)).toThrow(
        'INVALID_INPUT',
      );
    for (const route of ['//example.invalid/', '/x#secret', '/x\\private'])
      expect(() => buildLegacyAmazonUrl('US', route)).toThrow('INVALID_INPUT');
  });
  it('closes its own client while preserving caller-owned transport and configuration', async () => {
    const f = fixture();
    f.client.close();
    f.client.close();
    await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'CLOSED',
    });
    expect(f.transport.close).not.toHaveBeenCalled();
    expect(f.source.get).not.toHaveBeenCalled();
  });
  it('retains all 64 admissions after caller cancellation until ignoring flag readers actually settle', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = deferred<boolean>(),
      allBegan = deferred<void>();
    let active = 0;
    f.isEnabled.mockImplementation(async () => {
      if (++active === 64) allBegan.resolve();
      return pending.promise;
    });
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const outcomes = controllers.map((controller) =>
      f.client
        .call('GET', path, 'US', {}, null, { signal: controller.signal })
        .catch((error) => error),
    );
    await allBegan.promise;
    controllers.forEach((controller) => controller.abort());
    for (const error of await Promise.all(outcomes))
      expect(error).toMatchObject({ code: 'CANCELLED' });
    await expect(f.client.call('GET', path, 'US')).rejects.toMatchObject({
      code: 'CAPACITY',
    });
    expect(f.execute).not.toHaveBeenCalled();
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.source.get).not.toHaveBeenCalled();
    f.isEnabled.mockResolvedValue(true);
    await expect(f.client.call('GET', path, 'US')).resolves.toEqual({ asin });
  });
  it('includes a stalled flag reader in the call deadline and discards late enablement', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      began = deferred<void>(),
      pending = deferred<boolean>();
    f.isEnabled.mockImplementationOnce(async () => {
      began.resolve();
      return pending.promise;
    });
    const outcome = f.client
      .call('GET', path, 'US', {}, null, { timeoutMs: 100 })
      .catch((error) => error);
    await began.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ code: 'TIMEOUT' });
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
  });
  it('shares real executor windows with the standard client and charges neither disabled calls nor LWA refreshes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.config.useAwsSignature = false;
    const quota = new SpApiQuotaExecutor({ logger: f.logger });
    const standard = new SpApiClient({ ...f.options, quota });
    const legacy = new LegacySpApiClient({ ...f.options, quota });
    clients.push(legacy);
    try {
      const first = standard.call('GET', path, 'US');
      const second = legacy.call('GET', path, 'US');
      await vi.advanceTimersByTimeAsync(0);
      expect(f.transport.request).toHaveBeenCalledTimes(2); // One LWA + one Catalog.
      expect(await quota.snapshot('US', 'getCatalogItem')).toMatchObject({
        windows: { minute: { used: 1 } },
      });
      await vi.advanceTimersByTimeAsync(600);
      expect(f.transport.request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toHaveProperty('data.asin', asin);
      await expect(second).resolves.toEqual({ asin });
      const beforeDisabled = await quota.snapshot('US', 'getCatalogItem');
      expect(f.transport.request).toHaveBeenCalledTimes(4);
      expect(
        f.transport.request.mock.calls.filter(
          ([input]) => input.url.hostname === 'api.amazon.com',
        ),
      ).toHaveLength(2);
      f.isEnabled.mockResolvedValue(false);
      await expect(legacy.call('GET', path, 'US')).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
      });
      expect(await quota.snapshot('US', 'getCatalogItem')).toEqual(
        beforeDisabled,
      );
    } finally {
      standard.close();
      legacy.close();
      quota.close();
    }
  });
});
