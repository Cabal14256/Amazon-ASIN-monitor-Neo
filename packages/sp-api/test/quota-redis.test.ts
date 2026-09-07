import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_QUOTA_SETTINGS } from '../src/quota-policy';
import { RedisQuotaStore } from '../src/quota-redis';
import { deferred } from './fixtures';

afterEach(() => {
  vi.useRealTimers();
});
function fixture() {
  const redis = {
    status: 'ready',
    get: vi
      .fn<(_key: string) => Promise<string | null>>()
      .mockResolvedValue(null),
    eval: vi.fn().mockResolvedValue([1, 0]),
  };
  const store = new RedisQuotaStore(redis, DEFAULT_QUOTA_SETTINGS, {
    timeoutMs: 50,
    now: () => 1000,
  });
  return { redis, store };
}
describe('Bounded Redis quota transactions', () => {
  it('checks the updated local shadow after metadata GET and before any Redis deduction', async () => {
    const { redis, store } = fixture();
    redis.get.mockResolvedValue(JSON.stringify({ rate: 0.01, burst: 2 }));
    const guard = vi.fn(() => ({ allowed: false, retryMs: 5000 }));
    expect(
      await store.acquire('US', 'getCatalogItem', 'guarded', undefined, guard),
    ).toMatchObject({
      available: true,
      value: { allowed: false, retryMs: 5000, checkedRedis: false },
    });
    expect(guard).toHaveBeenCalledWith({
      rate: 0.01,
      burst: 2,
      updatedAt: undefined,
    });
    expect(redis.eval).not.toHaveBeenCalled();
    store.close();
  });
  it('encodes regional and operation windows in a single compatible Lua deduction', async () => {
    const { redis, store } = fixture();
    const result = await store.acquire(
      'US',
      'getCatalogItem',
      'fixture-request',
    );
    expect(result).toMatchObject({
      available: true,
      value: { allowed: true, retryMs: 0 },
    });
    expect(redis.get).toHaveBeenCalledWith(
      'spapi:ratelimiter:metadata:US:operation:getCatalogItem',
    );
    expect(redis.eval).toHaveBeenCalledOnce();
    const [_script, keyCount, ...payload] = redis.eval.mock.calls[0]!;
    expect(keyCount).toBe(5);
    expect(payload.slice(0, 5)).toEqual([
      'spapi:ratelimiter:US:region:minute',
      'spapi:ratelimiter:US:region:hour',
      'spapi:ratelimiter:US:operation:getCatalogItem:second',
      'spapi:ratelimiter:US:operation:getCatalogItem:minute',
      'spapi:ratelimiter:US:operation:getCatalogItem:hour',
    ]);
    expect(payload.slice(5)).toEqual([
      1000,
      'fixture-request',
      5,
      1,
      45,
      60000,
      120000,
      2700,
      3600000,
      7200000,
      1,
      1000,
      10000,
      90,
      60000,
      120000,
      5400,
      3600000,
      7200000,
    ]);
    store.close();
  });
  it('uses shared response-header metadata for the actual deducted capacities', async () => {
    const { redis, store } = fixture();
    redis.get.mockResolvedValue(
      JSON.stringify({
        rate: 1.5,
        burst: 4,
        source: 'response_header',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    const result = await store.acquire(
      'EU',
      'getCatalogItem',
      'fixture-request',
    );
    if (!result.available) throw new Error('Expected available fixture');
    expect(result.value.windows.map((window) => window.limit)).toEqual([
      45, 2700, 3, 67, 4050,
    ]);
    store.close();
  });
  it('retains one pending command after timeout and prevents a late metadata read from initiating a deduction', async () => {
    vi.useFakeTimers();
    const { redis, store } = fixture();
    const waiting = deferred<string | null>();
    redis.get.mockReturnValueOnce(waiting.promise);
    const first = store.acquire('US', 'getCatalogItem', 'request-one');
    await vi.advanceTimersByTimeAsync(51);
    await expect(first).resolves.toEqual({
      available: false,
      reason: 'timeout',
    });
    for (let i = 0; i < 20; i++)
      await expect(
        store.acquire('US', 'getCatalogItem', `request-${i}`),
      ).resolves.toEqual({ available: false, reason: 'busy' });
    expect(redis.get).toHaveBeenCalledOnce();
    waiting.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.eval).not.toHaveBeenCalled();
    await expect(
      store.acquire('US', 'getCatalogItem', 'after-recovery'),
    ).resolves.toMatchObject({ available: true });
    store.close();
  });
  it('retains admission for an EVAL whose acknowledgement has not arrived', async () => {
    vi.useFakeTimers();
    const { redis, store } = fixture();
    const waiting = deferred<unknown>();
    redis.eval.mockReturnValueOnce(waiting.promise);
    const first = store.acquire('US', 'getCatalogItem', 'request-one');
    await vi.advanceTimersByTimeAsync(51);
    await expect(first).resolves.toEqual({
      available: false,
      reason: 'timeout',
    });
    await expect(
      store.acquire('EU', 'getCatalogItem', 'request-two'),
    ).resolves.toEqual({ available: false, reason: 'busy' });
    waiting.resolve([1, 0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.eval).toHaveBeenCalledOnce();
    store.close();
  });
  it.each(['cancel', 'close'])(
    '%s prevents late Redis mutations and settles the caller promptly',
    async (action) => {
      const { redis, store } = fixture();
      const waiting = deferred<string | null>();
      redis.get.mockReturnValueOnce(waiting.promise);
      const controller = new AbortController();
      const result = store.acquire(
        'US',
        'getCatalogItem',
        'request-one',
        controller.signal,
      );
      await Promise.resolve();
      if (action === 'cancel') controller.abort(new Error('fixture-secret'));
      else store.close();
      await expect(result).resolves.toEqual({
        available: false,
        reason: action === 'cancel' ? 'cancelled' : 'closed',
      });
      waiting.resolve(null);
      await Promise.resolve();
      await Promise.resolve();
      expect(redis.eval).not.toHaveBeenCalled();
      store.close();
    },
  );
  it('does not queue commands on a disconnected connection and sanitizes driver failures', async () => {
    const { redis, store } = fixture();
    redis.status = 'reconnecting';
    await expect(
      store.acquire('US', 'getCatalogItem', 'request-one'),
    ).resolves.toEqual({ available: false, reason: 'not_ready' });
    expect(redis.get).not.toHaveBeenCalled();
    redis.status = 'ready';
    redis.eval.mockRejectedValueOnce(new Error('fixture-redis-secret'));
    await expect(
      store.acquire('US', 'getCatalogItem', 'request-two'),
    ).resolves.toEqual({ available: false, reason: 'dependency' });
    store.close();
  });
  it.each([
    { value: [1, 'bad'] },
    { value: [2, 0] },
    { value: [0, -1] },
    { value: null },
  ])('rejects malformed Redis decisions: %j', async ({ value }) => {
    const { redis, store } = fixture();
    redis.eval.mockResolvedValue(value);
    await expect(
      store.acquire('US', 'getCatalogItem', 'request-one'),
    ).resolves.toEqual({ available: false, reason: 'dependency' });
    store.close();
  });
  it('rejects missing or unsafe request identities before any Redis command', async () => {
    const { redis, store } = fixture();
    for (const id of [undefined, '', 'unsafe member', 'x'.repeat(201)])
      await expect(
        store.acquire('US', 'getCatalogItem', id as string),
      ).rejects.toThrow('SP-API INVALID_INPUT');
    expect(redis.get).not.toHaveBeenCalled();
    store.close();
  });
  it('does not start any work for an already cancelled caller', async () => {
    const { redis, store } = fixture();
    const controller = new AbortController();
    controller.abort(new Error('fixture-private-cancel-reason'));
    await expect(
      store.acquire(
        'US',
        'getCatalogItem',
        'fixture-request',
        controller.signal,
      ),
    ).resolves.toEqual({ available: false, reason: 'cancelled' });
    expect(redis.get).not.toHaveBeenCalled();
    store.close();
  });

  it('uses the same header capacities for an atomic usage snapshot', async () => {
    const { redis, store } = fixture();
    redis.get.mockResolvedValue(
      JSON.stringify({
        rate: 1,
        burst: 3,
        source: 'response_header',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    redis.eval.mockResolvedValue([2, 5, 20]);
    const result = await store.snapshot('US', 'getCatalogItem');
    if (!result.available) throw new Error('Expected available fixture');
    expect(
      result.value.windows.map(({ limit, used, remaining }) => ({
        limit,
        used,
        remaining,
      })),
    ).toEqual([
      { limit: 2, used: 2, remaining: 0 },
      { limit: 45, used: 5, remaining: 40 },
      { limit: 2700, used: 20, remaining: 2680 },
    ]);
    expect(redis.eval.mock.calls[0]?.[1]).toBe(3);
    store.close();
  });
  it('snapshots only shared region windows when no operation is specified', async () => {
    const { redis, store } = fixture();
    redis.eval.mockResolvedValue([46, 100]);
    const result = await store.snapshot('EU');
    if (!result.available) throw new Error('Expected available fixture');
    expect(
      result.value.windows.map(({ used, remaining }) => ({ used, remaining })),
    ).toEqual([
      { used: 46, remaining: 0 },
      { used: 100, remaining: 2600 },
    ]);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.eval.mock.calls[0]?.[1]).toBe(2);
    store.close();
  });
  it('publishes only a bounded Legacy-compatible metadata record with the operation burst', async () => {
    const { redis, store } = fixture();
    redis.eval.mockResolvedValue(1);
    await expect(store.publish('US', 'getCatalogItem', 1.5)).resolves.toEqual({
      available: true,
      value: true,
    });
    const [_script, count, key, value] = redis.eval.mock.calls[0]!;
    expect(count).toBe(1);
    expect(key).toBe('spapi:ratelimiter:metadata:US:operation:getCatalogItem');
    expect(JSON.parse(value)).toEqual({
      rate: 1.5,
      burst: 2,
      source: 'response_header',
      updatedAt: '1970-01-01T00:00:01.000Z',
    });
    store.close();
  });
  it('rejects invalid observations and never exposes a failed publish driver error', async () => {
    const { redis, store } = fixture();
    for (const rate of [0, -1, Infinity, 1_000_001])
      await expect(store.publish('US', 'getCatalogItem', rate)).rejects.toThrow(
        'SP-API INVALID_INPUT',
      );
    expect(redis.eval).not.toHaveBeenCalled();
    redis.eval.mockRejectedValue(new Error('fixture-private-response'));
    await expect(store.publish('US', 'getCatalogItem', 1)).resolves.toEqual({
      available: false,
      reason: 'dependency',
    });
    store.close();
  });
});
