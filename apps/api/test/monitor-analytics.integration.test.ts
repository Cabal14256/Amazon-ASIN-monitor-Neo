import {
  monitorAnalyticsDataSchemas,
  timescaleAggregateEvidenceManifest,
} from '@asin-monitor/contracts';
import {
  MONITOR_ANALYTICS_OPERATIONS,
  parseMonitorAnalyticsQuery,
  type MonitorAnalyticsOperation,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MonitorAnalyticsCache } from '../src/monitor/monitor-analytics-cache';
import { MonitorHistoryModule } from '../src/monitor/monitor-history.module';
import { legacyAnalyticsHttpFixture } from './helpers/monitor-analytics-legacy-http';
import { spApiConfigApp } from './helpers/sp-api-config-app';

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
          if (cacheKeys.size) await f.redis.del(...cacheKeys);
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
      const raw = { ...range, country: 'US', groupBy: 'day' };
      await clearCache();
      const first = (await get('by-time', raw)).json(),
        second = (await get('by-time', raw)).json();
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
      const fast = (await get('by-time', raw)).json();
      expect(fast.meta.source).toBe('agg');
      expect(fast.data).toEqual(before.data);
      expect((await get('by-time', raw)).json().meta.source).toBe('cache+agg');
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
