import { batchCreateAsinsResultSchema } from '@asin-monitor/contracts';
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
import { legacyAsinBatch } from './helpers/asin-batch-legacy';
import { legacyAsinBatchDatabase } from './helpers/asin-batch-legacy-database';
import { asinWriteApp } from './helpers/asin-write-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'batch ASIN creation / PostgreSQL savepoints, constraints and authorization',
  () => {
    let f: Awaited<ReturnType<typeof asinWriteApp>>;
    let headers: { authorization: string; origin: string };
    beforeAll(async () => {
      f = await asinWriteApp();
      await f.pools.primaryPool.query(
        'CREATE TABLE batch_failure_fixture(asin text PRIMARY KEY, code text NOT NULL)',
      );
      await f.pools.primaryPool.query('CREATE SEQUENCE batch_attempt_fixture');
      await f.pools.primaryPool.query(
        'CREATE TABLE batch_barrier_fixture(enabled boolean NOT NULL)',
      );
      await f.pools.primaryPool
        .query(`CREATE FUNCTION batch_failure_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE failure_code text;
      BEGIN PERFORM nextval('batch_attempt_fixture'); SELECT code INTO failure_code FROM batch_failure_fixture WHERE asin=NEW.asin;
      IF EXISTS(SELECT 1 FROM batch_barrier_fixture WHERE enabled) THEN PERFORM pg_advisory_xact_lock_shared(1095977294,193001); END IF;
      IF failure_code IS NOT NULL THEN RAISE EXCEPTION 'fixture private insertion failure' USING ERRCODE=failure_code; END IF; RETURN NEW; END $$`);
      await f.pools.primaryPool.query(
        'CREATE TRIGGER batch_failure_fixture BEFORE INSERT ON asins FOR EACH ROW EXECUTE FUNCTION batch_failure_fixture()',
      );
    });
    afterAll(async () => {
      try {
        if (f) await f.close();
      } finally {
        vi.restoreAllMocks();
      }
    });
    beforeEach(async () => {
      await f.pools.primaryPool.query(
        'TRUNCATE batch_failure_fixture, batch_barrier_fixture',
      );
      await f.pools.primaryPool.query(
        'ALTER SEQUENCE batch_attempt_fixture RESTART WITH 1',
      );
      await f.pools.primaryPool.query('DELETE FROM asins');
      await f.pools.primaryPool.query('DELETE FROM variant_groups');
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:write' ON CONFLICT DO NOTHING",
      );
      await login();
    });
    async function login() {
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u93-${userId}`, 'unused-fixture-hash'],
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
        origin: f.env.CORS_ORIGIN,
      };
    }
    const code = (index: number) => `B${String(index).padStart(9, '0')}`;
    const item = (index: number, parentId = 'g') => ({
      asin: code(index),
      country: 'US',
      site: 'amazon.com',
      brand: 'Fixture',
      parentId,
      name: `Product ${index}`,
      asinType: '1',
    });
    async function group(id = 'g', country = 'US') {
      await f.pools.primaryPool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand,create_time,update_time) VALUES($1,$1,$2,'amazon.com','Fixture','2020-01-01 08:00:00','2020-01-01 08:00:00')",
        [id, country],
      );
    }
    const write = (items: unknown[], auth = headers) =>
      f.http.inject({
        method: 'POST',
        url: '/api/v1/asins/batch-create',
        headers: auth,
        payload: { items },
      });
    const rows = async (table: 'variant_groups' | 'asins') =>
      (
        await f.pools.primaryPool.query(
          `SELECT row_to_json(t) AS data FROM ${table} t ORDER BY id`,
        )
      ).rows.map((row) => row.data);
    async function failAsin(asin: string, state = 'P0001') {
      await f.pools.primaryPool.query(
        'INSERT INTO batch_failure_fixture VALUES($1,$2)',
        [asin, state],
      );
    }
    async function blockedBy(client: PoolClient, kind = 'transactionid') {
      await vi.waitFor(
        async () => {
          expect(
            (
              await client.query(
                'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype=$1 AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
                [kind],
              )
            ).rows[0].n,
          ).toBeGreaterThan(0);
        },
        { timeout: 1000, interval: 10 },
      );
    }
    it.each([true, false])(
      'keeps a literal whitespace parent when trimmed neighbor exists=%s',
      async (withNeighbor) => {
        await group(' g ');
        if (withNeighbor) await group('g');
        const response = await write([item(1, ' g ')]);
        expect(response.statusCode).toBe(200);
        expect(response.json().data).toMatchObject({
          successCount: 1,
          results: [{ success: true, parentId: ' g ' }],
        });
        expect(await rows('asins')).toMatchObject([
          { variant_group_id: ' g ' },
        ]);
        if (withNeighbor)
          expect(
            (await rows('variant_groups')).find((row) => row.id === 'g')
              .update_time,
          ).toBe('2020-01-01T08:00:00');
      },
    );
    it('creates under a canonical all-space PostgreSQL parent and rejects unsafe IDs before SQL', async () => {
      await group('   ');
      const response = await write([
        item(1, '   '),
        item(2, ''),
        item(3, 'g\0x'),
        item(4, 'g\u0085x'),
        item(5, 'g\ud800x'),
        item(6, 'g'.repeat(51)),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        successCount: 1,
        failedCount: 5,
        results: expect.arrayContaining([
          {
            index: 0,
            id: expect.any(String),
            asin: code(1),
            country: 'US',
            success: true,
            parentId: '   ',
          },
        ]),
      });
      expect(await rows('asins')).toMatchObject([{ variant_group_id: '   ' }]);
    });
    it('serializes distinct 500-row batches at 4500 children and rejects the later group in full', async () => {
      await group();
      await f.pools.primaryPool
        .query(`INSERT INTO asins(id,asin,country,site,brand,variant_group_id)
        SELECT 'seed-'||n::text, 'S'||lpad(n::text,9,'0'),'US','amazon.com','Fixture','g' FROM generate_series(1,4500) n`);
      const firstHeaders = { ...headers };
      await login();
      await f.pools.primaryPool.query(
        'INSERT INTO batch_barrier_fixture VALUES(true)',
      );
      const blocker = await f.pools.primaryPool.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(1095977294,193001)');
        const first = write(
          Array.from({ length: 500 }, (_, index) => item(index)),
          firstHeaders,
        );
        pending.push(Promise.resolve(first).catch(() => {}));
        await blockedBy(blocker, 'advisory');
        const firstPid = (
          await blocker.query(
            "SELECT pid FROM pg_locks WHERE NOT granted AND locktype='advisory' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))",
          )
        ).rows[0].pid;
        const second = write(
          Array.from({ length: 500 }, (_, index) => item(index + 500)),
        );
        pending.push(Promise.resolve(second).catch(() => {}));
        await vi.waitFor(
          async () => {
            const waiting = await blocker.query(
              // pg_stat_activity can cache a backend snapshot in this observer
              // transaction before the second HTTP connection exists. pg_locks
              // reads the live lock manager and must prove a real transaction-ID
              // waiter blocked by the first batch while its insert is suspended.
              "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype='transactionid' AND $1=ANY(pg_blocking_pids(pid))",
              [firstPid],
            );
            expect(waiting.rows[0].n).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 10 },
        );
        await blocker.query('COMMIT');
        const responses = await Promise.all([first, second]);
        expect(responses.map((response) => response.statusCode)).toEqual([
          200, 200,
        ]);
        expect(
          responses.map((response) => response.json().data.successCount),
        ).toEqual([500, 0]);
        expect(responses[1].json().data.failedCount).toBe(500);
        expect(
          responses[1]
            .json()
            .data.errors.every((row: any) => row.message.includes('5000')),
        ).toBe(true);
        const count = await f.pools.primaryPool.query(
          "SELECT count(*)::int AS n FROM asins WHERE variant_group_id='g'",
        );
        expect(count.rows[0].n).toBe(5000);
        expect(
          (
            await f.http.inject({
              method: 'GET',
              url: '/api/v1/variant-groups/g',
              headers,
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        await blocker.query('ROLLBACK');
        await Promise.all(pending);
        blocker.release();
      }
    }, 15000);
    it('matches complete Legacy mixed-result phase ordering, counters and normalized inserts', async () => {
      await group();
      await group('uk', 'UK');
      await f.pools.primaryPool.query(
        "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) VALUES('existing',$1,'us','amazon.com','Fixture','g')",
        [code(5).toLowerCase()],
      );
      await failAsin(code(6));
      const items = [
        {
          ...item(0),
          asin: ` ${code(0).toLowerCase()} `,
          country: ' us ',
          name: ' Product zero ',
          asinType: 'MAIN_LINK',
        },
        { ...item(1), asin: 'bad' },
        item(0),
        item(3, 'missing'),
        item(4, 'uk'),
        item(5),
        item(6),
        item(7),
      ];
      const expected = await legacyAsinBatch(items, {
        groups: [
          { id: 'g', country: 'US' },
          { id: 'uk', country: 'UK' },
        ],
        existing: [{ asin: code(5).toLowerCase(), country: 'us' }],
        failAsin: code(6),
      });
      const response = await write(items);
      expect(response.statusCode).toBe(200);
      batchCreateAsinsResultSchema.parse(response.json());
      const data = response.json().data;
      for (const entry of data.results.filter((entry: any) => entry.success)) {
        expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
        entry.id = `new-${entry.index}`;
      }
      expect(data).toEqual(expected.result);
      expect(data.results.map((entry: any) => entry.index)).toEqual([
        1, 2, 3, 4, 5, 6, 0, 7,
      ]);
      const stored = await rows('asins');
      expect(stored).toHaveLength(3);
      expect(stored.find((row) => row.asin === code(0))).toMatchObject({
        country: 'US',
        name: 'Product zero',
        asin_type: '1',
        manual_broken: false,
        manual_excluded_from_group: false,
        is_broken: false,
        variant_status: 'NORMAL',
        feishu_notify_enabled: true,
      });
      expect(
        (await rows('variant_groups')).find((row) => row.id === 'uk')
          .update_time,
      ).toBe('2020-01-01T08:00:00');
      expect(
        (await rows('variant_groups')).find((row) => row.id === 'g')
          .update_time,
      ).not.toBe('2020-01-01T08:00:00');
      expect(response.body).not.toContain('private insertion');
    });
    it('returns all failed rows without touching a parent or attempting an insert', async () => {
      await group();
      const before = await rows('variant_groups');
      const response = await write([
        null,
        item(1, 'missing'),
        { ...item(2), country: 'CA' },
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        total: 3,
        successCount: 0,
        failedCount: 3,
      });
      expect(await rows('variant_groups')).toEqual(before);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT is_called FROM batch_attempt_fixture',
          )
        ).rows[0].is_called,
      ).toBe(false);
    });
    it('commits multiple 100-row blocks with unique records and explicit creation times', async () => {
      await group();
      const response = await write(
        Array.from({ length: 250 }, (_, index) => item(index)),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        total: 250,
        successCount: 250,
        failedCount: 0,
      });
      const stored = await rows('asins');
      expect(stored).toHaveLength(250);
      expect(new Set(stored.map((row) => row.asin)).size).toBe(250);
      expect(stored.every((row) => row.create_time === row.update_time)).toBe(
        true,
      );
      expect(
        response.json().data.results.map((entry: any) => entry.index),
      ).toEqual(Array.from({ length: 250 }, (_, index) => index));
    });
    it('recovers a failed second block to a savepoint and creates all other rows exactly once', async () => {
      await group();
      await failAsin(code(120));
      const response = await write(
        Array.from({ length: 220 }, (_, index) => item(index)),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        total: 220,
        successCount: 219,
        failedCount: 1,
        errors: [{ index: 120, message: '创建失败' }],
      });
      const stored = await rows('asins');
      expect(stored).toHaveLength(219);
      expect(new Set(stored.map((row) => row.asin)).size).toBe(219);
      expect(stored.some((row) => row.asin === code(120))).toBe(false);
      expect(
        Number(
          (
            await f.pools.primaryPool.query(
              'SELECT last_value FROM batch_attempt_fixture',
            )
          ).rows[0].last_value,
        ),
      ).toBeGreaterThan(220);
    });
    it('treats non-storable fields as row failures without blocking valid peers', async () => {
      await group();
      const response = await write([
        { ...item(1), name: 'x'.repeat(501) },
        { ...item(2), site: 'a\0b' },
        { ...item(3), parentId: 'a\0b' },
        item(4),
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        successCount: 1,
        failedCount: 3,
      });
      expect((await rows('asins')).map((row) => row.asin)).toEqual([code(4)]);
    });
    it('rolls back every successful block when updating a created parent fails', async () => {
      await group('g-fail-touch');
      const before = await rows('variant_groups');
      expect(
        (
          await write(
            Array.from({ length: 120 }, (_, index) =>
              item(index, 'g-fail-touch'),
            ),
          )
        ).statusCode,
      ).toBe(500);
      expect(await rows('asins')).toEqual([]);
      expect(await rows('variant_groups')).toEqual(before);
    });
    it.each(['57014', '40001'])(
      'aborts the whole batch on fatal SQLSTATE %s after an earlier successful block',
      async (state) => {
        await group();
        await failAsin(code(120), state);
        const before = await rows('variant_groups');
        const response = await write(
          Array.from({ length: 130 }, (_, index) => item(index)),
        );
        expect(response.statusCode).toBe(500);
        expect(response.json().data).toBeUndefined();
        expect(await rows('asins')).toEqual([]);
        expect(await rows('variant_groups')).toEqual(before);
      },
    );
    async function raceAtInsert(firstItems: unknown[], secondItems: unknown[]) {
      const firstHeaders = { ...headers };
      await login();
      await f.pools.primaryPool.query(
        'INSERT INTO batch_barrier_fixture VALUES(true)',
      );
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(1095977294,193001)');
        const responses = Promise.all([
          write(firstItems, firstHeaders),
          write(secondItems),
        ]);
        pending = responses.catch(() => {});
        // Both requests passed their existing-key query and reached BEFORE INSERT.
        await vi.waitFor(
          async () => {
            expect(
              (
                await blocker.query(
                  "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype='advisory' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))",
                )
              ).rows[0].n,
            ).toBe(2);
          },
          { timeout: 1000, interval: 10 },
        );
        await blocker.query('COMMIT');
        return await responses;
      } finally {
        await blocker.query('ROLLBACK');
        await pending;
        blocker.release();
      }
    }
    it('arbitrates simultaneous duplicate creation across separate parent groups', async () => {
      await group('a');
      await group('b');
      const responses = await raceAtInsert([item(1, 'a')], [item(1, 'b')]);
      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);
      expect(
        responses.map((response) => response.json().data.successCount).sort(),
      ).toEqual([0, 1]);
      expect(
        responses.map((response) => response.json().data.failedCount).sort(),
      ).toEqual([0, 1]);
      const stored = await rows('asins');
      expect(stored).toHaveLength(1);
      expect(
        (await rows('variant_groups')).filter(
          (row) => row.id !== stored[0].variant_group_id,
        )[0].update_time,
      ).toBe('2020-01-01T08:00:00');
    });
    it('avoids unique-key deadlocks for reversed overlapping batches in disjoint parents', async () => {
      await group('a');
      await group('b');
      const responses = await raceAtInsert(
        [item(2, 'a'), item(1, 'a')],
        [item(1, 'b'), item(2, 'b')],
      );
      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);
      expect(
        responses.reduce(
          (sum, response) => sum + response.json().data.successCount,
          0,
        ),
      ).toBe(2);
      expect(
        responses.reduce(
          (sum, response) => sum + response.json().data.failedCount,
          0,
        ),
      ).toBe(2);
      expect(await rows('asins')).toHaveLength(2);
    });
    it.each(['country', 'delete'])(
      'rechecks a parent after concurrent %s while waiting for its lock',
      async (change) => {
        await group();
        const blocker = await f.pools.primaryPool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            "SELECT id FROM variant_groups WHERE id='g' FOR UPDATE",
          );
          const response = write([item(1)]);
          pending = Promise.resolve(response).catch(() => {});
          await blockedBy(blocker);
          if (change === 'country')
            await blocker.query(
              "UPDATE variant_groups SET country='CA' WHERE id='g'",
            );
          else await blocker.query("DELETE FROM variant_groups WHERE id='g'");
          await blocker.query('COMMIT');
          const actual = await response;
          expect(actual.statusCode).toBe(200);
          expect(actual.json().data).toMatchObject({
            successCount: 0,
            failedCount: 1,
            errors: [
              {
                message:
                  change === 'country'
                    ? 'ASIN国家必须与所属变体组一致（CA）'
                    : '所属变体组不存在',
              },
            ],
          });
          expect(await rows('asins')).toEqual([]);
        } finally {
          await blocker.query('ROLLBACK');
          await pending;
          blocker.release();
        }
      },
    );
    it('rechecks cached write permission before any batch insert can occur', async () => {
      await group();
      expect(
        (
          await f.http.inject({
            method: 'GET',
            url: '/api/v1/variant-groups',
            headers,
          })
        ).statusCode,
      ).toBe(200);
      const before = await rows('variant_groups');
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        await blocker.query(
          "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id='writer-71' AND p.code='asin:write'",
        );
        const response = write([item(1)]);
        pending = Promise.resolve(response).catch(() => {});
        await blockedBy(blocker, 'advisory');
        await blocker.query('COMMIT');
        expect((await response).statusCode).toBe(403);
        expect(await rows('asins')).toEqual([]);
        expect(await rows('variant_groups')).toEqual(before);
      } finally {
        await blocker.query('ROLLBACK');
        await pending;
        blocker.release();
      }
    });
  },
);

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'actual Legacy MySQL batch canonical parents and locking current capacity',
  () => {
    let legacy: Awaited<ReturnType<typeof legacyAsinBatchDatabase>>;
    beforeAll(async () => {
      legacy = await legacyAsinBatchDatabase();
    });
    afterAll(async () => {
      if (legacy) await legacy.close();
    });
    beforeEach(async () => {
      await legacy.query('DELETE FROM asins');
      await legacy.query('DELETE FROM variant_groups');
    });
    const item = (index: number, parentId = 'g') => ({
      asin: `B${String(index).padStart(9, '0')}`,
      country: 'US',
      site: 'amazon.com',
      brand: 'Fixture',
      parentId,
    });
    const group = (id: string) =>
      legacy.query(
        "INSERT INTO variant_groups(id,name,country,site,brand,update_time) VALUES(?,?,'US','amazon.com','Fixture','2020-01-01 08:00:00')",
        [id, id],
      );
    it.each([true, false])(
      'keeps the raw MySQL parent when trimmed neighbor exists=%s',
      async (neighbor) => {
        await group(' g ');
        if (neighbor) await group('g');
        const result = await legacy.batch([item(1, ' g ')]);
        expect(result).toMatchObject({
          successCount: 1,
          results: [{ success: true, parentId: ' g ' }],
        });
        expect(
          await legacy.query('SELECT variant_group_id FROM asins'),
        ).toMatchObject([{ variant_group_id: ' g ' }]);
        if (neighbor) {
          const rows = await legacy.query(
            "SELECT update_time FROM variant_groups WHERE id='g'",
          );
          expect(rows[0].update_time.getTime()).toBe(
            new Date('2020-01-01T00:00:00Z').getTime(),
          );
        }
      },
    );
    it('creates under a canonical all-space MySQL parent and rejects unsafe IDs before SQL', async () => {
      await group('   ');
      const result = await legacy.batch([
        item(1, '   '),
        item(2, ''),
        item(3, 'g\0x'),
        item(4, 'g\u0085x'),
        item(5, 'g\ud800x'),
        item(6, 'g'.repeat(51)),
      ]);
      expect(result).toMatchObject({ successCount: 1, failedCount: 5 });
      expect(result.results.find((row) => row.success)).toMatchObject({
        parentId: '   ',
      });
      expect(
        await legacy.query('SELECT variant_group_id FROM asins'),
      ).toMatchObject([{ variant_group_id: '   ' }]);
    });
    it('recounts after a real parent-lock wait despite an older RR snapshot and rejects 4500+500+500 overflow', async () => {
      await group('g');
      const values = Array.from({ length: 4500 }, (_, index) => [
        `seed-${index}`,
        `S${String(index).padStart(9, '0')}`,
        'US',
        'amazon.com',
        'Fixture',
        'g',
      ]);
      await legacy.query(
        'INSERT INTO asins(id,asin,country,site,brand,variant_group_id) VALUES ?',
        [values],
      );
      const pause = legacy.pauseFirstInsert();
      const pending: Promise<unknown>[] = [];
      try {
        const first = legacy.batch(
          Array.from({ length: 500 }, (_, index) => item(index)),
        );
        pending.push(first.catch(() => {}));
        await Promise.race([
          pause.ready,
          first.then(() => {
            throw new Error('Expected first transaction to reach insertion');
          }),
        ]);
        const second = legacy.batch(
          Array.from({ length: 500 }, (_, index) => item(index + 500)),
        );
        pending.push(second.catch(() => {}));
        await vi.waitFor(
          async () => {
            expect(await legacy.parentIsBlocked()).toBe(true);
          },
          { timeout: 1000, interval: 10 },
        );
        pause.release();
        const results = await Promise.all([first, second]);
        expect(results.map((result) => result.successCount)).toEqual([500, 0]);
        expect(results[1].failedCount).toBe(500);
        expect(
          results[1].errors.every((row) => row.message.includes('5000')),
        ).toBe(true);
        expect(
          Number(
            (
              await legacy.query(
                "SELECT COUNT(*) AS n FROM asins WHERE variant_group_id='g'",
              )
            )[0].n,
          ),
        ).toBe(5000);
      } finally {
        pause.release();
        await Promise.all(pending);
      }
    }, 15000);
  },
);
