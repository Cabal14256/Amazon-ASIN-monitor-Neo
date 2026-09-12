import {
  CatalogDeferredError,
  getMarketplaceId,
  SpApiError,
  type CatalogVariantChecker,
  type SpApiClient,
} from '@asin-monitor/sp-api';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogHybridChecker } from '../src/hybrid';
import { decodeGroupCatalogResult } from '../src/hybrid-result';
import { asin, deferred, flush, product } from './fixtures';

const nativeRequire = createRequire(__filename);
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const item = (index = 1, related = false) => ({
  asin: asin(index).asin,
  relationships: related
    ? [{ relationships: [{ type: 'VARIATION', parentAsins: ['B000000099'] }] }]
    : [],
});
function legacyHybrid(
  response: () => unknown,
  detail: (asin: string) => Promise<unknown>,
) {
  const module = {
    exports: {} as {
      batchCheckASINsHybrid(asins: string[], country: string): Promise<unknown>;
    },
  };
  const deps: Record<string, unknown> = {
    '../config/sp-api': { callSPAPI: async () => response(), getMarketplaceId },
    './rateLimiter': { PRIORITY: { BATCH: 2 } },
    './spApiOperationIdentifier': {
      identifyOperation: () => 'searchCatalogItems',
    },
    '../utils/logger': { info() {}, warn() {}, error() {} },
    '../utils/variantParser': nativeRequire(
      '../../../server/src/utils/variantParser.js',
    ),
    './variantCheckService': { checkASINVariants: detail },
  };
  runInNewContext(
    readFileSync(
      resolve(
        __dirname,
        '../../../server/src/services/batchVariantCheckService.js',
      ),
      'utf8',
    ),
    {
      module,
      require: (name: string) => {
        if (!(name in deps))
          throw new Error('Unexpected Legacy batch dependency');
        return deps[name];
      },
    },
  );
  return module.exports;
}
const live: CatalogHybridChecker[] = [];
function fixture() {
  const call = vi.fn<SpApiClient['call']>(async () => ({
    data: { items: [] },
    metadata: {
      region: 'US',
      operation: 'searchCatalogItems',
      statusCode: 200,
    },
  }));
  const check = vi.fn<CatalogVariantChecker['check']>(async (code) =>
    product(Number(code.slice(1))),
  );
  const logger = { warn: vi.fn() };
  const hybrid = new CatalogHybridChecker({ call }, { check }, logger);
  live.push(hybrid);
  const options = { checkpoint: vi.fn(async (): Promise<void> => undefined) };
  return { call, check, logger, hybrid, options };
}
afterEach(() => {
  for (const value of live.splice(0)) value.close();
  vi.useRealTimers();
});

