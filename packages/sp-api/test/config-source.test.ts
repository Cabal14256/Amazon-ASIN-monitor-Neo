import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpApiClient } from '../src/client';
import { DatabaseConfigSource } from '../src/config-source';
import { deferred, fixture, path } from './fixtures';

const sources: DatabaseConfigSource[] = [];
function setup(
  read: ConstructorParameters<typeof DatabaseConfigSource>[1],
  options: ConstructorParameters<typeof DatabaseConfigSource>[2] = {},
) {
  const env = {
    SP_API_LWA_CLIENT_ID: 'fixture-env-id',
    SP_API_LWA_CLIENT_SECRET: 'fixture-env-secret',
    SP_API_REFRESH_TOKEN: 'fixture-env-token',
    SP_API_USE_AWS_SIGNATURE: 'true',
  };
  const source = new DatabaseConfigSource(env, read, options);
  sources.push(source);
  return { source, env };
}
afterEach(() => {
  for (const source of sources.splice(0)) source.close();
  vi.useRealTimers();
});
describe('Bounded database configuration source', () => {
  it('rotating committed credentials obtains a new LWA token without reusing the old token identity', async () => {
    const read = vi.fn(async () => ({
      SP_API_LWA_CLIENT_SECRET: 'first-fixture-secret',
      SP_API_USE_AWS_SIGNATURE: false,
    }));
    const { source } = setup(read);
    const f = fixture();
    f.client.close();
    const client = new SpApiClient({
      config: source,
      transport: f.transport,
      quota: f.quota,
      logger: f.logger,
    });
    try {
      await client.call('GET', path, 'US');
      read.mockResolvedValue({
        SP_API_LWA_CLIENT_SECRET: 'second-fixture-secret',
        SP_API_USE_AWS_SIGNATURE: false,
      });
      await client.call('GET', path, 'US');
      const tokenCalls = f.transport.request.mock.calls
        .map(([input]) => input)
        .filter((input) => input.url.hostname === 'api.amazon.com');
      expect(
        tokenCalls.map((input) =>
          new URLSearchParams(input.body).get('client_secret'),
        ),
      ).toEqual(['first-fixture-secret', 'second-fixture-secret']);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      client.close();
    }
  });
  it('a database failure prevents an actual Amazon attempt even when the client has a cached LWA token', async () => {
    const read = vi.fn(async () => ({ SP_API_USE_AWS_SIGNATURE: false }));
    const { source } = setup(read);
    const f = fixture();
    f.client.close();
    const client = new SpApiClient({
      config: source,
      transport: f.transport,
      quota: f.quota,
      logger: f.logger,
    });
    try {
      await client.call('GET', path, 'US');
      const count = f.transport.request.mock.calls.length;
      read.mockRejectedValue(new Error('fixture-private-database-failure'));
      await expect(client.call('GET', path, 'US')).rejects.toMatchObject({
        code: 'DEPENDENCY_ERROR',
      });
      expect(f.transport.request).toHaveBeenCalledTimes(count);
    } finally {
      client.close();
    }
  });
  it('reads each committed snapshot afresh, preserves DB/ENV priority and freezes returned credentials', async () => {
    const read = vi.fn(async () => ({
      SP_API_US_LWA_CLIENT_ID: 'fixture-db-us',
      SP_API_REFRESH_TOKEN: 'fixture-db-token',
      SP_API_USE_AWS_SIGNATURE: '',
    }));
    const { source, env } = setup(read);
    env.SP_API_LWA_CLIENT_ID = 'changed-env-after-start';
    const first = await source.get(new AbortController().signal);
    expect(first.regions.US.lwaClientId).toBe('fixture-db-us');
    expect(first.regions.EU.lwaClientId).toBe('fixture-env-id');
    expect(first.regions.EU.refreshToken).toBe('fixture-db-token');
    expect(first.useAwsSignature).toBe(false);
    expect(Object.isFrozen(first.regions.US)).toBe(true);
    read.mockResolvedValue({
      SP_API_US_LWA_CLIENT_ID: 'fixture-new-us',
      SP_API_REFRESH_TOKEN: 'fixture-new-token',
      SP_API_USE_AWS_SIGNATURE: 'true',
    });
    expect(
      (await source.reload(new AbortController().signal)).regions.US
        .refreshToken,
    ).toBe('fixture-new-token');
    expect(
      (await source.get(new AbortController().signal)).regions.US.lwaClientId,
    ).toBe('fixture-new-us');
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('does not silently fall back to ENV or a previous snapshot after a database error', async () => {
    const read = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({});
    const { source } = setup(read);
    await source.get(new AbortController().signal);
    read.mockRejectedValue(new Error('fixture database password payload'));
    await expect(
      source.get(new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_ERROR',
      message: 'SP-API DEPENDENCY_ERROR',
    });
  });
  it('returns cancellation promptly but retains admission until an ignoring reader actually settles', async () => {
    const pending = deferred<Record<string, unknown>>();
    const read = vi.fn((_signal: AbortSignal) => pending.promise);
    const { source } = setup(read, { maxActive: 1 });
    const abort = new AbortController();
    const first = source.get(abort.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await Promise.resolve();
    abort.abort();
    await rejected;
    expect(read.mock.calls[0]![0].aborted).toBe(true);
    await expect(
      source.get(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CAPACITY' });
    pending.resolve({});
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      source.get(new AbortController().signal),
    ).resolves.toMatchObject({ useAwsSignature: true });
  });
  it('cancelling one read does not abort another independent read', async () => {
    const pending = deferred<Record<string, unknown>>();
    const read = vi.fn((_signal: AbortSignal) => pending.promise);
    const { source } = setup(read);
    const a = new AbortController();
    const first = source.get(a.signal);
    const second = source.get(new AbortController().signal);
    const rejected = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await Promise.resolve();
    a.abort();
    await rejected;
    expect(read.mock.calls[1]![0].aborted).toBe(false);
    pending.resolve({});
    await expect(second).resolves.toMatchObject({ useAwsSignature: true });
  });
  it('bounds timeout without accumulating new reads behind a stuck dependency', async () => {
    vi.useFakeTimers();
    const pending = deferred<Record<string, unknown>>();
    const read = vi.fn(() => pending.promise);
    const { source } = setup(read, { timeoutMs: 50, maxActive: 1 });
    const rejected = expect(
      source.get(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    await expect(
      source.get(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(read).toHaveBeenCalledOnce();
    pending.resolve({});
    await vi.advanceTimersByTimeAsync(0);
  });
  it('pre-aborted reads and closed sources never start new database work', async () => {
    const read = vi.fn(async () => ({}));
    const { source } = setup(read);
    const aborted = new AbortController();
    aborted.abort();
    await expect(source.get(aborted.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    source.close();
    await expect(
      source.reload(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CLOSED' });
    expect(read).not.toHaveBeenCalled();
  });
  it('closing cancels current reads and rejects a late successful snapshot', async () => {
    const pending = deferred<Record<string, unknown>>();
    const { source } = setup(() => pending.promise);
    const rejected = expect(
      source.get(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CLOSED' });
    source.close();
    await rejected;
    pending.resolve({});
  });
  it.each([
    { maxActive: 0 },
    { maxActive: 65 },
    { timeoutMs: Infinity },
    { timeoutMs: 0 },
  ])('rejects unbounded options %j', (options) => {
    expect(() => setup(async () => ({}), options)).toThrow('INVALID_CONFIG');
  });
});
