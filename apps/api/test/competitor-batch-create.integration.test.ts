import {
  competitorBatchCreateResultSchema,
  type BatchCreateAsinsData,
} from '@asin-monitor/contracts';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
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
import { legacyCompetitorQueryFixture } from './helpers/competitor-query-legacy';
import { competitorWriteApp } from './helpers/competitor-write-app';

const item = {
  asin: 'B000000125',
  country: 'US',
  brand: 'Own brand',
  parentId: 'g1',
  asinType: 'MAIN_LINK',
};
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'competitor batch creation / actual MySQL and two PostgreSQL databases',
  () => {
    let f: Awaited<ReturnType<typeof competitorWriteApp>>,
      legacy: Awaited<ReturnType<typeof legacyCompetitorQueryFixture>>;
    let userId: string, sessionId: string, headers: { authorization: string };
    beforeAll(async () => {
      f = await competitorWriteApp();
      legacy = await legacyCompetitorQueryFixture();
      await f.pools.competitorPool.query(`
      CREATE TABLE batch_failure_fixture(asin text PRIMARY KEY,code text NOT NULL);
      CREATE TABLE batch_touch_failure(id text PRIMARY KEY);
      CREATE SEQUENCE batch_attempts;
      CREATE FUNCTION batch_reject_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE failure text;
      BEGIN
        PERFORM nextval('batch_attempts');
        SELECT code INTO failure FROM batch_failure_fixture WHERE asin=NEW.asin;
        IF failure IS NOT NULL THEN RAISE EXCEPTION 'private-batch-driver-payload' USING ERRCODE=failure; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER batch_reject_fixture BEFORE INSERT ON competitor_asins FOR EACH ROW EXECUTE FUNCTION batch_reject_fixture();
      CREATE FUNCTION batch_reject_touch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM batch_touch_failure WHERE id=NEW.id) THEN RAISE EXCEPTION 'private-batch-touch'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER batch_reject_touch BEFORE UPDATE ON competitor_variant_groups FOR EACH ROW EXECUTE FUNCTION batch_reject_touch();
    `);
      await legacy.query(
        'CREATE TABLE batch_failure_fixture(asin varchar(20) PRIMARY KEY)',
      );
      await legacy.query(`CREATE TRIGGER batch_reject_fixture BEFORE INSERT ON competitor_asins FOR EACH ROW
      BEGIN IF EXISTS(SELECT 1 FROM batch_failure_fixture WHERE asin=NEW.asin) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='创建失败'; END IF; END`);
    });
    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        await legacy?.close();
        vi.restoreAllMocks();
      }
    });
    beforeEach(async () => {
      await f.pools.competitorPool.query(
        'DELETE FROM batch_failure_fixture; DELETE FROM batch_touch_failure; ALTER SEQUENCE batch_attempts RESTART',
      );
      await legacy.query('DELETE FROM batch_failure_fixture');
      for (const table of [
        'competitor_monitor_history',
        'competitor_asins',
        'competitor_variant_groups',
      ]) {
        await f.pools.competitorPool.query(`DELETE FROM ${table}`);
        await legacy.query(`DELETE FROM ${table}`);
      }
      userId = randomUUID();
      sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
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
      await group('g1');
      await group('g2');
    });
    const request = (items: unknown[]) =>
      f.http.inject({
        method: 'POST',
        url: '/api/v1/competitor/asins/batch-create',
        headers,
        payload: { items },
      });
    const read = () =>
      f.http.inject({
        method: 'GET',
        url: '/api/v1/competitor/variant-groups',
        headers,
      });
    async function group(id: string, country = 'US') {
      const values = [id, `Group ${id}`, country, 'Parent brand'];
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_variant_groups(id,name,country,brand,feishu_notify_enabled,create_time,update_time) VALUES($1,$2,$3,$4,true,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        values,
      );
      await legacy.query(
        "INSERT INTO competitor_variant_groups(id,name,country,brand,feishu_notify_enabled,create_time,update_time) VALUES(?,?,?,?,1,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        values,
      );
    }
    async function existing(code = item.asin, country = 'US') {
      const values = [randomUUID(), code, country];
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id,create_time,update_time) VALUES($1,$2,$3,'Existing brand','g2','2020-01-01 08:00:00','2020-01-01 08:00:00')",
        values,
      );
      await legacy.query(
        "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id,create_time,update_time) VALUES(?,?,?,'Existing brand','g2','2020-01-01 08:00:00','2020-01-01 08:00:00')",
        values,
      );
    }
    async function snapshot() {
      return {
        groups: (
          await f.pools.competitorPool.query(
            'SELECT * FROM competitor_variant_groups ORDER BY id',
          )
        ).rows,
        asins: (
          await f.pools.competitorPool.query(
            'SELECT * FROM competitor_asins ORDER BY id',
          )
        ).rows,
      };
    }
    async function compare(items: unknown[]) {
      const response = await request(items);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      competitorBatchCreateResultSchema.parse(response.json());
      const data = response.json().data as BatchCreateAsinsData;
      // UUIDs are generated for every source input, even failed rows. Align the
      // generator before executing the real service; never rewrite either result.
      const ids = items.map(() => randomUUID() as string);
      for (const row of data.results)
        if (row.success) ids[row.index] = row.id as string;
      legacy.useGeneratedIds(ids);
      const expected = await legacy.batchCreateAsins({ items });
      expect(response.statusCode).toBe(expected.statusCode);
      expect(response.json()).toEqual(expected.body);
      const columns =
        'id,asin,name,asin_type,country,brand,variant_group_id,is_broken,variant_status,feishu_notify_enabled,last_check_time';
      const normalize = (rows: Record<string, unknown>[]) =>
        rows.map((row) => ({
          ...row,
          is_broken: row.is_broken == null ? null : !!row.is_broken,
          feishu_notify_enabled:
            row.feishu_notify_enabled == null
              ? null
              : !!row.feishu_notify_enabled,
        }));
      expect(
        normalize(
          (
            await f.pools.competitorPool.query(
              `SELECT ${columns} FROM competitor_asins ORDER BY id`,
            )
          ).rows,
        ),
      ).toEqual(
        normalize(
          await legacy.query(
            `SELECT ${columns} FROM competitor_asins ORDER BY id`,
          ),
        ),
      );
      const touched = new Set(
        data.results.filter((row) => row.success).map((row) => row.parentId),
      );
      for (const row of (await snapshot()).groups) {
        if (touched.has(row.id))
          expect(row.update_time).not.toEqual(row.create_time);
        else expect(row.update_time).toEqual(row.create_time);
      }
      return data;
    }
    async function failure(asin: string, code = 'P0001') {
      await f.pools.competitorPool.query(
        'INSERT INTO batch_failure_fixture VALUES($1,$2)',
        [asin, code],
      );
      await legacy.query('INSERT INTO batch_failure_fixture VALUES(?)', [asin]);
    }
    async function blocked(client: PoolClient) {
      await vi.waitFor(
        async () =>
          expect(
            (
              await client.query(
                'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
              )
            ).rows[0].n,
          ).toBeGreaterThan(0),
        { timeout: 1000, interval: 10 },
      );
    }
    it('matches the entire mixed result, validation phases, inserted rows and touched groups', async () => {
      await existing('b000000125 ');
      const data = await compare([
        {
          ...item,
          asin: ' b000000126 ',
          name: ' New ',
          asinType: ' SUB_REVIEW ',
          site: 'ignored\0' + 'x'.repeat(101),
        },
        { ...item, asin: 'bad', country: '', brand: '', parentId: '' },
        { ...item, asin: 'B000000127', parentId: 'missing' },
        item,
        { ...item, asin: 'B000000128', country: 'DE' },
        { ...item, asin: 'B000000129', brand: '' },
        { ...item, asin: 'B000000126', parentId: 'g2' },
        {
          ...item,
          asin: 'B000000130',
          parentId: undefined,
          variantGroupId: 'g1',
          name: false,
          asinType: false,
        },
        null,
      ]);
      expect(data.results.map((row) => row.index)).toEqual([
        1, 5, 6, 8, 2, 4, 3, 0, 7,
      ]);
      expect(data.successCount).toBe(2);
      const created = (await snapshot()).asins.filter(
        (row) => row.variant_group_id === 'g1',
      );
      expect(
        created.every(
          (row) =>
            row.feishu_notify_enabled === false &&
            row.is_broken === false &&
            row.variant_status === 'NORMAL',
        ),
      ).toBe(true);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT * FROM competitor_variant_groups',
          )
        ).rows,
      ).toEqual([{ id: 'g1', name: 'wrong-primary-data' }]);
    });
    it.each(['G1', 'gréup', 'GROUP', 'group '])(
      'preserves exact parent Map lookup after CI MySQL selection: %s',
      async (parentId) => {
        await group('Gréup');
        await group('group ');
        const data = await compare([{ ...item, parentId }]);
        expect(data.errors[0].message).toBe('所属变体组不存在');
      },
    );
    it.each([false, true])(
      'keeps first-input priority for accent-equivalent countries, reverse=%s',
      async (reverse) => {
        await group('accent', 'ÚS');
        const rows = [
          { ...item, country: 'ÚS', parentId: 'accent' },
          { ...item, parentId: 'g1' },
        ];
        const data = await compare(reverse ? rows.reverse() : rows);
        expect(data.results.map((row) => [row.index, row.success])).toEqual([
          [1, false],
          [0, true],
        ]);
      },
    );
    it('preserves the later write-error phase for a stored accent-equivalent identity', async () => {
      await existing('B000000É25');
      const data = await compare([
        { ...item, asin: 'B000000E25' },
        { ...item, parentId: 'missing' },
        { ...item, asin: 'B000000126' },
      ]);
      expect(data.results.map((row) => row.index)).toEqual([1, 0, 2]);
      expect(data.errors[1].message).toBe('ASIN B000000E25 在国家 US 中已存在');
    });
    it('recovers the failed bulk statement before retrying each row and continuing the next chunk', async () => {
      await failure('B000000002');
      const items = Array.from({ length: 101 }, (_, index) => ({
        ...item,
        asin: `B${String(index + 1).padStart(9, '0')}`,
      }));
      const data = await compare(items);
      expect(data).toMatchObject({
        total: 101,
        successCount: 100,
        failedCount: 1,
      });
      expect(data.results[0]).toMatchObject({ index: 1, message: '创建失败' });
      expect(
        (
          await f.pools.competitorPool.query(
            'SELECT last_value FROM batch_attempts',
          )
        ).rows[0].last_value,
      ).toBe('103');
      expect(JSON.stringify(data)).not.toContain('private-batch');
    });
    it.each(['22001', '23514'])(
      'recovers a real row-local PostgreSQL %s error without exposing driver text',
      async (code) => {
        await failure('B000000126', code);
        const data = await compare([
          item,
          { ...item, asin: 'B000000126' },
          { ...item, asin: 'B000000127' },
        ]);
        expect(data.successCount).toBe(2);
        expect(data.errors).toEqual([
          { index: 1, asin: 'B000000126', country: 'US', message: '创建失败' },
        ]);
      },
    );
    it('accepts all 1000 rows across ten real insert chunks', async () => {
      const items = Array.from({ length: 1000 }, (_, index) => ({
        ...item,
        asin: `B${String(index).padStart(9, '0')}`,
      }));
      const data = await compare(items);
      expect(data).toMatchObject({
        total: 1000,
        successCount: 1000,
        failedCount: 0,
      });
      expect(data.results.map((row) => row.index)).toEqual(
        items.map((_, index) => index),
      );
    });
    it('isolates oversized/NUL persisted text while ignoring site and retaining other successes', async () => {
      const response = await request([
        { ...item, name: 'x'.repeat(501) },
        { ...item, asin: 'B000000126', brand: 'private\0brand' },
        { ...item, asin: 'B000000127', parentId: 'a\0b' },
        { ...item, asin: 'B000000128', site: 'ignored\0' + 'x'.repeat(101) },
      ]);
      expect(response.statusCode).toBe(200);
      expect(
        response.json().data.results.map((row: { index: number }) => row.index),
      ).toEqual([2, 0, 1, 3]);
      expect(response.json().data.successCount).toBe(1);
      expect((await snapshot()).asins[0].asin).toBe('B000000128');
      expect(response.body).not.toContain('private');
    });
    it.each(['40001', '40P01', '57014', '08006'])(
      'rolls back earlier successful chunks on transaction-level SQLSTATE %s',
      async (code) => {
        const before = await snapshot();
        await failure('B000000101', code);
        const response = await request(
          Array.from({ length: 101 }, (_, index) => ({
            ...item,
            asin: `B${String(index + 1).padStart(9, '0')}`,
          })),
        );
        expect(response.statusCode).toBe(500);
        expect(response.json().data).toBeUndefined();
        expect(
          response.body + JSON.stringify(f.logger.error.mock.calls),
        ).not.toContain('private-batch');
        expect(await snapshot()).toEqual(before);
        await f.pools.competitorPool.query('DELETE FROM batch_failure_fixture');
        expect((await request([item])).statusCode).toBe(200);
      },
    );
    it('rolls back all inserts and parent timestamps when the final parent touch fails', async () => {
      const before = await snapshot();
      await f.pools.competitorPool.query(
        "INSERT INTO batch_touch_failure VALUES('g2')",
      );
      const response = await request([
        item,
        { ...item, asin: 'B000000126', parentId: 'g2' },
      ]);
      expect(response.statusCode).toBe(500);
      expect(await snapshot()).toEqual(before);
      expect(
        response.body + JSON.stringify(f.logger.error.mock.calls),
      ).not.toContain('private-batch');
    });
    it('does not touch parents for an entirely invalid batch', async () => {
      const before = await snapshot();
      expect(
        (
          await compare([
            null,
            { ...item, asin: 'bad' },
            { ...item, parentId: 'missing' },
          ])
        ).successCount,
      ).toBe(0);
      expect(await snapshot()).toEqual(before);
    });
    it.each(['permission', 'session', 'user', 'password-expiry'])(
      'rejects current primary %s changes despite a warmed cache',
      async (kind) => {
        expect((await read()).statusCode).toBe(200);
        const before = await snapshot();
        if (kind === 'permission')
          await f.pools.primaryPool.query(
            'DELETE FROM user_roles WHERE user_id=$1',
            [userId],
          );
        if (kind === 'session')
          await f.pools.primaryPool.query(
            "UPDATE sessions SET status='REVOKED' WHERE id=$1",
            [sessionId],
          );
        if (kind === 'user')
          await f.pools.primaryPool.query(
            "UPDATE users SET status='DISABLED' WHERE id=$1",
            [userId],
          );
        if (kind === 'password-expiry')
          await f.pools.primaryPool.query(
            "UPDATE users SET password_expires_at='2020-01-01' WHERE id=$1",
            [userId],
          );
        expect([401, 403]).toContain((await request([item])).statusCode);
        expect(await snapshot()).toEqual(before);
      },
    );
    it('fails closed while 0011 is rolled back, then recovers after policy reinstall', async () => {
      const before = await snapshot();
      await f.applyPolicy(true);
      try {
        expect((await request([item])).statusCode).toBe(503);
        expect(await snapshot()).toEqual(before);
      } finally {
        await f.applyPolicy();
      }
      expect((await request([item])).statusCode).toBe(200);
    });
    it('serializes reverse-order overlapping batches across different parents without deadlock', async () => {
      const items = Array.from({ length: 20 }, (_, index) => ({
        ...item,
        asin: `B${String(index).padStart(9, '0')}`,
      }));
      const results = await Promise.all([
        request(items),
        request(
          [...items].reverse().map((row) => ({ ...row, parentId: 'g2' })),
        ),
      ]);
      expect(results.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);
      expect(
        results.reduce(
          (total, response) => total + response.json().data.successCount,
          0,
        ),
      ).toBe(20);
      expect((await snapshot()).asins).toHaveLength(20);
    });
    it('rechecks parent country after a concurrent committed change during lock wait', async () => {
      const blocker = await f.pools.competitorPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof request>>> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "UPDATE competitor_variant_groups SET country='DE' WHERE id='g1'",
        );
        pending = Promise.resolve(request([item]));
        await blocked(blocker);
        await blocker.query('COMMIT');
        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(response.json().data.errors[0].message).toBe(
          'ASIN国家必须与所属变体组一致（DE）',
        );
        expect((await snapshot()).asins).toHaveLength(0);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending?.catch(() => {});
      }
    });
    it('bounds real lock waits and releases both transactions for subsequent requests', async () => {
      const before = await snapshot(),
        blocker = await f.pools.competitorPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM competitor_variant_groups WHERE id='g1' FOR UPDATE",
        );
        const started = Date.now();
        expect((await request([item])).statusCode).toBe(500);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(await snapshot()).toEqual(before);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect((await request([item])).statusCode).toBe(200);
    });
    it('keeps primary authorization locked until the complete competitor batch commits', async () => {
      const blocker = await f.pools.competitorPool.connect(),
        changer = await f.pools.primaryPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof request>>> | undefined,
        changed: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE competitor_variant_groups IN ACCESS EXCLUSIVE MODE',
        );
        pending = Promise.resolve(
          request([item, { ...item, asin: 'B000000126' }]),
        );
        await blocked(blocker);
        const pid = (await changer.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        changed = changer.query(
          'UPDATE users SET force_password_change=true WHERE id=$1',
          [userId],
        );
        await vi.waitFor(
          async () =>
            expect(
              (
                await f.pools.primaryPool.query(
                  'SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND NOT granted',
                  [pid],
                )
              ).rows[0].n,
            ).toBeGreaterThan(0),
          { timeout: 1000, interval: 10 },
        );
        await blocker.query('ROLLBACK');
        expect((await pending).statusCode).toBe(200);
        await changed;
        expect((await snapshot()).asins).toHaveLength(2);
        expect([401, 403]).toContain(
          (await request([{ ...item, asin: 'B000000127' }])).statusCode,
        );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await changed?.catch(() => {});
        changer.release();
        await pending?.catch(() => {});
      }
    });
  },
);