describe('Catalog hybrid batch / real Legacy business parity and supported Amazon protocol', () => {
  it.each([
    {
      name: 'no variants and missing identifiers',
      input: [1, 2],
      data: { items: [item(1)] },
    },
    {
      name: 'mixed parent, no variants and duplicate input',
      input: [1, 2, 1],
      data: { items: [item(1, true), item(2)] },
    },
    {
      name: 'empty modern relationship is not a search variant',
      input: [1],
      data: {
        items: [
          {
            asin: asin().asin,
            relationships: [{ relationships: [{ type: 'VARIATION' }] }],
          },
        ],
      },
    },
    {
      name: 'summary parent triggers detailed lookup',
      input: [1],
      data: {
        items: [
          { asin: asin().asin, summaries: [{ parentAsin: ' b000000099 ' }] },
        ],
      },
    },
  ])('matches complete Legacy results: $name', async ({ input, data }) => {
    const f = fixture();
    f.call.mockResolvedValue({
      data,
      metadata: {
        region: 'US',
        operation: 'searchCatalogItems',
        statusCode: 200,
      },
    });
    const legacyCheck = vi.fn(async (code: string) =>
      product(Number(code.slice(1))),
    );
    const inputs = input.map((index) => asin(index).asin);
    const expected = await legacyHybrid(
      () => data,
      legacyCheck,
    ).batchCheckASINsHybrid(inputs, 'US');
    expect(json(await f.hybrid.check(inputs, 'US', f.options))).toEqual(
      json(expected),
    );
    expect(f.check.mock.calls.map((args) => args[0])).toEqual(
      legacyCheck.mock.calls.map((args) => args[0]),
    );
  });

  it.each([false, true])(
    'preserves search evidence if the detailed request fails (search failed=%s)',
    async (searchFailed) => {
      const f = fixture();
      const response = () => {
        if (searchFailed) throw new SpApiError('HTTP_ERROR', 503);
        return { items: [item(1, true)] };
      };
      f.call.mockImplementation(async () => ({
        data: response(),
        metadata: {
          region: 'US',
          operation: 'searchCatalogItems',
          statusCode: 200,
        },
      }));
      const failure = new Error('SP-API检查失败');
      const detail = async () => {
        throw failure;
      };
      f.check.mockImplementation(detail);
      const expected = await legacyHybrid(
        response,
        detail,
      ).batchCheckASINsHybrid([asin().asin], 'US');
      expect(
        json(await f.hybrid.check([asin().asin], 'US', f.options)),
      ).toEqual(json(expected));
    },
  );

  it('uses GET with at most 20 CSV identifiers, one marketplace and pageSize 20', async () => {
    const f = fixture();
    const inputs = Array.from({ length: 41 }, (_, i) => asin(i + 1).asin);
    const output = await f.hybrid.check(inputs, 'DE', f.options);
    expect(output).toHaveLength(41);
    expect(f.call).toHaveBeenCalledTimes(3);
    for (const [index, args] of f.call.mock.calls.entries()) {
      expect(args).toEqual([
        'GET',
        '/catalog/2022-04-01/items',
        'DE',
        {
          identifiers: inputs.slice(index * 20, index * 20 + 20).join(','),
          identifiersType: 'ASIN',
          marketplaceIds: getMarketplaceId('DE'),
          includedData: 'summaries,relationships',
          pageSize: 20,
        },
        undefined,
        expect.objectContaining({
          maxRetries: 3,
          priority: 2,
          signal: expect.any(AbortSignal),
        }),
      ]);
    }
    expect(output.every((row) => row.errorType === 'NO_VARIANTS')).toBe(true);
    expect(f.check).not.toHaveBeenCalled();
  });

  it('collects all pages before classifying a missing item and never accepts an unrelated result', async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({
      data: { items: [item(1)], pagination: { nextToken: 'next-page' } },
      metadata: {
        region: 'US',
        operation: 'searchCatalogItems',
        statusCode: 200,
      },
    });
    f.call.mockResolvedValueOnce({
      data: { items: [item(2, true), item(3, true)] },
      metadata: {
        region: 'US',
        operation: 'searchCatalogItems',
        statusCode: 200,
      },
    });
    const output = await f.hybrid.check(
      [asin(1).asin, asin(2).asin],
      'US',
      f.options,
    );
    expect(f.call.mock.calls[1][3]).toMatchObject({ pageToken: 'next-page' });
    expect(output).toMatchObject([{ errorType: 'NO_VARIANTS' }, product(2)]);
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(f.check.mock.calls[0][0]).toBe(asin(2).asin);
  });

  it.each([
    { name: 'missing items', data: {} },
    { name: 'malformed items', data: { items: [null] } },
    {
      name: 'too many items',
      data: { items: Array.from({ length: 21 }, () => item()) },
    },
    { name: 'duplicate item', data: { items: [item(), item()] } },
    { name: 'invalid pagination', data: { items: [], pagination: true } },
    {
      name: 'invalid parent',
      data: {
        items: [
          {
            asin: asin().asin,
            summaries: [{ parentAsin: { token: 'private' } }],
          },
        ],
      },
    },
  ])(
    'falls back to detailed requests when search response is unsafe: $name',
    async ({ data }) => {
      const f = fixture();
      f.call.mockResolvedValue({
        data,
        metadata: {
          region: 'US',
          operation: 'searchCatalogItems',
          statusCode: 200,
        },
      });
      expect(await f.hybrid.check([asin().asin], 'US', f.options)).toEqual([
        product(),
      ]);
      expect(f.logger.warn).toHaveBeenCalledWith(
        '批量目录查询失败，将逐项查询',
        { reason: 'catalog_batch_search_failed', count: 1 },
      );
    },
  );

  it('detects a repeated page token and uses detailed checks instead of incomplete search evidence', async () => {
    const f = fixture();
    f.call.mockResolvedValue({
      data: { items: [], pagination: { nextToken: 'loop' } },
      metadata: {
        region: 'US',
        operation: 'searchCatalogItems',
        statusCode: 200,
      },
    });
    expect(await f.hybrid.check([asin().asin], 'US', f.options)).toEqual([
      product(),
    ]);
    expect(f.call).toHaveBeenCalledTimes(2);
  });

  it('does not reinterpret a task checkpoint failure inside pagination as a recoverable search error', async () => {
    const f = fixture();
    const failure = new Error('Task incarnation changed');
    f.call.mockImplementation(async () => {
      f.options.checkpoint.mockRejectedValue(failure);
      return {
        data: { items: [] },
        metadata: {
          region: 'US',
          operation: 'searchCatalogItems',
          statusCode: 200,
        },
      };
    });
    await expect(f.hybrid.check([asin().asin], 'US', f.options)).rejects.toBe(
      failure,
    );
    expect(f.check).not.toHaveBeenCalled();
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    'CANCELLED',
    'CLOSED',
    'CAPACITY',
    'TIMEOUT',
    'DEPENDENCY_ERROR',
    'INVALID_CONFIG',
  ] as const)(
    'stops on lifecycle failure %s without scheduling detailed fallback',
    async (code) => {
      const f = fixture();
      f.call.mockRejectedValue(new SpApiError(code));
      await expect(
        f.hybrid.check([asin().asin], 'US', f.options),
      ).rejects.toMatchObject({ code });
      expect(f.check).not.toHaveBeenCalled();
    },
  );

  it('keeps a real deferred detailed failure as the Legacy hybrid fallback without leaking its message', async () => {
    const f = fixture();
    f.call.mockResolvedValue({
      data: { items: [item(1, true)] },
      metadata: {
        region: 'US',
        operation: 'searchCatalogItems',
        statusCode: 200,
      },
    });
    const failure = new CatalogDeferredError(new SpApiError('HTTP_ERROR', 503));
    failure.message = 'token=private';
    f.check.mockRejectedValue(failure);
    const output = await f.hybrid.check([asin().asin], 'US', f.options);
    expect(output).toMatchObject([
      {
        hasVariants: true,
        errorType: 'SP_API_ERROR',
        details: {
          source: 'batch_search_fallback',
          errorMessage: 'SP-API检查失败',
        },
      },
    ]);
    expect(JSON.stringify(output)).not.toContain('private');
  });

  it('retains actual admission after cancellation and never schedules late details or progress', async () => {
    const f = fixture();
    const gate = deferred<Awaited<ReturnType<SpApiClient['call']>>>();
    f.call.mockImplementation(() => gate.promise);
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const progress = vi.fn();
    const pending = controllers.map((controller) =>
      f.hybrid
        .check([asin().asin], 'US', {
          ...f.options,
          signal: controller.signal,
          onProgress: progress,
        })
        .catch((error: unknown) => error),
    );
    await flush();
    controllers.forEach((controller) => controller.abort());
    expect(await Promise.all(pending)).toEqual(
      controllers.map(() => expect.objectContaining({ code: 'CANCELLED' })),
    );
    await expect(
      f.hybrid.check([asin().asin], 'US', f.options),
    ).rejects.toMatchObject({ code: 'CAPACITY' });
    gate.resolve({
      data: { items: [item(1, true)] },
      metadata: {
        region: 'US',
        operation: 'searchCatalogItems',
        statusCode: 200,
      },
    });
    await flush();
    expect(f.check).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    f.call.mockResolvedValue({
      data: { items: [] },
      metadata: {
        region: 'US',
        operation: 'searchCatalogItems',
        statusCode: 200,
      },
    });
    await expect(
      f.hybrid.check([asin().asin], 'US', f.options),
    ).resolves.toHaveLength(1);
  });

  it('times out a noncooperative progress callback and dispatches no more details', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const gate = deferred<void>();
    f.call.mockResolvedValue({
      data: { items: [item(1, true), item(2, true)] },
      metadata: {
        region: 'US',
        operation: 'searchCatalogItems',
        statusCode: 200,
      },
    });
    const result = f.hybrid
      .check([asin(1).asin, asin(2).asin], 'US', {
        ...f.options,
        onProgress: () => gate.promise,
      })
      .catch((error: unknown) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(900000);
    expect(await result).toMatchObject({ code: 'TIMEOUT' });
    gate.resolve();
    await flush();
    expect(f.check).toHaveBeenCalledTimes(1);
  });

  it('validates the smaller hybrid codec separately from complete Catalog results', async () => {
    const f = fixture();
    const [value] = await f.hybrid.check([asin().asin], 'US', f.options);
    expect(decodeGroupCatalogResult(value, asin().asin, 'US')).toEqual(value);
    expect(decodeGroupCatalogResult(product(), asin().asin, 'US')).toEqual(
      product(),
    );
    for (const invalid of [
      { ...value, errorType: 'NOT_FOUND' },
      { ...value, hasVariants: true },
      { ...value, asin: asin(2).asin },
      { ...value, token: 'private' },
      { ...value, details: { ...value.details, errorMessage: 'private' } },
      null,
      [],
    ]) {
      expect(() =>
        decodeGroupCatalogResult(invalid, asin().asin, 'US'),
      ).toThrow(SpApiError);
    }
  });
});
