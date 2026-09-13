import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogVariantChecker } from '../src/catalog-checker';
import {
  parseCatalogVariantResult,
  type CatalogVariantResult,
} from '../src/catalog-variants';
import {
  CatalogParentQuery,
  MAX_PARENT_QUERY_ITEMS,
} from '../src/parent-query';
import { legacyService } from './catalog-legacy-fixture';
import { deferred } from './fixtures';

const first = 'B000000001',
  second = 'B000000002',
  parent = 'B000000003',
  independent = 'B000000004';
const payload = (asin: string) => ({
  asin,
  summaries: [{ itemName: `Title ${asin}`, brand: 'Fixture brand' }],
  relationships:
    asin === independent
      ? []
      : [
          {
            relationships: [
              {
                type: 'VARIATION',
                ...(asin === parent
                  ? { childAsins: [first, second] }
                  : { parentAsins: [parent] }),
              },
            ],
          },
        ],
});
const queries: CatalogParentQuery[] = [];
function setup(concurrency = 5) {
  const checker = {
    check: vi.fn<CatalogVariantChecker['check']>(async (asin) =>
      parseCatalogVariantResult(payload(asin), asin),
    ),
  };
  const query = new CatalogParentQuery(checker, concurrency);
  queries.push(query);
  return { query, checker };
}
afterEach(() => {
  for (const query of queries.splice(0)) query.close();
  vi.useRealTimers();
});

