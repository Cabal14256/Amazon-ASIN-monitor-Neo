import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogDeferredError,
  CatalogVariantChecker,
  type CatalogCheckerOptions,
  type CatalogCheckOptions,
  type CatalogFallback,
} from '../src/catalog-checker';
import {
  parseCatalogVariantResult,
  type CatalogVariantResult,
} from '../src/catalog-variants';
import { SpApiError } from '../src/errors';
import type { HtmlVariantResult } from '../src/html-client';
import { deferred } from './fixtures';

const asin = 'B000000001',
  parent = 'B000000002';
const payload = {
  asin,
  summaries: [{ itemName: 'Fixture title', brand: 'Fixture brand' }],
  relationships: [
    { relationships: [{ type: 'VARIATION', parentAsins: [parent] }] },
  ],
};
const htmlResult: HtmlVariantResult = {
  hasVariants: true,
  variantCount: 1,
  details: {
    asin,
    parentAsin: parent,
    variantAsins: [parent],
    source: 'html_scraper',
    duration: 10,
  },
};
const checkers: CatalogVariantChecker[] = [];
function setup() {
  const events: string[] = [];
  const standard = {
    call: vi.fn<CatalogCheckerOptions['standard']['call']>(async () => {
      events.push('standard');
      return {
        data: payload,
        metadata: {
          region: 'US',
          operation: 'getCatalogItem',
          statusCode: 200,
        },
      };
    }),
  };
  const legacy = {
    call: vi.fn<CatalogCheckerOptions['legacy']['call']>(async () => {
      events.push('legacy');
      return payload;
    }),
  };
  const html = {
    checkVariants: vi.fn(async () => {
      events.push('html');
      return htmlResult;
    }),
  };
  const flags: Record<CatalogFallback, boolean> = {
    ENABLE_LEGACY_CLIENT_FALLBACK: false,
    ENABLE_HTML_SCRAPER_FALLBACK: false,
  };
  const isEnabled = vi.fn(async (key: CatalogFallback) => flags[key]);
  const store = {
    read: vi.fn(
      async (): Promise<CatalogVariantResult | undefined> => undefined,
    ),
    claim: vi.fn(async () => 'claim'),
    write: vi.fn<CatalogCheckerOptions['store']['write']>(
      async () => undefined,
    ),
    defer: vi.fn<CatalogCheckerOptions['store']['defer']>(
      async () => undefined,
    ),
  };
  const risk = { recordCheck: vi.fn() };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const checker = new CatalogVariantChecker({
    standard,
    legacy,
    html,
    isEnabled,
    store,
    risk,
    logger,
  });
  checkers.push(checker);
  return {
    checker,
    standard,
    legacy,
    html,
    isEnabled,
    flags,
    store,
    risk,
    logger,
    events,
  };
}
afterEach(() => {
  for (const checker of checkers.splice(0)) checker.close();
});
const http = (status: number, notFound = false) =>
  new SpApiError('HTTP_ERROR', status, notFound ? ['NOT_FOUND'] : []);

/** Execute the real Legacy service with isolated dependencies, including its
 * actual flag reloads, cache, parser and strict NOT_FOUND classifier. */
