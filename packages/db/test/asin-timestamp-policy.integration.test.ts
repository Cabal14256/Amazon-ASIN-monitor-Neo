import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createDb, createPgPool } from '../src/client';
import {
  AsinTimestampPolicyError,
  prepareAsinTimestampWrites,
} from '../src/repositories/asin-timestamp-policy';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'ASIN timestamp policy with real baseline triggers',
  () => {
    const schema = `asin_timestamp_86_${randomUUID().replace(/-/g, '')}`;
    const tables = ['variant_groups', 'asins'] as const;
    let bootstrap: Pool;
    let pool: Pool;
    let installed = false;
    const migration = (rollback = false) =>
      readFileSync(
        resolve(
          __dirname,
          `../migrations/0004_asin_timestamp_policy${
            rollback ? '.rollback' : ''
          }.sql`,
        ),
        'utf8',
      ).replaceAll('public', schema);
    async function apply(rollback = false, source = migration(rollback)) {
      const connection = await pool.connect();
      try {
        await connection.query(source);
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        await connection.query(`SET search_path TO ${schema}, public`);
        connection.release();
      }
    }
    async function transaction(
      operation: (client: PoolClient) => Promise<void>,
      commit = false,
    ) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await operation(client);
        if (commit) await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    const prepare = (client: PoolClient) =>
      prepareAsinTimestampWrites(createDb(client), () => {});
    const snapshot = async () =>
      Promise.all(
        tables.map(
          async (table) =>
            (
              await pool.query(
                `SELECT row_to_json(t)::text AS data FROM ${table} t ORDER BY id`,
              )
            ).rows,
        ),
      );
    const probe = () => transaction(prepare);
    async function waiting(blocker: PoolClient, kind: string) {
      await vi.waitFor(
        async () => {
          const result = await blocker.query(
            'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype=$1 AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
            [kind],
          );
          expect(result.rows[0].n).toBeGreaterThan(0);
        },
        { timeout: 1500, interval: 10 },
      );
    }
    beforeAll(async () => {
      if (!/^asin_timestamp_86_[0-9a-f]{32}$/.test(schema))
        throw new Error('Invalid fixture schema');
      bootstrap = createPgPool(process.env.DATABASE_URL!, {
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      installed = true;
      for (const table of tables)
        await bootstrap.query(
          `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
        );
      // LIKE does not copy triggers. Install the actual 0000 function and triggers.
      const baseline = readFileSync(
        resolve(__dirname, '../migrations/0000_baseline.sql'),
        'utf8',
      );
      const baselineFunction = baseline.match(
        /CREATE OR REPLACE FUNCTION set_updated_timestamp_column\(\)[\s\S]*?\$\$;/,
      )?.[0];
      if (!baselineFunction)
        throw new Error('Baseline timestamp function not found');
      await bootstrap.query(
        baselineFunction.replace(
          'FUNCTION set_updated_timestamp_column',
          `FUNCTION ${schema}.set_updated_timestamp_column`,
        ),
      );
      const url = new URL(process.env.DATABASE_URL!);
      url.searchParams.set(
        'options',
        `-c search_path=${schema},public -c timezone=UTC -c statement_timeout=5000`,
      );
      pool = createPgPool(url.toString(), {
        max: 6,
        connectionTimeoutMillis: 2000,
      });
      await apply(true);
    });
    afterAll(async () => {
      try {
        if (pool) await pool.end();
      } finally {
        if (bootstrap) {
          try {
            if (installed)
              await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
          } finally {
            await bootstrap.end();
          }
        }
      }
    });
    beforeEach(async () => {
      await apply();
      await pool.query('TRUNCATE asins, variant_groups');
      await pool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand,update_time) VALUES('g','group','US','site','brand','2020-01-01 08:00:00')",
      );
      await pool.query(
        "INSERT INTO asins(id,asin,name,country,site,brand,variant_group_id,update_time) VALUES('a','ASIN','asin','US','site','brand','g','2020-01-01 08:00:00')",
      );
    });

    it('reproduces baseline overwrite and refuses its old policy before setting explicit mode', async () => {
      await apply(true);
      for (const table of tables) {
        const changed = await pool.query(
          `UPDATE ${table} SET update_time='2001-01-01' RETURNING update_time='2001-01-01'::timestamp AS preserved`,
        );
        expect(changed.rows[0].preserved).toBe(false);
      }
      await expect(probe()).rejects.toBeInstanceOf(AsinTimestampPolicyError);
      await transaction(async (client) => {
        expect(
          (
            await client.query(
              "SELECT COALESCE(current_setting('asin_monitor.timestamp_mode',true),'') AS mode",
            )
          ).rows[0].mode,
        ).toBe('');
      });
    });
    it('repeats upgrade and rollback without changing historical rows', async () => {
      const before = await snapshot();
      await apply();
      await apply();
      await probe();
      await apply(true);
      await apply(true);
      expect(await snapshot()).toEqual(before);
      await expect(probe()).rejects.toBeInstanceOf(AsinTimestampPolicyError);
      await apply();
      await probe();
      expect(await snapshot()).toEqual(before);
    });
    it.each(
      tables.flatMap((table) =>
        [null, '2001-02-03 04:05:06.123456', '2099-12-31 23:59:59.999999'].map(
          (time) => ({ table, time }),
        ),
      ),
    )(
      'preserves explicit timestamp $time for $table in UTC connections',
      async ({ table, time }) => {
        const result = await pool.query(
          `UPDATE ${table} SET name='changed',update_time=$1 RETURNING update_time::text AS time`,
          [time],
        );
        expect(result.rows[0].time).toBe(time);
      },
    );
    it.each(tables)(
      'uses Shanghai current wall time for actual changes to %s and leaves no-ops unchanged',
      async (table) => {
        expect((await pool.query('SHOW timezone')).rows[0].TimeZone).toBe(
          'UTC',
        );
        await pool.query(`UPDATE ${table} SET name=name`);
        expect(
          (await pool.query(`SELECT update_time::text AS time FROM ${table}`))
            .rows[0].time,
        ).toBe('2020-01-01 08:00:00');
        const before = (
          await pool.query(
            "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::text AS time",
          )
        ).rows[0].time;
        await pool.query(`UPDATE ${table} SET name='changed'`);
        expect(
          (
            await pool.query(
              `SELECT update_time >= $1::timestamp AND update_time <= clock_timestamp() AT TIME ZONE 'Asia/Shanghai' AS valid FROM ${table}`,
              [before],
            )
          ).rows[0].valid,
        ).toBe(true);
        await pool.query(`UPDATE ${table} SET update_time=NULL`);
        await pool.query(`UPDATE ${table} SET name=name`);
        expect(
          (await pool.query(`SELECT update_time FROM ${table}`)).rows[0]
            .update_time,
        ).toBeNull();
      },
    );
    it.each([false, true])(
      'explicit mode retains old and NULL timestamps and resets after commit=%s',
      async (commit) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await prepare(client);
          await client.query(
            "UPDATE variant_groups SET name='managed',update_time=update_time",
          );
          await client.query(
            "UPDATE asins SET name='managed',update_time=NULL",
          );
          await client.query(
            "UPDATE asins SET asin_type='MAIN_LINK',update_time=update_time",
          );
          expect(
            (
              await client.query(
                'SELECT update_time::text AS time FROM variant_groups',
              )
            ).rows[0].time,
          ).toBe('2020-01-01 08:00:00');
          expect(
            (await client.query('SELECT update_time FROM asins')).rows[0]
              .update_time,
          ).toBeNull();
          await client.query(commit ? 'COMMIT' : 'ROLLBACK');
          expect(
            (
              await client.query(
                "SELECT COALESCE(current_setting('asin_monitor.timestamp_mode',true),'') AS mode",
              )
            ).rows[0].mode,
          ).toBe('');
          expect(
            (await client.query('SELECT name FROM asins')).rows[0].name,
          ).toBe(commit ? 'managed' : 'asin');
          const result = await client.query(
            "UPDATE variant_groups SET name='default again' RETURNING update_time > '2020-01-01 08:00:00'::timestamp AS advanced",
          );
          expect(result.rows[0].advanced).toBe(true);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      },
    );
    it('rejects unsupported transaction mode with fixed error and rolls back writes', async () => {
      const before = await snapshot();
      await expect(
        transaction(async (client) => {
          await client.query(
            "SET LOCAL asin_monitor.timestamp_mode='unexpected'",
          );
          await client.query("UPDATE asins SET name='must roll back'");
        }, true),
      ).rejects.toMatchObject({
        code: '22023',
        message: 'Unsupported ASIN timestamp mode',
      });
      expect(await snapshot()).toEqual(before);
    });
    it.each(tables)(
      'does not restore transaction/statement start time after a real row lock wait on %s',
      async (table) => {
        const blocker = await pool.connect();
        const waiter = await pool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await blocker.query('BEGIN');
          await blocker.query(`SELECT id FROM ${table} FOR UPDATE`);
          await waiter.query('BEGIN');
          const write = waiter.query(
            `UPDATE ${table} SET name='waiter' RETURNING extract(epoch FROM update_time)::text AS time`,
          );
          pending = write.catch(() => {});
          await waiting(blocker, 'transactionid');
          const newer = await blocker.query(
            `UPDATE ${table} SET name='blocker' RETURNING extract(epoch FROM update_time)::text AS time`,
          );
          await blocker.query('COMMIT');
          const result = await write;
          await waiter.query('COMMIT');
          expect(Number(result.rows[0].time)).toBeGreaterThanOrEqual(
            Number(newer.rows[0].time),
          );
          expect(
            (await pool.query(`SELECT name FROM ${table}`)).rows[0].name,
          ).toBe('waiter');
        } finally {
          await blocker.query('ROLLBACK');
          await pending;
          await waiter.query('ROLLBACK');
          blocker.release();
          waiter.release();
        }
      },
    );
    it.each([
      'ALTER TABLE asins DISABLE TRIGGER trg_asins_update_time',
      'DROP TRIGGER trg_asins_update_time ON asins',
      "COMMENT ON FUNCTION set_asin_update_timestamp() IS 'wrong-version'",
      'DROP TRIGGER trg_asins_update_time ON asins; CREATE TRIGGER trg_asins_update_time AFTER UPDATE ON asins FOR EACH ROW EXECUTE FUNCTION set_asin_update_timestamp()',
      'DROP TRIGGER trg_asins_update_time ON asins; CREATE TRIGGER trg_asins_update_time BEFORE UPDATE OF name ON asins FOR EACH ROW EXECUTE FUNCTION set_asin_update_timestamp()',
      'DROP TRIGGER trg_asins_update_time ON asins; CREATE TRIGGER trg_asins_update_time BEFORE UPDATE ON asins FOR EACH ROW WHEN (NEW.name IS NOT NULL) EXECUTE FUNCTION set_asin_update_timestamp()',
    ])('fails closed for altered policy: %s', async (change) => {
      await pool.query(change);
      await expect(probe()).rejects.toBeInstanceOf(AsinTimestampPolicyError);
    });
    it('refuses replication mode where normal triggers would not fire', async () => {
      await expect(
        transaction(async (client) => {
          await client.query("SET LOCAL session_replication_role='replica'");
          await prepare(client);
        }),
      ).rejects.toBeInstanceOf(AsinTimestampPolicyError);
    });
    it('holds compatible table locks through commit so trigger changes cannot race the probe', async () => {
      const writer = await pool.connect();
      const ddl = await pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await writer.query('BEGIN');
        await prepare(writer);
        await probe(); // Another writer can prepare before this one commits.
        const alter = ddl.query(
          'ALTER TABLE asins DISABLE TRIGGER trg_asins_update_time',
        );
        pending = alter.catch(() => {});
        await waiting(writer, 'relation');
        await writer.query('COMMIT');
        await alter;
        await expect(probe()).rejects.toBeInstanceOf(AsinTimestampPolicyError);
      } finally {
        await writer.query('ROLLBACK');
        await pending;
        writer.release();
        ddl.release();
      }
    });
    it('rolls back a failed upgrade atomically and leaves the baseline available', async () => {
      await apply(true);
      const before = await snapshot();
      const source = migration().replace(
        'COMMIT;',
        "DO $$ BEGIN RAISE EXCEPTION 'fixture upgrade failure'; END $$; COMMIT;",
      );
      await expect(apply(false, source)).rejects.toMatchObject({
        message: 'fixture upgrade failure',
      });
      await expect(probe()).rejects.toBeInstanceOf(AsinTimestampPolicyError);
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await pool.query('SELECT to_regprocedure($1) AS policy', [
            `${schema}.set_asin_update_timestamp()`,
          ])
        ).rows[0].policy,
      ).toBeNull();
      await apply();
      await probe();
    });
    it('rolls back a failed policy removal without losing upgraded behavior or data', async () => {
      const before = await snapshot();
      const source = migration(true).replace(
        'COMMIT;',
        "DO $$ BEGIN RAISE EXCEPTION 'fixture rollback failure'; END $$; COMMIT;",
      );
      await expect(apply(true, source)).rejects.toMatchObject({
        message: 'fixture rollback failure',
      });
      await probe();
      expect(await snapshot()).toEqual(before);
    });
  },
);
