import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisCatalogCheckStore } from '../src/catalog-check-store';
import type { CatalogCheckIdentity } from '../src/catalog-checker';
import {
  catalogNotFoundResult,
  decodeCatalogVariantResult,
  parseCatalogVariantResult,
} from '../src/catalog-variants';
import { deferred } from './fixtures';

const identity: CatalogCheckIdentity = {
  asin: 'B000000001',
  country: 'US',
  owner: 'primary',
};
const result = () =>
  parseCatalogVariantResult(
    { asin: identity.asin, summaries: [{ itemName: 'Product' }] },
    identity.asin,
  );
const stores: RedisCatalogCheckStore[] = [];
function setup(timeout = 20) {
  const redis = {
    status: 'ready',
    eval: vi.fn(async (): Promise<unknown> => 1),
  };
  const store = new RedisCatalogCheckStore(redis, 'fixture', timeout);
  stores.push(store);
  return { store, redis };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});
const signal = () => new AbortController().signal;

describe('Catalog persisted-result codec', () => {
  it('round trips complete Catalog, confirmed NOT_FOUND and HTML results with detached JSON', () => {
    const values = [
      result(),
      catalogNotFoundResult(identity.asin, 'US'),
      catalogNotFoundResult(identity.asin, 'US', 'legacy_spapi'),
      { ...result(), meta: { source: 'html_scraper', apiVersion: null } },
    ];
    for (const value of values) {
      const decoded = decodeCatalogVariantResult(value, identity.asin, 'US');
      expect(decoded).toEqual(value);
      expect(decoded).not.toBe(value);
      expect(decoded.details).not.toBe(value.details);
    }
  });
  it.each([
    (value: ReturnType<typeof result>) => ({
      ...value,
      secret: 'unrecognized',
    }),
    (value: ReturnType<typeof result>) => ({ ...value, variantCount: -1 }),
    (value: ReturnType<typeof result>) => ({ ...value, variantCount: 10001 }),
    (value: ReturnType<typeof result>) => ({ ...value, hasVariants: 'false' }),
    (value: ReturnType<typeof result>) => ({
      ...value,
      details: { ...value.details, asin: 'B000000002' },
    }),
    (value: ReturnType<typeof result>) => ({
      ...value,
      details: { ...value.details, country: 'UK' },
    }),
    (value: ReturnType<typeof result>) => ({
      ...value,
      details: { ...value.details, variations: [{ asin: identity.asin }] },
    }),
    (value: ReturnType<typeof result>) => ({
      ...value,
      details: { ...value.details, relationships: [null] },
    }),
    (value: ReturnType<typeof result>) => ({
      ...value,
      details: { ...value.details, parentAsin: false },
    }),
    (value: ReturnType<typeof result>) => ({
      ...value,
      meta: { source: 'other', apiVersion: null },
    }),
    (value: ReturnType<typeof result>) => ({
      ...value,
      meta: { source: 'spapi', apiVersion: null },
    }),
    (value: ReturnType<typeof result>) => ({
      ...value,
      errorType: 'NOT_FOUND',
    }),
    (value: ReturnType<typeof result>) => ({
      ...value,
      details: { ...value.details, notFound: true },
    }),
  ])(
    'rejects corrupt, cross-product and inconsistent persisted data %#',
    (mutate) => {
      expect(() =>
        decodeCatalogVariantResult(mutate(result()), identity.asin, 'US'),
      ).toThrow('INVALID_RESPONSE');
    },
  );
  it('rejects HTML results that pretend to confirm Amazon NOT_FOUND', () => {
    expect(() =>
      decodeCatalogVariantResult(
        {
          ...catalogNotFoundResult(identity.asin, 'US'),
          meta: { source: 'html_scraper', apiVersion: null },
        },
        identity.asin,
        'US',
      ),
    ).toThrow('INVALID_RESPONSE');
  });
});
describe('Bounded Redis catalog adapter', () => {
  it('retains all 64 timed-out wire admissions until the actual calls settle', async () => {
    const f = setup();
    const pending = deferred<unknown>();
    f.redis.eval.mockReturnValue(pending.promise);
    const checks = Promise.allSettled(
      Array.from({ length: 64 }, () => f.store.read(identity, signal())),
    );
    await vi.advanceTimersByTimeAsync(21);
    expect(
      (await checks).every(
        (row) => row.status === 'rejected' && row.reason.code === 'TIMEOUT',
      ),
    ).toBe(true);
    await expect(f.store.read(identity, signal())).rejects.toMatchObject({
      code: 'CAPACITY',
    });
    expect(f.redis.eval).toHaveBeenCalledTimes(64);
    pending.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    f.redis.eval.mockResolvedValue(null);
    await expect(f.store.read(identity, signal())).resolves.toBeUndefined();
    expect(f.redis.eval).toHaveBeenCalledTimes(65);
  });
  it('rejects disconnected Redis without emitting a command', async () => {
    const f = setup();
    f.redis.status = 'reconnecting';
    await expect(f.store.claim(identity, signal())).rejects.toMatchObject({
      code: 'DEPENDENCY_ERROR',
    });
    expect(f.redis.eval).not.toHaveBeenCalled();
  });
  it('cancels only the waiter and prevents reuse of the still-pending admission on close', async () => {
    const f = setup();
    const pending = deferred<unknown>();
    f.redis.eval.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const read = f.store.read(identity, controller.signal);
    const rejected = expect(read).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('secret'));
    await rejected;
    f.store.close();
    await expect(f.store.read(identity, signal())).rejects.toMatchObject({
      code: 'CLOSED',
    });
    pending.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes pending work promptly and removes timers after actual settlement', async () => {
    const f = setup();
    const pending = deferred<unknown>();
    f.redis.eval.mockReturnValue(pending.promise);
    const read = f.store.read(identity, signal());
    const rejected = expect(read).rejects.toMatchObject({ code: 'CLOSED' });
    await vi.advanceTimersByTimeAsync(0);
    f.store.close();
    await rejected;
    pending.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('returns a cache miss for corrupt JSON or a result for a different product', async () => {
    const f = setup();
    for (const raw of [
      'broken',
      JSON.stringify({
        ...result(),
        details: { ...result().details, asin: 'B000000002' },
      }),
    ]) {
      f.redis.eval.mockResolvedValue(raw);
      await expect(f.store.read(identity, signal())).resolves.toBeUndefined();
    }
  });
  it('safely rejects dependency errors and invalid script responses', async () => {
    const f = setup();
    f.redis.eval.mockRejectedValue(new Error('private connection string'));
    await expect(f.store.claim(identity, signal())).rejects.toMatchObject({
      message: 'SP-API DEPENDENCY_ERROR',
    });
    f.redis.eval.mockResolvedValue('unexpected');
    await expect(f.store.claim(identity, signal())).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
  it('validates write identity, size and exact TTL before I/O', async () => {
    const f = setup();
    await expect(
      f.store.write(identity, 'invalid', result(), 600, signal()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.store.write(identity, randomUUID(), result(), 601, signal()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.store.write(
        { ...identity, asin: 'B000000002' },
        randomUUID(),
        result(),
        600,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(f.redis.eval).not.toHaveBeenCalled();
  });
  it('does not persist arbitrary errors in a deferred record or acknowledge capacity refusal', async () => {
    const f = setup();
    const value = {
      ...identity,
      region: 'US' as const,
      error: 'private password',
      deferredAt: 1000,
      retryCount: 0,
    };
    await expect(f.store.defer(value, 3600, signal())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(f.redis.eval).not.toHaveBeenCalled();
    f.redis.eval.mockResolvedValue(0);
    await expect(
      f.store.defer(
        { ...value, error: 'SP-API HTTP_ERROR (403)' },
        3600,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY' });
  });
});