async function legacyResult(
  standard: unknown,
  fallback: unknown,
  html: unknown,
  flags: { legacy: boolean; html: boolean },
) {
  const nativeRequire = createRequire(__filename);
  const events: string[] = [];
  const reply = (name: string, value: unknown) => async () => {
    events.push(name);
    if (value instanceof SpApiError)
      throw {
        statusCode: value.statusCode,
        message: value.message,
        responseData: { errors: value.amazonCodes.map((code) => ({ code })) },
      };
    return value;
  };
  const cache = { getAsync: async () => null, setAsync: vi.fn(), set: vi.fn() };
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const dependencies: Record<string, unknown> = {
    '../config/sp-api': {
      callSPAPI: reply('standard', standard),
      getMarketplaceId: () => 'ATVPDKIKX0DER',
    },
    './legacySPAPIClient': { callLegacySPAPI: reply('legacy', fallback) },
    './htmlScraperService': { checkASINVariantsByHTML: reply('html', html) },
    '../models/VariantGroup': {},
    '../models/ASIN': {},
    '../models/MonitorHistory': {},
    './cacheService': cache,
    '../models/SPAPIConfig': {
      findByKey: async (key: string) => ({
        config_value: key.includes('LEGACY') ? flags.legacy : flags.html,
      }),
    },
    './riskControlService': { recordCheck: vi.fn() },
    './rateLimiter': { PRIORITY: { MANUAL: 1, RETRY: 2, SCHEDULED: 3 } },
    './spApiOperationIdentifier': { identifyOperation: () => 'getCatalogItem' },
    './batchVariantCheckService': {},
    '../utils/logger': logger,
    '../utils/variantParser': nativeRequire(
      '../../../server/src/utils/variantParser.js',
    ),
    '../utils/variantStatus': nativeRequire(
      '../../../server/src/utils/variantStatus.js',
    ),
    '../utils/spApiError': nativeRequire(
      '../../../server/src/utils/spApiError.js',
    ),
  };
  const module = {
    exports: {} as {
      doCheckASINVariants(
        asin: string,
        country: string,
        force: boolean,
      ): Promise<unknown>;
      reloadLegacyClientFallbackConfig(): Promise<void>;
      reloadHtmlScraperFallbackConfig(): Promise<void>;
    },
  };
  runInNewContext(
    readFileSync(
      resolve(__dirname, '../../../server/src/services/variantCheckService.js'),
      'utf8',
    ),
    {
      module,
      process: { env: {} },
      Buffer,
      require: (name: string) => {
        if (!(name in dependencies))
          throw new Error('Unexpected Legacy dependency');
        return dependencies[name];
      },
    },
  );
  await module.exports.reloadLegacyClientFallbackConfig();
  await module.exports.reloadHtmlScraperFallbackConfig();
  const result = await module.exports
    .doCheckASINVariants(asin, 'US', true)
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  return { result, events, cache };
}

