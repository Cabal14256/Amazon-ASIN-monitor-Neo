import {
  competitorGroupListResultSchema,
  competitorGroupResultSchema,
} from '@asin-monitor/contracts';
import { createPgPool, PgCompetitorQueryRepository } from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { CompetitorModule } from '../src/competitor/competitor.module';
import { legacyCompetitorQueryFixture } from './helpers/competitor-query-legacy';
import { spApiConfigApp } from './helpers/sp-api-config-app';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../../packages/db/migrations/0010_competitor_query_matching.sql',
  ),
  'utf8',
);
const rollback = readFileSync(
  resolve(
    __dirname,
    '../../../packages/db/migrations/0010_competitor_query_matching.rollback.sql',
  ),
  'utf8',
);
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'competitor queries / actual Legacy MySQL, two PostgreSQL databases and HTTP',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>>,
      legacy: Awaited<ReturnType<typeof legacyCompetitorQueryFixture>>;
    let admin: ReturnType<typeof createPgPool>,
      schema: string,
      userId: string,
      sessionId: string,
      headers: { authorization: string };
    beforeAll(async () => {
      if (
        process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
        !process.env.COMPETITOR_DATABASE_URL
      )
        throw new Error('Disposable D6 databases must be enabled');
      legacy = await legacyCompetitorQueryFixture();
      admin = createPgPool(process.env.COMPETITOR_DATABASE_URL, {
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      schema = `competitor_query_119_${randomUUID().replace(/-/g, '')}`;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      for (const table of ['competitor_variant_groups', 'competitor_asins'])
        await admin.query(
          `CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`,
        );
      const url = new URL(process.env.COMPETITOR_DATABASE_URL);
      url.searchParams.set('options', `-c search_path=${schema}`);
      f = await spApiConfigApp({
        imports: [CompetitorModule],
        env: { COMPETITOR_DATABASE_URL: url.toString() },
      });
      expect(
        (await f.pools.competitorPool.query('SELECT current_schema() AS name'))
          .rows[0].name,
      ).toBe(schema);
      expect(
        (
          await f.pools.competitorPool.query(
            "SELECT to_regclass('users') AS value",
          )
        ).rows[0].value,
      ).toBeNull();
      expect(
        (await f.pools.primaryPool.query('SELECT current_database() AS name'))
          .rows[0].name,
      ).not.toBe(
        (
          await f.pools.competitorPool.query(
            'SELECT current_database() AS name',
          )
        ).rows[0].name,
      );
      // Deliberately conflicting IDs in the primary fixture must never be read.
      await f.pools.primaryPool.query(
        'CREATE TABLE competitor_variant_groups(id text PRIMARY KEY,name text)',
      );
      await f.pools.primaryPool.query(
        "INSERT INTO competitor_variant_groups VALUES('g1','wrong-primary-data')",
      );
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code='asin:read'",
      );
    });
    afterAll(async () => {
      try {
        if (f) await f.close();
      } finally {
        try {
          if (admin && schema) {
            if (!/^competitor_query_119_[0-9a-f]{32}$/.test(schema))
              throw new Error('Unsafe competitor fixture schema');
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          }
        } finally {
          await admin?.end();
          await legacy?.close();
          vi.restoreAllMocks();
        }
      }
    });
    beforeEach(async () => {
      for (const table of ['competitor_asins', 'competitor_variant_groups']) {
        await f.pools.competitorPool.query(`DELETE FROM ${table}`);
        await legacy.query(`DELETE FROM \`${table}\``);
      }
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
    });
    const get = (query: Record<string, string> = {}, auth = headers) =>
      f.http.inject({
        method: 'GET',
        url: '/api/v1/competitor/variant-groups?' + new URLSearchParams(query),
        headers: auth,
      });
    const detail = (id: string) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/competitor/variant-groups/${encodeURIComponent(id)}`,
        headers,
      });
    async function group(
      id: string,
      name = id,
      broken: boolean | null = false,
      country = 'US',
      day = '01',
    ) {
      const values = [
        id,
        name,
        country,
        'Fixture',
        broken,
        'BROKEN',
        null,
        `2026-09-${day} 08:00:00`,
      ];
      const fields =
        'id,name,country,brand,is_broken,variant_status,feishu_notify_enabled,create_time,update_time,last_check_time';
      await f.pools.competitorPool.query(
        `INSERT INTO competitor_variant_groups(${fields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL)`,
        values,
      );
      await legacy.query(
        `INSERT INTO competitor_variant_groups(${fields}) VALUES(?,?,?,?,?,?,?,?,NULL,NULL)`,
        values.map((value) =>
          typeof value === 'boolean' ? Number(value) : value,
        ),
      );
    }
    async function asin(
      id: string,
      parent: string,
      broken: boolean | null = false,
      country = 'US',
      code = `B${id.padStart(9, '0')}`,
    ) {
      const fields =
        'id,asin,name,asin_type,country,brand,variant_group_id,is_broken,variant_status,feishu_notify_enabled,create_time,update_time,last_check_time';
      const values = [
        id,
        code,
        null,
        'SUB_REVIEW',
        country,
        'Fixture',
        parent,
        broken,
        'OTHER',
        null,
        `2026-09-01 0${Number(id) % 9}:00:00`,
      ];
      await f.pools.competitorPool.query(
        `INSERT INTO competitor_asins(${fields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL)`,
        values,
      );
      await legacy.query(
        `INSERT INTO competitor_asins(${fields}) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
        values.map((value) =>
          typeof value === 'boolean' ? Number(value) : value,
        ),
      );
    }
    async function compare(query: Record<string, string> = {}) {
      const expected = await legacy.list(query),
        actual = await get(query);
      expect(actual.statusCode).toBe(expected.statusCode);
      expect(actual.json()).toEqual(expected.body);
      competitorGroupListResultSchema.parse(actual.json());
      return actual.json().data;
    }
    async function blocked(client: PoolClient) {
      await vi.waitFor(
        async () => {
          const locks = await client.query(
            'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
          );
          expect(locks.rows[0].n).toBeGreaterThan(0);
        },
        { timeout: 1000, interval: 10 },
      );
    }
    it('returns the full source result from the competitor database with D8/null fields and no-store', async () => {
      await group('g1', 'Correct competitor');
      await asin('1', 'g1');
      const data = await compare();
      expect(data.list[0]).toMatchObject({
        name: 'Correct competitor',
        createTime: '2026-09-01T00:00:00.000Z',
        update_time: null,
        feishuNotifyEnabled: 0,
        children: [{ asinType: '2', updateTime: null }],
      });
      const response = await detail('g1'),
        expected = await legacy.detail('g1');
      expect(response.statusCode).toBe(expected.statusCode);
      expect(response.json()).toEqual(expected.body);
      competitorGroupResultSchema.parse(response.json());
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await get({}, {} as never)).statusCode).toBe(401);
      expect((await detail('missing')).json()).toEqual(
        (await legacy.detail('missing')).body,
      );
    });
    it.each(['', 'BROKEN', 'NORMAL', 'other'])(
      'preserves distinct persisted filter and displayed child state (%s)',
      async (variantStatus) => {
        await group('g1', 'Empty stored broken', true);
        await group('g2', 'Child broken', false, 'US', '02');
        await group('g3', 'Null state', null, 'UK', '03');
        await asin('1', 'g2', true);
        await asin('2', 'g2', false, 'UK');
        await asin('3', 'g3', null, 'UK');
        await compare({ variantStatus });
        await compare({ variantStatus, country: 'US' });
        await compare({ variantStatus, country: 'UK' });
      },
    );
    it('counts matching empty parents and complete children independently from keyword asin_count', async () => {
      await group('g1', 'Needle empty');
      await group('g2', 'Needle full', false, 'US', '02');
      await group('g3', 'Other full', false, 'US', '03');
      await asin('1', 'g2');
      await asin('2', 'g2', true);
      await asin('3', 'g3');
      await compare({ keyword: 'Needle', pageSize: '1' });
      await compare({ keyword: 'Needle', current: '2', pageSize: '1' });
      const match = await compare({ keyword: 'B000000001' });
      expect(match.list[0].asin_count).toBe(1);
      expect(match.list[0].children).toHaveLength(2);
    });
    it.each([
      'cafe',
      'CAFÉ',
      'Straße',
      'strasse',
      'str_ss_',
      'a\\%b',
      'a_b',
      '中文🔎',
    ])('matches actual source LIKE for keyword %s', async (keyword) => {
      await group('g1', 'Café a%b Straße 中文🔎', false, 'ús ');
      await group('g2', 'other', false, 'UK', '02');
      await asin('1', 'g1');
      await compare({ keyword });
    });
    it('retains case/accent/PADSPACE equality for country and detail ID lookup', async () => {
      await group('Gróup ', 'Fixture', false, 'ús ');
      for (const country of ['US', 'us ', 'ÚS']) await compare({ country });
      for (const id of ['GROUP', 'gróup ', 'Group  ']) {
        const actual = await detail(id),
          expected = await legacy.detail(id);
        expect(actual.statusCode).toBe(expected.statusCode);
        expect(actual.json()).toEqual(expected.body);
      }
    });
    it('observes committed permission revocation after a real primary administration lock wait', async () => {
      await group('g1');
      expect((await get()).statusCode).toBe(200);
      const client = await f.pools.primaryPool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        pending = Promise.resolve(get());
        await blocked(client);
        await client.query('DELETE FROM user_roles WHERE user_id=$1', [userId]);
        await client.query('COMMIT');
        expect(
          ((await pending) as Awaited<ReturnType<typeof get>>).statusCode,
        ).toBe(403);
      } finally {
        await client.query('ROLLBACK');
        client.release();
        await pending?.catch(() => {});
      }
    });
    it.each(['user', 'session'])(
      'rejects current %s changes after the guard cache is warm',
      async (kind) => {
        await group('g1');
        expect((await get()).statusCode).toBe(200);
        if (kind === 'user')
          await f.pools.primaryPool.query(
            'UPDATE users SET force_password_change=true WHERE id=$1',
            [userId],
          );
        else
          await f.pools.primaryPool.query(
            "UPDATE sessions SET status='REVOKED' WHERE id=$1",
            [sessionId],
          );
        expect([401, 403]).toContain((await get()).statusCode);
      },
    );
    it('holds primary authorization until a blocked competitor read has completed', async () => {
      await group('g1');
      expect((await get()).statusCode).toBe(200);
      const blocker = await f.pools.competitorPool.connect(),
        changer = await f.pools.primaryPool.connect();
      let read: ReturnType<typeof get> | undefined,
        changed: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE competitor_variant_groups IN ACCESS EXCLUSIVE MODE',
        );
        read = get();
        const completedRead = Promise.resolve(read);
        await blocked(blocker);
        const changerPid = (
          await changer.query('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        changed = changer.query(
          'UPDATE users SET force_password_change=true WHERE id=$1',
          [userId],
        );
        await vi.waitFor(
          async () => {
            const result = await f.pools.primaryPool.query(
              'SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND NOT granted',
              [changerPid],
            );
            expect(result.rows[0].n).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 10 },
        );
        await blocker.query('ROLLBACK');
        expect((await completedRead).statusCode).toBe(200);
        await changed;
        expect([401, 403]).toContain((await get()).statusCode);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await changed?.catch(() => {});
        changer.release();
        if (read) await Promise.resolve(read).catch(() => {});
      }
    });
    it('cancels both borrowed transactions while SQL is blocked and retains reusable host pools', async () => {
      await group('g1');
      const reader = new PgCompetitorQueryRepository(
        f.pools.primaryPool,
        f.pools.competitorPool,
      );
      const blocker = await f.pools.competitorPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE competitor_variant_groups IN ACCESS EXCLUSIVE MODE',
        );
        const abort = new AbortController(),
          task = reader.read((unit) => unit.detail('g1'), abort.signal);
        const rejected = expect(task).rejects.toMatchObject({
          code: 'cancelled',
        });
        await blocked(blocker);
        abort.abort('private cancellation value');
        await rejected;
        await blocker.query('ROLLBACK');
        expect((await get()).statusCode).toBe(200);
      } finally {
        reader.close();
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    });
    it('enforces real SQL timeouts without leaking SQL and recovers after the lock is released', async () => {
      await group('g1');
      const blocker = await f.pools.competitorPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE competitor_variant_groups IN ACCESS EXCLUSIVE MODE',
        );
        const start = Date.now(),
          result = await get();
        expect(result.statusCode).toBe(500);
        expect(Date.now() - start).toBeLessThan(4500);
        expect(
          result.body + JSON.stringify(f.logger.error.mock.calls),
        ).not.toContain('competitor_variant_groups');
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect((await get()).statusCode).toBe(200);
    });
    it('does not substitute primary data after a competitor relation is missing', async () => {
      await group('g1');
      await f.pools.competitorPool.query(
        'ALTER TABLE competitor_variant_groups RENAME TO hidden_competitor_groups',
      );
      try {
        expect((await detail('g1')).statusCode).toBe(500);
      } finally {
        await f.pools.competitorPool.query(
          'ALTER TABLE hidden_competitor_groups RENAME TO competitor_variant_groups',
        );
      }
      expect((await detail('g1')).statusCode).toBe(200);
    });
    it('rejects a complete response larger than the child limit rather than truncating it', async () => {
      await group('g1');
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id) SELECT 'large-'||n,'B'||lpad(n::text,9,'0'),'US','Fixture','g1' FROM generate_series(1,5001) n",
      );
      const result = await detail('g1');
      expect(result.statusCode).toBe(413);
      expect(result.json().data).toBeUndefined();
    });
    it('runs the actual upgrade/rollback repeatedly, rejects duplicate identities and incompatible collation without changing rows', async () => {
      const name = `competitor_upgrade_119_${randomUUID().replace(/-/g, '')}`;
      if (!/^competitor_upgrade_119_[0-9a-f]{32}$/.test(name))
        throw new Error('Unsafe fixture database');
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(process.env.COMPETITOR_DATABASE_URL!);
      url.pathname = `/${name}`;
      const pool = createPgPool(url.toString(), {
        max: 1,
        connectionTimeoutMillis: 2000,
      });
      try {
        await pool.query(
          'CREATE TABLE competitor_variant_groups(id varchar(50) PRIMARY KEY); CREATE TABLE competitor_asins(id varchar(50) PRIMARY KEY,variant_group_id varchar(50),is_broken boolean)',
        );
        await pool.query(
          "INSERT INTO competitor_variant_groups VALUES('g'),('G ')",
        );
        await expect(pool.query(migration)).rejects.toThrow();
        await pool.query('ROLLBACK');
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM competitor_variant_groups',
            )
          ).rows[0].n,
        ).toBe(2);
        expect(
          (
            await pool.query(
              "SELECT to_regcollation('public.neo_competitor_query_ci') AS value",
            )
          ).rows[0].value,
        ).toBeNull();
        await pool.query("DELETE FROM competitor_variant_groups WHERE id='G '");
        await pool.query(migration);
        await pool.query(migration);
        await expect(
          pool.query("INSERT INTO competitor_variant_groups VALUES('G ')"),
        ).rejects.toThrow();
        expect(
          (
            await pool.query(
              "SELECT public.neo_competitor_query_like('Café','%CAFE%') AS value",
            )
          ).rows[0].value,
        ).toBe(true);
        await pool.query(rollback);
        await pool.query(rollback);
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM competitor_variant_groups',
            )
          ).rows[0].n,
        ).toBe(1);
        await pool.query(
          "CREATE COLLATION public.neo_competitor_query_ci (provider=icu,locale='und-u-ks-level3',deterministic=true)",
        );
        await expect(pool.query(migration)).rejects.toThrow(
          'Competitor query collation definition or ICU version differs',
        );
        await pool.query('ROLLBACK');
      } finally {
        await pool.end();
        await admin.query(`DROP DATABASE "${name}"`);
      }
    });
  },
);