describe('Two-pass parent ASIN query', () => {
  it.each(
    [
      [first, second],
      [parent, first, second],
      [first, parent, second],
      [independent],
      [first, first, second],
      [` ${first.toLowerCase()} `, 'invalid', independent],
    ].map((input) => ({ input })),
  )(
    'matches complete actual Legacy results, ordering, duplicates and parent-title scheduling %#',
    async ({ input }) => {
      const f = setup();
      const old = legacyService(payload);
      const previous = await old.service.batchQueryParentAsin(input, 'US');
      const current = await f.query.query(input, 'US');
      expect(current).toEqual(previous);
      // The actual Legacy cache fixture misses, exposing parent-title fetch order.
      expect(f.checker.check.mock.calls.map(([asin]) => asin)).toEqual(
        old.call.mock.calls.map(([, path]) => path.split('/').at(-1)),
      );
    },
  );
  it('forces manual first-pass checks and performs one cache-eligible lookup per parent', async () => {
    const f = setup();
    const progress = vi.fn();
    await f.query.query([first, first, second], ' us ', {
      onProgress: progress,
    });
    expect(f.checker.check).toHaveBeenCalledTimes(4);
    expect(
      f.checker.check.mock.calls.map(([, country, options]) => ({
        country,
        force: options?.forceRefresh,
        priority: options?.priority,
      })),
    ).toEqual([
      { country: 'US', force: true, priority: 1 },
      { country: 'US', force: true, priority: 1 },
      { country: 'US', force: true, priority: 1 },
      { country: 'US', force: false, priority: 1 },
    ]);
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
  it('retains a failed item without exposing dependency details or discarding successful siblings', async () => {
    const f = setup();
    f.checker.check.mockImplementation(async (asin) => {
      if (asin === second) throw new Error('private upstream secret');
      return parseCatalogVariantResult(payload(asin), asin);
    });
    const result = await f.query.query([first, second, independent], 'US');
    expect(result.map((item) => item.asin)).toEqual([
      first,
      second,
      independent,
    ]);
    expect(result[0]).toMatchObject({
      error: null,
      parentTitle: `Title ${parent}`,
    });
    expect(result[1]).toMatchObject({
      error: 'ASIN查询失败，请稍后重试',
      parentAsin: null,
    });
    expect(result[2]).toMatchObject({ error: null, hasVariants: false });
    expect(JSON.stringify(result)).not.toContain('private upstream secret');
  });
  it('keeps child relationships when the optional parent-title lookup fails', async () => {
    const f = setup();
    f.checker.check.mockImplementation(async (asin) => {
      if (asin === parent) throw new Error('fixture unavailable');
      return parseCatalogVariantResult(payload(asin), asin);
    });
    const result = await f.query.query([first, second], 'US');
    expect(
      result.every(
        (item) =>
          item.parentAsin === parent &&
          item.parentTitle === '' &&
          item.error === null,
      ),
    ).toBe(true);
  });
  it('uses first occurrence semantics when a parent is itself one of the inputs', async () => {
    const f = setup();
    f.checker.check.mockImplementation(async (asin, _country, options) => {
      const value = parseCatalogVariantResult(payload(asin), asin);
      value.details.title = options?.forceRefresh
        ? 'First pass'
        : 'Parent lookup';
      return value;
    });
    expect(
      (await f.query.query([parent, first], 'US')).map(
        (item) => item.parentTitle,
      ),
    ).toEqual(['First pass', 'First pass']);
    expect(
      (await f.query.query([first, parent], 'US')).map(
        (item) => item.parentTitle,
      ),
    ).toEqual(['Parent lookup', 'Parent lookup']);
  });
  it('bounds actual first-pass work and serializes progress writes while preserving input order', async () => {
    const f = setup(2);
    const a = deferred<CatalogVariantResult>(),
      b = deferred<CatalogVariantResult>();
    f.checker.check
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise);
    const report = deferred<void>();
    const progress = vi.fn().mockImplementationOnce(() => report.promise);
    const query = f.query.query([first, second, independent], 'US', {
      onProgress: progress,
    });
    await vi.waitFor(() => expect(f.checker.check).toHaveBeenCalledTimes(2));
    b.resolve(parseCatalogVariantResult(payload(second), second));
    await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
    a.resolve(parseCatalogVariantResult(payload(first), first));
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.checker.check).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledOnce();
    report.resolve();
    const values = await query;
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(values.map((item) => item.asin)).toEqual([
      first,
      second,
      independent,
    ]);
  });
  it('stops queued items and parent lookups after cancellation without releasing noncooperative work early', async () => {
    const f = setup(1);
    const pending = deferred<CatalogVariantResult>();
    f.checker.check.mockReturnValue(pending.promise);
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const queries = controllers.map((controller) =>
      f.query.query([first, second], 'US', { signal: controller.signal }),
    );
    const settled = Promise.allSettled(queries);
    await vi.waitFor(() => expect(f.checker.check).toHaveBeenCalledTimes(4));
    controllers.forEach((controller) => controller.abort());
    expect(
      (await settled).every(
        (item) =>
          item.status === 'rejected' && item.reason.code === 'CANCELLED',
      ),
    ).toBe(true);
    await expect(f.query.query([first], 'US')).rejects.toMatchObject({
      code: 'CAPACITY',
    });
    pending.resolve(parseCatalogVariantResult(payload(first), first));
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.checker.check).toHaveBeenCalledTimes(4);
  });
  it('fails the whole query on a failed progress callback and starts no new items', async () => {
    const f = setup(1);
    await expect(
      f.query.query([first, second], 'US', {
        onProgress: async () => {
          throw new Error('private registry connection');
        },
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_ERROR' });
    expect(f.checker.check).toHaveBeenCalledOnce();
  });
  it('counts repeated parent titles against the output byte cap before retaining the parent map', async () => {
    const f = setup();
    f.checker.check.mockImplementation(async (asin) => {
      const result = parseCatalogVariantResult(payload(asin), asin);
      if (asin === parent) result.details.title = 'x'.repeat(7 * 1024 * 1024);
      return result;
    });
    await expect(
      f.query.query(Array(5).fill(first), 'US'),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });
  it('bounds the whole-query deadline and rejects new calls after close', async () => {
    vi.useFakeTimers();
    const f = setup();
    const pending = deferred<CatalogVariantResult>();
    f.checker.check.mockReturnValue(pending.promise);
    const query = f.query.query([first], 'US');
    const rejected = expect(query).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(900001);
    await rejected;
    f.query.close();
    await expect(f.query.query([first], 'US')).rejects.toMatchObject({
      code: 'CLOSED',
    });
    pending.resolve(parseCatalogVariantResult(payload(first), first));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { input: [], code: 'INVALID_INPUT' },
    { input: ['invalid'], code: 'INVALID_INPUT' },
    {
      input: Array(MAX_PARENT_QUERY_ITEMS + 1).fill(first),
      code: 'BODY_TOO_LARGE',
    },
  ])(
    'rejects empty, all-invalid or excessive batches before upstream I/O %#',
    async ({ input, code }) => {
      const f = setup();
      await expect(f.query.query(input, 'US')).rejects.toMatchObject({ code });
      expect(f.checker.check).not.toHaveBeenCalled();
    },
  );
});
