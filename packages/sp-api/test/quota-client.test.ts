import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpApiClient } from '../src/client';
import { SpApiQuotaExecutor } from '../src/quota-executor';
import type { QuotaRedisPort } from '../src/quota-redis';
import { QUOTA_ACQUIRE_SCRIPT, QUOTA_PUBLISH_SCRIPT } from '../src/quota-redis';
import { deferred, fixture, path, response, tokenResponse } from './fixtures';

const resources: { client: SpApiClient; quota: SpApiQuotaExecutor }[] = [];
function setup(redis?: QuotaRedisPort) {
  const f = fixture();
  f.client.close();
  const quota = new SpApiQuotaExecutor({
    logger: f.logger,
    redis,
    concurrency: 1,
    redisTimeoutMs: 50,
  });
  const client = new SpApiClient({
    config: f.source,
    transport: f.transport,
    logger: f.logger,
    quota,
  });
  resources.push({ client, quota });
  return { ...f, client, quota };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 7));
});
afterEach(() => {
  for (const { client, quota } of resources.splice(0)) {
    client.close();
    quota.close();
  }
  vi.useRealTimers();
});
describe('Actual shared client with bounded quota executor', () => {
  it('charges each 429 retry separately and waits for operation refill before sending again', async () => {
    const redis = {
      status: 'ready',
      get: vi.fn(async () => null),
      eval: vi.fn(async (script: string) =>
        script === QUOTA_ACQUIRE_SCRIPT ? [1, 0] : 1,
      ),
    };
    const { client, transport } = setup(redis);
    transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        response({ errors: [{ code: 'QuotaExceeded' }] }, 429, {
          'retry-after': '0.001',
          'x-amzn-ratelimit-limit': '2',
        }),
      )
      .mockResolvedValueOnce(
        response({ ok: true }, 200, { 'x-amzn-ratelimit-limit': '2' }),
      );
    const result = client.call('GET', path, 'US', {}, undefined, {
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(transport.request).toHaveBeenCalledTimes(2); // LWA + first Amazon response.
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toMatchObject({ data: { ok: true } });
    const charges = redis.eval.mock.calls.filter(
      ([script]) => script === QUOTA_ACQUIRE_SCRIPT,
    );
    expect(charges).toHaveLength(2);
    expect(
      redis.eval.mock.calls.filter(
        ([script]) => script === QUOTA_PUBLISH_SCRIPT,
      ),
    ).toHaveLength(2);
    expect(transport.request).toHaveBeenCalledTimes(3);
  });
  it('does not delay or replay a successful response when publishing its rate metadata stalls', async () => {
    const write = deferred<unknown>();
    const redis = {
      status: 'ready',
      get: vi.fn(async () => null),
      eval: vi.fn(async (script: string) =>
        script === QUOTA_PUBLISH_SCRIPT ? write.promise : [1, 0],
      ),
    };
    const { client, transport } = setup(redis);
    transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        response({ ok: true }, 200, { 'x-amzn-ratelimit-limit': '1.5' }),
      );
    await expect(client.call('GET', path, 'US')).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(transport.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60);
    write.reject(new Error('fixture secret driver payload'));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.request).toHaveBeenCalledTimes(2);
  });
  it('returns caller cancellation promptly while the actual executor retains the running slot', async () => {
    const { client, transport } = setup();
    const held = deferred<ReturnType<typeof response>>();
    transport.request
      .mockResolvedValueOnce(tokenResponse())
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(response({ second: true }));
    const abort = new AbortController();
    const first = client.call('GET', path, 'US', {}, undefined, {
      signal: abort.signal,
    });
    const rejected = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await rejected;
    const second = client.call('GET', path, 'US');
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.request).toHaveBeenCalledTimes(2);
    held.resolve(response());
    await expect(second).resolves.toMatchObject({ data: { second: true } });
    expect(transport.request).toHaveBeenCalledTimes(3);
  });
});
