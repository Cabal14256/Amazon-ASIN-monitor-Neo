import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  PG_PERMISSION_GENERATION_KEY,
  PostgresPermissionCache,
} from '../src/auth/postgres-permission-cache';
import type { AppLogger } from '../src/logger/app-logger.service';
import type { ApplicationRedisClient } from '../src/redis/redis.service';

const schema = z.array(z.string());
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const values = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      values.set(key, value);
    }),
    eval: vi.fn(async () => {
      const next = Number(values.get(PG_PERMISSION_GENERATION_KEY) ?? '0') + 1;
      values.set(PG_PERMISSION_GENERATION_KEY, String(next));
      return next;
    }),
  };
  const logger = { warn: vi.fn() };
  const cache = () =>
    new PostgresPermissionCache(
      redis as unknown as ApplicationRedisClient,
      logger as unknown as AppLogger,
      2,
    );
  return { values, redis, logger, cache };
}
afterEach(() => vi.restoreAllMocks());

describe('PostgreSQL permission cache generation', () => {
  it('isolates PostgreSQL data from Legacy keys and validates cached payloads', async () => {
    const f = fixture();
    const cache = f.cache();
    const loader = vi.fn(async () => ['role:read']);
    f.values.set('user:permissions:operator', '["user:delete"]');
    expect(await cache.read('permissions', 'operator', schema, loader)).toEqual(
      ['role:read'],
    );
    expect(f.redis.setex).toHaveBeenCalledWith(
      'neo:auth:0:permissions:operator',
      2,
      '["role:read"]',
    );
    expect(await cache.read('permissions', 'operator', schema, loader)).toEqual(
      ['role:read'],
    );
    expect(loader).toHaveBeenCalledOnce();
    f.values.set('neo:auth:0:permissions:operator', '{"wrong":true}');
    await cache.read('permissions', 'operator', schema, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it('invalidates both permissions and roles across API instances without enumerating users', async () => {
    const f = fixture();
    const first = f.cache();
    const second = f.cache();
    await first.read('permissions', 'operator', schema, async () => [
      'role:write',
    ]);
    await first.read('roles', 'operator', schema, async () => ['ADMIN']);
    await second.clear();
    expect(
      await first.read('permissions', 'operator', schema, async () => []),
    ).toEqual([]);
    expect(
      await first.read('roles', 'operator', schema, async () => []),
    ).toEqual([]);
    expect(f.values.get('neo:auth:0:permissions:operator')).toBe(
      '["role:write"]',
    );
    expect(f.values.get('neo:auth:1:permissions:operator')).toBe('[]');
  });
  it('keeps an old in-flight fill out of the namespace used after another instance commits', async () => {
    const f = fixture();
    const first = f.cache();
    const second = f.cache();
    const old = deferred<string[]>();
    const loader = vi.fn(() => old.promise);
    const reading = first.read('permissions', 'operator', schema, loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    await second.clear();
    old.resolve(['role:write']);
    expect(await reading).toEqual(['role:write']); // This request overlapped the update.
    expect(
      await first.read('permissions', 'operator', schema, async () => []),
    ).toEqual([]);
  });
  it('rechecks an in-flight read invalidated locally instead of returning its old permission', async () => {
    const f = fixture();
    const cache = f.cache();
    const old = deferred<string[]>();
    const loader = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue([]);
    const reading = cache.read('permissions', 'operator', schema, loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    await cache.clear();
    old.resolve(['role:write']);
    expect(await reading).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it('bypasses old Redis data after failed invalidation, and repairs on recovery', async () => {
    const f = fixture();
    const cache = f.cache();
    await cache.read('permissions', 'operator', schema, async () => [
      'role:write',
    ]);
    const working = f.redis.eval.getMockImplementation()!;
    f.redis.eval.mockRejectedValue(new Error('fixture Redis failure'));
    await cache.clear();
    const loader = vi.fn(async () => []);
    expect(await cache.read('permissions', 'operator', schema, loader)).toEqual(
      [],
    );
    expect(await cache.read('permissions', 'operator', schema, loader)).toEqual(
      [],
    );
    expect(loader).toHaveBeenCalledTimes(2);
    f.redis.eval.mockImplementation(working);
    expect(await cache.read('permissions', 'operator', schema, loader)).toEqual(
      [],
    );
    expect(f.values.get(PG_PERMISSION_GENERATION_KEY)).toBe('1');
  });
  it('rereads PostgreSQL during a Redis outage so a prior grant is not reused', async () => {
    const f = fixture();
    const cache = f.cache();
    const loader = vi.fn(async () => ['role:read']);
    await cache.read('permissions', 'operator', schema, loader);
    f.redis.get.mockRejectedValue(new Error('fixture offline'));
    expect(await cache.read('permissions', 'operator', schema, loader)).toEqual(
      ['role:read'],
    );
    expect(loader).toHaveBeenCalledTimes(2);
    loader.mockResolvedValue([]);
    expect(await cache.read('permissions', 'operator', schema, loader)).toEqual(
      [],
    );
    expect(loader).toHaveBeenCalledTimes(3);
  });
  it('does not turn a cache write failure into a failed database read', async () => {
    const f = fixture();
    f.redis.setex.mockRejectedValue(new Error('fixture offline'));
    expect(
      await f
        .cache()
        .read('permissions', 'operator', schema, async () => ['role:read']),
    ).toEqual(['role:read']);
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain(
      'fixture offline',
    );
  });
});
