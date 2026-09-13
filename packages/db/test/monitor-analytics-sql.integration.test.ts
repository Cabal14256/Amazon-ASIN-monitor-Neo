import { timescaleAggregateEvidenceManifest } from '@asin-monitor/contracts';
import { sql } from 'drizzle-orm';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPgPool } from '../src/client';
import { parseMonitorAnalyticsQuery } from '../src/domain/monitor-analytics-query';
import type { MonitorSourceGranularity } from '../src/domain/monitor-calendar';
import { normalizeSqlDurationMetricRow } from '../src/domain/monitor-duration';
import {
  monitorAggregateCoverageSelect,
  type MonitorAggregateFamily,
} from '../src/repositories/monitor-aggregate-coverage';
import { monitorAggregateDurationSelect } from '../src/repositories/monitor-analytics-aggregate-query';
import { consumeMonitorAnalyticsRows } from '../src/repositories/monitor-analytics-cursor';
import {
  monitorAggregateBucketHoursSql,
  monitorAggregateMetricsSelect,
} from '../src/repositories/monitor-analytics-metrics-sql';
import {
  monitorAbnormalBucketsSelect,
  monitorAggregateSourceSelect,
  monitorCountStatisticsSelect,
  monitorPeriodGroupsSelect,
  monitorPeriodPageSelect,
  monitorRawDurationSourceSelect,
} from '../src/repositories/monitor-analytics-sql';
import {
  readMonitorCountQuery,
  readMonitorPeakQuery,
} from '../src/repositories/monitor-count-query';
import { readMonitorDurationQuery } from '../src/repositories/monitor-duration-query';
import { readMonitorPeriodQuery } from '../src/repositories/monitor-period-query';
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
      for (const [id, code, type] of [
        ['analytics-109-id-a', 'B109CURRENT', 'MAIN_LINK'],
        ['analytics-109-id-only', 'B109FALLBACK', '2'],
      ]) {
        await pool.query(
          "INSERT INTO public.asins(id,asin,name,asin_type,country,site,brand,variant_group_id) VALUES($1,$2,'Café name',$3,'US','store','brand','analytics-109-a')",
          [id, code, type],
        );
        await legacy.query(
          "INSERT INTO asins(id,asin,name,asin_type,country,site,brand,variant_group_id) VALUES(?,?,'Café name',?,'US','store','brand','analytics-109-a')",
          [id, code, type],
        );
      }
      const fixtures = [
        [
          null,
          'US',
          1,
          'GROUP',
          '03 03:10:00',
          '',
          '',
          'a',
          'Snapshot',
          'id-only',
        ],
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
          id ? `analytics-109-${id}` : null,
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
      const [{ mode }] = await legacy.query(
        'SELECT @@SESSION.sql_mode AS mode',
      );
      try {
        for (const granularity of granularities) {
          if (granularity === 'month') {
            // The frozen monthly Legacy SQL fails ONLY_FULL_GROUP_BY because it
            // wraps a grouped timestamp expression in DATE_FORMAT. Record that
            // source defect, then compare its unchanged SQL under permissive
            // grouping. Neo uses the generated month column and needs no waiver.
            expect(String(mode)).toContain('ONLY_FULL_GROUP_BY');
            await expect(
              legacy.model.getDurationSourceRowsFromRaw({
                ...range,
                sourceGranularity: granularity,
              }),
            ).rejects.toMatchObject({ code: 'ER_WRONG_FIELD_WITH_GROUP' });
            await legacy.query(
              "SET SESSION sql_mode=REPLACE(@@SESSION.sql_mode,'ONLY_FULL_GROUP_BY','')",
            );
          }
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
          const old =
            await legacy.model.getVariantGroupDurationSourceRowsFromRaw({
              ...query,
              sourceGranularity: granularity,
            });
          expect(comparable(neo.rows)).toEqual(comparable(old));
        }
      } finally {
        await legacy.query('SET SESSION sql_mode=?', [mode]);
      }
      const query = parseMonitorAnalyticsQuery('statistics', {
        ...range,
        variantGroupId: 'ANALYTICS-109-A ',
        asinId: 'ANALYTICS-109-ID-A',
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
        { country: 'US', asinId: 'analytics-109-id-a' },
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

    it('matches abnormal-duration SQL across IDs, code/name snapshots, SQL LIKE, types and hourly/daily/weekly buckets', async () => {
      for (const end of [
        '1997-10-03 23:59:59',
        '1997-10-20 23:59:59',
        endTime,
      ]) {
        for (const filter of [
          {},
          { country: 'EU' },
          { asinIds: 'analytics-109-id-a' },
          { asinCodes: 'B109FALLBACK' },
          { asinCodes: ['', 'B109SQL001'] },
          { asinType: '1' },
          { asinType: 'SUB_REVIEW' },
          { asinName: 'CAFE%' },
          { variantGroupName: 'Snap_hot' },
          { asinName: 'absent' },
        ]) {
          const query = parseMonitorAnalyticsQuery(
            'abnormal-duration-statistics',
            { startTime, endTime: end, ...filter },
          );
          const neo = await createDb(pool).execute(
            monitorAbnormalBucketsSelect(query),
          );
          const old = await legacy.capture(
            'getAbnormalDurationStatistics',
            query,
          );
          expect(comparable(neo.rows)).toEqual(comparable(old.at(-1)!));
        }
      }
    });
    it('counts and pages period groups in one statement, retaining the total beyond the final page', async () => {
      for (const current of ['1', '2', '99']) {
        for (const filter of [
          {},
          { country: 'EU' },
          { site: ' ' },
          { brand: 'cafe ' },
          { country: 'ZZ' },
        ]) {
          const query = parseMonitorAnalyticsQuery('period-summary', {
            ...range,
            endTime: '1997-10-03 23:59:59',
            ...filter,
            current,
            pageSize: '2',
          });
          const old = await legacy.model.getPeriodSummaryPageGroupsFromRaw(
            query,
          );
          for (const source of ['raw', 'aggregate'] as const) {
            const selected = monitorPeriodPageSelect(
              query,
              monitorPeriodGroupsSelect(query, source, 'day'),
            );
            const result = await createDb(pool).execute(
              source === 'raw'
                ? selected
                : sql`
              WITH coverage AS MATERIALIZED (${monitorAggregateCoverageSelect(
                query,
                'dim',
                'day',
              )})
              SELECT coverage.covered, page.* FROM coverage LEFT JOIN LATERAL (${selected}) page ON coverage.covered`,
            );
            if (source === 'aggregate')
              expect(result.rows[0].covered).toBe(true);
            const list = result.rows
              .filter((row) => row.row_present)
              .map(({ country, site, brand }) => ({ country, site, brand }));
            expect({
              total: Number(result.rows[0].total_rows),
              current: query.current,
              pageSize: query.pageSize,
              list,
            }).toEqual(old);
          }
        }
      }
    });

    it('reads all nine actual CAGGs with coverage and data in one snapshot, independent of search_path and session timezone', async () => {
      // Current group names can change without invalidating history CAGGs. The
      // fast path requires independent snapshots; raw fallback above covers NULL.
      await pool.query(
        "UPDATE public.monitor_history SET variant_group_name='Group B snapshot' WHERE variant_group_id='analytics-109-b'",
      );
      await legacy.query(
        "UPDATE monitor_history SET variant_group_name='Group B snapshot' WHERE variant_group_id='analytics-109-b'",
      );
      await refreshAll();
      for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
        await pool.query("SELECT set_config('TimeZone',$1,false)", [tz]);
        for (const granularity of granularities) {
          for (const family of [
            'asin',
            'dim',
            'variant_group',
          ] as MonitorAggregateFamily[]) {
            const query = parseMonitorAnalyticsQuery('by-time', {
              ...range,
              endTime: '1997-10-03 12:59:59',
            });
            const result = await createDb(pool)
              .execute(sql`WITH coverage AS MATERIALIZED (
            ${monitorAggregateCoverageSelect(query, family, granularity)}
          ) SELECT coverage.covered, source.* FROM coverage
          LEFT JOIN LATERAL (${monitorAggregateSourceSelect(
            query,
            family,
            granularity,
          )}) source ON coverage.covered`);
            expect(
              result.rows.every((row) => row.covered === true),
              `${tz}/${family}/${granularity}`,
            ).toBe(true);
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
      // PostgreSQL deparses view definitions differently without public in its
      // search path. The fingerprint then conservatively rejects the fast path;
      // qualified raw reads still use the intended hypertable.
      await pool.query('SET search_path TO pg_catalog');
      const query = parseMonitorAnalyticsQuery('by-time', {
        ...range,
        endTime: '1997-10-03 12:59:59',
      });
      const proof = await createDb(pool).execute(
        monitorAggregateCoverageSelect(query, 'asin', 'hour'),
      );
      expect(proof.rows[0].covered).toBe(false);
      const raw = await createDb(pool).execute(
        monitorRawDurationSourceSelect(query, 'asin', 'hour'),
      );
      expect(
        raw.rows.reduce((sum, row) => sum + Number(row.total_checks), 0),
      ).toBe(10);
      await pool.query('RESET search_path');
    });

    it('matches complete aggregate leaf queries, including regional UNION precision and group-wide ASIN deduplication', async () => {
      // These tests isolate the query/mapping contract. Actual projection
      // construction and raw parity are checked above and by the 0001 gate.
      for (const family of ['asin', 'variant_group', 'dim'] as const) {
        const target =
          family === 'asin'
            ? 'monitor_history_agg'
            : family === 'dim'
            ? 'monitor_history_agg_dim'
            : 'monitor_history_agg_variant_group';
        const relation =
          family === 'asin'
            ? sql`public.monitor_history_agg_v2`
            : family === 'dim'
            ? sql`public.monitor_history_agg_dim_v2`
            : sql`public.monitor_history_agg_variant_group_v2`;
        const columns = [
          'granularity',
          'time_slot',
          'country',
          'asin_key',
          'check_count',
          'broken_count',
          'has_peak',
          'has_broken',
          'first_check_time',
          'last_check_time',
          ...(family === 'variant_group'
            ? ['variant_group_id', 'variant_group_name']
            : family === 'dim'
            ? ['site', 'brand']
            : []),
        ];
        const selected = await createDb(pool).execute(sql`SELECT granularity,
          to_char(time_slot,'YYYY-MM-DD HH24:MI:SS') AS time_slot,country,asin_key,check_count,broken_count,
          has_peak::int AS has_peak,has_broken::int AS has_broken,
          to_char(first_check_time,'YYYY-MM-DD HH24:MI:SS') AS first_check_time,
          to_char(last_check_time,'YYYY-MM-DD HH24:MI:SS') AS last_check_time
          ${
            family === 'variant_group'
              ? sql`,variant_group_id,variant_group_name`
              : family === 'dim'
              ? sql`,site,brand`
              : sql``
          }
          FROM ${relation} WHERE time_slot>='1997-10-01'::timestamp AND time_slot<'1997-11-01'::timestamp`);
        await legacy.query(`DELETE FROM ${target}`);
        await legacy.query(
          `INSERT INTO ${target}(${columns.join(',')}) VALUES ?`,
          [selected.rows.map((row) => columns.map((column) => row[column]))],
        );
      }
      const cases = [
        { operation: 'statistics', method: 'getAllCountriesSummaryFromAgg' },
        {
          operation: 'all-countries-summary',
          method: 'getAllCountriesSummaryFromAgg',
        },
        { operation: 'region-summary', method: 'getRegionSummaryFromAgg' },
        {
          operation: 'asin-by-country',
          method: 'getASINStatisticsByCountryFromAgg',
        },
        {
          operation: 'asin-by-variant-group',
          method: 'getASINStatisticsByVariantGroupFromAgg',
        },
        {
          operation: 'analytics-monthly-breakdown',
          method: 'getStatisticsByTimeFromAgg',
        },
        ...['hour', 'day', 'week', 'month'].map((groupBy) => ({
          operation: 'by-time',
          method: 'getStatisticsByTimeFromAgg',
          groupBy,
        })),
      ] as const;
      const normalize = (row: Record<string, unknown>, operation: string) => {
        if (operation === 'statistics' || operation === 'all-countries-summary')
          return normalizeSqlDurationMetricRow(row);
        if (operation === 'region-summary')
          return normalizeSqlDurationMetricRow(row, {
            regionCode: row.group_label,
          });
        const counts = {
          total_checks: Number(row.totalChecks || 0),
          broken_count: Number(row.brokenCount || 0),
          normal_count: Math.max(
            0,
            Number(row.totalChecks || 0) - Number(row.brokenCount || 0),
          ),
        };
        if (operation === 'asin-by-country')
          return normalizeSqlDurationMetricRow(row, {
            country: row.group_key,
            ...counts,
          });
        if (operation === 'asin-by-variant-group')
          return normalizeSqlDurationMetricRow(row, {
            variant_group_id: row.group_key,
            variant_group_name: row.group_label,
            country: row.country,
            ...counts,
          });
        const metrics = normalizeSqlDurationMetricRow(row, {
          time_period: row.group_label,
        });
        return {
          ...metrics,
          total_asins: metrics.totalAsinsDedup,
          broken_asins: metrics.brokenAsinsDedup,
          asin_broken_rate: metrics.ratioAllAsin,
          normal_count: Math.max(0, metrics.totalChecks - metrics.brokenCount),
        };
      };
      const canonical = (value: unknown) =>
        Array.isArray(value)
          ? [...value].sort((a, b) =>
              JSON.stringify(a, Object.keys(a).sort()).localeCompare(
                JSON.stringify(b, Object.keys(b).sort()),
              ),
            )
          : value;
      for (const granularity of granularities) {
        for (const item of cases) {
          for (const bounds of [
            { startTime, endTime: '1997-10-03 12:59:59' },
            {
              startTime: '1997-10-01 03:00:00.123',
              endTime: '1997-10-01 03:00:01.900',
            },
            {
              startTime: '1997-10-01 00:00:00',
              endTime: '1997-10-01 00:00:01.900',
              country: 'EU',
              limit: '1',
            },
          ]) {
            const operation = item.operation as Parameters<
              typeof parseMonitorAnalyticsQuery
            >[0];
            const query = parseMonitorAnalyticsQuery(operation, {
              ...bounds,
              ...('groupBy' in item ? { groupBy: item.groupBy } : {}),
            });
            const neo = await createDb(pool).execute(
              monitorAggregateDurationSelect(query, granularity),
            );
            expect(neo.rows[0].covered, `${operation}/${granularity}`).toBe(
              true,
            );
            const rows = neo.rows
              .filter((row) => row.group_key !== null)
              .map((row) => normalize(row, operation));
            const result =
              operation === 'statistics' ||
              operation === 'all-countries-summary'
                ? rows[0] || normalizeSqlDurationMetricRow()
                : rows;
            const old = await legacy.aggregate(item.method, {
              ...query,
              sourceGranularity: granularity,
              sourceGranularityOverride: granularity,
              ...(operation === 'analytics-monthly-breakdown'
                ? { groupBy: 'day' }
                : {}),
            });
            expect
              .soft(
                canonical(result),
                `${operation}/${granularity}/${JSON.stringify(bounds)}`,
              )
              .toEqual(canonical(old));
            if (operation === 'by-time')
              expect(
                rows.map(
                  (row) => (row as { time_period?: unknown }).time_period,
                ),
              ).toEqual(
                rows
                  .map((row) => (row as { time_period?: unknown }).time_period)
                  .sort(),
              );
          }
        }
      }
      for (const query of [
        parseMonitorAnalyticsQuery('statistics', {
          ...range,
          asinId: 'analytics-109-id-a',
        }),
        parseMonitorAnalyticsQuery('statistics', {
          ...range,
          checkType: 'GROUP',
        }),
        parseMonitorAnalyticsQuery('by-time', {}),
      ]) {
        const result = await createDb(pool).execute(
          monitorAggregateDurationSelect(query, 'hour'),
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
          covered: false,
          group_key: null,
        });
      }
    }, 20_000);

    it('executes the streamed duration reader against actual Legacy raw queries and preserves complete result fields', async () => {
      expect(new Date('2000-01-01T00:00:00Z').getTimezoneOffset()).toBe(-480);
      await refreshAll();
      const client = await pool.connect();
      const db = createDb(client);
      try {
        await client.query('BEGIN');
        const cases = [
          ['statistics', 'getStatistics'],
          ['by-time', 'getStatisticsByTime'],
          ['analytics-monthly-breakdown', 'getStatisticsByTimeFromRaw'],
          ['all-countries-summary', 'getAllCountriesSummary'],
          ['region-summary', 'getRegionSummary'],
          ['asin-by-country', 'getASINStatisticsByCountry'],
          ['asin-by-variant-group', 'getASINStatisticsByVariantGroup'],
        ] as const;
        for (const [operation, method] of cases) {
          for (const params of [
            { ...range },
            {
              startTime: '1997-10-01 03:11:12',
              endTime: '1997-10-02 15:14:15',
              country: 'EU',
            },
            {
              startTime: '1997-10-01 03:00:00.123',
              endTime: '1997-10-01 03:00:01.900',
            },
            // The shared PG database contains later performance fixtures that
            // are absent from this private MySQL schema. A sole upper bound
            // preserves the missing-bound contract with identical source data.
            { endTime: '1997-10-02 03:00:00' },
            {
              startTime: '1997-10-03 01:00:00',
              endTime: '1997-10-01 00:00:00',
            },
          ]) {
            const query = parseMonitorAnalyticsQuery(operation, params);
            const neo = await readMonitorDurationQuery(db, query, () => {}, {
              aggregateEnabled: false,
              onAggregateFallback: () => {
                throw new Error('Unexpected aggregate attempt');
              },
            });
            const old = await legacy.model[method]({
              ...query,
              ...(operation === 'analytics-monthly-breakdown'
                ? { groupBy: 'day', sourceGranularityOverride: 'day' }
                : {}),
            });
            expect
              .soft(neo.data, `${operation}/${JSON.stringify(params)}`)
              .toEqual(old);
            expect(neo.source).toBe('raw');
          }
        }
        for (const fields of [
          { checkType: 'GROUP' },
          { asinId: 'analytics-109-id-a' },
          { variantGroupId: 'analytics-109-a' },
          { checkType: 'ASIN' },
        ]) {
          const query = parseMonitorAnalyticsQuery('statistics', {
            ...range,
            ...fields,
          });
          const neo = await readMonitorDurationQuery(db, query, () => {}, {
            aggregateEnabled: false,
            onAggregateFallback() {},
          });
          expect
            .soft(neo.data, JSON.stringify(fields))
            .toEqual(await legacy.model.getStatistics(query));
        }
        const query = parseMonitorAnalyticsQuery('by-time', {
          ...range,
          endTime: '1997-10-03 12:59:59',
        });
        const fast = await readMonitorDurationQuery(db, query, () => {}, {
          aggregateEnabled: true,
          onAggregateFallback() {},
        });
        expect(fast.source).toBe('agg');
        expect(fast.data).toEqual(
          await legacy.aggregate('getStatisticsByTimeFromAgg', query),
        );
        for (const [operation, method] of cases) {
          const fastQuery = parseMonitorAnalyticsQuery(operation, {
            ...range,
            endTime: '1997-10-03 12:59:59',
          });
          const result = await readMonitorDurationQuery(
            db,
            fastQuery,
            () => {},
            { aggregateEnabled: true, onAggregateFallback() {} },
          );
          expect(result.source).toBe('agg');
          const old = await legacy.aggregate(
            operation === 'analytics-monthly-breakdown'
              ? 'getStatisticsByTime'
              : method,
            {
              ...fastQuery,
              ...(operation === 'analytics-monthly-breakdown'
                ? { groupBy: 'day', sourceGranularityOverride: 'day' }
                : {}),
            },
          );
          expect
            .soft(result.data, `${operation}/complete-aggregate`)
            .toEqual(old);
        }
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }, 20_000);

    it('preserves COUNT/SUM JSON types and complete peak metrics on raw and guarded aggregate paths', async () => {
      const client = await pool.connect();
      const db = createDb(client);
      try {
        await client.query('BEGIN');
        for (const [operation, method] of [
          ['by-country', 'getStatisticsByCountry'],
          ['by-variant-group', 'getStatisticsByVariantGroup'],
        ] as const) {
          for (const params of [
            { ...range },
            { ...range, country: 'EU', limit: '1' },
            {
              startTime: '1997-12-01 00:00:00',
              endTime: '1997-12-01 01:00:00',
            },
          ]) {
            const query = parseMonitorAnalyticsQuery(operation, params);
            expect(await readMonitorCountQuery(db, query, () => {})).toEqual(
              await legacy.model[method](query),
            );
          }
        }
        for (const country of ['US', 'EU', 'UK', 'CA', 'us']) {
          for (const times of [
            { ...range, endTime: '1997-10-03 12:59:59' },
            {
              startTime: '1997-10-01 03:11:12',
              endTime: '1997-10-02 15:14:15',
            },
            {
              startTime: '1997-10-01 03:00:00.123',
              endTime: '1997-10-01 03:00:01.900',
            },
            { ...range, checkType: 'GROUP' },
            { ...range, endTime: '1997-10-03 12:59:59', checkType: 'unknown' },
          ]) {
            const query = parseMonitorAnalyticsQuery('peak-hours', {
              ...times,
              country,
            });
            for (const aggregateEnabled of [false, true]) {
              const neo = await readMonitorPeakQuery(db, query, () => {}, {
                aggregateEnabled,
                onAggregateFallback() {},
              });
              const old = aggregateEnabled
                ? await legacy.aggregate('getPeakHoursStatistics', query)
                : await legacy.model.getPeakHoursStatistics(query);
              expect
                .soft(
                  neo,
                  `${country}/${JSON.stringify(times)}/${aggregateEnabled}`,
                )
                .toEqual(old);
            }
          }
        }
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }, 20_000);

    it('reads period counts, pages and their exact group buckets together, including empty pages and literal EU details', async () => {
      const client = await pool.connect();
      const db = createDb(client);
      try {
        await client.query('BEGIN');
        for (const params of [
          {},
          { current: '2', pageSize: '2' },
          { current: '100', pageSize: '2' },
          { country: 'EU' },
          { country: 'US', site: 'store', brand: 'Cafe' },
          { site: ' ' },
          { country: 'CA' },
          { timeSlotGranularity: 'week' },
          {
            startTime: '1997-10-01 03:10:00.123',
            endTime: '1997-10-01 03:10:01.900',
          },
        ]) {
          for (const [operation, method] of [
            ['period-summary', 'getPeriodSummary'],
            ['period-summary/details', 'getPeriodSummaryTimeSlotDetails'],
          ] as const) {
            const query = parseMonitorAnalyticsQuery(operation, {
              startTime,
              endTime: '1997-10-03 12:59:59',
              ...params,
            });
            for (const aggregateEnabled of [false, true]) {
              const neo = await readMonitorPeriodQuery(db, query, () => {}, {
                aggregateEnabled,
                onAggregateFallback() {},
              });
              const old = aggregateEnabled
                ? await legacy.aggregate(method, query)
                : await legacy.model[method](query);
              expect
                .soft(
                  neo.data,
                  `${operation}/${JSON.stringify(params)}/${aggregateEnabled}`,
                )
                .toEqual(old);
            }
          }
        }
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }, 20_000);

    it('streams bounded batches from one cursor snapshot while another connection changes the history row', async () => {
      const client = await pool.connect(),
        db = createDb(client);
      const writer = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 3000,
      });
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const sizes: number[] = [];
        const count = await consumeMonitorAnalyticsRows(
          db,
          sql`
          SELECT n, mh.is_broken FROM generate_series(1,2501) n
          CROSS JOIN public.monitor_history mh
          WHERE mh.asin_code='B109SQL001' AND mh.country='US' AND mh.check_time='1997-10-01 03:10:00'::timestamp
          ORDER BY n`,
          async (rows) => {
            sizes.push(rows.length);
            expect(rows.every((row) => row.is_broken === true)).toBe(true);
            if (sizes.length === 1)
              await writer.query(
                "UPDATE public.monitor_history SET is_broken=false WHERE asin_code='B109SQL001' AND country='US' AND check_time='1997-10-01 03:10:00'::timestamp",
              );
          },
          () => {},
        );
        expect(count).toBe(2501);
        expect(sizes).toEqual([1000, 1000, 501]);
        expect(
          (
            await client.query(
              "SELECT is_broken FROM public.monitor_history WHERE asin_code='B109SQL001' AND country='US' AND check_time='1997-10-01 03:10:00'::timestamp",
            )
          ).rows[0].is_broken,
        ).toBe(false);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS total FROM pg_cursors WHERE name='monitor_analytics_rows_cursor'",
            )
          ).rows[0].total,
        ).toBe(0);
      } finally {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        try {
          await writer.query(
            "UPDATE public.monitor_history SET is_broken=true WHERE asin_code='B109SQL001' AND country='US' AND check_time='1997-10-01 03:10:00'::timestamp",
          );
        } finally {
          await writer.end();
        }
      }
    });

    it('recovers the transaction after a mid-stream SQL error or row limit, and supports early termination', async () => {
      const client = await pool.connect(),
        db = createDb(client);
      try {
        await client.query('BEGIN');
        let seen = 0;
        await expect(
          consumeMonitorAnalyticsRows(
            db,
            sql`SELECT n,1/(2001-n) AS quotient FROM generate_series(1,3000) n`,
            (rows) => {
              seen += rows.length;
            },
            () => {},
          ),
        ).rejects.toThrow();
        expect(seen).toBe(2000);
        await expect(
          consumeMonitorAnalyticsRows(
            db,
            sql`SELECT n FROM generate_series(1,1001) n`,
            () => {},
            () => {},
            1000,
          ),
        ).rejects.toMatchObject({ code: 'capacity' });
        let batches = 0;
        expect(
          await consumeMonitorAnalyticsRows(
            db,
            sql`SELECT n FROM generate_series(1,3000) n`,
            () => {
              batches++;
              return false;
            },
            () => {},
          ),
        ).toBe(1000);
        expect(batches).toBe(1);
        const values: unknown[] = [];
        await consumeMonitorAnalyticsRows(
          db,
          sql`SELECT 42 AS value`,
          (rows) => {
            values.push(...rows.map((row) => row.value));
          },
          () => {},
        );
        expect(values).toEqual([42]);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS total FROM pg_cursors WHERE name='monitor_analytics_rows_cursor'",
            )
          ).rows[0].total,
        ).toBe(0);
      } finally {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    });

    it('matches all SQL metrics against real Legacy aggregate columns across partial buckets, per-ASIN averages and zero denominators', async () => {
      for (const granularity of granularities) {
        await legacy.query('DELETE FROM monitor_history_agg');
        const input = Array.from({ length: 12 }, (_, index) => {
          const date = new Date(Date.UTC(1997, 9, 1));
          if (granularity === 'hour') date.setUTCHours(index);
          if (granularity === 'day') date.setUTCDate(index + 1);
          if (granularity === 'month') date.setUTCMonth(9 + index);
          const slot = date.toISOString().slice(0, 19).replace('T', ' ');
          const checks = [3, 7, 0, 19, 99991, 113][index % 6];
          return {
            slot,
            country: index % 2 ? 'US' : 'UK',
            asin: `A${index % 3}`,
            checks,
            broken: checks ? Math.min(checks, 1 + index * 17) : 0,
            peak: index % 2,
          };
        });
        await legacy.query(
          'INSERT INTO monitor_history_agg(granularity,time_slot,country,asin_key,check_count,broken_count,has_peak,has_broken,first_check_time,last_check_time) VALUES ?',
          [
            input.map((row) => [
              granularity,
              row.slot,
              row.country,
              row.asin,
              row.checks,
              row.broken,
              row.peak,
              row.broken > 0 ? 1 : 0,
              row.slot,
              row.slot,
            ]),
          ],
        );
        const source = sql`(VALUES ${sql.join(
          input.map(
            (row) => sql`(${row.slot}::timestamp,
          ${row.country}::text COLLATE public.legacy_utf8mb4_unicode_ci, ${row.asin}::text COLLATE public.legacy_utf8mb4_unicode_ci,
          ${row.checks}::bigint, ${row.broken}::bigint, ${row.peak}::int)`,
          ),
          sql`, `,
        )}) AS agg(time_slot,country,asin_key,check_count,broken_count,has_peak)`;
        for (const [start, end] of [
          ['1997-10-01 00:00:00.123', '1997-10-01 00:00:01.900'],
          ['1997-10-01 00:00:00', '1997-10-02 23:59:59'],
          ['1997-10-01 00:00:59.600', '1998-10-01 02:34:56.999'],
          ['1997-10-02 23:59:59', '1997-10-01 00:00:00'],
        ]) {
          const query = parseMonitorAnalyticsQuery('by-time', {
            startTime: start,
            endTime: end,
          });
          const oldBase = `SELECT agg.country AS group_key,agg.country AS group_label,agg.asin_key,
            agg.check_count,agg.broken_count,agg.has_peak,${legacy.getAggBucketHoursSqlExpr(
              granularity,
            )} AS bucket_hours
            FROM monitor_history_agg agg WHERE agg.granularity=?`;
          const old = await legacy.query(
            `${legacy.getAggDurationCtesSql(oldBase)}
            SELECT group_key,group_label,${legacy.getDurationMetricsSqlSelect(
              'asin_metrics',
            )}
            FROM asin_metrics GROUP BY group_key,group_label ORDER BY group_key,group_label`,
            [start, end, granularity],
          );
          const neo = await createDb(pool).execute(
            monitorAggregateMetricsSelect(sql`
            SELECT agg.country AS group_key,agg.country AS group_label,agg.asin_key,
              agg.check_count,agg.broken_count,agg.has_peak,${monitorAggregateBucketHoursSql(
                query,
                granularity,
                sql`agg.time_slot`,
              )} AS bucket_hours
              FROM ${source}`),
          );
          const normalize = (row: Record<string, unknown>) => ({
            group: row.group_key,
            ...normalizeSqlDurationMetricRow(row),
          });
          expect(
            neo.rows.map(normalize),
            `${granularity}/${start}/${end}`,
          ).toEqual(old.map(normalize));
        }
      }
    });

    it('matches Legacy decimal intermediates and preserves the small-duration ratio edge case', async () => {
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
          const neoQuery = parseMonitorAnalyticsQuery('by-time', {
            startTime: start,
            endTime: end,
          });
          const neo = await createDb(pool).execute(
            monitorAggregateMetricsSelect(sql`
            SELECT 'ALL'::text AS group_key,'ALL'::text AS group_label,'A'::text AS asin_key,
              3 AS check_count,1 AS broken_count,1 AS has_peak,
              ${monitorAggregateBucketHoursSql(
                neoQuery,
                granularity,
                sql`agg.time_slot`,
              )} AS bucket_hours
              FROM (SELECT '1997-10-01 00:00:00'::timestamp AS time_slot) agg`),
          );
          expect(
            neo.rows.map((row) => normalizeSqlDurationMetricRow(row)),
            `${granularity}/${start}/${end}`,
          ).toEqual(metrics.map((row) => normalizeSqlDurationMetricRow(row)));
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