describe('Shared catalog fetch and parse pipeline', () => {
  const scenarios = [
    { standard: payload, fallback: payload, legacy: true, html: true },
    { standard: { asin }, fallback: payload, legacy: true, html: true },
    { standard: http(404, true), fallback: payload, legacy: true, html: true },
    { standard: http(403), fallback: payload, legacy: true, html: true },
    {
      standard: http(400),
      fallback: http(404, true),
      legacy: true,
      html: true,
    },
    { standard: http(401), fallback: http(500), legacy: true, html: true },
    { standard: http(429), fallback: http(403), legacy: false, html: true },
    { standard: null, fallback: payload, legacy: true, html: false },
    { standard: http(403), fallback: null, legacy: true, html: true },
    { standard: http(403), fallback: http(403), legacy: false, html: false },
    { standard: http(404), fallback: http(404), legacy: true, html: false },
    { standard: http(503), fallback: payload, legacy: true, html: true },
  ];
  it.each(scenarios)(
    'matches actual Legacy result, fallback order and deferred decision %#',
    async (scenario) => {
      const fixture = setup();
      const respond = (name: string, value: unknown) => async () => {
        fixture.events.push(name);
        if (value instanceof SpApiError) throw value;
        return value;
      };
      fixture.standard.call.mockImplementation(async () => ({
        data: await respond('standard', scenario.standard)(),
        metadata: {
          region: 'US',
          operation: 'getCatalogItem',
          statusCode: 200,
        },
      }));
      fixture.legacy.call.mockImplementation(
        respond('legacy', scenario.fallback),
      );
      fixture.flags.ENABLE_LEGACY_CLIENT_FALLBACK = scenario.legacy;
      fixture.flags.ENABLE_HTML_SCRAPER_FALLBACK = scenario.html;
      const old = await legacyResult(
        scenario.standard,
        scenario.fallback,
        htmlResult,
        scenario,
      );
      const current = await fixture.checker
        .check(asin, 'US', { forceRefresh: true })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      expect(fixture.events).toEqual(old.events);
      if ('value' in old.result) {
        expect(current).toEqual(old.result);
        expect(fixture.store.write).toHaveBeenCalledOnce();
        expect(fixture.store.defer).not.toHaveBeenCalled();
      } else {
        expect('error' in current).toBe(true);
        if ('error' in current)
          expect(!!current.error.isDeferred).toBe(
            !!old.result.error.isDeferred,
          );
        expect(fixture.store.defer.mock.calls.length).toBe(
          old.cache.set.mock.calls.length,
        );
        expect(fixture.store.write).not.toHaveBeenCalled();
      }
      expect(fixture.risk.recordCheck).toHaveBeenCalledOnce();
    },
  );
  it('uses the normalized Catalog endpoint, required fields and bounded client retry policy', async () => {
    const f = setup();
    await f.checker.check(` ${asin.toLowerCase()} `, ' us ', {
      priority: 1,
      forceRefresh: true,
    });
    expect(f.standard.call).toHaveBeenCalledWith(
      'GET',
      `/catalog/2022-04-01/items/${asin}`,
      'US',
      {
        marketplaceIds: ['ATVPDKIKX0DER'],
        includedData: ['summaries', 'relationships'],
      },
      null,
      { priority: 1, maxRetries: 3, signal: expect.any(AbortSignal) },
    );
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.store.write).toHaveBeenCalledWith(
      { asin, country: 'US', owner: 'primary' },
      'claim',
      expect.objectContaining({ hasVariants: true }),
      600,
      expect.any(AbortSignal),
    );
  });
  it('returns cached full results without flags, quota calls, claims or writes', async () => {
    const f = setup();
    const cached = parseCatalogVariantResult(payload, asin);
    f.store.read.mockResolvedValue(cached);
    expect(await f.checker.check(asin, 'US')).toEqual(cached);
    expect(f.standard.call).not.toHaveBeenCalled();
    expect(f.isEnabled).not.toHaveBeenCalled();
    expect(f.store.claim).not.toHaveBeenCalled();
    expect(f.store.write).not.toHaveBeenCalled();
    expect(f.risk.recordCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        isRateLimit: false,
        isSpApiError: false,
      }),
    );
  });
  it.each(['read', 'claim', 'write'] as const)(
    'tolerates optional cache %s failure without leaking adapter details',
    async (operation) => {
      const f = setup();
      f.store[operation].mockRejectedValue(new Error('private-password-value'));
      expect(await f.checker.check(asin, 'US')).toMatchObject({
        hasVariants: true,
      });
      expect(f.logger.warn).toHaveBeenCalledWith('变体检查共享缓存不可用', {
        reason: `${operation}_failed`,
      });
      expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain(
        'private-password-value',
      );
      if (operation === 'claim') expect(f.store.write).not.toHaveBeenCalled();
    },
  );
  it('reads current fallback flags on each refresh instead of retaining a startup switch', async () => {
    const f = setup();
    f.standard.call.mockRejectedValue(http(403));
    await expect(
      f.checker.check(asin, 'US', { forceRefresh: true }),
    ).rejects.toBeInstanceOf(CatalogDeferredError);
    f.flags.ENABLE_LEGACY_CLIENT_FALLBACK = true;
    await expect(
      f.checker.check(asin, 'US', { forceRefresh: true }),
    ).resolves.toMatchObject({ hasVariants: true });
    f.flags.ENABLE_LEGACY_CLIENT_FALLBACK = false;
    f.flags.ENABLE_HTML_SCRAPER_FALLBACK = true;
    await expect(
      f.checker.check(asin, 'US', { forceRefresh: true }),
    ).resolves.toMatchObject({ meta: { source: 'html_scraper' } });
    expect(f.legacy.call).toHaveBeenCalledOnce();
    expect(f.html.checkVariants).toHaveBeenCalledOnce();
  });
  it.each([{}, { asin: parent }, { asin, summaries: [{ itemName: {} }] }])(
    'does not hide a malformed successful response behind fallback %#',
    async (data) => {
      const f = setup();
      f.flags.ENABLE_LEGACY_CLIENT_FALLBACK = true;
      f.flags.ENABLE_HTML_SCRAPER_FALLBACK = true;
      f.standard.call.mockResolvedValue({
        data,
        metadata: {
          region: 'US',
          operation: 'getCatalogItem',
          statusCode: 200,
        },
      });
      await expect(f.checker.check(asin, 'US')).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
      expect(f.isEnabled).not.toHaveBeenCalled();
      expect(f.store.defer).not.toHaveBeenCalled();
      expect(f.store.write).not.toHaveBeenCalled();
    },
  );
  it('persists a bounded safe deferred record in the correct region and owner before claiming it was queued', async () => {
    const f = setup();
    const error = http(429);
    error.message = 'private upstream token';
    f.standard.call.mockRejectedValue(error);
    await expect(
      f.checker.check(asin, 'UK', { owner: 'competitor' }),
    ).rejects.toMatchObject({
      isDeferred: true,
      code: 'HTTP_ERROR',
      message: 'ASIN检查失败，已加入延后队列',
    });
    expect(f.store.defer).toHaveBeenCalledWith(
      {
        asin,
        country: 'UK',
        region: 'EU',
        owner: 'competitor',
        error: 'SP-API HTTP_ERROR (429)',
        deferredAt: expect.any(Number),
        retryCount: 0,
      },
      3600,
      expect.any(AbortSignal),
    );
    expect(f.risk.recordCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        isRateLimit: true,
        isSpApiError: false,
      }),
    );
  });
  it('does not falsely acknowledge a failed deferred write', async () => {
    const f = setup();
    f.standard.call.mockRejectedValue(http(403));
    f.store.defer.mockRejectedValue(new Error('private redis error'));
    await expect(f.checker.check(asin, 'US')).rejects.toMatchObject({
      code: 'DEPENDENCY_ERROR',
      message: 'SP-API DEPENDENCY_ERROR',
    });
    expect(f.store.write).not.toHaveBeenCalled();
  });
  it('never uses an HTML 404 as Catalog NOT_FOUND', async () => {
    const f = setup();
    f.standard.call.mockRejectedValue(http(403));
    f.flags.ENABLE_HTML_SCRAPER_FALLBACK = true;
    f.html.checkVariants.mockRejectedValue(http(404));
    await expect(f.checker.check(asin, 'US')).rejects.toMatchObject({
      isDeferred: true,
    });
    expect(f.store.write).not.toHaveBeenCalled();
  });
  it.each([
    'CANCELLED',
    'CLOSED',
    'TIMEOUT',
    'CAPACITY',
    'DEPENDENCY_ERROR',
  ] as const)(
    'does not start another fallback or defer after %s',
    async (code) => {
      const f = setup();
      f.standard.call.mockRejectedValue(http(403));
      f.flags.ENABLE_LEGACY_CLIENT_FALLBACK = true;
      f.flags.ENABLE_HTML_SCRAPER_FALLBACK = true;
      f.legacy.call.mockRejectedValue(new SpApiError(code));
      await expect(f.checker.check(asin, 'US')).rejects.toMatchObject({ code });
      expect(f.html.checkVariants).not.toHaveBeenCalled();
      expect(f.store.defer).not.toHaveBeenCalled();
    },
  );
  it('stops after cancellation during a noncooperative cache read, and never calls upstream later', async () => {
    const f = setup();
    const read = deferred<CatalogVariantResult | undefined>();
    f.store.read.mockReturnValue(read.promise);
    const signal = new AbortController();
    const check = f.checker.check(asin, 'US', { signal: signal.signal });
    const cancelled = expect(check).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await vi.waitFor(() => expect(f.store.read).toHaveBeenCalledOnce());
    signal.abort();
    await cancelled;
    read.resolve(undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.store.claim).not.toHaveBeenCalled();
    expect(f.standard.call).not.toHaveBeenCalled();
  });
  it('deduplicates normalized calls with one risk observation and immutable full results', async () => {
    const f = setup();
    const results = await Promise.all([
      f.checker.check(asin, 'US'),
      f.checker.check(asin.toLowerCase(), 'us'),
    ]);
    expect(f.standard.call).toHaveBeenCalledOnce();
    expect(f.risk.recordCheck).toHaveBeenCalledOnce();
    expect(results[0]).toBe(results[1]);
    expect(
      Object.isFrozen(results[0].details.relationships[0].parentAsins),
    ).toBe(true);
    expect(() => {
      results[0].details.title = 'modified';
    }).toThrow();
  });
  it('separates deduplication by region and owner', async () => {
    const f = setup();
    await Promise.all([
      f.checker.check(asin, 'US'),
      f.checker.check(asin, 'UK'),
      f.checker.check(asin, 'US', { owner: 'competitor' }),
    ]);
    expect(f.standard.call).toHaveBeenCalledTimes(3);
  });
  it.each([
    { asin: '../escape', country: 'US' },
    { asin, country: 'ZZ' },
  ])('rejects bad identity before cache or upstream I/O %#', async (input) => {
    const f = setup();
    await expect(
      f.checker.check(input.asin, input.country),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.store.read).not.toHaveBeenCalled();
  });
  it.each([{ forceRefresh: 'true' }, { priority: 0 }, { owner: 'other' }])(
    'rejects bad options before I/O %#',
    async (options) => {
      const f = setup();
      await expect(
        f.checker.check(asin, 'US', options as CatalogCheckOptions),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(f.store.read).not.toHaveBeenCalled();
    },
  );
});
