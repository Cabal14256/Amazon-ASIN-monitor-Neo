import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpApiError } from '../src/errors';
import { SpApiQuotaExecutor } from '../src/quota-executor';
import { DEFAULT_QUOTA_SETTINGS } from '../src/quota-policy';
import type { AttemptContext } from '../src/types';
import { deferred } from './fixtures';

const executors: SpApiQuotaExecutor[] = [];
const context = (overrides: Partial<AttemptContext> = {}): AttemptContext => ({
  region: 'US',
  operation: 'getCatalogItem',
  priority: 2,
  signal: new AbortController().signal,
  ...overrides,
});
function setup(
  options: ConstructorParameters<typeof SpApiQuotaExecutor>[0] = {
    logger: logger(),
  },
) {
  const executor = new SpApiQuotaExecutor(options);
  executors.push(executor);
  return executor;
}
function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  for (const executor of executors.splice(0)) executor.close();
  vi.useRealTimers();
});

describe('SP-API bounded priority executor', () => {
  it('retains one stalled Redis admission while later groups use bounded fallback after the real timeout', async () => {
    const read = deferred<string | null>();
    const redis = {
      status: 'ready',
      get: vi.fn(() => read.promise),
      eval: vi.fn(async () => [1, 0]),
    };
    const log = logger();
    const executor = setup({ logger: log, redis, redisTimeoutMs: 20 });
    const first = executor.execute(context(), async () => 1);
    await vi.advanceTimersByTimeAsync(21);
    await expect(first).resolves.toBe(1);
    await expect(
      executor.execute(
        context({ operation: 'searchCatalogItems' }),
        async () => 2,
      ),
    ).resolves.toBe(2);
    await expect(
      executor.execute(context({ region: 'EU' }), async () => 3),
    ).resolves.toBe(3);
    expect(redis.get).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
    read.resolve(null);
    await flush();
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it('does not charge Redis when freshly read metadata makes existing local debt exceed the new capacity', async () => {
    const redis = {
      status: 'ready',
      get: vi.fn(async () => JSON.stringify({ rate: 2, burst: 10 })),
      eval: vi.fn(async () => [1, 0]),
    };
    const executor = setup({ logger: logger(), redis, maxWaitMs: 50 });
    for (let i = 0; i < 3; i++)
      await executor.execute(context(), async () => i);
    redis.get.mockResolvedValue(JSON.stringify({ rate: 0.01, burst: 2 }));
    const task = vi.fn(async () => 4);
    const rejected = expect(
      executor.execute(context(), task),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(redis.get).toHaveBeenCalledTimes(4);
    expect(redis.eval).toHaveBeenCalledTimes(3);
    expect(task).not.toHaveBeenCalled();
  });
  it('runs manual before scheduled before batch and preserves FIFO within a priority', async () => {
    const executor = setup({ logger: logger(), concurrency: 1 });
    const held = deferred<void>();
    const order: string[] = [];
    const first = executor.execute(context(), () => held.promise);
    await flush();
    const jobs = [
      ['batch', 3],
      ['scheduled', 2],
      ['manual-a', 1],
      ['manual-b', 1],
    ] as const;
    const promises = jobs.map(([label, priority]) =>
      executor.execute(context({ priority }), async () => {
        order.push(label);
      }),
    );
    held.resolve();
    await first;
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(promises);
    expect(order).toEqual(['manual-a', 'manual-b', 'scheduled', 'batch']);
  });
  it('keeps an exhausted operation from blocking other operations or regions', async () => {
    const executor = setup();
    await executor.execute(context(), async () => 1);
    const blocked = vi.fn(async () => 2);
    const pending = executor.execute(context(), blocked);
    const other = executor.execute(
      context({ operation: 'searchCatalogItems' }),
      async () => 3,
    );
    const eu = executor.execute(context({ region: 'EU' }), async () => 4);
    await expect(other).resolves.toBe(3);
    await expect(eu).resolves.toBe(4);
    expect(blocked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    await expect(pending).resolves.toBe(2);
  });
  it('bounds waiting work and rejects queued cancellation without invoking its task', async () => {
    const executor = setup({ logger: logger(), maxPending: 1, concurrency: 1 });
    const held = deferred<void>();
    const running = executor.execute(context(), () => held.promise);
    await flush();
    const abort = new AbortController();
    const task = vi.fn(async () => 1);
    const waiting = executor.execute(context({ signal: abort.signal }), task);
    const cancelled = expect(waiting).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await expect(executor.execute(context(), task)).rejects.toMatchObject({
      code: 'CAPACITY',
    });
    abort.abort();
    await cancelled;
    expect(task).not.toHaveBeenCalled();
    held.resolve();
    await running;
  });
  it('times out queue admission even when the wall clock moves backwards', async () => {
    const executor = setup({ logger: logger(), maxWaitMs: 50, concurrency: 1 });
    const held = deferred<void>();
    const running = executor.execute(context(), () => held.promise);
    await flush();
    const task = vi.fn(async () => 1);
    const waiting = executor.execute(context(), task);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'TIMEOUT' });
    vi.setSystemTime(0);
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(task).not.toHaveBeenCalled();
    held.resolve();
    await running;
  });
  it('does not settle a running cancellation or release its slot until actual work ends', async () => {
    const executor = setup({ logger: logger(), concurrency: 1 });
    const abort = new AbortController();
    const held = deferred<void>();
    const first = executor.execute(
      context({ signal: abort.signal }),
      () => held.promise,
    );
    let settled = false;
    void first.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    abort.abort();
    const task = vi.fn(async () => 2);
    const second = executor.execute(context(), task);
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    expect(task).not.toHaveBeenCalled();
    held.resolve();
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(second).resolves.toBe(2);
    expect(task).toHaveBeenCalledOnce();
  });
  it('closes queued work immediately but awaits running work and rejects future submissions', async () => {
    const executor = setup({ logger: logger(), concurrency: 1 });
    const held = deferred<void>();
    const running = executor.execute(context(), () => held.promise);
    const rejectedRunning = expect(running).rejects.toMatchObject({
      code: 'CLOSED',
    });
    await flush();
    const task = vi.fn(async () => 1);
    const waiting = executor.execute(context(), task);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'CLOSED' });
    executor.close();
    await rejected;
    await expect(executor.execute(context(), task)).rejects.toMatchObject({
      code: 'CLOSED',
    });
    held.resolve();
    await rejectedRunning;
    expect(task).not.toHaveBeenCalled();
  });
  it('never replays a failed task and preserves safe HTTP errors for the client retry policy', async () => {
    const executor = setup();
    const error = new SpApiError('HTTP_ERROR', 429, ['QuotaExceeded']);
    const task = vi.fn(async () => {
      throw error;
    });
    await expect(executor.execute(context(), task)).rejects.toBe(error);
    expect(task).toHaveBeenCalledOnce();
    await expect(
      executor.execute(context({ region: 'EU' }), async () => {
        throw new Error('fixture-secret');
      }),
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_ERROR',
      message: 'SP-API DEPENDENCY_ERROR',
    });
  });
  it('does not refill local consumption on Redis failure or recovery', async () => {
    const redis = {
      status: 'ready',
      get: vi.fn(async () => null),
      eval: vi.fn(async () => [1, 0]),
    };
    const log = logger();
    const executor = setup({
      logger: log,
      redis,
      settings: {
        ...DEFAULT_QUOTA_SETTINGS,
        regionPerMinute: 2,
        regionPerHour: 100,
      },
      maxWaitMs: 60_000,
    });
    await executor.execute(context(), async () => 1);
    redis.status = 'reconnecting';
    await executor.execute(
      context({ operation: 'searchCatalogItems' }),
      async () => 2,
    );
    redis.status = 'ready';
    const task = vi.fn(async () => 3);
    const third = executor.execute(context({ operation: 'default' }), task);
    await flush();
    expect(task).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_100);
    expect(task).toHaveBeenCalledOnce();
    await expect(third).resolves.toBe(3);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
  it('cancels a stalled metadata lookup before it can launch a late charge or task', async () => {
    const waiting = deferred<string | null>();
    const redis = {
      status: 'ready',
      get: vi.fn(() => waiting.promise),
      eval: vi.fn(async () => [1, 0]),
    };
    const executor = setup({ logger: logger(), redis });
    const abort = new AbortController();
    const task = vi.fn(async () => 1);
    const pending = executor.execute(context({ signal: abort.signal }), task);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await flush();
    abort.abort();
    await rejected;
    waiting.resolve(null);
    await flush();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
  });
  it.each([
    { maxPending: 0 },
    { maxPending: 1001 },
    { maxWaitMs: Infinity },
    { concurrency: 3 as 1 },
  ])('rejects unbounded configuration %j', (options) => {
    expect(() => setup({ logger: logger(), ...options })).toThrow(
      'INVALID_CONFIG',
    );
  });
  it('validates operation and priority before reserving queue capacity', async () => {
    const executor = setup();
    await expect(
      executor.execute(context({ operation: 'constructor' }), async () => 1),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      executor.execute(context({ priority: 0 as 1 }), async () => 1),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('reports effective memory windows and keeps consumed debt after lower and higher header observations', async () => {
    const executor = setup();
    await executor.execute(context(), async () => 1);
    executor.observe({
      region: 'US',
      operation: 'getCatalogItem',
      statusCode: 200,
      rateLimit: 0.01,
    });
    const lower = await executor.snapshot('US', 'getCatalogItem');
    expect(lower).toMatchObject({
      mode: 'memory',
      redisAvailable: false,
      name: 'US:operation:getCatalogItem',
      secondTokens: 0,
      minuteTokens: 0,
      limits: { second: 1, minute: 1, hour: 27 },
      limitSource: 'response_header',
      limitUpdatedAt: '1970-01-01T00:00:01.000Z',
      windows: { minute: { used: 1, remaining: 0, limit: 1, windowMs: 60000 } },
    });
    executor.observe({
      region: 'US',
      operation: 'getCatalogItem',
      statusCode: 200,
      rateLimit: 2,
    });
    expect(await executor.snapshot('US', 'getCatalogItem')).toMatchObject({
      minuteTokens: 89,
      hourTokens: 5399,
    });
    expect(await executor.snapshot('US')).toMatchObject({
      name: 'US:region',
      secondTokens: null,
      minuteTokens: 44,
      hourTokens: 2699,
      limits: { second: null, minute: 45, hour: 2700 },
      limitSource: 'default',
    });
  });
  it('coalesces observations to one in-flight write and one latest record without delaying task completion', async () => {
    const write = deferred<number>();
    const redis = {
      status: 'ready',
      get: vi.fn(async () => null),
      eval: vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue(1),
    };
    const executor = setup({ logger: logger(), redis });
    executor.observe({
      region: 'US',
      operation: 'getCatalogItem',
      statusCode: 200,
      rateLimit: 1,
    });
    await flush();
    vi.setSystemTime(2000);
    for (let i = 2; i <= 100; i++)
      executor.observe({
        region: 'US',
        operation: 'getCatalogItem',
        statusCode: 200,
        rateLimit: i,
      });
    await flush();
    expect(redis.eval).toHaveBeenCalledOnce();
    write.resolve(1);
    await flush();
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(JSON.parse(redis.eval.mock.calls[1]![3] as string)).toEqual({
      rate: 100,
      burst: 2,
      source: 'response_header',
      updatedAt: '1970-01-01T00:00:02.000Z',
    });
  });
  it('keeps a newer local header when Redis still holds an older observation and checks it before Lua', async () => {
    const redis = {
      status: 'ready',
      get: vi.fn(async () =>
        JSON.stringify({
          rate: 2,
          burst: 2,
          updatedAt: '1970-01-01T00:00:00.000Z',
        }),
      ),
      eval: vi.fn().mockResolvedValue([1, 0]),
    };
    const executor = setup({ logger: logger(), redis, maxWaitMs: 50 });
    await executor.execute(context(), async () => 1);
    redis.eval.mockResolvedValue(1);
    executor.observe({
      region: 'US',
      operation: 'getCatalogItem',
      statusCode: 200,
      rateLimit: 0.01,
    });
    await flush();
    redis.eval.mockClear();
    const task = vi.fn(async () => 2);
    const rejected = expect(
      executor.execute(context(), task),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(task).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it('uses the stricter local shadow in a Redis snapshot after a memory fallback', async () => {
    const redis = {
      status: 'reconnecting',
      get: vi.fn(async () => null),
      eval: vi.fn().mockResolvedValue([0, 0]),
    };
    const executor = setup({ logger: logger(), redis });
    await executor.execute(context(), async () => 1);
    redis.status = 'ready';
    expect(await executor.snapshot('US')).toMatchObject({
      mode: 'redis-distributed',
      lastMode: 'memory',
      redisAvailable: true,
      minuteTokens: 44,
      hourTokens: 2699,
      windows: { minute: { used: 1, remaining: 44, limit: 45 } },
    });
  });
  it('does not bypass a healthy Redis admission slot still occupied by cancelled underlying work', async () => {
    const read = deferred<string | null>();
    const redis = {
      status: 'ready',
      get: vi.fn(() => read.promise),
      eval: vi.fn(async () => [1, 0]),
    };
    const executor = setup({ logger: logger(), redis, maxWaitMs: 50 });
    const abort = new AbortController();
    const first = executor.execute(
      context({ signal: abort.signal }),
      async () => 1,
    );
    const rejectedFirst = expect(first).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await flush();
    abort.abort();
    await rejectedFirst;
    const task = vi.fn(async () => 2);
    const rejected = expect(
      executor.execute(context({ region: 'EU' }), task),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(task).not.toHaveBeenCalled();
    expect(redis.get).toHaveBeenCalledOnce();
    read.resolve(null);
    await flush();
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it('falls back once after a timed-out EVAL and never reruns the task on a late acknowledgement', async () => {
    const charge = deferred<number[]>();
    const redis = {
      status: 'ready',
      get: vi.fn(async () => null),
      eval: vi.fn(() => charge.promise),
    };
    const log = logger();
    const executor = setup({ logger: log, redis, redisTimeoutMs: 20 });
    const task = vi.fn(async () => 7);
    const pending = executor.execute(context(), task);
    await vi.advanceTimersByTimeAsync(21);
    await expect(pending).resolves.toBe(7);
    charge.resolve([1, 0]);
    await flush();
    expect(task).toHaveBeenCalledOnce();
    expect(redis.eval).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith('SP-API 配额降级为进程内存', {
      reason: 'timeout',
    });
  });
  it('preserves Legacy catalog concurrency two and default concurrency one even with high observed rates', async () => {
    const executor = setup({
      logger: logger(),
      settings: { ...DEFAULT_QUOTA_SETTINGS, safetyFactor: 1 },
    });
    const held = deferred<void>();
    const task = vi.fn(() => held.promise);
    const catalog = [1, 2, 3].map(() => executor.execute(context(), task));
    const defaultTask = vi.fn(() => held.promise);
    executor.observe({
      region: 'EU',
      operation: 'default',
      statusCode: 200,
      rateLimit: 100,
    });
    const defaults = [1, 2].map(() =>
      executor.execute(
        context({ region: 'EU', operation: 'default' }),
        defaultTask,
      ),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(defaultTask).toHaveBeenCalledOnce();
    held.resolve();
    await Promise.all([...catalog, ...defaults]);
  });
});
