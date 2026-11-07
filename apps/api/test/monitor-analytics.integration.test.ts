import { loadEnv } from '@asin-monitor/config';
import {
  monitorAnalyticsDataSchemas,
  timescaleAggregateEvidenceManifest,
} from '@asin-monitor/contracts';
import {
  MONITOR_ANALYTICS_OPERATIONS,
  parseMonitorAnalyticsQuery,
  PgMonitorAnalyticsQueryRepository,
  type MonitorAnalyticsOperation,
  type MonitorAnalyticsQueryRepositoryPort,
  type MonitorAnalyticsQueryUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
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
import { ApplicationDatabasePools } from '../src/database/database.service';
import { AppLogger } from '../src/logger/app-logger.service';
import { MonitorAnalyticsCache } from '../src/monitor/monitor-analytics-cache';
import { MONITOR_ANALYTICS_REPOSITORY } from '../src/monitor/monitor-analytics.service';
import { MonitorHistoryModule } from '../src/monitor/monitor-history.module';
import { OpsModule } from '../src/ops/ops.module';
import { ApplicationRedisClient } from '../src/redis/redis.service';
import { boundedRedisRespGate } from './helpers/bounded-redis-resp-gate';
import { legacyAnalyticsHttpFixture } from './helpers/monitor-analytics-legacy-http';
import { spApiConfigApp } from './helpers/sp-api-config-app';

function assertFenceDisposableTargets() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
    process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
      'amazon_asin_monitor_ci'
  )
    throw new Error(
      'Analytics fence requires explicitly disposable CI targets',
    );
  const expected = [
    ['DATABASE_URL', 'postgresql:', '5432', '/amazon_asin_monitor_ci'],
    [
      'COMPETITOR_DATABASE_URL',
      'postgresql:',
      '5432',
      '/amazon_competitor_monitor_ci',
    ],
    ['REDIS_URL', 'redis:', '6379', '/15'],
  ] as const;
  for (const [name, protocol, port, pathname] of expected) {
    const target = new URL(process.env[name] ?? '');
    if (
      target.protocol !== protocol ||
      target.hostname !== '127.0.0.1' ||
      target.port !== port ||
      target.pathname !== pathname ||
      target.search ||
      target.hash ||
      target.password ||
      target.username !== (name === 'REDIS_URL' ? '' : 'postgres')
    )
      throw new Error(
        'Analytics fence target is not the exact disposable CI endpoint',
      );
  }
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'all analytics HTTP / Legacy MySQL + PostgreSQL + Redis',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>>,
      legacy: Awaited<ReturnType<typeof legacyAnalyticsHttpFixture>>;
    let headers: { authorization: string },
      cache: MonitorAnalyticsCache,
      userId: string,
      sessionId: string;
    const suffix = randomUUID().replace(/-/g, ''),
      group = `http109-${suffix}`,
      prefix = `analytics-http-${suffix}`;
    const ids = [0, 1, 2].map((index) => `http109-${suffix}-${index}`);
    const codes = [0, 1, 2].map((index) => `B${suffix.slice(0, 8)}${index}`);
    const range = {
      startTime: '1996-02-01 00:00:00',
      endTime: '1996-02-29 23:59:59',
    };
    const cacheKeys = new Set<string>();
    let previousTimezone: string | undefined;
    beforeAll(async () => {
      if (
        process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
        process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
          'amazon_asin_monitor_ci'
      )
        throw new Error(
          'Analytics HTTP requires explicitly disposable CI databases',
        );
      assertFenceDisposableTargets();
      // Freeze the Legacy process convention independently of the host default.
      previousTimezone = process.env.TZ;
      process.env.TZ = 'Asia/Shanghai';
      legacy = await legacyAnalyticsHttpFixture();
      f = await spApiConfigApp({
        imports: [MonitorHistoryModule],
        env: {
          BULL_PREFIX: prefix,
          ANALYTICS_AGG_ENABLED: true,
          ANALYTICS_STATUS_INTERVAL_ENABLED: false,
        },
      });
      expect(
        (await f.pools.primaryPool.query('SELECT current_database() AS name'))
          .rows[0].name,
      ).toBe('amazon_asin_monitor_ci');
      cache = f.app.get(MonitorAnalyticsCache);
      const evaluate = f.redis.eval.bind(f.redis);
      vi.spyOn(f.redis, 'eval').mockImplementation(
        async (script, keys, args) => {
          for (const key of keys)
            if (key.startsWith(`${prefix}:neo:analytics:v1:`))
              cacheKeys.add(key);
          return evaluate(script, keys, args);
        },
      );
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code IN ('monitor:read','analytics:read')",
      );
      userId = randomUUID();
      sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'reader-71')",
        [userId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      headers = {
        authorization: `Bearer ${jwt.sign(
          { userId, sessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
      await f.pools.primaryPool.query(
        "INSERT INTO public.variant_groups(id,name,country,site,brand) VALUES($1,'Current Résumé','US','current-site','current-brand')",
        [group],
      );
      await legacy.query(
        "INSERT INTO variant_groups(id,name,country,site,brand) VALUES(?,'Current Résumé','US','current-site','current-brand')",
        [group],
      );
      for (let i = 0; i < 2; i++) {
        const values = [
          ids[i],
          codes[i],
          group,
          i === 0 ? 'MAIN_LINK' : 'SUB_REVIEW',
        ];
        await f.pools.primaryPool.query(
          "INSERT INTO public.asins(id,asin,variant_group_id,asin_type,country,site,brand,name) VALUES($1,$2,$3,$4,'US','current-site','current-brand','Current Café 😀')",
          values,
        );
        await legacy.query(
          "INSERT INTO asins(id,asin,variant_group_id,asin_type,country,site,brand,name) VALUES(?,?,?,?,'US','current-site','current-brand','Current Café 😀')",
          values,
        );
      }
      for (let i = 0; i < 36; i++) {
        const values = [
          group,
          i % 6 === 0 ? null : 'Snapshot Résumé',
          ids[i % 3],
          i % 11 === 0 ? null : i % 7 === 0 ? '' : codes[i % 3],
          i % 5 === 0 ? '' : i % 4 === 0 ? null : '快照 Café 😀',
          ['US', 'UK', 'DE', 'FR', 'IT', 'ES'][Math.floor(i / 3) % 6],
          i % 7 === 0 ? 'GROUP' : i % 5 === 0 ? null : 'ASIN',
          i % 5 === 0 ? null : i % 2,
          `1996-02-${String(Math.floor(i / 12) + 1).padStart(2, '0')} ${String(
            i % 24,
          ).padStart(2, '0')}:10:00`,
          i % 4 === 0 ? null : `store-${i % 2}`,
          i % 3 === 0 ? '' : '品牌',
        ];
        const columns =
          'variant_group_id,variant_group_name,asin_id,asin_code,asin_name,country,check_type,is_broken,check_time,site_snapshot,brand_snapshot';
        await legacy.query(
          `INSERT INTO monitor_history(${columns}) VALUES(${values
            .map(() => '?')
            .join(',')})`,
          values,
        );
        await f.pools.primaryPool.query(
          `INSERT INTO public.monitor_history(${columns}) VALUES(${values
            .map((_, pos) => `$${pos + 1}`)
            .join(',')})`,
          values.map((value, pos) =>
            pos === 7 && value !== null ? Boolean(value) : value,
          ),
        );
      }
    }, 30000);
    afterAll(async () => {
      try {
        if (f) {
          await f.pools.primaryPool.query(
            'DELETE FROM public.monitor_history WHERE variant_group_id=$1',
            [group],
          );
          await f.pools.primaryPool.query(
            'DELETE FROM public.monitor_history_status_interval WHERE variant_group_id=$1',
            [group],
          );
          await f.pools.primaryPool.query(
            'DELETE FROM public.monitor_interval_dirty WHERE asin_key=ANY($1::varchar[])',
            [[...codes, ...ids.map((id) => `ID#${id}`)]],
          );
          await f.pools.primaryPool.query(
            'DELETE FROM public.asins WHERE variant_group_id=$1',
            [group],
          );
          await f.pools.primaryPool.query(
            'DELETE FROM public.variant_groups WHERE id=$1',
            [group],
          );
          for (const key of cacheKeys) {
            if (!key.startsWith(`${prefix}:neo:analytics:v1:`))
              throw new Error('Unsafe analytics fixture cache owner');
          }
          await f.redis.del(
            ...cacheKeys,
            `${prefix}:neo:ops:analytics-cache:generation`,
            `${prefix}:neo:ops:analytics-cache:last-cleared-at`,
          );
          await f.close();
        }
      } finally {
        if (legacy) await legacy.close();
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
        vi.restoreAllMocks();
      }
    });
    const get = (
      operation: MonitorAnalyticsOperation,
      query: Record<string, string> = {},
      auth: Record<string, string> = headers,
    ) =>
      f.http.inject({
        method: 'GET',
        url:
          '/api/v1/monitor-history/' +
          (operation === 'statistics' ||
          operation === 'abnormal-duration-statistics'
            ? operation
            : `statistics/${operation}`) +
          '?' +
          new URLSearchParams(query),
        headers: auth,
      });
    async function clearCache() {
      if (cacheKeys.size) await f.redis.del(...cacheKeys);
    }
    async function compare(
      operation: MonitorAnalyticsOperation,
      query: Record<string, string>,
    ) {
      await clearCache();
      const expected = await legacy.http(operation, query),
        actual = await get(operation, query);
      expect(
        expected.statusCode,
        operation + JSON.stringify(expected.body),
      ).toBe(200);
      expect(actual.statusCode, operation + actual.body).toBe(200);
      const body = actual.json();
      monitorAnalyticsDataSchemas[operation].parse(body.data);
      // Independent requests have different wall clocks. Assert the complete meta
      // shape and timestamp format, then align only that nondeterministic instant.
      if (body.meta) {
        expect(body.meta.lastUpdatedAt).toMatch(
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
        );
        const expectedMeta = expected.body.meta as Record<string, unknown>;
        expectedMeta.lastUpdatedAt = body.meta.lastUpdatedAt;
      }
      expect(body, operation + JSON.stringify(query)).toEqual(expected.body);
      expect(actual.headers['cache-control']).toBe('no-store');
      return body;
    }
    it.each(MONITOR_ANALYTICS_OPERATIONS)(
      'matches every field of actual Legacy HTTP %s, including empty windows',
      async (operation) => {
        await compare(operation, { ...range, country: 'US' });
        await compare(operation, {
          startTime: '1996-02-25 00:00:00',
          endTime: '1996-02-26 23:59:59',
          country: 'US',
        });
      },
    );
    it('preserves grouping, pagination, exact filters, fractional ranges and abnormal summary-only data', async () => {
      for (const groupBy of ['hour', 'day', 'week'])
        await compare('by-time', { ...range, groupBy });
      await compare('statistics', {
        ...range,
        checkType: 'GROUP',
        variantGroupId: group,
      });
      await compare('period-summary', {
        ...range,
        country: 'EU',
        current: '2',
        pageSize: '3',
      });
      await compare('period-summary/details', {
        ...range,
        country: 'US',
        site: 'store-1',
        brand: '品牌',
        timeSlotGranularity: 'hour',
      });
      await compare('asin-by-variant-group', { ...range, limit: '1' });
      await compare('abnormal-duration-statistics', {
        ...range,
        includeSeries: '0',
        asinIds: ids.join(','),
      });
      await compare('abnormal-duration-statistics', {
        ...range,
        asinType: 'MAIN_LINK',
        asinName: '%Café%',
      });
      await compare('by-time', {
        country: 'US',
        startTime: '1996-02-01 03:10:00.500',
        endTime: '1996-02-02 03:11:11.250',
        groupBy: 'hour',
      });
    });
    it('preserves monthly metrics while recording the frozen Legacy strict-grouping defect', async () => {
      const [{ mode }] = await legacy.query(
        'SELECT @@SESSION.sql_mode AS mode',
      );
      expect(String(mode)).toContain('ONLY_FULL_GROUP_BY');
      const query = { ...range, groupBy: 'month' };
      const strict = await legacy.http('by-time', query);
      expect(strict.statusCode).toBe(500);
      expect(strict.body.errorMessage).toContain('only_full_group_by');
      // The existing SQL differential suite records the same frozen defect.
      // Only this private MySQL oracle session relaxes grouping; production
      // Legacy SQL and every PostgreSQL query remain unchanged and strict.
      try {
        await legacy.query(
          "SET SESSION sql_mode=REPLACE(@@SESSION.sql_mode,'ONLY_FULL_GROUP_BY','')",
        );
        await compare('by-time', query);
      } finally {
        await legacy.query('SET SESSION sql_mode=?', [mode]);
      }
    });
    it('uses real Redis cache with original timestamps, per-range keys and current permission revocation', async () => {
      const metricCount = async (outcome: 'hits' | 'misses') => {
        const response = await f.http.inject({
          method: 'GET',
          url: '/metrics',
        });
        expect(response.statusCode).toBe(200);
        const line = response.body
          .split('\n')
          .find((value) =>
            value.startsWith(
              `amazon_asin_monitor_cache_${outcome}_total{cache_key_prefix="statisticsByTime"} `,
            ),
          );
        return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
      };
      const raw = { ...range, country: 'US', groupBy: 'day' };
      await clearCache();
      const beforeHit = await metricCount('hits');
      const beforeMiss = await metricCount('misses');
      const first = (await get('by-time', raw)).json(),
        second = (await get('by-time', raw)).json();
      expect(await metricCount('hits')).toBe(beforeHit + 1);
      expect(await metricCount('misses')).toBe(beforeMiss + 1);
      expect(second.data).toEqual(first.data);
      expect(second.meta).toEqual({
        ...first.meta,
        source: 'cache+raw',
        cacheHit: true,
        cacheTime: first.meta.lastUpdatedAt,
        dataFreshness: 'cached',
      });
      const key = cache.key(parseMonitorAnalyticsQuery('by-time', raw));
      expect(await f.redis.client.pttl(key)).toBeGreaterThan(0);
      expect(
        (
          await get('by-time', { ...raw, startTime: '1996-02-02 00:00:00' })
        ).json().meta.cacheHit,
      ).toBe(false);
      await f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='reader-71' AND permission_id=(SELECT id FROM permissions WHERE code='analytics:read')",
      );
      try {
        expect((await get('by-time', raw)).statusCode).toBe(403);
        expect(await metricCount('hits')).toBe(beforeHit + 1);
        expect(await metricCount('misses')).toBe(beforeMiss + 2);
      } finally {
        await f.pools.primaryPool.query(
          "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code='analytics:read'",
        );
      }
      expect((await get('by-time', raw)).json().meta.cacheHit).toBe(true);
    });
    it('expires real Redis entries and rejects corrupted or oversized cached responses', async () => {
      const raw = { ...range, country: 'US', groupBy: 'day' };
      const key = cache.key(parseMonitorAnalyticsQuery('by-time', raw));
      await clearCache();
      expect((await get('by-time', raw)).json().meta.cacheHit).toBe(false);
      await f.redis.client.pexpire(key, 1);
      await vi.waitFor(async () =>
        expect(await f.redis.client.exists(key)).toBe(0),
      );
      expect((await get('by-time', raw)).json().meta.cacheHit).toBe(false);
      for (const corrupt of ['{', 'x'.repeat(3 * 1024 * 1024)]) {
        await f.redis.client.psetex(key, 300000, corrupt);
        const response = await get('by-time', raw);
        expect(response.statusCode).toBe(200);
        expect(response.json().meta.cacheHit).toBe(false);
      }
    });
    it('bounds concurrent real SQL requests to two and restores admission when they finish', async () => {
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof get>>[]> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE public.monitor_history IN ACCESS EXCLUSIVE MODE',
        );
        pending = Promise.all([
          get('statistics', range),
          get('statistics', range),
        ]);
        await vi.waitFor(
          async () => {
            const waiting = await blocker.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE relation='public.monitor_history'::regclass AND mode='AccessShareLock' AND NOT granted",
            );
            expect(waiting.rows[0].n).toBe(2);
          },
          { timeout: 1000, interval: 20 },
        );
        expect((await get('statistics', range)).statusCode).toBe(429);
        await blocker.query('ROLLBACK');
        expect((await pending).map((response) => response.statusCode)).toEqual([
          200, 200,
        ]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (pending) await pending;
      }
      expect((await get('statistics', range)).statusCode).toBe(200);
    });
    it('checks a committed revocation after waiting on the shared authorization lock', async () => {
      const blocker = await f.pools.primaryPool.connect();
      let pending: ReturnType<typeof get> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        pending = get('statistics', { ...range, country: 'US' });
        const request = Promise.resolve(pending);
        await vi.waitFor(
          async () => {
            const waiting = await blocker.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=1095977294 AND objid=1380073795 AND NOT granted",
            );
            expect(waiting.rows[0].n).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 20 },
        );
        await blocker.query(
          "DELETE FROM role_permissions WHERE role_id='reader-71' AND permission_id IN (SELECT id FROM permissions WHERE code IN ('monitor:read','analytics:read'))",
        );
        await blocker.query('COMMIT');
        expect((await request).statusCode).toBe(403);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await f.pools.primaryPool.query(
          "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code IN ('monitor:read','analytics:read') ON CONFLICT DO NOTHING",
        );
        if (pending) await pending;
      }
    });
    it('bounds an actual locked analytics query, returns no partial data and releases the connection', async () => {
      const blocker: PoolClient = await f.pools.primaryPool.connect();
      await clearCache();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE public.monitor_history IN ACCESS EXCLUSIVE MODE',
        );
        const start = Date.now();
        const response = await get('statistics', { ...range, country: 'US' });
        expect(response.statusCode, response.body).toBe(504);
        expect(response.json().data).toBeUndefined();
        expect(Date.now() - start).toBeLessThan(10000);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(
        (await get('statistics', { ...range, country: 'US' })).statusCode,
      ).toBe(200);
    });
    it('serves refreshed Timescale results and invalidates the fast path after a historical correction', async () => {
      const raw = {
        startTime: '1996-02-01 00:00:00',
        endTime: '1996-02-01 23:59:59',
        groupBy: 'hour',
      };
      await clearCache();
      const before = (await get('by-time', raw)).json();
      expect(before.meta.source).toBe('raw');
      for (const item of timescaleAggregateEvidenceManifest) {
        await f.pools.primaryPool.query(
          'CALL public.refresh_continuous_aggregate($1::regclass,$2::timestamp,$3::timestamp,force=>true)',
          [
            `public.${item.caggRelation}`,
            range.startTime,
            '1996-03-01 00:00:00',
          ],
        );
      }
      await clearCache();
      // The API auth fixture deliberately has a private-only search_path. The
      // same immutable Timescale definition deparses differently in that scope;
      // analytics must establish its canonical data scope after authorization.
      const inspector = await f.pools.primaryPool.connect();
      try {
        const digestSql =
          "SELECT md5(regexp_replace(view_definition,'[[:space:]]+',' ','g')) AS digest FROM timescaledb_information.continuous_aggregates WHERE view_schema='public' AND view_name='monitor_history_cagg_asin_hour'";
        const scoped = (await inspector.query(digestSql)).rows[0].digest;
        await inspector.query('BEGIN');
        await inspector.query('SET LOCAL search_path TO pg_catalog, public');
        const canonical = (await inspector.query(digestSql)).rows[0].digest;
        expect(canonical).toBe('c8fbca31141d9ff2fd87bb2bc27a23da');
        expect(scoped).not.toBe(canonical);
      } finally {
        await inspector.query('ROLLBACK');
        inspector.release();
      }
      const fast = (await get('by-time', raw)).json();
      expect(fast.meta.source).toBe('agg');
      expect(fast.data).toEqual(before.data);
      expect((await get('by-time', raw)).json().meta.source).toBe('cache+agg');
      expect(
        (
          await f.pools.primaryPool.query(
            "SELECT current_setting('search_path') AS path",
          )
        ).rows[0].path,
      ).toBe(f.schema);
      await f.pools.primaryPool.query(
        "UPDATE public.monitor_history SET is_broken=false WHERE variant_group_id=$1 AND check_time='1996-02-01 01:10:00'",
        [group],
      );
      await legacy.query(
        "UPDATE monitor_history SET is_broken=0 WHERE variant_group_id=? AND check_time='1996-02-01 01:10:00'",
        [group],
      );
      const corrected = await compare('by-time', raw);
      expect(corrected.meta.source).toBe('raw');
      expect(corrected.data).not.toEqual(before.data);
    });
  },
);

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'analytics clear fence / independent real PostgreSQL and Redis API instances',
  () => {
    type App = Awaited<ReturnType<typeof spApiConfigApp>>;
    type Gate = Awaited<ReturnType<typeof boundedRedisRespGate>>;
    type Hold = ReturnType<Gate['arm']>;
    type DurationResult = Awaited<
      ReturnType<MonitorAnalyticsQueryUnit['duration']>
    >;
    type ApiResponse = {
      statusCode: number;
      body: string;
      json(): { data: Record<string, unknown>; meta: { cacheHit: boolean } };
    };
    const suffix = randomUUID().replace(/-/g, '');
    const prefix = `analytics-fence-${suffix}`;
    const group = `fence255-${suffix}`;
    const asin = `fence255-${suffix}`;
    const code = `B${suffix.slice(0, 9)}`;
    const generationKey = `${prefix}:neo:ops:analytics-cache:generation`;
    const lastClearedKey = `${prefix}:neo:ops:analytics-cache:last-cleared-at`;
    const range = {
      startTime: '1971-05-09 00:00:00',
      endTime: '1971-05-09 23:59:59',
    };
    const query = parseMonitorAnalyticsQuery('all-countries-summary', range);
    const apps: App[] = [];
    const gates: Gate[] = [];
    const holds: Hold[] = [];
    const pending = new Set<Promise<unknown>>();
    const dataKeys = new Set<string>();
    const restores: (() => void)[] = [];
    let a: App, b: App, gateA: Gate, gateB: Gate;
    let observer: ApplicationRedisClient | undefined;
    let headersA: { authorization: string },
      headersB: { authorization: string };
    function signal<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((accept) => {
        resolve = accept;
      });
      return { promise, resolve };
    }
    let sqlGate:
      | {
          arrived: ReturnType<typeof signal<DurationResult>>;
          release: ReturnType<typeof signal<void>>;
        }
      | undefined;
    const activeSqlGates = new Set<NonNullable<typeof sqlGate>>();
    const track = <T>(request: PromiseLike<T>): Promise<T> => {
      const work = Promise.resolve(request);
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => undefined);
      return work;
    };
    function arm(
      gate: Gate,
      marker: 'capture' | 'fill' | 'rotate',
      mode: 'before-command' | 'after-reply' = 'before-command',
    ) {
      const hold = gate.arm((arguments_) => {
        if (arguments_[0]?.toString('ascii').toUpperCase() !== 'EVAL')
          return false;
        const script = arguments_[1]?.toString('utf8');
        return (
          script?.startsWith(`-- neo-analytics-cache-${marker}:v2\n`) ===
            true &&
          arguments_[3]?.toString('utf8') === generationKey &&
          (marker !== 'fill' ||
            arguments_[4]
              ?.toString('utf8')
              .startsWith(`${prefix}:neo:analytics:v1:`) === true)
        );
      }, mode);
      holds.push(hold);
      return hold;
    }
    async function seedPrincipal(app: App) {
      const userId = randomUUID(),
        sessionId = randomUUID();
      app.userIds.add(userId);
      await app.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code IN ('monitor:read','analytics:read') ON CONFLICT DO NOTHING",
      );
      await app.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'fixture-unused-hash'],
      );
      await app.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
        [userId],
      );
      await app.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      return {
        authorization: `Bearer ${jwt.sign(
          { userId, sessionId },
          app.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
    }
    const read = (app: App, headers: { authorization: string }) =>
      track<ApiResponse>(
        app.http.inject({
          method: 'GET',
          url: `/api/v1/monitor-history/statistics/all-countries-summary?${new URLSearchParams(
            range,
          )}`,
          headers,
        }),
      );
    const clear = (app: App, headers: { authorization: string }) =>
      track<ApiResponse>(
        app.http.inject({
          method: 'POST',
          url: '/api/v1/ops/analytics/cache/clear',
          headers,
        }),
      );
    async function token() {
      const value = await observer!.get(generationKey);
      expect(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)).toBe(
        true,
      );
      expect(await observer!.client.pttl(generationKey)).toBe(-1);
      return value!;
    }
    async function freshDatabase() {
      await a.pools.primaryPool.query(
        "INSERT INTO public.monitor_history(variant_group_id,asin_id,asin_code,country,check_type,is_broken,check_time) VALUES($1,$2,$3,'US','ASIN',true,'1971-05-09 02:00:00')",
        [group, asin, code],
      );
    }
    function expectData(
      response: Awaited<ReturnType<typeof read>>,
      checks: number,
      cacheHit: boolean,
    ) {
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      monitorAnalyticsDataSchemas['all-countries-summary'].parse(body.data);
      expect(body.data.totalChecks).toBe(checks);
      expect(body.meta.cacheHit).toBe(cacheHit);
      return body;
    }
    beforeAll(async () => {
      // Validate targets before listening or constructing any PG/Redis provider.
      assertFenceDisposableTargets();
      const base = loadEnv(process.env);
      gateA = await boundedRedisRespGate(base.REDIS_URL);
      gates.push(gateA);
      gateB = await boundedRedisRespGate(base.REDIS_URL);
      gates.push(gateB);
      a = await spApiConfigApp({
        imports: [MonitorHistoryModule, OpsModule],
        env: {
          BULL_PREFIX: prefix,
          REDIS_URL: gateA.url,
          HEALTH_PROBE_TIMEOUT_MS: 15000,
          ANALYTICS_AGG_ENABLED: false,
          ANALYTICS_STATUS_INTERVAL_ENABLED: false,
        },
        configure: (builder) =>
          builder.overrideProvider(MONITOR_ANALYTICS_REPOSITORY).useFactory({
            inject: [ApplicationDatabasePools],
            factory: (pools: ApplicationDatabasePools) => {
              const real = new PgMonitorAnalyticsQueryRepository(
                pools.primaryPool,
                {
                  aggregateEnabled: false,
                  intervalEnabled: false,
                  onAggregateFallback: () => undefined,
                  onIntervalFallback: () => undefined,
                },
              );
              const decorated: MonitorAnalyticsQueryRepositoryPort = {
                read<T>(
                  action: (unit: MonitorAnalyticsQueryUnit) => Promise<T>,
                ) {
                  return real.read((unit) =>
                    action({
                      // Explicit delegation keeps real prototype methods and every
                      // authorization/advisory-lock/transaction/deadline operation.
                      lockOperator: (...arguments_) =>
                        unit.lockOperator(...arguments_),
                      lockSession: (...arguments_) =>
                        unit.lockSession(...arguments_),
                      operatorPermissionCodes: (...arguments_) =>
                        unit.operatorPermissionCodes(...arguments_),
                      counts: (...arguments_) => unit.counts(...arguments_),
                      peak: (...arguments_) => unit.peak(...arguments_),
                      period: (...arguments_) => unit.period(...arguments_),
                      abnormal: (...arguments_) => unit.abnormal(...arguments_),
                      duration: async (normalized) => {
                        const result = await unit.duration(normalized);
                        const owned = sqlGate;
                        if (
                          owned &&
                          normalized.operation === 'all-countries-summary'
                        ) {
                          sqlGate = undefined;
                          owned.arrived.resolve(result);
                          await owned.release.promise;
                          activeSqlGates.delete(owned);
                        }
                        return result;
                      },
                    }),
                  );
                },
              };
              return decorated;
            },
          }),
      });
      apps.push(a);
      b = await spApiConfigApp({
        imports: [MonitorHistoryModule, OpsModule],
        env: {
          BULL_PREFIX: prefix,
          REDIS_URL: gateB.url,
          HEALTH_PROBE_TIMEOUT_MS: 15000,
          ANALYTICS_AGG_ENABLED: false,
          ANALYTICS_STATUS_INTERVAL_ENABLED: false,
        },
      });
      apps.push(b);
      expect(a.schema === b.schema).toBe(false);
      expect(a.redis === b.redis).toBe(false);
      expect(a.pools.primaryPool === b.pools.primaryPool).toBe(false);
      for (const app of apps) {
        expect(
          (
            await app.pools.primaryPool.query(
              'SELECT current_database() AS name',
            )
          ).rows[0].name,
        ).toBe('amazon_asin_monitor_ci');
        const evaluate = app.redis.eval.bind(app.redis);
        const spy = vi
          .spyOn(app.redis, 'eval')
          .mockImplementation(async (script, keys, arguments_) => {
            for (const key of keys)
              if (key.startsWith(`${prefix}:neo:analytics:v1:`))
                dataKeys.add(key);
            return evaluate(script, keys, arguments_);
          });
        restores.push(() => spy.mockRestore());
      }
      observer = new ApplicationRedisClient(
        { ...base, HEALTH_PROBE_TIMEOUT_MS: 15000 },
        a.app.get(AppLogger),
      );
      await observer.ping();
      const clientInfo = String(await observer.client.call('CLIENT', 'INFO'));
      expect(/(?:^|\s)db=15(?:\s|$)/.test(clientInfo)).toBe(true);
      headersA = await seedPrincipal(a);
      headersB = await seedPrincipal(b);
      await a.pools.primaryPool.query(
        "INSERT INTO public.variant_groups(id,name,country,site,brand) VALUES($1,'Fence fixture','US','fence','fence')",
        [group],
      );
      await a.pools.primaryPool.query(
        "INSERT INTO public.asins(id,asin,variant_group_id,asin_type,country,site,brand,name) VALUES($1,$2,$3,'MAIN_LINK','US','fence','fence','Fence fixture')",
        [asin, code, group],
      );
      dataKeys.add(a.app.get(MonitorAnalyticsCache).key(query));
    }, 30000);
    beforeEach(async () => {
      await observer!.del(...dataKeys, generationKey, lastClearedKey);
      await a.pools.primaryPool.query(
        'DELETE FROM public.monitor_history WHERE variant_group_id=$1 AND asin_id=$2',
        [group, asin],
      );
      await a.pools.primaryPool.query(
        "INSERT INTO public.monitor_history(variant_group_id,asin_id,asin_code,country,check_type,is_broken,check_time) VALUES($1,$2,$3,'US','ASIN',false,'1971-05-09 00:00:00'),($1,$2,$3,'US','ASIN',false,'1971-05-09 01:00:00')",
        [group, asin, code],
      );
    });
    afterEach(async () => {
      sqlGate?.release.resolve();
      sqlGate = undefined;
      for (const sql of activeSqlGates) sql.release.resolve();
      activeSqlGates.clear();
      await Promise.all(holds.splice(0).map((hold) => hold.destroy()));
      await Promise.allSettled([...pending]);
    });
    afterAll(async () => {
      // Cleanup always releases transports before waiting for real transactions.
      sqlGate?.release.resolve();
      sqlGate = undefined;
      for (const sql of activeSqlGates) sql.release.resolve();
      activeSqlGates.clear();
      await Promise.all(holds.splice(0).map((hold) => hold.destroy()));
      await Promise.allSettled([...pending]);
      const failures: unknown[] = [];
      const clean = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };
      if (a) {
        await clean(() =>
          a.pools.primaryPool.query(
            'DELETE FROM public.monitor_history WHERE variant_group_id=$1 AND asin_id=$2',
            [group, asin],
          ),
        );
        await clean(() =>
          a.pools.primaryPool.query(
            'DELETE FROM public.monitor_history_status_interval WHERE variant_group_id=$1 AND asin_id=$2',
            [group, asin],
          ),
        );
        await clean(() =>
          a.pools.primaryPool.query(
            'DELETE FROM public.monitor_interval_dirty WHERE asin_key=ANY($1::varchar[])',
            [[code, `ID#${asin}`]],
          ),
        );
        await clean(() =>
          a.pools.primaryPool.query(
            'DELETE FROM public.asins WHERE id=$1 AND variant_group_id=$2',
            [asin, group],
          ),
        );
        await clean(() =>
          a.pools.primaryPool.query(
            'DELETE FROM public.variant_groups WHERE id=$1',
            [group],
          ),
        );
      }
      if (observer)
        await clean(() =>
          observer!.del(...dataKeys, generationKey, lastClearedKey),
        );
      for (const restore of restores) restore();
      for (const app of [...apps].reverse()) await clean(() => app.close());
      observer?.onModuleDestroy();
      for (const gate of gates) await clean(() => gate.close());
      vi.restoreAllMocks();
      if (failures.length)
        throw new Error('Analytics fence fixture cleanup failed');
    }, 30000);

    it('fences genuine late SQL delivery after another API has authorized and cleared', async () => {
      const firstClearCommand = arm(gateB, 'capture');
      const clearing = clear(b, headersB);
      // Receiving capture proves B's real role transaction has COMMITted.
      // Starting A first would block B behind A's global shared admin lock.
      await firstClearCommand.held;
      const sql = {
        arrived: signal<DurationResult>(),
        release: signal<void>(),
      };
      sqlGate = sql;
      activeSqlGates.add(sql);
      const reading = read(a, headersA);
      try {
        const genuinelyRead = await sql.arrived.promise;
        expect(
          (genuinelyRead.data as Record<string, unknown>).totalChecks,
        ).toBe(2);
        firstClearCommand.forward();
        expect((await clearing).statusCode).toBe(200);
        await freshDatabase();
      } finally {
        sql.release.resolve();
      }
      const old = expectData(await reading, 2, false);
      const fresh = expectData(await read(b, headersB), 3, false);
      expect(fresh.data).not.toEqual(old.data);
      expect(expectData(await read(a, headersA), 3, true).data).toEqual(
        fresh.data,
      );
    }, 20000);

    it('rejects a real fill EVAL transmitted only after cache timeout, PG commit and another API clear', async () => {
      const fill = arm(gateA, 'fill');
      const reading = read(a, headersA);
      await fill.held;
      const before = await token();
      // Wait for the real 500ms fallback and PgMonitorAnalyticsDeadline COMMIT;
      // the underlying Redis command still owns its admission and is not canceled.
      const old = expectData(await reading, 2, false);
      expect((await clear(b, headersB)).statusCode).toBe(200);
      expect((await token()) !== before).toBe(true);
      await freshDatabase();
      fill.forward();
      expect(await fill.executed).toBe(0);
      await fill.ackForwarded;
      const fresh = expectData(await read(b, headersB), 3, false);
      expect(fresh.data).not.toEqual(old.data);
      expect(expectData(await read(a, headersA), 3, true).data).toEqual(
        fresh.data,
      );
    }, 20000);

    it('rejects final Lua at the real Redis server deadline without changing generation or last-clear proof', async () => {
      expectData(await read(a, headersA), 2, false);
      const before = await token();
      expect(await observer!.get(lastClearedKey)).toBeNull();
      const final = arm(gateB, 'rotate');
      const clearing = clear(b, headersB);
      const arguments_ = await final.held;
      const fixedDeadline = Number(arguments_.at(-1)!.toString('ascii'));
      expect(Number.isSafeInteger(fixedDeadline)).toBe(true);
      expect((await clearing).statusCode).toBe(503);
      await vi.waitFor(
        async () => {
          const time = await observer!.client.time();
          expect(
            Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000),
          ).toBeGreaterThanOrEqual(fixedDeadline);
        },
        { timeout: 1000, interval: 20 },
      );
      final.forward();
      expect(await final.executed).toBe(-1);
      await final.ackForwarded;
      expect((await token()) === before).toBe(true);
      expect(await observer!.get(lastClearedKey)).toBeNull();
    }, 20000);

    it('reports lost final ACK as unknown 503 while retaining the actual successful rotation and fresh retry', async () => {
      expectData(await read(a, headersA), 2, false);
      const before = await token();
      const final = arm(gateB, 'rotate', 'after-reply');
      const clearing = clear(b, headersB);
      await final.held;
      expect(await final.executed).toBe(1);
      const changed = await token();
      expect(changed !== before).toBe(true);
      expect((await clearing).statusCode).toBe(503);
      expect((await token()) === changed).toBe(true);
      expect(await observer!.get(lastClearedKey)).not.toBeNull();
      // The success reply is discarded, never replayed or interpreted as undo.
      await final.destroy();
      expect((await clear(a, headersA)).statusCode).toBe(200);
      const retried = await token();
      expect(retried !== changed && retried !== before).toBe(true);
      expectData(await read(a, headersA), 2, false);
      expectData(await read(a, headersA), 2, true);
    }, 20000);
  },
);
