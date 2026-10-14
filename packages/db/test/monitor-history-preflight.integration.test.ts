import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPgPool } from '../src/client';
import {
  DrizzleMonitorHistoryQueryUnit,
  MAX_MONITOR_HISTORY_RESPONSE_BYTES,
} from '../src/repositories/monitor-history-query-repository';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'monitor history preflight / actual PostgreSQL evaluation and snapshot',
  () => {
    const schema = `history_preflight_225_${randomUUID().replace(/-/g, '')}`;
    const quoted = `"${schema}"`;
    const pauseLock = Number.parseInt(randomUUID().slice(0, 7), 16);
    let pool: Pool;
    let reader: PoolClient;
    let unit: DrizzleMonitorHistoryQueryUnit;
    let created = false;
    const statements: string[] = [];
    const results: QueryResult[] = [];

    beforeAll(async () => {
      if (
        process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
          'amazon_asin_monitor_ci' ||
        !process.env.DATABASE_URL
      )
        throw new Error(
          'History preflight requires the disposable CI database',
        );
      pool = createPgPool(process.env.DATABASE_URL, {
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      const database = await pool.query('SELECT current_database() AS name');
      if (database.rows[0].name !== 'amazon_asin_monitor_ci')
        throw new Error('Unexpected history preflight database');
      await pool.query(`CREATE SCHEMA ${quoted}`);
      created = true;
      for (const table of ['variant_groups', 'asins', 'monitor_history'])
        await pool.query(
          `CREATE TABLE ${quoted}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      await pool.query(`CREATE TABLE ${quoted}.measured_rows (
        position bigint GENERATED ALWAYS AS IDENTITY,
        id bigint NOT NULL, bytes integer NOT NULL
      )`);
      // Instrument only the real cost expression. This volatile function returns
      // the unchanged octet_length and records which expressions PostgreSQL
      // actually evaluated; it does not manufacture an estimated size.
      await pool.query(`CREATE FUNCTION ${quoted}.measure_result(record_id bigint, value text)
        RETURNS integer LANGUAGE plpgsql VOLATILE STRICT AS $body$
        DECLARE measured integer;
        BEGIN
          measured := octet_length(value);
          IF current_setting('neo.history_preflight_pause',true)='on' THEN
            PERFORM pg_advisory_xact_lock(${pauseLock});
          END IF;
          INSERT INTO ${quoted}.measured_rows(id,bytes) VALUES(record_id,measured);
          RETURN measured;
        END; $body$`);
      reader = await pool.connect();
      // No business-table fallback to public, even if a fixture table is absent.
      await reader.query(`SET search_path TO ${quoted},pg_catalog`);
      await reader.query('SET statement_timeout = 1500');
      const instrumented = {
        query: async (config: QueryConfig, values: unknown[]) => {
          const expression =
            'octet_length(to_json(mh.check_result::text)::text)';
          expect(config.text.split(expression)).toHaveLength(2);
          statements.push(config.text);
          const result = await reader.query(
            {
              ...config,
              text: config.text.replace(
                expression,
                `${quoted}.measure_result(mh.id,to_json(mh.check_result::text)::text)`,
              ),
            },
            values,
          );
          results.push(result);
          return result;
        },
      } as unknown as Pool;
      unit = new DrizzleMonitorHistoryQueryUnit(
        createDb(instrumented),
        () => {},
      );
    });
    beforeEach(async () => {
      statements.length = 0;
      results.length = 0;
      await reader.query("SET neo.history_preflight_pause='off'");
      await reader.query(
        'TRUNCATE monitor_history, measured_rows RESTART IDENTITY',
      );
    });
    afterAll(async () => {
      if (!pool) return;
      try {
        if (reader) reader.release();
        if (created) {
          if (!/^history_preflight_225_[0-9a-f]{32}$/.test(schema))
            throw new Error('Invalid history preflight fixture schema');
          await pool.query(`DROP SCHEMA ${quoted} CASCADE`);
        }
      } finally {
        await pool.end();
      }
    });
    async function insert(id: number, result: unknown) {
      await reader.query(
        `INSERT INTO monitor_history(id,country,check_type,check_time,check_result,asin_code)
         OVERRIDING SYSTEM VALUE VALUES($1,'US','ASIN','2026-09-13 08:00:00',$2::jsonb,$3)`,
        [id, result === null ? null : JSON.stringify(result), `B225${id}`],
      );
    }
    async function measurements() {
      const response = await reader.query(
        'SELECT id::text,bytes FROM measured_rows ORDER BY position',
      );
      return response.rows as { id: string; bytes: number }[];
    }

    it('returns an empty page and complete total without evaluating any result', async () => {
      expect(await unit.listHistory({ current: 1, pageSize: 10 })).toEqual({
        list: [],
        total: 0,
      });
      expect(await measurements()).toEqual([]);
      expect(statements).toHaveLength(1);
      expect(results[0].rows[0].bytes).toBe('0');
    });
    it('numbers after OFFSET, preserves complete multibyte/escaped values and counts outside the page', async () => {
      const content = '完整😀"\\\n'.repeat(10);
      for (let id = 1; id <= 5; id++)
        await insert(id, id === 2 ? null : { content, id });
      const page = await unit.listHistory({ current: 2, pageSize: 2 });
      expect(page.total).toBe(5);
      expect(page.list.map((row) => row.id)).toEqual([3, 2]);
      expect(JSON.parse(page.list[0].checkResult!)).toEqual({ content, id: 3 });
      expect(page.list[0].check_result).toBe(page.list[0].checkResult);
      expect(page.list[1].checkResult).toBeNull();
      expect(await measurements()).toEqual([
        { id: '3', bytes: expect.any(Number) },
      ]);
      // NULL retains the original conservative four-byte cost without invoking
      // octet_length. Both selected rows still contribute their metadata budget.
      const [{ bytes }] = await measurements();
      expect(results[0].rows[0].bytes).toBe(
        String(2 * 16384 + 2 * (bytes + 4)),
      );
      expect(statements).toHaveLength(1);
    });
    it('stops at the first overflowing prefix of the original 31 huge JSON records', async () => {
      const content = '完整结果"\\'.repeat(150_000);
      await insert(1, { content });
      await reader.query(`INSERT INTO monitor_history(id,country,check_type,check_time,check_result)
        OVERRIDING SYSTEM VALUE
        SELECT n,'US','ASIN','2026-09-13 08:00:00',check_result
        FROM monitor_history CROSS JOIN generate_series(2,31) AS series(n)`);
      const cost = await reader.query(`SELECT (16384::bigint + 2::bigint *
        COALESCE(octet_length(to_json(check_result::text)::text),4))::text AS bytes
        FROM monitor_history LIMIT 1`);
      const perRow = Number(cost.rows[0].bytes);
      const prefixLength =
        Math.floor(MAX_MONITOR_HISTORY_RESPONSE_BYTES / perRow) + 1;
      expect(prefixLength).toBeGreaterThan(1);
      expect(prefixLength).toBeLessThan(31);
      await expect(
        unit.listHistory({ current: 1, pageSize: 100 }),
      ).rejects.toMatchObject({
        code: 'too-large',
      });
      const measured = await measurements();
      expect(measured).toHaveLength(prefixLength);
      expect(measured.map(({ id }) => Number(id))).toEqual(
        Array.from({ length: prefixLength }, (_, index) => 31 - index),
      );
      expect(results[0].rows[0]).toEqual({
        total: null,
        bytes: String(perRow * prefixLength),
        records: null,
      });
      expect(statements).toHaveLength(1);
      expect(
        (await reader.query('SHOW statement_timeout')).rows[0]
          .statement_timeout,
      ).toBe('1500ms');
    });
    it('keeps count, measured bytes and complete payload on the statement snapshot during concurrent writes', async () => {
      await insert(1, { content: 'before "\\😀' });
      const blocker = await pool.connect();
      let pending: ReturnType<typeof unit.listHistory> | undefined;
      try {
        await blocker.query('SELECT pg_advisory_lock($1::bigint)', [pauseLock]);
        await reader.query("SET neo.history_preflight_pause='on'");
        const pid = (await reader.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        pending = unit.listHistory({ current: 1, pageSize: 10 });
        void pending.catch(() => undefined);
        // Observe the real SQL waiting inside its cost expression before changing
        // the fixture. No arbitrary sleep defines the snapshot boundary.
        let blocked = false;
        const deadline = Date.now() + 750;
        while (Date.now() < deadline) {
          const state = await blocker.query(
            'SELECT wait_event FROM pg_stat_activity WHERE pid=$1',
            [pid],
          );
          if (state.rows[0]?.wait_event === 'advisory') {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await blocker.query(
          `UPDATE ${quoted}.monitor_history SET check_result='{"content":"after"}' WHERE id=1`,
        );
        await blocker.query(
          `INSERT INTO ${quoted}.monitor_history(id,country,check_time,check_result)
           OVERRIDING SYSTEM VALUE VALUES(2,'US','2026-09-13 09:00:00','{"new":true}')`,
        );
        await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [
          pauseLock,
        ]);
        const page = await pending;
        expect(page.total).toBe(1);
        expect(page.list).toHaveLength(1);
        expect(JSON.parse(page.list[0].checkResult!)).toEqual({
          content: 'before "\\😀',
        });
        const [{ bytes }] = await measurements();
        expect(results[0].rows[0].bytes).toBe(String(16384 + 2 * bytes));
        expect(statements).toHaveLength(1);
      } finally {
        await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [
          pauseLock,
        ]);
        blocker.release();
        await pending?.catch(() => undefined);
      }
    });
  },
);
