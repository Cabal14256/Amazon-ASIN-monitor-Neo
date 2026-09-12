import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  CATALOG_CACHE_MAX_BYTES,
  CATALOG_CACHE_MAX_ENTRIES,
  CATALOG_DEFERRED_MAX_ENTRIES,
  RedisCatalogCheckStore,
} from '../src/catalog-check-store';
import type { CatalogCheckIdentity } from '../src/catalog-checker';
import {
  MAX_CATALOG_BYTES,
  parseCatalogVariantResult,
} from '../src/catalog-variants';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Real Redis shared Catalog check state',
  () => {
    let admin: Redis,
      peer: Redis,
      prefix: string,
      a: RedisCatalogCheckStore,
      b: RedisCatalogCheckStore;
    const signal = () => new AbortController().signal;
    const identity = (index = 1): CatalogCheckIdentity => ({
      asin: `B${String(index).padStart(9, '0')}`,
      country: 'US',
      owner: 'primary',
    });
    const result = (index = 1, title = 'Product') =>
      parseCatalogVariantResult(
        { asin: identity(index).asin, summaries: [{ itemName: title }] },
        identity(index).asin,
      );
    const base = () => `${prefix}:neo:catalog`;
    const key = (index = 1) => `${base()}:cache:US:${identity(index).asin}`;
    const indexKey = () => `${base()}:cache-index`;
    const sizeKey = () => `${base()}:cache-sizes`;
    async function connect() {
      if (!process.env.REDIS_URL)
        throw new Error('Missing isolated fixture Redis URL');
      const client = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        commandTimeout: 2000,
        connectTimeout: 1000,
        retryStrategy: () => null,
      });
      client.on('error', () => undefined);
      await client.connect();
      return client;
    }
    beforeAll(async () => {
      admin = await connect();
      peer = await connect();
    });
    beforeEach(() => {
      prefix = `catalog105:${randomUUID().replace(/-/g, '')}`;
      a = new RedisCatalogCheckStore(admin, prefix, 2000);
      b = new RedisCatalogCheckStore(peer, prefix, 2000);
    });
    afterEach(async () => {
      a.close();
      b.close();
      if (!/^catalog105:[a-f0-9]{32}$/.test(prefix))
        throw new Error('Unsafe fixture prefix');
      let cursor = '0';
      do {
        const [next, keys] = await admin.scan(
          cursor,
          'MATCH',
          `${prefix}:*`,
          'COUNT',
          100,
        );
        if (keys.some((key) => !key.startsWith(`${prefix}:`)))
          throw new Error('Unexpected fixture key');
        if (keys.length) await admin.del(...keys);
        cursor = next;
      } while (cursor !== '0');
    });
    afterAll(() => {
      admin?.disconnect();
      peer?.disconnect();
    });
    it('shares complete cached results and fixed TTL across two independent clients', async () => {
      const token = await a.claim(identity(), signal());
      await a.write(identity(), token, result(), 600, signal());
      expect(await b.read(identity(), signal())).toEqual(result());
      expect(await admin.pttl(key())).toBeGreaterThan(590000);
      expect(await admin.pttl(key())).toBeLessThanOrEqual(600000);
    });
    it('prevents a slower earlier refresh from overwriting a newer result', async () => {
      const old = await a.claim(identity(), signal()),
        fresh = await b.claim(identity(), signal());
      await b.write(identity(), fresh, result(1, 'New'), 600, signal());
      await a.write(identity(), old, result(1, 'Old'), 600, signal());
      expect((await a.read(identity(), signal()))?.details.title).toBe('New');
    });
    it('fences an in-flight fetch when committed status invalidates its cache', async () => {
      const token = await a.claim(identity(), signal());
      await b.invalidate(identity(), signal());
      await a.write(identity(), token, result(), 600, signal());
      expect(await a.read(identity(), signal())).toBeUndefined();
    });
    it('does not recreate an expired claim from a late response', async () => {
      const token = await a.claim(identity(), signal());
      await admin.del(key());
      await a.write(identity(), token, result(), 600, signal());
      expect(await admin.exists(key())).toBe(0);
    });
    it('isolates deployment prefixes and countries, and shares Catalog facts across business owners', async () => {
      const token = await a.claim(identity(), signal());
      await a.write(identity(), token, result(), 600, signal());
      expect(
        await b.read({ ...identity(), owner: 'competitor' }, signal()),
      ).toEqual(result());
      expect(
        await b.read({ ...identity(), country: 'UK' }, signal()),
      ).toBeUndefined();
      const other = new RedisCatalogCheckStore(peer, `${prefix}:other`);
      try {
        expect(await other.read(identity(), signal())).toBeUndefined();
      } finally {
        other.close();
      }
    });
    it('bounds cache record count and preserves index accounting', async () => {
      for (let i = 0; i < CATALOG_CACHE_MAX_ENTRIES + 3; i++) {
        const token = await a.claim(identity(i), signal());
        await a.write(identity(i), token, result(i), 600, signal());
      }
      expect(await admin.zcard(indexKey())).toBe(CATALOG_CACHE_MAX_ENTRIES);
      expect(await admin.hlen(sizeKey())).toBe(CATALOG_CACHE_MAX_ENTRIES);
      let cursor = '0',
        count = 0;
      do {
        const [next, keys] = await admin.scan(
          cursor,
          'MATCH',
          `${base()}:cache:*`,
          'COUNT',
          100,
        );
        count += keys.length;
        cursor = next;
      } while (cursor !== '0');
      expect(count).toBe(CATALOG_CACHE_MAX_ENTRIES);
    }, 15000);
    it('bounds aggregate cache bytes instead of allowing every entry the full response cap', async () => {
      for (let i = 0; i < 10; i++) {
        const token = await a.claim(identity(i), signal());
        await a.write(
          identity(i),
          token,
          result(i, 'x'.repeat(7 * 1024 * 1024)),
          600,
          signal(),
        );
      }
      const sizes = (await admin.hvals(sizeKey())).map(Number);
      expect(sizes.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(
        CATALOG_CACHE_MAX_BYTES,
      );
      expect(sizes.length).toBeLessThan(10);
    }, 30000);
    it('returns a miss for oversized or corrupt cached data without transferring an oversized value', async () => {
      const token = await a.claim(identity(), signal());
      await a.write(identity(), token, result(), 600, signal());
      await admin.hset(key(), 'raw', 'x'.repeat(MAX_CATALOG_BYTES + 1));
      expect(await b.read(identity(), signal())).toBeUndefined();
      await admin.hset(key(), 'raw', JSON.stringify(result(2)));
      expect(await b.read(identity(), signal())).toBeUndefined();
    });
    it('validates index type and metadata before mutating a valid cached entry', async () => {
      const token = await a.claim(identity(), signal());
      await a.write(identity(), token, result(), 600, signal());
      const original = await admin.hgetall(key());
      await admin.del(indexKey());
      await admin.set(indexKey(), 'wrongtype');
      await expect(b.invalidate(identity(), signal())).rejects.toMatchObject({
        code: 'DEPENDENCY_ERROR',
      });
      expect(await admin.hgetall(key())).toEqual(original);
      await admin.del(indexKey());
      await admin.zadd(indexKey(), 1, 'US:B000000001');
      await admin.hset(sizeKey(), 'US:B000000001', 'invalid-size');
      await expect(b.invalidate(identity(), signal())).rejects.toMatchObject({
        code: 'DEPENDENCY_ERROR',
      });
      expect(await admin.hgetall(key())).toEqual(original);
    });
    it('stores complete deferred records with owner/region separation, then clears only the selected record', async () => {
      const value = {
        ...identity(),
        region: 'US' as const,
        error: 'SP-API HTTP_ERROR (403)',
        deferredAt: Date.now(),
        retryCount: 0,
      };
      await a.defer(value, 3600, signal());
      await b.defer({ ...value, owner: 'competitor' }, 3600, signal());
      const primary = `${base()}:deferred:US:primary`,
        competitor = `${base()}:deferred:US:competitor`;
      const member = 'US:B000000001';
      expect(
        JSON.parse((await admin.get(`${primary}:item:${member}`))!),
      ).toEqual(value);
      expect(await admin.ttl(`${primary}:item:${member}`)).toBeGreaterThan(
        3590,
      );
      await a.clearDeferred(identity(), signal());
      expect(await admin.zcard(primary)).toBe(0);
      expect(await admin.exists(`${primary}:item:${member}`)).toBe(0);
      expect(await admin.zcard(competitor)).toBe(1);
    });
    it('refuses excess deferred identities without dropping existing pending work, while allowing replacement', async () => {
      const index = `${base()}:deferred:US:primary`;
      const time = await admin.time();
      const expiry = Number(time[0]) * 1000 + 3600000;
      const entries: (number | string)[] = [];
      for (let i = 0; i < CATALOG_DEFERRED_MAX_ENTRIES; i++)
        entries.push(expiry, `US:${identity(i).asin}`);
      await admin.zadd(index, ...entries);
      const value = {
        ...identity(CATALOG_DEFERRED_MAX_ENTRIES),
        region: 'US' as const,
        error: 'SP-API HTTP_ERROR (403)',
        deferredAt: Date.now(),
        retryCount: 0,
      };
      await expect(a.defer(value, 3600, signal())).rejects.toMatchObject({
        code: 'CAPACITY',
      });
      expect(await admin.zcard(index)).toBe(CATALOG_DEFERRED_MAX_ENTRIES);
      await a.defer({ ...value, ...identity(1) }, 3600, signal());
      expect(await admin.zcard(index)).toBe(CATALOG_DEFERRED_MAX_ENTRIES);
    });
  },
);
