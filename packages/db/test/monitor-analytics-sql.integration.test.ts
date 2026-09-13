import { timescaleAggregateEvidenceManifest } from '@asin-monitor/contracts';
import { sql } from 'drizzle-orm';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPgPool } from '../src/client';
import { parseMonitorAnalyticsQuery } from '../src/domain/monitor-analytics-query';
import type { MonitorSourceGranularity } from '../src/domain/monitor-calendar';
import {
  monitorAggregateCoverageSelect,
  type MonitorAggregateFamily,
} from '../src/repositories/monitor-aggregate-coverage';
import {
  monitorAggregateSourceSelect,
  monitorCountStatisticsSelect,
  monitorRawDurationSourceSelect,
} from '../src/repositories/monitor-analytics-sql';
import { legacyAnalyticsFixture } from './helpers/monitor-analytics-legacy';

// Only numeric SQL representation and PAD SPACE trailing blanks are normalized.
// Nulls, case, snapshot values and all actual count fields remain observable.
function comparable(rows: Record<string, unknown>[]) {
  return rows
    .map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => key !== 'time_slot' && key !== 'covered')
          .map(([key, value]) => [
            key,
            [
              'total_checks',
              'broken_count',
              'normal_count',
              'has_peak',
              'group_count',
              'asin_count',
            ].includes(key)
              ? value === null
                ? null
                : Number(value)
              : typeof value === 'string'
              ? value.trimEnd()
              : value,
          ]),
      ),
    )
    .sort((a, b) =>
      JSON.stringify(a, Object.keys(a).sort()).localeCompare(
        JSON.stringify(b, Object.keys(b).sort()),
      ),
    );
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'monitor statistics SQL / actual Legacy MySQL and PostgreSQL',
  () => {
    let pool: Pool;
    let legacy: Awaited<ReturnType<typeof legacyAnalyticsFixture>>;
    let disposableVerified = false;
    const startTime = '1997-10-01 00:00:00',
      endTime = '1997-10-31 23:59:59';
    const range = { startTime, endTime };
    const granularities: MonitorSourceGranularity[] = ['hour', 'day', 'month'];
    async function refreshAll() {
      for (const item of timescaleAggregateEvidenceManifest)
        await pool.query(
          'CALL public.refresh_continuous_aggregate($1::regclass,$2::timestamp,$3::timestamp,force=>true)',
          [`public.${item.caggRelation}`, startTime, '1997-11-01 00:00:00'],
        );
    }
    async function clean() {
      await pool.query(
        "DELETE FROM public.monitor_history WHERE variant_group_id LIKE 'analytics-109-%'",
      );
      await refreshAll();
      await pool.query(
        "DELETE FROM public.variant_groups WHERE id LIKE 'analytics-109-%'",
      );
    }
    beforeAll(async () => {
      if (
        process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
        'amazon_asin_monitor_ci'
      )
        throw new Error(
          'Statistics SQL tests require the explicitly disposable CI database',
        );
      pool = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 3000,
      });
      const result = await pool.query('SELECT current_database() AS name');
      if (result.rows[0].name !== 'amazon_asin_monitor_ci')
        throw new Error('Unexpected statistics integration database');
      disposableVerified = true;
      legacy = await legacyAnalyticsFixture();
      await clean();
      for (const [id, name] of [
        ['analytics-109-a', 'Current group'],
        ['analytics-109-b', 'Second group'],
      ]) {
        await pool.query(
          "INSERT INTO public.variant_groups(id,name,country,site,brand) VALUES($1,$2,'US','current-site','current-brand')",
          [id, name],
        );
        await legacy.query(
          "INSERT INTO variant_groups(id,name,country,site,brand) VALUES(?,?,'US','current-site','current-brand')",
          [id, name],
        );
      }
      const fixtures = [
        [
          'B109SQL001',
          'US',
          1,
          'ASIN',
          '01 03:10:00',
          'Store',
          'Café',
          'a',
          'Snapshot',
          'id-a',
        ],
        [
          'B109SQL001',
          'US',
          0,
          'ASIN',
          '01 03:20:00',
          'Store',
          'Café',
          'a',
          'Snapshot',
          'id-a',
        ],
        [
          'B109SQL001',
          'US',
          null,
          'ASIN',
          '01 03:30:00',
          'Store',
          'Café',
          'a',
          'Snapshot',
          'id-a',
        ],
        [
          'B109SQL001',
          'US',
          1,
          'ASIN',
          '01 18:10:00',
          'Store',
          'Café',
          'a',
          'Snapshot',
          'id-a',
        ],
        [
          'B109SQL001',
          'UK',
          0,
          'ASIN',
          '02 15:10:00',
          'Store',
          'Café',
          'a',
          'Snapshot',
          'id-a',
        ],
        [
          'B109SQL002',
          'DE',
          1,
          'ASIN',
          '02 12:10:00',
          null,
          '',
          'b',
          null,
          null,
        ],
        [
          'B109SQL003',
          'FR',
          0,
          'ASIN',
          '02 18:10:00',
          '',
          null,
          'b',
          null,
          null,
        ],
        ['B109SQL004', 'ES', 1, 'ASIN', '03 12:10:00', '', '', 'b', null, null],
        [
          'B109SQL005',
          'IT',
          null,
          'ASIN',
          '03 10:10:00',
          '',
          '',
          'b',
          null,
          null,
        ],
        [
          '',
          'US',
          1,
          'ASIN',
          '01 03:10:00',
          '',
          '',
          'a',
          'Snapshot',
          'id-only',
        ],
        [null, 'US', 1, 'ASIN', '01 03:10:00', '', '', 'a', 'Snapshot', null],
        [' ', 'US', 0, 'ASIN', '01 03:10:00', '', '', 'a', 'Snapshot', null],
        [
          'B109SQLGROUP',
          'US',
          1,
          'GROUP',
          '01 03:10:00',
          '',
          '',
          'a',
          'Snapshot',
          null,
        ],
        [
          'B109SQLOTHER',
          'US',
          0,
          'other',
          '01 03:10:00',
          '',
          '',
          'a',
          'Snapshot',
          null,
        ],
      ];
      for (const [
        code,
        country,
        broken,
        type,
        time,
        site,
        brand,
        group,
        name,
        id,
      ] of fixtures) {
        const params = [
          code,
          country,
          broken,
          type,
          `1997-10-${time}`,
          site,
          brand,
          `analytics-109-${group}`,
          name,
          id,
        ];
        await legacy.query(
          'INSERT INTO monitor_history(asin_code,country,is_broken,check_type,check_time,site_snapshot,brand_snapshot,variant_group_id,variant_group_name,asin_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
          params,
        );
        await pool.query(
          'INSERT INTO public.monitor_history(asin_code,country,is_broken,check_type,check_time,site_snapshot,brand_snapshot,variant_group_id,variant_group_name,asin_id) VALUES($1,$2,$3,$4,$5::timestamp,$6,$7,$8,$9,$10)',
          params.map((value, index) =>
            index === 2 && value !== null ? Boolean(value) : value,
          ),
        );
      }
      await refreshAll();
    }, 30_000);
    afterAll(async () => {
      try {
        if (pool && disposableVerified) await clean();
      } finally {
        try {
          if (legacy) await legacy.close();
        } finally {
          if (pool) await pool.end();
        }
      }
    });

    it('matches real raw duration buckets at all three source granularities, including snapshots, peak checks and ICU filters', async () => {
      for (const granularity of granularities) {
        for (const filter of [
          {},
          { country: 'EU' },
          { country: 'us ' },
          { country: 'US', site: 'store ', brand: 'CAFE' },
        ]) {
          const query = parseMonitorAnalyticsQuery('period-summary/details', {
            ...range,
            ...filter,
          });
          const neo = await createDb(pool).execute(
            monitorRawDurationSourceSelect(query, 'dim', granularity),
          );
          const old = await legacy.model.getDurationSourceRowsFromRaw({
            ...query,
            sourceGranularity: granularity,
          });
          expect(comparable(neo.rows)).toEqual(comparable(old));
        }
        const query = parseMonitorAnalyticsQuery(
          'asin-by-variant-group',
          range,
        );
        const neo = await createDb(pool).execute(
          monitorRawDurationSourceSelect(query, 'variant_group', granularity),
        );
        const old = await legacy.model.getVariantGroupDurationSourceRowsFromRaw(
          { ...query, sourceGranularity: granularity },
        );
        expect(comparable(neo.rows)).toEqual(comparable(old));
      }
      const query = parseMonitorAnalyticsQuery('statistics', {
        ...range,
        variantGroupId: 'ANALYTICS-109-A ',
        asinId: 'ID-A',
      });
      const neo = await createDb(pool).execute(
        monitorRawDurationSourceSelect(query, 'asin', 'hour'),
      );
      const old = await legacy.capture('getStatistics', query);
      expect(comparable(neo.rows)).toEqual(comparable(old[1]));
    });

    it('preserves nullable normal counts, GROUP checks, distinct IDs, deleted groups and bounded ranking', async () => {
      for (const filter of [
        {},
        { checkType: 'GROUP' },
        { checkType: 'ASIN' },
        { checkType: 'asin ' },
        { country: 'EU' },
        { country: 'US', asinId: 'id-a' },
        { country: 'ZZ' },
      ]) {
        const query = parseMonitorAnalyticsQuery('statistics', {
          ...range,
          ...filter,
        });
        const neo = await createDb(pool).execute(
          monitorCountStatisticsSelect(query),
        );
        const old = await legacy.capture('getStatistics', query);
        expect(comparable(neo.rows)).toEqual(comparable(old[0]));
      }
      for (const operation of ['by-country', 'by-variant-group'] as const) {
        const query = parseMonitorAnalyticsQuery(operation, {
          ...range,
          limit: '1',
        });
        const neo = await createDb(pool).execute(
          monitorCountStatisticsSelect(query),
        );
        const old = await legacy.model[
          operation === 'by-country'
            ? 'getStatisticsByCountry'
            : 'getStatisticsByVariantGroup'
        ](query);
        expect(comparable(neo.rows)).toEqual(comparable(old));
      }
      await pool.query(
        "DELETE FROM public.variant_groups WHERE id='analytics-109-b'",
      );
      await legacy.query(
        "DELETE FROM variant_groups WHERE id='analytics-109-b'",
      );
      const query = parseMonitorAnalyticsQuery('by-variant-group', range);
      const neo = await createDb(pool).execute(
        monitorCountStatisticsSelect(query),
      );
      expect(comparable(neo.rows)).toEqual(
        comparable(await legacy.model.getStatisticsByVariantGroup(query)),
      );
    });

    it('reads all nine actual CAGGs with coverage and data in one snapshot, independent of search_path and session timezone', async () => {
      // Current group names can change without invalidating history CAGGs. The
      // fast path requires independent snapshots; raw fallback above covers NULL.
      await pool.query(
        "UPDATE public.monitor_history SET variant_group_name='Group B snapshot' WHERE variant_group_id='analytics-109-b'",
      );
      await refreshAll();
      for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
        await pool.query("SELECT set_config('TimeZone',$1,false)", [tz]);
        // No public in the search path: every runtime relation/collation stays explicit.
        await pool.query('SET search_path TO pg_catalog');
        for (const granularity of granularities) {
          for (const family of [
            'asin',
            'dim',
            'variant_group',
          ] as MonitorAggregateFamily[]) {
            const query = parseMonitorAnalyticsQuery('by-time', range);
            const result = await createDb(pool)
              .execute(sql`WITH coverage AS MATERIALIZED (
            ${monitorAggregateCoverageSelect(query, family, granularity)}
          ) SELECT coverage.covered, source.* FROM coverage
          LEFT JOIN LATERAL (${monitorAggregateSourceSelect(
            query,
            family,
            granularity,
          )}) source ON coverage.covered`);
            expect(result.rows.every((row) => row.covered === true)).toBe(true);
            expect(
              result.rows.reduce(
                (sum, row) => sum + Number(row.total_checks),
                0,
              ),
            ).toBe(10);
            expect(
              result.rows.reduce(
                (sum, row) => sum + Number(row.broken_count),
                0,
              ),
            ).toBe(5);
            expect(
              result.rows.every((row) => typeof row.slot_period === 'string'),
            ).toBe(true);
          }
        }
      }
      await pool.query('RESET search_path');
    });

    it('records actual Legacy decimal intermediates and complete SQL metrics for the subsequent metric adapter', async () => {
      const arithmetic = await legacy.query(
        'SELECT @@div_precision_increment AS division_scale, 1/3 AS fraction, (1/3)*1.0000 AS product, 86399/3600 AS hours, (86399/3600)*(1/3) AS duration',
      );
      expect(arithmetic[0].division_scale).toBe(4);
      const buckets = [];
      for (const granularity of granularities) {
        for (const [start, end] of [
          ['1997-10-01 00:00:00', '1997-10-01 23:59:59'],
          ['1997-10-01 00:00:00.123', '1997-10-01 00:00:01.900'],
        ]) {
          const expression = legacy.getAggBucketHoursSqlExpr(
            granularity,
            'agg',
          );
          const rows = await legacy.query(
            `SELECT ${expression} AS bucket_hours FROM (SELECT CAST('1997-10-01 00:00:00' AS DATETIME) AS time_slot) agg`,
            [start, end],
          );
          const base = `SELECT 'ALL' AS group_key,'ALL' AS group_label,'A' AS asin_key,3 AS check_count,1 AS broken_count,1 AS has_peak,${expression} AS bucket_hours FROM (SELECT CAST('1997-10-01 00:00:00' AS DATETIME) AS time_slot) agg`;
          const metrics = await legacy.query(
            `${legacy.getAggDurationCtesSql(
              base,
            )} SELECT ${legacy.getDurationMetricsSqlSelect(
              'asin_metrics',
            )} FROM asin_metrics GROUP BY group_key`,
            [start, end],
          );
          buckets.push({ granularity, start, end, rows, metrics });
          expect(metrics).toHaveLength(1);
        }
      }
      const directory = resolve(__dirname, '../../../artifacts/refactor-audit');
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, 'monitor-analytics-109-decimal-evidence.json'),
        JSON.stringify({ arithmetic, buckets }, null, 2),
      );
    });
  },
);
