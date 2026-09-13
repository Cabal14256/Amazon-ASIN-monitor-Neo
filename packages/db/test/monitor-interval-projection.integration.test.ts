import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPgPool } from '../src/client';
import { parseMonitorAnalyticsQuery } from '../src/domain/monitor-analytics-query';
import { readMonitorAbnormalQuery } from '../src/repositories/monitor-abnormal-query';
import { monitorIntervalCoverageSelect } from '../src/repositories/monitor-interval-coverage';
import { reconcileMonitorInterval } from '../src/repositories/monitor-interval-projection';
import { legacyAnalyticsFixture } from './helpers/monitor-analytics-legacy';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'observed interval projection / actual Legacy processor',
  () => {
    let pool: Pool, unrelated: PoolClient;
    let legacy: Awaited<ReturnType<typeof legacyAnalyticsFixture>>;
    let verified = false;
    const country = 'ZI109';
    const predicate = "country LIKE 'ZI109%'";
    const range = {
      country,
      startTime: '1998-01-01 00:00:00',
      endTime: '1998-01-01 06:00:00',
    };
    const selectPg = `SELECT asin_key, asin_id, asin_code, asin_name, country, variant_group_id, variant_group_name,
    to_char(interval_start,'YYYY-MM-DD HH24:MI:SS') AS interval_start,
    to_char(interval_end,'YYYY-MM-DD HH24:MI:SS') AS interval_end, is_broken::integer AS is_broken
    FROM public.monitor_history_status_interval WHERE ${predicate} ORDER BY country, asin_key, interval_start`;
    const selectMysql = `SELECT asin_key, asin_id, asin_code, asin_name, country, variant_group_id, variant_group_name,
    DATE_FORMAT(interval_start,'%Y-%m-%d %H:%i:%s') AS interval_start,
    DATE_FORMAT(interval_end,'%Y-%m-%d %H:%i:%s') AS interval_end, is_broken
    FROM monitor_history_status_interval ORDER BY country, asin_key, interval_start`;
    async function covered(client?: PoolClient) {
      const result = await createDb(client ?? pool).execute(
        monitorIntervalCoverageSelect(
          parseMonitorAnalyticsQuery('abnormal-duration-statistics', range),
        ),
      );
      return result.rows[0].covered;
    }
    async function drain() {
      for (let i = 0; i < 50; i++) {
        const changed = await createDb(pool).transaction(
          async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = 5000`);
            return reconcileMonitorInterval(tx, () => {});
          },
          { isolationLevel: 'read committed' },
        );
        if (!changed) return;
      }
      throw new Error('Fixture interval queue did not drain within bounds');
    }
    async function seed(
      extra: {
        code?: string | null;
        id?: string | null;
        country?: string;
        name?: string | null;
        group?: string | null;
        type?: string;
        broken?: boolean | null;
        hour?: number;
      } = {},
    ) {
      const row = {
        code: 'I109-A',
        id: 'interval-109-a',
        country,
        name: 'First snapshot',
        group: 'First group',
        type: 'ASIN',
        broken: false,
        hour: 0,
        ...extra,
      };
      const values = [
        row.code,
        row.id,
        row.country,
        row.name,
        'interval-109',
        row.group,
        row.type,
        `1998-01-01 ${String(row.hour).padStart(2, '0')}:00:00`,
        row.broken,
      ];
      const fields =
        'asin_code,asin_id,country,asin_name,variant_group_id,variant_group_name,check_type,check_time,is_broken';
      await pool.query(
        `INSERT INTO public.monitor_history(${fields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values,
      );
      await legacy.query(
        `INSERT INTO monitor_history(${fields}) VALUES(?,?,?,?,?,?,?,?,?)`,
        values.map((value) =>
          typeof value === 'boolean' ? Number(value) : value,
        ),
      );
    }
    async function replayLegacy(batchSize = 10_000) {
      await legacy.query('DELETE FROM monitor_history_status_interval');
      await legacy.query('DELETE FROM analytics_refresh_watermark');
      await legacy.refreshIntervals({ batchSize, maxBatches: 100 });
      return legacy.query(selectMysql);
    }
    async function sameAsLegacy(batchSize?: number) {
      expect((await pool.query(selectPg)).rows).toEqual(
        await replayLegacy(batchSize),
      );
    }
    beforeAll(async () => {
      if (
        process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
        'amazon_asin_monitor_ci'
      )
        throw new Error(
          'Interval tests require the explicitly disposable CI database',
        );
      pool = createPgPool(process.env.DATABASE_URL!, {
        max: 5,
        connectionTimeoutMillis: 3000,
      });
      expect(
        (await pool.query('SELECT current_database() AS name')).rows[0].name,
      ).toBe('amazon_asin_monitor_ci');
      verified = true;
      legacy = await legacyAnalyticsFixture();
      // Other integration fixtures intentionally have unreconciled source history.
      // Lock only their receipts so the real SKIP LOCKED consumer selects our work.
      unrelated = await pool.connect();
      await unrelated.query('BEGIN');
      await unrelated.query(
        `SELECT 1 FROM public.monitor_interval_dirty WHERE NOT (${predicate}) FOR UPDATE`,
      );
    });
    beforeEach(async () => {
      await pool.query(`DELETE FROM public.monitor_history WHERE ${predicate}`);
      await pool.query(
        `DELETE FROM public.monitor_history_status_interval WHERE ${predicate}`,
      );
      await pool.query(
        `DELETE FROM public.monitor_interval_dirty WHERE ${predicate}`,
      );
      await legacy.query('DELETE FROM monitor_history');
      await legacy.query('DELETE FROM monitor_history_status_interval');
      await legacy.query('DELETE FROM analytics_refresh_watermark');
    });
    afterAll(async () => {
      if (unrelated) {
        await unrelated.query('ROLLBACK');
        unrelated.release();
      }
      if (verified) {
        await pool.query(
          `DELETE FROM public.monitor_history WHERE ${predicate}`,
        );
        await pool.query(
          `DELETE FROM public.monitor_history_status_interval WHERE ${predicate}`,
        );
        await pool.query(
          `DELETE FROM public.monitor_interval_dirty WHERE ${predicate}`,
        );
      }
      await legacy?.close();
      await pool?.end();
    });

    it('returns complete Legacy interval and bucket responses with filters, clipped bounds and summary-only reads', async () => {
      await seed();
      await seed({ hour: 1, broken: true });
      await seed({ hour: 2, broken: true, name: '' });
      await seed({ hour: 4, broken: false });
      await seed({ code: null, id: 'interval-109-orphan', broken: true });
      await seed({ code: null, id: 'interval-109-orphan', hour: 4 });
      await seed({
        code: 'I109-GROUP',
        id: 'interval-109-group',
        type: 'GROUP',
        broken: true,
      });
      await drain();
      await replayLegacy();
      const cases = [
        {},
        { includeSeries: '0' },
        { asinIds: ['interval-109-a'] },
        { asinCodes: ['I109-A'] },
        { asinCodes: ['missing'] },
        { asinName: 'First' },
        { asinName: '%' },
        { variantGroupName: 'First' },
        { variantGroupId: 'interval-109' },
        { asinType: '1' },
        { asinType: 'SUB_REVIEW' },
        { startTime: '1998-01-01 00:30:00', endTime: '1998-01-01 03:15:00' },
        { startTime: '1997-12-31 23:00:00' },
        { endTime: '1998-01-01 07:00:00' },
        { startTime: '', includeSeries: '0' },
        { endTime: '', includeSeries: '0' },
      ];
      for (const filter of cases) {
        const query = parseMonitorAnalyticsQuery(
          'abnormal-duration-statistics',
          { ...range, ...filter },
        );
        for (const intervalEnabled of [true, false]) {
          const actual = await createDb(pool).transaction((tx) =>
            readMonitorAbnormalQuery(tx, query, () => {}, {
              intervalEnabled,
              onIntervalFallback() {},
            }),
          );
          if (!Object.keys(filter).length)
            expect(actual.source).toBe(intervalEnabled ? 'interval' : 'raw');
          expect(
            actual.data,
            JSON.stringify({ query, source: actual.source }),
          ).toEqual(await legacy.abnormal(query, actual.source === 'interval'));
        }
      }
      // A late mutation makes the maintained intervals stale immediately. The
      // reader falls back even though their previous time watermark still covers.
      await pool.query(
        `UPDATE public.monitor_history SET is_broken = true WHERE ${predicate} AND check_time = '1998-01-01 00:00:00'`,
      );
      await legacy.query(
        "UPDATE monitor_history SET is_broken = 1 WHERE check_time = '1998-01-01 00:00:00'",
      );
      const query = parseMonitorAnalyticsQuery(
        'abnormal-duration-statistics',
        range,
      );
      const fallback = await createDb(pool).transaction((tx) =>
        readMonitorAbnormalQuery(tx, query, () => {}, {
          intervalEnabled: true,
          onIntervalFallback() {},
        }),
      );
      expect(fallback.source).toBe('raw');
      expect(fallback.data).toEqual(await legacy.abnormal(query, false));
    });

    it('preserves first metadata, null flags, fallback keys and same-second transitions across Legacy batches', async () => {
      await seed();
      await seed({
        hour: 1,
        name: 'Ignored while unchanged',
        group: 'Ignored group',
      });

      await seed({ hour: 2, broken: true, name: 'Broken snapshot', group: '' });
      await seed({ hour: 2, broken: false, name: 'Middle zero-length' });
      await seed({ hour: 2, broken: true, name: 'Last within second' });
      await seed({ hour: 3, broken: true, name: 'Ignored again' });
      await seed({ hour: 4, broken: null, name: '', group: '' });
      await seed({ code: null, id: 'interval-109-b', broken: true, hour: 1 });
      await seed({ code: null, id: 'interval-109-b', broken: false, hour: 5 });
      await seed({ code: 'GROUP-IGNORED', type: 'GROUP', broken: true });
      expect(await covered()).toBe(false);
      await drain();
      expect(await covered()).toBe(true);
      await sameAsLegacy();
      await sameAsLegacy(1);
      await sameAsLegacy(3);
    });

    it('rebuilds late corrections, deletions, changed keys and ASIN-to-GROUP mutations without advancing a watermark', async () => {
      await seed();
      await seed({ hour: 2, broken: true });
      await seed({ hour: 4 });
      await drain();
      const mutations = [
        [
          "SET is_broken = true, asin_name = 'Corrected' WHERE check_time = '1998-01-01 00:00:00'",
          "SET is_broken = 1, asin_name = 'Corrected' WHERE check_time = '1998-01-01 00:00:00'",
        ],
        [
          "SET asin_code = 'I109-MOVED', country = 'ZI109-M' WHERE check_time = '1998-01-01 02:00:00'",
          "SET asin_code = 'I109-MOVED', country = 'ZI109-M' WHERE check_time = '1998-01-01 02:00:00'",
        ],
        [
          "SET check_type = 'GROUP' WHERE check_time = '1998-01-01 04:00:00'",
          "SET check_type = 'GROUP' WHERE check_time = '1998-01-01 04:00:00'",
        ],
      ];
      for (const [pgMutation, mysqlMutation] of mutations) {
        await pool.query(
          `UPDATE public.monitor_history ${pgMutation} AND ${predicate}`,
        );
        await legacy.query(`UPDATE monitor_history ${mysqlMutation}`);
        expect(await covered()).toBe(false);
        await drain();
        await sameAsLegacy();
      }
      await pool.query(`DELETE FROM public.monitor_history WHERE ${predicate}`);
      await legacy.query('DELETE FROM monitor_history');
      await drain();
      await sameAsLegacy();
      expect(await covered()).toBe(false);
      expect(
        (
          await pool.query(
            `SELECT active FROM public.monitor_interval_dirty WHERE ${predicate}`,
          )
        ).rows.every((row) => !row.active),
      ).toBe(true);
    });

    it('keeps receipts pending on rollback and after direct interval edits; metadata-only history bookkeeping is clean', async () => {
      await seed();
      await seed({ hour: 4, broken: true });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        expect(await reconcileMonitorInterval(createDb(client), () => {})).toBe(
          true,
        );
        expect(await covered(client)).toBe(true);
        expect(await covered()).toBe(false);
        await client.query('ROLLBACK');
        expect(await covered()).toBe(false);
      } finally {
        client.release();
      }
      await drain();
      await pool.query(
        `UPDATE public.monitor_history SET notification_sent = true WHERE ${predicate}`,
      );
      expect(await covered()).toBe(true);
      await pool.query(
        `UPDATE public.monitor_history_status_interval SET is_broken = false WHERE ${predicate}`,
      );
      expect(await covered()).toBe(false);
      await drain();
      await sameAsLegacy();
      expect(await covered()).toBe(true);
    });

    it('does not lose a source update that waits behind the rebuilding receipt', async () => {
      await seed();
      await seed({ hour: 4, broken: true });
      const rebuilding = await pool.connect(),
        writer = await pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await rebuilding.query('BEGIN');
        await rebuilding.query(
          `SELECT 1 FROM public.monitor_interval_dirty WHERE ${predicate} FOR UPDATE`,
        );
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        pending = writer.query(
          `UPDATE public.monitor_history SET is_broken = true WHERE ${predicate} AND check_time = '1998-01-01 00:00:00'`,
        );
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const state = await pool.query(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
            [pid],
          );
          if (state.rows[0]?.wait_event_type === 'Lock') {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        expect(
          await reconcileMonitorInterval(createDb(rebuilding), () => {}),
        ).toBe(true);
        await rebuilding.query('COMMIT');
        await pending;
        expect(await covered()).toBe(false);
        await legacy.query(
          "UPDATE monitor_history SET is_broken = 1 WHERE check_time = '1998-01-01 00:00:00'",
        );
        await drain();
        await sameAsLegacy();
        expect(await covered()).toBe(true);
      } finally {
        await rebuilding.query('ROLLBACK');
        await pending?.catch(() => {});
        rebuilding.release();
        writer.release();
      }
    });

    it('rejects disabled tracking triggers and source or projection truncation, with rollback restoring coverage', async () => {
      await seed();
      await seed({ hour: 4, broken: true });
      await drain();
      const client = await pool.connect();
      // All destructive statements below roll back in the verified disposable
      // database. Release test-only claims because TRUNCATE dirties every key.
      await unrelated.query('ROLLBACK');
      try {
        for (const statement of [
          'ALTER TABLE public.monitor_history DISABLE TRIGGER trg_monitor_interval_source_dirty',
          'TRUNCATE public.monitor_history_status_interval',
          'TRUNCATE public.monitor_history',
        ]) {
          await client.query('BEGIN');
          await client.query("SET LOCAL statement_timeout = '5s'");
          await client.query(statement);
          expect(await covered(client), statement).toBe(false);
          await client.query('ROLLBACK');
          expect(await covered(), statement).toBe(true);
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
        await unrelated.query('BEGIN');
        await unrelated.query(
          `SELECT 1 FROM public.monitor_interval_dirty WHERE NOT (${predicate}) FOR UPDATE`,
        );
      }
    });

    it('detects source chunks removed by retention and rebuilds their keys without row DELETE triggers', async () => {
      await seed();
      await seed({ hour: 4, broken: true });
      await drain();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '5s'");
        const before = await client.query(
          `SELECT revision, completed_revision FROM public.monitor_interval_dirty WHERE ${predicate}`,
        );
        const chunks =
          await client.query(`SELECT range_start, range_end FROM timescaledb_information.chunks
          WHERE hypertable_schema = 'public' AND hypertable_name = 'monitor_history'
            AND range_start <= '1998-01-01 00:00:00+08'::timestamptz AND range_end > '1998-01-01 00:00:00+08'::timestamptz`);
        expect(chunks.rows).toHaveLength(1);
        const { range_start: start, range_end: end } = chunks.rows[0];
        await client.query(
          "SELECT public.drop_chunks('public.monitor_history', newer_than => $1::timestamptz, older_than => $2::timestamptz)",
          [start, end],
        );
        expect(
          (
            await client.query(
              `SELECT revision, completed_revision FROM public.monitor_interval_dirty WHERE ${predicate}`,
            )
          ).rows,
        ).toEqual(before.rows);
        expect(await covered(client)).toBe(false);
        expect(await reconcileMonitorInterval(createDb(client), () => {})).toBe(
          true,
        );
        expect((await client.query(selectPg)).rows).toEqual([]);
        expect(
          (
            await client.query(
              `SELECT active, source_relation_ids FROM public.monitor_interval_dirty WHERE ${predicate}`,
            )
          ).rows,
        ).toEqual([{ active: false, source_relation_ids: [] }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await covered()).toBe(true);
    });

    it('keeps full 50-character fallback identifiers and rejects ambiguous case-insensitive identities', async () => {
      await seed({ code: null, id: 'x'.repeat(50), hour: 4 });
      await seed();
      await seed({ code: 'i109-a', hour: 4, broken: true });
      await drain();
      expect(
        (await pool.query(selectPg)).rows.some(
          (row) => row.asin_key === `ID#${'x'.repeat(50)}`,
        ),
      ).toBe(true);
      expect(await covered()).toBe(false);
      // The varchar(53) extension intentionally fixes Legacy's valid-ID overflow;
      // do not insert that out-of-range interval into the old varchar(50) table.
      await pool.query(
        `DELETE FROM public.monitor_history WHERE ${predicate} AND asin_code = 'i109-a'`,
      );
      await drain();
      expect(await covered()).toBe(true);
    });
  },
);
