import { dashboardDataSchema } from '@asin-monitor/contracts';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
import { legacyDashboard } from '../../../packages/db/test/helpers/dashboard-legacy';
import { legacyAnalyticsFixture } from '../../../packages/db/test/helpers/monitor-analytics-legacy';
import { DashboardModule } from '../src/dashboard/dashboard.module';
import { spApiConfigApp } from './helpers/sp-api-config-app';

// Only JSON TEXT/JSONB whitespace and object key order differ. Keep the complete
// JSON value and every response field, alias, null and array position.
function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, item) =>
    key === 'check_result' && typeof item === 'string'
      ? JSON.parse(item)
      : item,
  );
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'dashboard / actual Legacy MySQL controller and Neo PostgreSQL HTTP',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>>;
    let legacy: Awaited<ReturnType<typeof legacyAnalyticsFixture>>;
    let userId: string, sessionId: string, headers: { authorization: string };
    beforeAll(async () => {
      legacy = await legacyAnalyticsFixture();
    });
    afterAll(async () => {
      if (legacy) await legacy.close();
    });
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-13T10:00:00Z'));
      f = await spApiConfigApp({ imports: [DashboardModule] });
      await f.redis.ping();
      for (const table of ['variant_groups', 'asins', 'monitor_history'])
        await f.pools.primaryPool.query(
          `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      for (const table of ['monitor_history', 'asins', 'variant_groups'])
        await legacy.query(`DELETE FROM \`${table}\``);
      userId = randomUUID();
      sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'fixture-unused-hash'],
      );
      // No role/permission grants: the Legacy Home/dashboard is login-only.
      headers = await session(sessionId);
    });
    afterEach(async () => {
      try {
        if (f) await f.close();
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    });
    async function session(id: string) {
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [id, userId],
      );
      return {
        authorization: `Bearer ${jwt.sign(
          { userId, sessionId: id },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
    }
    const get = (auth: Record<string, string> = headers) =>
      f.http.inject({
        method: 'GET',
        url: '/api/v1/dashboard',
        headers: auth,
      });
    async function compare() {
      const expected = await legacyDashboard(legacy.query, Date.now()),
        actual = await get();
      expect(expected.statusCode, JSON.stringify(expected.body)).toBe(200);
      expect(actual.statusCode, actual.body).toBe(200);
      expect(actual.headers['cache-control']).toBe('no-store');
      dashboardDataSchema.parse(actual.json().data);
      expect(canonical(actual.json())).toEqual(canonical(expected.body));
      return actual.json().data;
    }
    async function insert(
      table: 'variant_groups' | 'asins' | 'monitor_history',
      row: Record<string, unknown>,
    ) {
      const keys = Object.keys(row),
        values = Object.values(row);
      await legacy.query(
        `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys
          .map(() => '?')
          .join(',')})`,
        values,
      );
      await f.pools.primaryPool.query(
        `INSERT INTO ${table}(${keys.join(',')}) ${
          table === 'monitor_history' ? 'OVERRIDING SYSTEM VALUE' : ''
        } VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
        values.map((value, i) =>
          [
            'is_broken',
            'manual_broken',
            'manual_excluded_from_group',
            'notification_sent',
          ].includes(keys[i]) && value !== null
            ? Boolean(value)
            : value,
        ),
      );
    }
    async function group(id: string, options: Record<string, unknown> = {}) {
      await insert('variant_groups', {
        id,
        name: `Current group ${id}`,
        country: 'US',
        site: '12',
        brand: 'Fixture',
        is_broken: 0,
        manual_broken: 0,
        variant_status: 'STORED_GROUP',
        update_time: '2026-09-13 08:00:00',
        ...options,
      });
    }
    async function asin(
      id: string,
      parent: string,
      options: Record<string, unknown> = {},
    ) {
      await insert('asins', {
        id,
        asin: id.padStart(10, 'B'),
        name: `Current product ${id}`,
        country: 'US',
        site: '12',
        brand: 'Fixture',
        variant_group_id: parent,
        is_broken: 0,
        manual_broken: 0,
        manual_excluded_from_group: 0,
        variant_status: 'STORED_ASIN',
        update_time: '2026-09-13 09:00:00',
        ...options,
      });
    }
    async function history(id: number, options: Record<string, unknown> = {}) {
      await insert('monitor_history', {
        id,
        variant_group_id: 'g1',
        variant_group_name: 'Old group snapshot',
        asin_id: 'a1',
        asin_code: 'OLD0000001',
        asin_name: 'Old product snapshot',
        site_snapshot: 'old-site',
        brand_snapshot: 'Old brand',
        country: 'US',
        check_type: 'ASIN',
        is_broken: 1,
        notification_sent: 0,
        check_time: '2026-09-13 08:00:00',
        create_time: '2026-09-13 08:30:00',
        check_result: JSON.stringify({
          nested: { values: [null, true, '原始结果😀'] },
          z: id,
          a: 'first',
        }),
        ...options,
      });
    }
    it('matches the complete empty response without domain grants and denies anonymous reads', async () => {
      const result = await compare();
      expect(result.overview.totalASINs).toBe(0);
      expect((await get({})).statusCode).toBe(401);
    });
    it('matches all status combinations, seven countries, complete top tens and latest twenty activities', async () => {
      const countries = ['US', 'UK', 'DE', 'FR', 'IT', 'ES', 'JP'];
      for (let i = 0; i < 32; i++) {
        const id = String(i + 1).padStart(2, '0'),
          country = countries[i % 7];
        await group('g' + id, {
          country,
          is_broken: i & 1 ? 1 : 0,
          manual_broken: i & 2 ? 1 : 0,
          update_time: `2026-09-13 08:00:${id}`,
        });
        await asin('a' + id, 'g' + id, {
          country,
          is_broken: i & 4 ? 1 : 0,
          manual_broken: i & 8 ? 1 : 0,
          manual_excluded_from_group: i & 16 ? 1 : 0,
          name: i === 31 ? null : `Current product ${id}`,
          update_time: `2026-09-13 09:00:${id}`,
        });
        await history(i + 1, {
          country,
          variant_group_id: 'g' + id,
          asin_id: 'a' + id,
          check_time: `2026-09-13 10:00:${id}`,
          is_broken: i % 3 === 0 ? null : i % 2,
          notification_sent: i % 3 === 0 ? null : (i + 1) % 2,
          create_time: i === 31 ? null : '2026-09-13 10:30:00',
        });
      }
      const result = await compare();
      expect(result.realtimeAlerts.brokenGroups).toHaveLength(10);
      expect(result.realtimeAlerts.brokenASINs).toHaveLength(10);
      expect(result.recentActivities).toHaveLength(20);
      expect(result.recentActivities[0]).toMatchObject({
        id: 32,
        asin_name: null,
        asinName: null,
        variant_group_name: 'Current group g32',
        asin_code: 'OLD0000001',
        createTime: null,
      });
      expect(result.recentActivities[0]).not.toHaveProperty('checkResult');
      expect(result.overview).toMatchObject({
        totalGroups: 32,
        totalASINs: 32,
        brokenGroups: 30,
        brokenASINs: 26,
        todayChecks: 32,
      });
      expect(
        result.distribution.byCountry.map(
          (row: { country: string }) => row.country,
        ),
      ).toContain('JP');
      expect(result.overview.overviewByCountry).not.toHaveProperty('JP');
    });
    it('matches nullable flags, null update times and the full large JSON result without dropping fields', async () => {
      await group('g1', {
        is_broken: null,
        manual_broken: 1,
        update_time: null,
        variant_status: null,
      });
      await asin('a1', 'g1', {
        is_broken: null,
        manual_broken: null,
        manual_excluded_from_group: null,
        name: null,
        update_time: null,
        variant_status: null,
      });
      await history(1, {
        is_broken: null,
        notification_sent: null,
        check_type: null,
        create_time: null,
        check_result: JSON.stringify({
          padding: 'x'.repeat(60_000),
          nested: ['完整值', null, false],
        }),
      });
      const result = await compare();
      expect(result.overview).toMatchObject({
        brokenGroups: 1,
        brokenASINs: 1,
        todayChecks: 0,
      });
      expect(
        JSON.parse(result.recentActivities[0].check_result).padding,
      ).toHaveLength(60_000);
    });
    it('matches current membership, CI/PADSPACE joins, deleted names and future/UTC+8 today boundaries', async () => {
      await group('g1', { name: 'Renamed group', manual_broken: 1 });
      await asin('a1', 'G1 ', { name: 'Renamed ASIN' });
      for (const [i, row] of [
        { check_time: '2026-09-12 23:59:59' },
        { check_time: '2026-09-13 00:00:00' },
        {
          check_time: '2026-09-13 00:00:01',
          check_type: 'asin ',
          asin_id: 'A1 ',
          variant_group_id: 'G1 ',
        },
        { check_time: '2026-09-14 01:00:00' },
        { check_time: '2026-09-14 01:00:01', check_type: 'GROUP' },
        {
          check_time: '2026-09-14 01:00:02',
          asin_id: 'deleted',
          variant_group_id: 'deleted',
        },
        {
          check_time: '2026-09-14 01:00:03',
          asin_id: null,
          variant_group_id: null,
        },
      ].entries())
        await history(i + 1, row);
      let result = await compare();
      expect(result.overview.todayChecks).toBe(3);
      expect(result.recentActivities[0]).toMatchObject({
        asin_name: null,
        variant_group_name: null,
        asin: null,
      });
      // Cache lifetime crosses a day boundary; yesterday's values cannot leak.
      vi.setSystemTime(new Date('2026-09-13T15:59:59Z'));
      headers = await session(randomUUID());
      await compare();
      vi.setSystemTime(new Date('2026-09-13T16:00:00Z'));
      result = await compare();
      expect(result.overview.todayChecks).toBe(1);
    });
    it('preserves noncanonical single country labels and strict Legacy country-key lookups', async () => {
      for (const [i, country] of ['us ', 'uk', 'XX', 'JP'].entries()) {
        await group(`g${i}`, { country });
        await asin(`a${i}`, `g${i}`, { country });
      }
      const result = await compare();
      expect(result.overview.totalGroups).toBe(4);
      expect(result.overview.overviewByCountry.US.totalGroups).toBe(0);
      expect(result.overview.overviewByCountry.EU_TOTAL.totalGroups).toBe(0);
    });
    it('compares CI-equivalent mixed country labels with the real Legacy grouped representative', async () => {
      await group('g1', { country: 'US' });
      await group('g2', { country: 'us ' });
      await asin('a1', 'g1', { country: 'US' });
      await asin('a2', 'g2', { country: 'us ' });
      await history(1, { country: 'US', check_time: '2026-09-13 08:00:01' });
      await history(2, {
        country: 'us ',
        asin_id: 'a2',
        check_time: '2026-09-13 08:00:02',
      });
      const result = await compare();
      expect(result.overview.overviewByCountry.US).toMatchObject({
        totalGroups: 2,
        totalASINs: 2,
        todayChecks: 2,
      });
    });
    it.each([
      'account',
      'password',
      'password-expiry',
      'session',
      'session-expiry',
    ])(
      'rechecks current %s state before serving the process cache',
      async (state) => {
        await compare();
        if (state === 'account')
          await f.pools.primaryPool.query(
            "UPDATE users SET status='SUSPENDED' WHERE id=$1",
            [userId],
          );
        if (state === 'password')
          await f.pools.primaryPool.query(
            'UPDATE users SET force_password_change=true WHERE id=$1',
            [userId],
          );
        if (state === 'password-expiry')
          await f.pools.primaryPool.query(
            "UPDATE users SET password_expires_at='2000-01-01' WHERE id=$1",
            [userId],
          );
        if (state === 'session')
          await f.pools.primaryPool.query(
            "UPDATE sessions SET status='REVOKED' WHERE id=$1",
            [sessionId],
          );
        if (state === 'session-expiry')
          await f.pools.primaryPool.query(
            "UPDATE sessions SET expires_at='2000-01-01' WHERE id=$1",
            [sessionId],
          );
        const response = await get();
        // The existing authentication guard checks authoritative session expiry
        // before the transactional dashboard check and uses 401 for expiry.
        expect(response.statusCode, response.body).toBe(
          state === 'session-expiry' ? 401 : 403,
        );
        expect(response.json().data).toBeUndefined();
      },
    );
    it('observes revocation committed while waiting for the administration lock, even on a cache hit', async () => {
      await compare();
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof get>>> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        pending = get().then((value) => value);
        await vi.waitFor(
          async () => {
            const result = await blocker.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=1095977294 AND objid=1380073795 AND NOT granted",
            );
            expect(result.rows[0].n).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 10 },
        );
        await blocker.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [
          userId,
        ]);
        await blocker.query('COMMIT');
        const result = await pending;
        expect(result.statusCode, result.body).toBe(403);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (pending) await pending;
      }
    });
    it('bounds an actual locked query and recovers without publishing partial results', async () => {
      const blocker = await f.pools.primaryPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE monitor_history IN ACCESS EXCLUSIVE MODE',
        );
        const start = performance.now(),
          response = await get();
        expect(response.statusCode, response.body).toBe(504);
        expect(response.json().data).toBeUndefined();
        expect(performance.now() - start).toBeLessThan(9000);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      await compare();
    });
    it('rejects a third real pending query before authentication and recovers admission', async () => {
      const secondHeaders = await session(randomUUID());
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof get>>[]> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE monitor_history IN ACCESS EXCLUSIVE MODE',
        );
        pending = Promise.all([get(), get(secondHeaders)]);
        await vi.waitFor(
          async () => {
            const result = await blocker.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='relation' AND relation='monitor_history'::regclass AND NOT granted",
            );
            expect(result.rows[0].n).toBe(2);
          },
          { timeout: 1000, interval: 10 },
        );
        expect((await get()).statusCode).toBe(429);
        await blocker.query('COMMIT');
        expect((await pending).map((result) => result.statusCode)).toEqual([
          200, 200,
        ]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (pending) await pending;
      }
      await compare();
    });
    it('refuses PG-only ambiguous current IDs before duplicate joins can change totals', async () => {
      await group('g1');
      const duplicate =
        "INSERT INTO variant_groups(id,name,country,site,brand) VALUES('G1 ','Duplicate','US','12','Fixture')";
      await expect(f.pools.primaryPool.query(duplicate)).rejects.toMatchObject({
        code: '23505',
      });
      // The normal schema already enforces this invariant. Simulate a missing
      // index only inside the verified private fixture to exercise read defense.
      const indexes = await f.pools.primaryPool.query(
        "SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE i.indrelid='variant_groups'::regclass AND i.indisunique AND pg_get_indexdef(i.indexrelid) LIKE '%neo_import_group_ci%' AND n.nspname=$1",
        [f.schema],
      );
      expect(indexes.rows).toHaveLength(1);
      await f.pools.primaryPool.query(`DROP INDEX ${indexes.rows[0].name}`);
      await f.pools.primaryPool.query(duplicate);
      const response = await get();
      expect(response.statusCode, response.body).toBe(500);
      expect(response.json().data).toBeUndefined();
    });
    it('refuses an oversized PostgreSQL result before JSON aggregation and retains no failed cache', async () => {
      await f.pools.primaryPool.query(
        "INSERT INTO monitor_history(country,check_time,check_result) VALUES('US','2026-09-13 08:00:00',jsonb_build_object('padding',repeat('x',18*1024*1024)))",
      );
      const response = await get();
      expect(response.statusCode, response.body).toBe(413);
      expect(response.json().data).toBeUndefined();
      await f.pools.primaryPool.query('DELETE FROM monitor_history');
      await compare();
    });
    it('defines a stable binary-minimum label when Legacy selects another CI-equivalent spelling', async () => {
      await group('g1', { country: 'us ' });
      await group('g2', { country: 'US' });
      // This is an explicit compatibility boundary, not an oracle normalization:
      // Legacy groups equivalent spellings but then does a strict JS lookup.
      const expected = await legacyDashboard(legacy.query, Date.now());
      expect(expected.statusCode).toBe(200);
      expect(expected.body).toMatchObject({
        data: {
          overview: {
            totalGroups: 2,
            overviewByCountry: { US: { totalGroups: 0 } },
          },
          distribution: {
            byCountry: [{ country: 'us ', total: 2, broken: '0', normal: 2 }],
          },
        },
      });
      const response = await get();
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toMatchObject({
        overview: {
          totalGroups: 2,
          overviewByCountry: { US: { totalGroups: 2 } },
        },
        distribution: {
          byCountry: [{ country: 'US', total: 2, broken: '0', normal: 2 }],
        },
      });
    });
    it('uses explicit ID tie breakers for equal alert and activity times', async () => {
      for (const id of ['2', '1']) {
        await group('g' + id, { manual_broken: 1 });
        await asin('a' + id, 'g' + id);
        await history(Number(id), {
          variant_group_id: 'g' + id,
          asin_id: 'a' + id,
        });
      }
      const response = await get();
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json().data;
      expect(
        result.realtimeAlerts.brokenGroups.map((row: { id: string }) => row.id),
      ).toEqual(['g1', 'g2']);
      expect(
        result.realtimeAlerts.brokenASINs.map((row: { id: string }) => row.id),
      ).toEqual(['a1', 'a2']);
      expect(
        result.recentActivities.map((row: { id: number }) => row.id),
      ).toEqual([2, 1]);
    });
    it('returns all totals and lists from one snapshot around a concurrent multi-table commit', async () => {
      await group('g1');
      await asin('a1', 'g1');
      const before = await legacyDashboard(legacy.query, Date.now());
      await legacy.query(
        "UPDATE variant_groups SET manual_broken=1,update_time='2026-09-13 08:00:00' WHERE id='g1'",
      );
      // Explicit timestamps prevent unrelated MySQL ON UPDATE behavior entering
      // this data-snapshot comparison. No API read has populated the cache yet.
      await legacy.query(
        "INSERT INTO monitor_history(id,country,check_time,create_time,check_type,asin_id) VALUES(1,'US','2026-09-13 08:00:00','2026-09-13 08:00:01','ASIN','a1')",
      );
      const after = await legacyDashboard(legacy.query, Date.now());
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof get>>> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE monitor_history IN ACCESS EXCLUSIVE MODE',
        );
        await blocker.query(
          "UPDATE variant_groups SET manual_broken=true,update_time='2026-09-13 08:00:00' WHERE id='g1'",
        );
        await blocker.query(
          "INSERT INTO monitor_history(id,country,check_time,create_time,check_type,asin_id) OVERRIDING SYSTEM VALUE VALUES(1,'US','2026-09-13 08:00:00','2026-09-13 08:00:01','ASIN','a1')",
        );
        pending = get().then((value) => value);
        await vi.waitFor(
          async () => {
            const result = await blocker.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='relation' AND relation='monitor_history'::regclass AND NOT granted",
            );
            expect(result.rows[0].n).toBe(1);
          },
          { timeout: 1000, interval: 10 },
        );
        await blocker.query('COMMIT');
        const response = await pending;
        expect(response.statusCode, response.body).toBe(200);
        expect([canonical(before.body), canonical(after.body)]).toContainEqual(
          canonical(response.json()),
        );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (pending) await pending;
      }
    });
  },
);
