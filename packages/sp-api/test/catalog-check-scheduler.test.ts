import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogCheckScheduler,
  type CatalogCheckLimits,
} from '../src/catalog-check-scheduler';
import { deferred } from './fixtures';

const schedulers: CatalogCheckScheduler<number>[] = [];
const setup = (limits: CatalogCheckLimits = {}) => {
  const scheduler = new CatalogCheckScheduler<number>(limits);
  schedulers.push(scheduler);
  return scheduler;
};
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.close();
  vi.useRealTimers();
});
describe('Complete catalog check admission', () => {
  it('does not let newly joined subscribers extend the 15-minute whole-check deadline', async () => {
    const scheduler = setup({ concurrency: 1, timeoutMs: 900000 });
    const upstream = deferred<number>();
    const first = scheduler.run(
      'one',
      3,
      false,
      undefined,
      () => upstream.promise,
    );
    const timeout = expect(first).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(450000);
    const joined = scheduler.run('one', 3, false, undefined, async () => 99);
    const joinedTimeout = expect(joined).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(450001);
    await Promise.all([timeout, joinedTimeout]);
    const start = vi.fn(async () => 2);
    const queued = scheduler.run('two', 3, false, undefined, start);
    await flush();
    expect(start).not.toHaveBeenCalled();
    upstream.resolve(1);
    await expect(queued).resolves.toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('limits actual work, queued work and duplicate waiters independently', async () => {
    const scheduler = setup({ concurrency: 1, maxQueued: 1, maxWaiters: 3 });
    const active = deferred<number>();
    const start = vi.fn(() => active.promise);
    const first = scheduler.run('one', 3, false, undefined, start);
    const duplicate = scheduler.run('one', 3, false, undefined, start);
    const queued = scheduler.run('two', 3, false, undefined, async () => 2);
    await expect(
      scheduler.run('one', 1, false, undefined, start),
    ).rejects.toMatchObject({ code: 'CAPACITY' });
    await flush();
    expect(start).toHaveBeenCalledOnce();
    active.resolve(1);
    await expect(Promise.all([first, duplicate, queued])).resolves.toEqual([
      1, 1, 2,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a new queued identity even when duplicate waiter capacity remains', async () => {
    const scheduler = setup({ concurrency: 1, maxQueued: 0 });
    const active = deferred<number>();
    const first = scheduler.run(
      'one',
      3,
      false,
      undefined,
      () => active.promise,
    );
    await expect(
      scheduler.run('two', 3, false, undefined, async () => 2),
    ).rejects.toMatchObject({ code: 'CAPACITY' });
    const joined = scheduler.run('one', 3, false, undefined, async () => 9);
    active.resolve(1);
    await expect(Promise.all([first, joined])).resolves.toEqual([1, 1]);
  });
  it('keeps another subscriber alive when the first caller disconnects', async () => {
    const scheduler = setup();
    const upstream = deferred<number>();
    const firstSignal = new AbortController();
    let workSignal!: AbortSignal;
    const first = scheduler.run(
      'one',
      3,
      false,
      firstSignal.signal,
      (signal) => {
        workSignal = signal;
        return upstream.promise;
      },
    );
    const rejected = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    const joined = scheduler.run('one', 1, false, undefined, async () => 99);
    await flush();
    firstSignal.abort(new Error('private caller reason'));
    await rejected;
    expect(workSignal.aborted).toBe(false);
    upstream.resolve(7);
    await expect(joined).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('starts per-caller deadlines at admission and retains an ignored-abort work slot until settlement', async () => {
    const scheduler = setup({ concurrency: 1, timeoutMs: 100 });
    const upstream = deferred<number>();
    const later = vi.fn(async () => 2);
    const first = scheduler.run(
      'one',
      3,
      false,
      undefined,
      () => upstream.promise,
    );
    const timeout = expect(first).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(101);
    await timeout;
    const queued = scheduler.run('two', 3, false, undefined, later);
    await flush();
    expect(later).not.toHaveBeenCalled();
    upstream.resolve(1);
    await expect(queued).resolves.toBe(2);
    expect(later).toHaveBeenCalledOnce();
  });
  it('gives a later duplicate its own remaining deadline', async () => {
    const scheduler = setup({ timeoutMs: 100 });
    const upstream = deferred<number>();
    const first = scheduler.run(
      'one',
      3,
      false,
      undefined,
      () => upstream.promise,
    );
    const timeout = expect(first).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(60);
    const joined = scheduler.run('one', 3, false, undefined, async () => 99);
    await vi.advanceTimersByTimeAsync(41);
    await timeout;
    upstream.resolve(3);
    await expect(joined).resolves.toBe(3);
  });
  it('removes cancelled queued work without running it and reclaims its admission', async () => {
    const scheduler = setup({ concurrency: 1, maxQueued: 1 });
    const upstream = deferred<number>();
    const first = scheduler.run(
      'one',
      3,
      false,
      undefined,
      () => upstream.promise,
    );
    const signal = new AbortController();
    const never = vi.fn(async () => 0);
    const queued = scheduler.run('two', 3, false, signal.signal, never);
    const cancelled = expect(queued).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    signal.abort();
    await cancelled;
    const replacement = scheduler.run(
      'three',
      3,
      false,
      undefined,
      async () => 3,
    );
    upstream.resolve(1);
    await expect(Promise.all([first, replacement])).resolves.toEqual([1, 3]);
    expect(never).not.toHaveBeenCalled();
  });
  it('keeps forced refreshes independent and old completion cannot remove the latest deduplication entry', async () => {
    const scheduler = setup();
    const old = deferred<number>(),
      fresh = deferred<number>();
    const first = scheduler.run('one', 3, false, undefined, () => old.promise);
    const refresh = scheduler.run(
      'one',
      1,
      true,
      undefined,
      () => fresh.promise,
    );
    await flush();
    old.resolve(1);
    await expect(first).resolves.toBe(1);
    const joined = scheduler.run('one', 3, false, undefined, async () => 99);
    fresh.resolve(2);
    await expect(Promise.all([refresh, joined])).resolves.toEqual([2, 2]);
  });
  it('honors manual/retry/scheduled ordering and promotes queued duplicates', async () => {
    const scheduler = setup({ concurrency: 1 });
    const upstream = deferred<number>();
    const first = scheduler.run(
      'active',
      3,
      false,
      undefined,
      () => upstream.promise,
    );
    const order: string[] = [];
    const run =
      (key: string) => async (_signal: AbortSignal, priority: number) => {
        order.push(`${key}:${priority}`);
        return 1;
      };
    const scheduled = scheduler.run(
      'scheduled',
      3,
      false,
      undefined,
      run('scheduled'),
    );
    const retry = scheduler.run('retry', 2, false, undefined, run('retry'));
    const promoted = scheduler.run(
      'scheduled',
      1,
      false,
      undefined,
      run('duplicate'),
    );
    const manual = scheduler.run('manual', 1, false, undefined, run('manual'));
    upstream.resolve(1);
    await Promise.all([first, scheduled, retry, promoted, manual]);
    expect(order).toEqual(['scheduled:1', 'manual:1', 'retry:2']);
  });
  it('closes active and queued subscriptions, does not start queued work or accept another call', async () => {
    const scheduler = setup({ concurrency: 1 });
    const upstream = deferred<number>();
    const active = scheduler.run(
      'one',
      3,
      false,
      undefined,
      () => upstream.promise,
    );
    const never = vi.fn(async () => 2);
    const queued = scheduler.run('two', 3, false, undefined, never);
    const settled = Promise.allSettled([active, queued]);
    await flush();
    scheduler.close();
    scheduler.close();
    expect(
      (await settled).map(
        (item) => item.status === 'rejected' && item.reason.code,
      ),
    ).toEqual(['CLOSED', 'CLOSED']);
    await expect(
      scheduler.run('new', 1, false, undefined, never),
    ).rejects.toMatchObject({ code: 'CLOSED' });
    expect(vi.getTimerCount()).toBe(0);
    upstream.resolve(1);
    await flush();
    expect(never).not.toHaveBeenCalled();
  });
  it.each([
    { concurrency: 0 },
    { concurrency: 65 },
    { maxQueued: -1 },
    { maxWaiters: 0 },
    { timeoutMs: 900001 },
  ])('rejects invalid limits %j', (limits) => {
    expect(() => setup(limits)).toThrow('INVALID_CONFIG');
  });
});
