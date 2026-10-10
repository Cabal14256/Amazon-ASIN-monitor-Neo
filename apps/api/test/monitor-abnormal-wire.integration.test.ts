import { monitorAnalyticsDataSchemas } from '@asin-monitor/contracts';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MonitorAnalyticsCache } from '../src/monitor/monitor-analytics-cache';
import { MonitorHistoryModule } from '../src/monitor/monitor-history.module';
import { spApiConfigApp } from './helpers/sp-api-config-app';

function requireDisposableServices() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
    process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
      'amazon_asin_monitor_ci'
  )
    throw new Error(
      'Issue 241 HTTP/PG probe requires explicitly disposable CI services',
    );
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  for (const [key, database] of [
    ['DATABASE_URL', 'amazon_asin_monitor_ci'],
    ['COMPETITOR_DATABASE_URL', 'amazon_competitor_monitor_ci'],
  ] as const) {
    const endpoint = new URL(process.env[key] ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(endpoint.protocol) ||
      !localHosts.has(endpoint.hostname) ||
      (endpoint.port !== '' && endpoint.port !== '5432') ||
      endpoint.pathname !== `/${database}` ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error(
        'Issue 241 PostgreSQL endpoint is not the exact local disposable CI target',
      );
  }
  const redis = new URL(process.env.REDIS_URL ?? '');
  if (
    !['redis:', 'rediss:'].includes(redis.protocol) ||
    !localHosts.has(redis.hostname) ||
    (redis.port !== '' && redis.port !== '6379') ||
    redis.pathname !== '/15' ||
    redis.search ||
    redis.hash
  )
    throw new Error(
      'Issue 241 Redis endpoint is not the exact local disposable CI target',
    );
}

