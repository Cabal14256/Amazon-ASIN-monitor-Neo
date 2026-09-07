import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SpApiClient } from '../src/client';
import { SpApiQuotaExecutor } from '../src/quota-executor';
import {
  buildQuotaWindows,
  DEFAULT_QUOTA_SETTINGS,
  type QuotaSettings,
} from '../src/quota-policy';
import { RedisQuotaStore } from '../src/quota-redis';
import {
  fixture as clientFixture,
  deferred,
  path,
  response,
  tokenResponse,
} from './fixtures';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Real Redis SP-API quota compatibility',
  () => {
    let admin: Redis;
    let prefix: string;
    let settings: QuotaSettings;
    const clients: Redis[] = [];
    const stores: RedisQuotaStore[] = [];
    const executors: SpApiQuotaExecutor[] = [];
    const apiClients: SpApiClient[] = [];
    const errors: string[] = [];
    async function connect() {
      if (!process.env.REDIS_URL) throw new Error('Missing fixture Redis URL');
      const client = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 1000,
        connectTimeout: 1000,
      });
      client.on('error', () => {
        errors.push('fixture redis error');
      });
      clients.push(client);
      await client.connect();
      return client;
    }
    beforeAll(async () => {
      admin = await connect();
      clients.pop();
    });
    beforeEach(() => {
      prefix = `spapi:quota69:${randomUUID().replace(/-/g, '')}`;
      settings = { ...DEFAULT_QUOTA_SETTINGS, prefix };
    });
    afterEach(async () => {
      for (const client of apiClients.splice(0)) client.close();
      for (const executor of executors.splice(0)) executor.close();
      for (const store of stores.splice(0)) store.close();
      for (const client of clients.splice(0)) client.disconnect();
      if (!/^spapi:quota69:[a-f0-9]{32}$/.test(prefix))
        throw new Error('Invalid fixture key prefix');
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
    afterAll(async () => {
      if (admin) await admin.quit();
      expect(errors).toEqual([]);
    });
    async function fixture(now?: () => number) {
      const client = await connect();
      const store = new RedisQuotaStore(client, settings, { now });
      stores.push(store);
      return { client, store };
    }

    function logger() {
      return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    }
    async function executorFixture(maxWaitMs = 500, now?: () => number) {
      const client = await connect();
      const log = logger();
      const executor = new SpApiQuotaExecutor({
        logger: log,
        redis: client,
        settings,
        maxWaitMs,
        now,
      });
      executors.push(executor);
      return { client, executor, log };
    }
    const context = (operation = 'getCatalogItem') => ({
      region: 'US' as const,
      operation,
      priority: 2 as const,
      signal: new AbortController().signal,
    });

    it('two actual executors admit only one callback under a shared regional cap', async () => {
      settings = { ...settings, regionPerMinute: 1, regionPerHour: 1 };
      const a = await executorFixture();
      const b = await executorFixture();
      const task = vi.fn(async () => 'completed');
      const results = await Promise.allSettled(
        [a, b].flatMap(({ executor }) =>
          ['getCatalogItem', 'searchCatalogItems', 'default'].map((operation) =>
            executor.execute(context(operation), task),
          ),
        ),
      );
      expect(task).toHaveBeenCalledOnce();
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      for (const result of results)
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({ code: 'TIMEOUT' });
      const snapshot = await a.executor.snapshot('US');
      expect(snapshot).toMatchObject({
        redisAvailable: true,
        minuteTokens: 0,
        hourTokens: 0,
        windows: { minute: { used: 1 }, hour: { used: 1 } },
      });
    });

    it('the actual client charges both a 429 and its successful retry in Redis', async () => {
      const { executor } = await executorFixture(4000);
      const f = clientFixture();
      f.client.close();
      const client = new SpApiClient({
        config: f.source,
        transport: f.transport,
        logger: f.logger,
        quota: executor,
      });
      apiClients.push(client);
      f.transport.request
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
      await expect(
        client.call('GET', path, 'US', {}, undefined, {
          maxRetries: 1,
          timeoutMs: 5000,
        }),
      ).resolves.toMatchObject({ data: { ok: true } });
      expect(f.transport.request).toHaveBeenCalledTimes(3);
      const windows = buildQuotaWindows(settings, 'US', 'getCatalogItem');
      expect(await admin.zcard(windows[0]!.key)).toBe(2);
      expect(await admin.zcard(windows[1]!.key)).toBe(2);
      expect(await admin.zcard(windows[3]!.key)).toBe(2);
      expect(await executor.snapshot('US', 'getCatalogItem')).toMatchObject({
        redisAvailable: true,
        limitSource: 'response_header',
        limits: { second: 1, minute: 90, hour: 5400 },
      });
    }, 10_000);

    it('a disconnected and reconnected owned client preserves memory debt and resumes shared charging', async () => {
      settings = { ...settings, regionPerMinute: 2, regionPerHour: 100 };
      let now = Date.now();
      const { executor, client, log } = await executorFixture(50, () => now);
      await executor.execute(context(), async () => 1);
      const ended = once(client, 'end', { signal: AbortSignal.timeout(1000) });
      client.disconnect();
      await ended;
      await executor.execute(context('searchCatalogItems'), async () => 2);
      await client.connect();
      const task = vi.fn(async () => 3);
      await expect(
        executor.execute(context('default'), task),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(task).not.toHaveBeenCalled();
      expect(await executor.snapshot('US')).toMatchObject({
        redisAvailable: true,
        lastMode: 'memory',
        minuteTokens: 0,
      });
      now += 30_100;
      await expect(executor.execute(context('default'), task)).resolves.toBe(3);
      expect(task).toHaveBeenCalledOnce();
      expect(
        await admin.zcard(buildQuotaWindows(settings, 'US', 'default')[0]!.key),
      ).toBe(2);
      expect(log.warn).toHaveBeenCalledOnce();
      expect(log.info).toHaveBeenCalledOnce();
    });

    it('two independent instances share the region cap across operations', async () => {
      settings = { ...settings, regionPerMinute: 1, regionPerHour: 1 };
      const a = await fixture();
      const b = await fixture();
      const results = await Promise.all(
        [a, b].map(async ({ store }, instance) => {
          const decisions: boolean[] = [];
          for (let i = 0; i < 3; i++) {
            const result = await store.acquire(
              'US',
              i % 2 ? 'searchCatalogItems' : 'getCatalogItem',
              `instance-${instance}-${i}`,
            );
            if (!result.available) throw new Error('Fixture Redis unavailable');
            decisions.push(result.value.allowed);
          }
          return decisions;
        }),
      );
      expect(results.flat().filter(Boolean)).toHaveLength(1);
      const snapshot = await a.store.snapshot('US');
      if (!snapshot.available) throw new Error('Fixture Redis unavailable');
      expect(snapshot.value.windows.map((window) => window.used)).toEqual([
        1, 1,
      ]);
    });

    it('keeps US and EU budgets independent', async () => {
      settings = { ...settings, regionPerMinute: 1, regionPerHour: 1 };
      const a = await fixture();
      const b = await fixture();
      const results = await Promise.all([
        a.store.acquire('US', 'getCatalogItem', 'us-one'),
        b.store.acquire('EU', 'getCatalogItem', 'eu-one'),
      ]);
      for (const result of results)
        expect(result).toMatchObject({
          available: true,
          value: { allowed: true },
        });
    });

    it('an operation rejection does not charge the region or prevent another operation', async () => {
      const { store } = await fixture(() => 1000);
      await expect(
        store.acquire('US', 'getCatalogItem', 'first'),
      ).resolves.toMatchObject({ value: { allowed: true } });
      await expect(
        store.acquire('US', 'getCatalogItem', 'blocked'),
      ).resolves.toMatchObject({ value: { allowed: false } });
      const windows = buildQuotaWindows(settings, 'US', 'getCatalogItem');
      expect(
        await Promise.all(
          windows.slice(0, 2).map((window) => admin.zcard(window.key)),
        ),
      ).toEqual([1, 1]);
      await expect(
        store.acquire('US', 'searchCatalogItems', 'other-operation'),
      ).resolves.toMatchObject({ value: { allowed: true } });
      expect(
        await Promise.all(
          windows.slice(0, 2).map((window) => admin.zcard(window.key)),
        ),
      ).toEqual([2, 2]);
    });

    it('honors usage charged by the actual Legacy Lua script', async () => {
      const legacy = createRequire(__filename)(
        '../../../server/src/services/rateLimiter.js',
      ) as { DISTRIBUTED_ACQUIRE_SCRIPT: string };
      const { store } = await fixture(() => 1000);
      const windows = buildQuotaWindows(settings, 'US', 'getCatalogItem');
      await expect(
        admin.eval(
          legacy.DISTRIBUTED_ACQUIRE_SCRIPT,
          windows.length,
          ...windows.map((window) => window.key),
          1000,
          'legacy-fixture',
          windows.length,
          1,
          ...windows.flatMap((window) => [
            window.limit,
            window.windowMs,
            window.ttlMs,
          ]),
        ),
      ).resolves.toEqual([1, 0]);
      await expect(
        store.acquire('US', 'getCatalogItem', 'neo-fixture'),
      ).resolves.toMatchObject({ available: true, value: { allowed: false } });
      for (const window of windows) {
        expect(await admin.zrange(window.key, 0, -1)).toEqual([
          'legacy-fixture:1',
        ]);
        expect(await admin.pttl(window.key)).toBeGreaterThan(0);
      }
    });

    it('a repeated acknowledgement neither charges twice nor extends the original member timestamp', async () => {
      let now = 1000;
      const { store } = await fixture(() => now);
      await expect(
        store.acquire('US', 'getCatalogItem', 'same-request'),
      ).resolves.toMatchObject({ value: { allowed: true } });
      now += 200;
      await expect(
        store.acquire('US', 'getCatalogItem', 'same-request'),
      ).resolves.toMatchObject({ value: { allowed: true } });
      for (const window of buildQuotaWindows(
        settings,
        'US',
        'getCatalogItem',
      )) {
        expect(await admin.zcard(window.key)).toBe(1);
        expect(await admin.zscore(window.key, 'same-request:1')).toBe('1000');
      }
    });

    it('expires the second window at its inclusive boundary while preserving minute and hour usage', async () => {
      let now = 1000;
      const { store } = await fixture(() => now);
      await store.acquire('US', 'getCatalogItem', 'first');
      now += 1000;
      await expect(
        store.acquire('US', 'getCatalogItem', 'second'),
      ).resolves.toMatchObject({ value: { allowed: true } });
      const windows = buildQuotaWindows(settings, 'US', 'getCatalogItem');
      expect(
        await Promise.all(windows.map((window) => admin.zcard(window.key))),
      ).toEqual([2, 2, 1, 2, 2]);
    });

    it('shares observed capacities and rejects an older metadata update', async () => {
      const a = await fixture();
      const b = await fixture();
      await expect(
        a.store.publish('US', 'getCatalogItem', 1.5, undefined, 2000),
      ).resolves.toEqual({ available: true, value: true });
      await expect(
        b.store.publish('US', 'getCatalogItem', 0.5, undefined, 1000),
      ).resolves.toEqual({ available: true, value: false });
      const decision = await b.store.acquire(
        'US',
        'getCatalogItem',
        'after-header',
      );
      if (!decision.available) throw new Error('Fixture Redis unavailable');
      expect(
        decision.value.windows.slice(2).map((window) => window.limit),
      ).toEqual([1, 67, 4050]);
      const snapshot = await a.store.snapshot('US', 'getCatalogItem');
      if (!snapshot.available) throw new Error('Fixture Redis unavailable');
      expect(
        snapshot.value.windows.map((window) => [window.limit, window.used]),
      ).toEqual([
        [1, 1],
        [67, 1],
        [4050, 1],
      ]);
      expect(snapshot.value.metadata?.updatedAt).toBe(
        '1970-01-01T00:00:02.000Z',
      );
    });

    it('a wrong-type key fails before any deductions and recovers after fixture repair', async () => {
      const { store } = await fixture();
      const windows = buildQuotaWindows(settings, 'US', 'getCatalogItem');
      await admin.set(windows[2]!.key, 'fixture-private-value');
      await expect(
        store.acquire('US', 'getCatalogItem', 'blocked'),
      ).resolves.toEqual({ available: false, reason: 'dependency' });
      expect(
        await Promise.all(
          windows.slice(0, 2).map((window) => admin.zcard(window.key)),
        ),
      ).toEqual([0, 0]);
      await admin.del(windows[2]!.key);
      await expect(
        store.acquire('US', 'getCatalogItem', 'recovered'),
      ).resolves.toMatchObject({ value: { allowed: true } });
    });

    it('malformed stored metadata cannot permanently block a valid observation', async () => {
      const { store } = await fixture();
      const key = `${prefix}:metadata:US:operation:getCatalogItem`;
      for (const bad of [
        { rate: 1, updatedAt: 'z'.repeat(24) },
        { rate: 1, updatedAt: '2026-02-31T00:00:00.000Z' },
        { rate: true, updatedAt: '2026-01-01T00:00:00.000Z' },
      ]) {
        await admin.set(key, JSON.stringify(bad));
        await expect(
          store.publish('US', 'getCatalogItem', 1.5, undefined, 2000),
        ).resolves.toEqual({ available: true, value: true });
        expect(JSON.parse((await admin.get(key))!)).toMatchObject({
          rate: 1.5,
          updatedAt: '1970-01-01T00:00:02.000Z',
        });
      }
    });

    it('cancellation after a real metadata read cannot initiate a late Redis deduction', async () => {
      const { client } = await fixture();
      const read = deferred<void>();
      const release = deferred<void>();
      const store = new RedisQuotaStore(
        {
          get status() {
            return client.status;
          },
          get: async (key) => {
            const value = await client.get(key);
            read.resolve();
            await release.promise;
            return value;
          },
          eval: (script, count, ...args) => client.eval(script, count, ...args),
        },
        settings,
      );
      stores.push(store);
      const controller = new AbortController();
      const result = store.acquire(
        'US',
        'getCatalogItem',
        'cancelled',
        controller.signal,
      );
      await read.promise;
      controller.abort();
      await expect(result).resolves.toEqual({
        available: false,
        reason: 'cancelled',
      });
      release.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      for (const window of buildQuotaWindows(settings, 'US', 'getCatalogItem'))
        expect(await admin.exists(window.key)).toBe(0);
    });
  },
);