// Native Integration job must explicitly run this file: the default API unit
// command does not prove HTTP -> actual PostgreSQL selection or durations.
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Issue 241 abnormal raw identifier wire / actual PostgreSQL',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>>;
    let headers: { authorization: string };
    const namespace = randomUUID().replace(/-/g, '').slice(0, 16);
    const group = `wire241-${namespace}`;
    const secondPiece = `MiXeD-${namespace.slice(0, 8)}`;
    const rawId = ` ${namespace},${secondPiece} `;
    const ids = [rawId, rawId.trim(), namespace, secondPiece];
    const codes = [
      `B241${namespace.slice(0, 6)}`,
      `D241${namespace.slice(0, 6)}`,
      `E241${namespace.slice(0, 6)}`,
      `F241${namespace.slice(0, 6)}`,
    ];
    const prefix = `wire241-${namespace}`;
    const cacheKeys = new Set<string>();
    let verifiedDatabase = false;
    const range = {
      startTime: '1997-03-01 00:00:00',
      endTime: '1997-03-01 03:00:00',
    };
    beforeAll(async () => {
      requireDisposableServices();
      f = await spApiConfigApp({
        imports: [MonitorHistoryModule],
        env: {
          BULL_PREFIX: prefix,
          ANALYTICS_AGG_ENABLED: false,
          ANALYTICS_STATUS_INTERVAL_ENABLED: false,
        },
      });
      const primary = await f.pools.primaryPool.query(
        "SELECT current_database() AS name, current_schema() AS schema, current_setting('search_path') AS path",
      );
      expect(primary.rows[0]).toEqual({
        name: 'amazon_asin_monitor_ci',
        schema: f.schema,
        path: f.schema,
      });
      const competitor = await f.pools.competitorPool.query(
        'SELECT current_database() AS name, current_schema() AS schema',
      );
      expect(competitor.rows[0]).toEqual({
        name: 'amazon_competitor_monitor_ci',
        schema: 'public',
      });
      verifiedDatabase = true;
      await f.redis.ping();
      const evaluate = f.redis.eval.bind(f.redis);
      vi.spyOn(f.redis, 'eval').mockImplementation(
        async (script, keys, args) => {
          for (const key of keys)
            if (key.startsWith(`${prefix}:neo:analytics:v1:`))
              cacheKeys.add(key);
          return evaluate(script, keys, args);
        },
      );
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code='monitor:read' ON CONFLICT DO NOTHING",
      );
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
        "INSERT INTO public.variant_groups(id,name,country) VALUES($1,'wire241 group','US')",
        [group],
      );
      for (let index = 0; index < ids.length; index++) {
        await f.pools.primaryPool.query(
          "INSERT INTO public.asins(id,asin,variant_group_id,asin_type,country,name) VALUES($1,$2,$3,'MAIN_LINK','US','wire241 ASIN')",
          [ids[index], codes[index], group],
        );
        for (const [time, broken] of [
          ['00:00:00', true],
          ['01:00:00', false],
          ['02:00:00', true],
        ] as const) {
          await f.pools.primaryPool.query(
            "INSERT INTO public.monitor_history(variant_group_id,variant_group_name,asin_id,asin_code,asin_name,country,check_type,is_broken,check_time) VALUES($1,'wire241 group',$2,$3,'wire241 ASIN','US','ASIN',$4,$5::timestamp)",
            [group, ids[index], codes[index], broken, `1997-03-01 ${time}`],
          );
        }
      }
      // Fetching this provider proves the real module did not use a stubbed
      // analytics repository/cache implementation in this integration fixture.
      expect(f.app.get(MonitorAnalyticsCache)).toBeInstanceOf(
        MonitorAnalyticsCache,
      );
    }, 30000);
    afterAll(async () => {
      try {
        if (f && verifiedDatabase) {
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
          for (const key of cacheKeys)
            if (!key.startsWith(`${prefix}:neo:analytics:v1:`))
              throw new Error('Unexpected Issue 241 cache owner');
          if (cacheKeys.size) await f.redis.del(...cacheKeys);
        }
      } finally {
        try {
          if (f) await f.close();
        } finally {
          vi.restoreAllMocks();
        }
      }
    });
    const get = (entries: [string, string][]) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/monitor-history/abnormal-duration-statistics?${new URLSearchParams(
          [
            ...Object.entries(range),
            ['variantGroupId', group],
            ['includeSeries', '0'],
            ...entries,
          ],
        )}`,
        headers,
      });
    const parse = (response: {
      statusCode: number;
      body: string;
      json(): { data: unknown };
    }) => {
      expect(response.statusCode, response.body).toBe(200);
      return monitorAnalyticsDataSchemas['abnormal-duration-statistics'].parse(
        response.json().data,
      );
    };

    it('CONTROL: the existing repeated regular array preserves a single raw padded/comma ID', async () => {
      const data = parse(
        await get([
          ['asinIds', rawId],
          ['asinIds', rawId],
        ]),
      );
      expect(data.data).toEqual([]);
      expect(data.summary.map((row) => row.asin)).toEqual([codes[0]]);
      expect(data.summary[0].abnormalCount).toBe(2);
    });

    it('CONTROL: ordinary scalar CSV retains its trim/split semantics and selects the two intended decoys', async () => {
      const data = parse(
        await get([
          ['asinIds', ` ${namespace}, ${secondPiece} ,, ${namespace} `],
        ]),
      );
      expect(data.summary.map((row) => row.asin).sort()).toEqual(
        [codes[2], codes[3]].sort(),
      );
      expect(data.data).toEqual([]);
    });

    it('RED: single bracket raw-ID selection matches the original repeated-array source result, including all duration fields', async () => {
      const expected = parse(
        await get([
          ['asinIds', rawId],
          ['asinIds', rawId],
        ]),
      );
      const actual = parse(await get([['asinIds[]', rawId]]));
      expect(actual).toEqual(expected);
      expect(actual.summary.map((row) => row.asin)).toEqual([codes[0]]);
    });

    it('RED: repeated bracket IDs/codes remain arrays, preserve duplicates, and keep existing filter intersection', async () => {
      const expected = parse(
        await get([
          ['asinIds', rawId],
          ['asinIds', rawId],
          ['asinCodes', codes[0]],
          ['asinCodes', codes[0]],
        ]),
      );
      const actual = parse(
        await get([
          ['asinIds[]', rawId],
          ['asinIds[]', rawId],
          ['asinCodes[]', codes[0]],
          ['asinCodes[]', codes[0]],
        ]),
      );
      expect(actual).toEqual(expected);
    });

    it('RED: an empty bracket item stays a restricted empty-ID filter rather than widening to all ASINs', async () => {
      const data = parse(await get([['asinIds[]', '']]));
      expect(data.summary).toEqual([]);
      expect(data.data).toEqual([]);
    });

    it('RED: regular/bracket conflicts and nested aliases return 400 through the native HTTP controller', async () => {
      for (const entries of [
        [
          ['asinIds', rawId],
          ['asinIds[]', rawId],
        ],
        [
          ['asinCodes', codes[0]],
          ['asinCodes[]', codes[0]],
        ],
        [['asinIds[0]', rawId]],
      ] as [string, string][][])
        expect((await get(entries)).statusCode).toBe(400);
    });
  },
);
