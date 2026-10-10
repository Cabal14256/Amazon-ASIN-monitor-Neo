import { timescaleAggregateEvidenceManifest } from '@asin-monitor/contracts';
import { sql } from 'drizzle-orm';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPgPool } from '../src/client';
import { parseMonitorAnalyticsQuery } from '../src/domain/monitor-analytics-query';
import {
  getMonitorDurationSourceGranularity,
  type MonitorSourceGranularity,
} from '../src/domain/monitor-calendar';
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
  monitorRawSummaryIdentityCoverageSelect,
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
    async function refreshAll(from = startTime) {
      for (const item of timescaleAggregateEvidenceManifest)
        await pool.query(
          'CALL public.refresh_continuous_aggregate($1::regclass,$2::timestamp,$3::timestamp,force=>true,options=>$4::jsonb)',
          [
            `public.${item.caggRelation}`,
            from,
            '1997-11-01 00:00:00',
            // A batched refresh may skip empty September chunks and retain
            // their initial invalidation. Refresh the whole fixture window.
            JSON.stringify({ buckets_per_batch: 0 }),
          ],
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
          const oracleParams = {
            ...fastQuery,
            ...(operation === 'analytics-monthly-breakdown'
              ? { groupBy: 'day', sourceGranularityOverride: 'day' }
              : {}),
          };
          const old =
            operation === 'all-countries-summary' ||
            operation === 'region-summary'
              ? await legacy.model[method](oracleParams)
              : await legacy.aggregate(
                  operation === 'analytics-monthly-breakdown'
                    ? 'getStatisticsByTime'
                    : method,
                  oracleParams,
                );
          if (operation === 'asin-by-country') {
            // Legacy SQL specifies only these two rank keys. Countries with
            // identical scores have no defined relative order across engines.
            const rank = (
              a: Record<string, unknown>,
              b: Record<string, unknown>,
            ) =>
              Number(b.abnormalDurationHours) -
                Number(a.abnormalDurationHours) ||
              Number(b.ratioAllTime) - Number(a.ratioAllTime);
            const rows = result.data as Record<string, unknown>[];
            expect(
              rows.every(
                (row, index) => index === 0 || rank(rows[index - 1], row) <= 0,
              ),
            ).toBe(true);
            const tied = (
              a: Record<string, unknown>,
              b: Record<string, unknown>,
            ) =>
              rank(a, b) || String(a.country).localeCompare(String(b.country));
            expect
              .soft([...rows].sort(tied), `${operation}/complete-aggregate`)
              .toEqual([...old].sort(tied));
          } else {
            expect
              .soft(result.data, `${operation}/complete-aggregate`)
              .toEqual(old);
          }
        }
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }, 20_000);

    it('selects the same UTF-8 byte minimum for summary CI/PAD buckets in either insertion order', async () => {
      const prefix = 'binary-min-226-';
      const bounds = {
        startTime: '1997-10-28 00:00:00',
        endTime: '1997-10-28 00:59:59',
      };
      // These are legal historical varchar values, including Unicode and
      // fallback IDs. Preserve their bytes instead of imposing an ASIN format.
      const cases = [
        {
          name: 'case-pad',
          values: ['b226min ', 'B226MIN ', 'b226min', 'B226MIN'].map(
            (asin_code) => ({ asin_code, asin_id: null }),
          ),
        },
        {
          name: 'unicode-pad',
          values: ['é226min  ', 'É226MIN ', 'é226min ', 'É226MIN  '].map(
            (asin_code) => ({ asin_code, asin_id: null }),
          ),
        },
        {
          name: 'id-fallback',
          values: [
            'é226min-id ',
            'É226MIN-ID  ',
            'é226min-id  ',
            'É226MIN-ID ',
          ].map((asin_id) => ({ asin_code: null, asin_id })),
        },
      ];
      const expected = new Map<string, string>();
      const seeded: {
        asin_code: string | null;
        asin_id: string | null;
        site: string;
      }[] = [];
      const [{ mode }] = await legacy.query(
        'SELECT @@SESSION.sql_mode AS mode',
      );
      try {
        expect((await pool.query('SHOW server_encoding')).rows).toEqual([
          { server_encoding: 'UTF8' },
        ]);
        await legacy.query(
          "SET SESSION sql_mode=REPLACE(@@SESSION.sql_mode,'ONLY_FULL_GROUP_BY','')",
        );
        for (const item of cases) {
          const spellings = item.values.map(
            (value) => value.asin_code ?? `ID#${value.asin_id}`,
          );
          const minimum = [...spellings].sort((a, b) =>
            Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
          )[0];
          for (const reverse of [false, true]) {
            const site = `${prefix}${item.name}-${
              reverse ? 'reverse' : 'forward'
            }`;
            expected.set(site, minimum);
            const ordered = reverse ? [...item.values].reverse() : item.values;
            for (const [index, value] of ordered.entries()) {
              seeded.push({ ...value, site });
              const params = [
                value.asin_code,
                value.asin_id,
                index % 2,
                `1997-10-28 00:${String(index + 5).padStart(2, '0')}:00`,
                site,
              ];
              await legacy.query(
                "INSERT INTO monitor_history(asin_code,asin_id,is_broken,check_time,site_snapshot,brand_snapshot,country,check_type,variant_group_id) VALUES(?,?,?,?,?,'binary-min-226-brand','US','ASIN','analytics-109-a')",
                params,
              );
              await pool.query(
                "INSERT INTO public.monitor_history(asin_code,asin_id,is_broken,check_time,site_snapshot,brand_snapshot,country,check_type,variant_group_id) VALUES($1,$2,$3,$4::timestamp,$5,'binary-min-226-brand','US','ASIN','analytics-109-a')",
                params.map((value, index) =>
                  index === 2 ? Boolean(value) : value,
                ),
              );
            }
          }
        }
        const raw = (rows: Record<string, unknown>[]) =>
          rows.map((row) => ({
            asin_code: row.asin_code,
            asin_id: row.asin_id,
            site: row.site,
          }));
        expect(
          raw(
            await legacy.query(
              "SELECT asin_code,asin_id,site_snapshot AS site FROM monitor_history WHERE site_snapshot LIKE 'binary-min-226-%' ORDER BY id",
            ),
          ),
        ).toEqual(seeded);
        expect(
          raw(
            (
              await pool.query(
                "SELECT asin_code,asin_id,site_snapshot AS site FROM public.monitor_history WHERE site_snapshot LIKE 'binary-min-226-%' ORDER BY id",
              )
            ).rows,
          ),
        ).toEqual(seeded);
        for (const granularity of granularities) {
          const old = await legacy.model.getDurationSourceRowsFromRaw({
            ...bounds,
            sourceGranularity: granularity,
            asinSpelling: 'binary-min',
          });
          const query = parseMonitorAnalyticsQuery(
            'all-countries-summary',
            bounds,
          );
          const neo = await createDb(pool).execute(
            monitorRawDurationSourceSelect(
              query,
              'dim',
              granularity,
              undefined,
              'binary-min',
            ),
          );
          for (const [engine, rows] of [
            ['mysql', old],
            ['postgres', neo.rows],
          ] as const) {
            const selected = rows.filter((row) =>
              expected.has(String(row.site)),
            );
            expect(
              selected,
              `${engine}/${granularity}/CI-PAD partitions`,
            ).toHaveLength(expected.size);
            for (const row of selected) {
              const minimum = expected.get(String(row.site));
              expect(row.asin_key, `${engine}/${granularity}/${row.site}`).toBe(
                minimum,
              );
              expect(Buffer.from(String(row.asin_key)).toString('hex')).toBe(
                Buffer.from(minimum!).toString('hex'),
              );
              expect(Number(row.total_checks)).toBe(4);
              expect(Number(row.broken_count)).toBe(2);
              expect(Number(row.has_peak)).toBe(0);
              expect(row.country).toBe('US');
            }
          }
        }
      } finally {
        await legacy.query(
          "DELETE FROM monitor_history WHERE site_snapshot LIKE 'binary-min-226-%'",
        );
        await pool.query(
          "DELETE FROM public.monitor_history WHERE site_snapshot LIKE 'binary-min-226-%'",
        );
        await legacy.query('SET SESSION sql_mode=?', [mode]);
      }
    }, 20_000);

    it('keeps guarded CAGG summaries exactly equal to Legacy raw for 24 clipped ASINs, month ratios and dimension splits', async () => {
      const countries = ['US', 'UK', 'DE', 'FR', 'ES', 'IT'];
      type Seed = {
        asin_code: string;
        country: string;
        is_broken: boolean;
        check_time: string;
        site_snapshot: string;
        brand_snapshot: string;
      };
      const seed = async (rows: Seed[]) => {
        await legacy.query(
          'INSERT INTO monitor_history(asin_code,country,is_broken,check_type,check_time,site_snapshot,brand_snapshot,variant_group_id) VALUES ?',
          [
            rows.map((row) => [
              row.asin_code,
              row.country,
              Number(row.is_broken),
              'ASIN',
              row.check_time,
              row.site_snapshot,
              row.brand_snapshot,
              'analytics-109-a',
            ]),
          ],
        );
        await pool.query(
          `INSERT INTO public.monitor_history(asin_code,country,is_broken,check_type,check_time,site_snapshot,brand_snapshot,variant_group_id)
          SELECT asin_code,country,is_broken,'ASIN',check_time,site_snapshot,brand_snapshot,'analytics-109-a'
          FROM jsonb_to_recordset($1::jsonb) AS seed(asin_code text,country text,is_broken boolean,check_time timestamp,site_snapshot text,brand_snapshot text)`,
          [JSON.stringify(rows)],
        );
      };
      const rows: Seed[] = [];
      for (let asin = 0; asin < 24; asin++) {
        const country = countries[asin % countries.length];
        for (const time of [
          country === 'UK' ? '01 15:15:' : '01 18:15:',
          '31 23:45:',
        ]) {
          for (let check = 0; check < 11; check++)
            rows.push({
              asin_code: `B226${String(asin).padStart(6, '0')}`,
              country,
              is_broken: check < (asin % 4) + 1,
              check_time: `1997-10-${time}${String(check).padStart(2, '0')}`,
              site_snapshot: 'precision-site',
              brand_snapshot: 'precision-brand',
            });
        }
      }
      const [{ mode }] = await legacy.query(
        'SELECT @@SESSION.sql_mode AS mode',
      );
      try {
        // The unchanged Legacy raw month SQL is already known to reject
        // ONLY_FULL_GROUP_BY. Restrict the same existing oracle waiver to this
        // disposable MySQL session, restore it below, and never alter its SQL.
        await legacy.query(
          "SET SESSION sql_mode=REPLACE(@@SESSION.sql_mode,'ONLY_FULL_GROUP_BY','')",
        );
        await seed(rows);
        await refreshAll();
        const read = async (
          query: Parameters<typeof readMonitorDurationQuery>[1],
          onAggregateFallback: Parameters<
            typeof readMonitorDurationQuery
          >[3]['onAggregateFallback'] = (reason) => {
            const source = getMonitorDurationSourceGranularity(
              query.timeSlotGranularity || 'day',
              query.startTime,
              query.endTime,
            );
            throw new Error(
              `Unexpected precision fixture fallback: ${reason}; ${query.operation}/${query.timeSlotGranularity}; source=${source}; ${query.startTime}..${query.endTime}`,
            );
          },
        ) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const result = await readMonitorDurationQuery(
              createDb(client),
              query,
              () => {},
              { aggregateEnabled: true, onAggregateFallback },
            );
            await client.query('COMMIT');
            return result;
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        };
        const compareSummaries = async (bounds: typeof range) => {
          for (const timeSlotGranularity of granularities) {
            for (const [operation, method] of [
              ['all-countries-summary', 'getAllCountriesSummary'],
              ['region-summary', 'getRegionSummary'],
            ] as const) {
              const query = parseMonitorAnalyticsQuery(operation, {
                ...bounds,
                timeSlotGranularity,
              });
              const actual = await read(query);
              const expected = await legacy.model[method](query);
              expect(actual.source, `${operation}/${timeSlotGranularity}`).toBe(
                'agg',
              );
              expect(
                actual.data,
                `${operation}/${timeSlotGranularity}`,
              ).toEqual(expected);
            }
          }
        };
        await compareSummaries(range);
        const hour = parseMonitorAnalyticsQuery('all-countries-summary', {
          ...range,
          timeSlotGranularity: 'hour',
        });
        const legacyAggregate = await createDb(pool).execute(
          monitorAggregateDurationSelect(hour, 'hour'),
        );
        const raw = await legacy.model.getAllCountriesSummary(hour);
        // Twenty-four final low buckets lose (3599/3600 - .9997) each under
        // the prior DECIMAL protocol. This is the observed HTTP gate defect.
        expect(
          Number(
            (
              Number(
                (raw as unknown as Record<string, unknown>).lowDurationHours,
              ) - Number(legacyAggregate.rows[0].lowDurationHours)
            ).toFixed(4),
          ),
        ).toBe(0.0005);

        await seed([
          {
            ...rows[0],
            asin_code: 'B226MILLI',
            check_time: '1997-10-01 00:00:00',
            is_broken: true,
          },
        ]);
        await refreshAll();
        for (const milliseconds of ['180', '540']) {
          for (const [operation, method] of [
            ['all-countries-summary', 'getAllCountriesSummary'],
            ['region-summary', 'getRegionSummary'],
          ] as const) {
            const query = parseMonitorAnalyticsQuery(operation, {
              startTime,
              endTime: `1997-10-01 00:00:00.${milliseconds}`,
              timeSlotGranularity: 'hour',
            });
            const actual = await read(query);
            const expected = await legacy.model[method](query);
            expect(actual.source, `${operation}/${milliseconds}ms`).toBe('agg');
            expect(actual.data, `${operation}/${milliseconds}ms`).toEqual(
              expected,
            );
            const metrics = Array.isArray(actual.data)
              ? actual.data.find((row) => row.regionCode === 'US')
              : actual.data;
            expect(metrics).toMatchObject({
              totalDurationHours: 0.0001,
              abnormalDurationHours: 0.0001,
            });
          }
        }
        // Keep the half-round fixture out of later .123-start windows: the
        // midnight check would correctly invalidate their aggregate coverage.
        await legacy.query(
          "DELETE FROM monitor_history WHERE variant_group_id='analytics-109-a' AND asin_code='B226MILLI'",
        );
        await pool.query(
          "DELETE FROM public.monitor_history WHERE variant_group_id='analytics-109-a' AND asin_code='B226MILLI'",
        );
        await refreshAll();

        const paddedAsinCode = `\t${rows[0].asin_code}\u00a0`;
        const paddedLowerAsinCode = `\ufeff${rows[0].asin_code.toLowerCase()}\u3000`;
        await seed([
          { ...rows[0], site_snapshot: 'second-site', is_broken: true },
          {
            ...rows[0],
            country: 'DE',
            site_snapshot: 'third-site',
            is_broken: false,
          },
          {
            ...rows[0],
            asin_code: rows[0].asin_code.toLowerCase(),
            country: 'FR',
            site_snapshot: 'fourth-site',
            is_broken: true,
          },
          {
            ...rows[0],
            asin_code: paddedAsinCode,
            country: 'IT',
            site_snapshot: 'trimmed-site',
            is_broken: true,
          },
          {
            ...rows[0],
            asin_code: paddedLowerAsinCode,
            country: 'ES',
            site_snapshot: 'trimmed-lower-site',
            is_broken: false,
          },
        ]);
        await refreshAll();
        await compareSummaries(range);
        await compareSummaries({
          startTime: '1997-10-01 00:00:00.123',
          endTime: '1997-10-31 23:59:59.900',
        });
        // More than 31 days selects the actual native daily source, while
        // hour/month targets still retain their separate source semantics.
        await refreshAll('1997-09-01 00:00:00');
        for (const granularity of granularities) {
          const query = parseMonitorAnalyticsQuery('all-countries-summary', {
            startTime: '1997-09-01 00:00:00',
            endTime,
            timeSlotGranularity: granularity,
          });
          const coverage = await createDb(pool).execute(
            monitorAggregateCoverageSelect(query, 'dim', granularity),
          );
          expect(
            coverage.rows,
            `refreshed empty September/${granularity}`,
          ).toEqual([{ covered: true }]);
        }
        await compareSummaries({ startTime: '1997-09-01 00:00:00', endTime });
        for (const [operation, method] of [
          ['all-countries-summary', 'getAllCountriesSummary'],
          ['region-summary', 'getRegionSummary'],
        ] as const) {
          const query = parseMonitorAnalyticsQuery(operation, {
            startTime: '1997-10-31 23:45:05',
            endTime,
            timeSlotGranularity: 'hour',
          });
          const reasons: string[] = [];
          const actual = await read(query, (reason) => {
            reasons.push(reason);
          });
          expect(actual.source).toBe('raw');
          expect(reasons).toEqual(['coverage']);
          expect(actual.data).toEqual(await legacy.model[method](query));
        }

        // CA contributes neither regional rows nor EU_TOTAL. Its clipped edge
        // and mixed-case identity must not reject an otherwise reusable region.
        const regionalBounds = {
          startTime: '1997-10-28 00:20:00',
          endTime: '1997-10-28 01:40:00',
          timeSlotGranularity: 'hour',
        };
        const regionalSeed = {
          ...rows[0],
          asin_code: 'B226REGION',
          site_snapshot: 'regional-scope-site',
        };
        await seed([
          { ...regionalSeed, check_time: '1997-10-28 00:30:00' },
          { ...regionalSeed, check_time: '1997-10-28 01:30:00' },
          ...['00:05:00', '00:25:00', '01:55:00'].map((time) => ({
            ...regionalSeed,
            country: 'CA',
            asin_code: 'B226CASECA',
            check_time: `1997-10-28 ${time}`,
          })),
          {
            ...regionalSeed,
            country: 'CA',
            asin_code: 'b226caseca',
            check_time: '1997-10-28 00:35:00',
          },
        ]);
        await refreshAll();
        const regionalQuery = parseMonitorAnalyticsQuery(
          'region-summary',
          regionalBounds,
        );
        const regional = await read(regionalQuery);
        expect(regional.source).toBe('agg');
        expect(regional.data).toEqual(
          await legacy.model.getRegionSummary(regionalQuery),
        );
        const globalQuery = parseMonitorAnalyticsQuery(
          'all-countries-summary',
          regionalBounds,
        );
        const globalReasons: string[] = [];
        const global = await read(globalQuery, (reason) => {
          globalReasons.push(reason);
        });
        expect(global.source).toBe('raw');
        expect(globalReasons).toEqual(['coverage']);
        expect(global.data).toEqual(
          await legacy.model.getAllCountriesSummary(globalQuery),
        );

        // Same CI bucket, two raw spellings: CAGG stores only one of them.
        // The user-approved summary contract now selects the binary minimum.
        // Keep both original raw spellings and the opposite second dimension.
        const identitySeed = {
          ...rows[0],
          asin_code: 'B226IDENTITY',
          site_snapshot: 'identity-first-site',
        };
        await seed([
          { ...identitySeed, check_time: '1997-10-27 00:05:00' },
          {
            ...identitySeed,
            asin_code: 'b226identity',
            is_broken: false,
            check_time: '1997-10-27 00:10:00',
          },
        ]);
        const identityBounds = {
          startTime: '1997-10-27 00:00:00',
          endTime: '1997-10-27 01:00:00',
        };
        const mysqlBuckets = await legacy.model.getDurationSourceRowsFromRaw({
          ...identityBounds,
          sourceGranularity: 'hour',
          asinSpelling: 'binary-min',
        });
        const representative = mysqlBuckets.find(
          (row) => row.site === identitySeed.site_snapshot,
        );
        expect(representative?.total_checks).toBe(2);
        expect(representative?.asin_key).toBe('B226IDENTITY');
        await seed([
          {
            ...identitySeed,
            asin_code:
              representative?.asin_key === 'B226IDENTITY'
                ? 'b226identity'
                : 'B226IDENTITY',
            site_snapshot: 'identity-second-site',
            check_time: '1997-10-27 00:30:00',
          },
        ]);
        await refreshAll();
        const mysqlFinalBuckets =
          await legacy.model.getDurationSourceRowsFromRaw({
            ...identityBounds,
            sourceGranularity: 'hour',
            asinSpelling: 'binary-min',
          });
        expect(mysqlFinalBuckets).toHaveLength(2);
        expect(new Set(mysqlFinalBuckets.map((row) => row.asin_key)).size).toBe(
          2,
        );
        const writeIdentityFailureEvidence = async (
          query: Parameters<typeof readMonitorDurationQuery>[1],
          actual: unknown,
          expected: unknown,
        ) => {
          const codes = [
            ...new Set(rows.map((row) => row.asin_code)),
            rows[0].asin_code.toLowerCase(),
            paddedAsinCode,
            paddedLowerAsinCode,
            'B226REGION',
            'B226CASECA',
            'b226caseca',
            'B226IDENTITY',
            'b226identity',
          ];
          const allowedCodes = new Set(codes.map((code) => code.trim()));
          const sites = new Set([
            'precision-site',
            'second-site',
            'third-site',
            'fourth-site',
            'trimmed-site',
            'trimmed-lower-site',
            'regional-scope-site',
            'identity-first-site',
            'identity-second-site',
          ]);
          const diagnosticBuckets = (sourceRows: Record<string, unknown>[]) =>
            sourceRows
              .filter(
                (row) =>
                  allowedCodes.has(String(row.asin_key).trim()) &&
                  sites.has(String(row.site)),
              )
              .map((row) => ({
                slot_period: row.slot_period,
                country: row.country,
                site: row.site,
                brand: row.brand,
                asin_key: row.asin_key,
                asin_key_utf8_hex: Buffer.from(String(row.asin_key)).toString(
                  'hex',
                ),
                map_key: String(row.asin_key).trim(),
                map_key_utf8_hex: Buffer.from(
                  String(row.asin_key).trim(),
                ).toString('hex'),
                total_checks: Number(row.total_checks),
                broken_count: Number(row.broken_count),
                has_peak: Number(row.has_peak),
              }));
          const evidence: Record<string, unknown> = {
            operation: query.operation,
            timeSlotGranularity: query.timeSlotGranularity,
            sourceGranularity: getMonitorDurationSourceGranularity(
              query.timeSlotGranularity || 'day',
              query.startTime,
              query.endTime,
            ),
            bounds: { startTime: query.startTime, endTime: query.endTime },
            actual,
            expected,
            initialHourlyRepresentative: {
              asin_key: representative?.asin_key,
              asin_key_utf8_hex: Buffer.from(
                String(representative?.asin_key),
              ).toString('hex'),
            },
          };
          const capture = async (key: string, read: () => Promise<unknown>) => {
            try {
              evidence[key] = await read();
            } catch {
              evidence[key] = { captureFailed: true };
            }
          };
          // Read-only evidence runs only after the unchanged exact comparison
          // fails. The disposable fixture code allowlist excludes other data.
          for (const sourceGranularity of granularities) {
            await capture(sourceGranularity, async () => {
              const mysql = await legacy.diagnoseDurationSourceRows({
                startTime: query.startTime,
                endTime: query.endTime,
                sourceGranularity,
                asinSpelling: 'binary-min',
              });
              const neo = await createDb(pool).execute(
                monitorRawDurationSourceSelect(
                  query,
                  'dim',
                  sourceGranularity,
                  undefined,
                  'binary-min',
                ),
              );
              return {
                legacy: diagnosticBuckets(mysql.rows),
                neo: diagnosticBuckets(neo.rows),
                mysqlExplain: mysql.plan,
              };
            });
          }
          await capture('legacyRawChecks', () =>
            legacy.query(
              `SELECT id,DATE_FORMAT(check_time,'%Y-%m-%d %H:%i:%s') AS check_time,
                asin_code,HEX(CONVERT(asin_code USING utf8mb4)) AS asin_code_utf8_hex,
                country,site_snapshot,brand_snapshot,is_broken
              FROM monitor_history WHERE variant_group_id='analytics-109-a'
                AND BINARY asin_code IN (?) ORDER BY check_time,id`,
              [codes],
            ),
          );
          await capture(
            'neoRawChecks',
            async () =>
              (
                await pool.query(
                  `SELECT id::text,to_char(check_time,'YYYY-MM-DD HH24:MI:SS') AS check_time,
                  asin_code,encode(convert_to(asin_code,'UTF8'),'hex') AS asin_code_utf8_hex,
                  country,site_snapshot,brand_snapshot,is_broken
                FROM public.monitor_history WHERE variant_group_id='analytics-109-a'
                  AND asin_code COLLATE "C"=ANY($1::text[]) ORDER BY check_time,id`,
                  [codes],
                )
              ).rows,
          );
          const directory = resolve(
            __dirname,
            '../../../artifacts/refactor-audit',
          );
          await mkdir(directory, { recursive: true });
          await writeFile(
            resolve(directory, 'monitor-analytics-226-identity-failure.json'),
            JSON.stringify(evidence, null, 2),
          );
        };
        for (const [timeSlotGranularity, bounds] of [
          ['hour', identityBounds],
          ['day', { startTime: '1997-09-01 00:00:00', endTime }],
          ['month', range],
        ] as const) {
          for (const [operation, method] of [
            ['all-countries-summary', 'getAllCountriesSummary'],
            ['region-summary', 'getRegionSummary'],
          ] as const) {
            const query = parseMonitorAnalyticsQuery(operation, {
              ...bounds,
              timeSlotGranularity,
            });
            const coverage = await createDb(pool).execute(
              monitorAggregateCoverageSelect(query, 'dim', timeSlotGranularity),
            );
            expect(coverage.rows).toEqual([{ covered: true }]);
            const reasons: string[] = [];
            const actual = await read(query, (reason) => {
              reasons.push(reason);
            });
            expect(
              actual.source,
              `${operation}/${timeSlotGranularity}/identity`,
            ).toBe('raw');
            expect(reasons).toEqual(['coverage']);
            const expected = await legacy.model[method](query);
            try {
              expect(actual.data).toEqual(expected);
            } catch (error) {
              await writeIdentityFailureEvidence(
                query,
                actual.data,
                expected,
              ).catch(() => {});
              throw error;
            }
            if (timeSlotGranularity === 'hour') {
              const metrics = Array.isArray(actual.data)
                ? actual.data.find((row) => row.regionCode === 'US')
                : actual.data;
              expect(metrics).toMatchObject({
                totalAsinsDedup: 2,
                ratioAllAsin: 75,
              });
            }
          }
        }
      } finally {
        await legacy.query('SET SESSION sql_mode=?', [mode]);
        const codes = [
          ...new Set(rows.map((row) => row.asin_code)),
          rows[0].asin_code.toLowerCase(),
          `\t${rows[0].asin_code}\u00a0`,
          `\ufeff${rows[0].asin_code.toLowerCase()}\u3000`,
          'B226MILLI',
          'B226REGION',
          'B226CASECA',
          'b226caseca',
          'B226IDENTITY',
          'b226identity',
        ];
        await legacy.query(
          "DELETE FROM monitor_history WHERE variant_group_id='analytics-109-a' AND asin_code IN (?)",
          [codes],
        );
        await pool.query(
          "DELETE FROM public.monitor_history WHERE variant_group_id='analytics-109-a' AND asin_code=ANY($1::text[])",
          [codes],
        );
        await refreshAll();
      }
    }, 30_000);

    it('rejects incomplete raw identity evidence without fabricating Timescale coverage metadata', async () => {
      const codes = ['B226PROOFA', 'B226PROOFB'];
      const query = parseMonitorAnalyticsQuery('all-countries-summary', {
        startTime: '1997-10-30 00:00:00',
        endTime: '1997-10-30 02:00:00',
        timeSlotGranularity: 'hour',
      });
      try {
        await pool.query(
          `INSERT INTO public.monitor_history(asin_code,country,is_broken,check_type,check_time,site_snapshot,brand_snapshot,variant_group_id)
          SELECT asin_code,'US',false,'ASIN',check_time,'count-proof-site','count-proof-brand','analytics-109-a'
          FROM jsonb_to_recordset($1::jsonb) AS seed(asin_code text,check_time timestamp)`,
          [
            JSON.stringify([
              { asin_code: codes[0], check_time: '1997-10-30 00:05:00' },
              { asin_code: codes[0], check_time: '1997-10-30 00:10:00' },
              { asin_code: codes[1], check_time: '1997-10-30 01:05:00' },
              { asin_code: codes[1], check_time: '1997-10-30 01:10:00' },
            ]),
          ],
        );
        await refreshAll();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const proof = async () =>
            (
              await createDb(client).execute(
                monitorRawSummaryIdentityCoverageSelect(query, 'hour'),
              )
            ).rows;
          expect(await proof()).toEqual([{ covered: true }]);
          // Leave the real materialized source unchanged. Inspect only this
          // scalar count proof, not the separate invalidation/watermark guard.
          await client.query(
            "DELETE FROM public.monitor_history WHERE asin_code=$1 AND check_time='1997-10-30 00:05:00'",
            [codes[0]],
          );
          expect(
            await proof(),
            'one check missing from an existing bucket',
          ).toEqual([{ covered: false }]);
          await client.query(
            'DELETE FROM public.monitor_history WHERE asin_code=$1',
            [codes[0]],
          );
          expect(await proof(), 'one whole raw bucket missing').toEqual([
            { covered: false },
          ]);
          await client.query(
            'DELETE FROM public.monitor_history WHERE asin_code=$1',
            [codes[1]],
          );
          expect(await proof(), 'raw evidence entirely absent').toEqual([
            { covered: false },
          ]);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      } finally {
        await pool.query(
          "DELETE FROM public.monitor_history WHERE variant_group_id='analytics-109-a' AND asin_code=ANY($1::text[])",
          [codes],
        );
        await refreshAll();
      }
    }, 10_000);

    it('sums ASIN rates in chronological Map insertion order rather than alphabetical order', async () => {
      const cases = [
        ['B226ORDERA', '00', 128, 1],
        ['B226ORDERC', '01', 128, 2],
        ['B226ORDERB', '02', 15625, 6],
      ] as const;
      const rows = cases.flatMap(([asin_code, hour, count, broken]) =>
        Array.from({ length: count }, (_, index) => ({
          asin_code,
          check_time: `1997-10-29 ${hour}:00:00`,
          is_broken: index < broken,
        })),
      );
      const codes = cases.map(([code]) => code);
      try {
        await legacy.query(
          'INSERT INTO monitor_history(asin_code,country,is_broken,check_type,check_time,site_snapshot,brand_snapshot,variant_group_id) VALUES ?',
          [
            rows.map((row) => [
              row.asin_code,
              'US',
              Number(row.is_broken),
              'ASIN',
              row.check_time,
              'map-order-site',
              'map-order-brand',
              'analytics-109-a',
            ]),
          ],
        );
        // Keep the real per-row interval-dirty trigger enabled. Separate
        // statements let PostgreSQL prune repeated updates to the same key;
        // one 15881-row statement retains every dirty-row version until end.
        for (let offset = 0; offset < rows.length; offset += 500)
          await pool.query(
            `INSERT INTO public.monitor_history(asin_code,country,is_broken,check_type,check_time,site_snapshot,brand_snapshot,variant_group_id)
            SELECT asin_code,'US',is_broken,'ASIN',check_time,'map-order-site','map-order-brand','analytics-109-a'
            FROM jsonb_to_recordset($1::jsonb) AS seed(asin_code text,check_time timestamp,is_broken boolean)`,
            [JSON.stringify(rows.slice(offset, offset + 500))],
          );
        await refreshAll();
        for (const [operation, method] of [
          ['all-countries-summary', 'getAllCountriesSummary'],
          ['region-summary', 'getRegionSummary'],
        ] as const) {
          const query = parseMonitorAnalyticsQuery(operation, {
            startTime: '1997-10-29 00:00:00',
            endTime: '1997-10-29 03:00:00',
            timeSlotGranularity: 'hour',
          });
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const actual = await readMonitorDurationQuery(
              createDb(client),
              query,
              () => {},
              {
                aggregateEnabled: true,
                onAggregateFallback() {
                  throw new Error('Unexpected Map order fixture fallback');
                },
              },
            );
            expect(actual.source).toBe('agg');
            expect(actual.data).toEqual(await legacy.model[method](query));
            const metrics = Array.isArray(actual.data)
              ? actual.data.find((row) => row.regionCode === 'US')
              : actual.data;
            // A,C,B = .7940, A,B,C = .7941. Each first time is distinct,
            // so this regression does not depend on engine tie ordering.
            expect(metrics).toMatchObject({
              ratioAllAsin: 0.794,
              ratio_all_asin: 0.794,
              totalChecks: 15881,
              totalAsinsDedup: 3,
            });
            await client.query('COMMIT');
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        }
      } finally {
        await legacy.query(
          "DELETE FROM monitor_history WHERE variant_group_id='analytics-109-a' AND asin_code IN (?)",
          [codes],
        );
        let removed: number;
        do {
          const result = await pool.query(
            `WITH selected AS (
              SELECT id,check_time FROM public.monitor_history
              WHERE variant_group_id='analytics-109-a' AND asin_code=ANY($1::text[])
              ORDER BY id,check_time LIMIT 500
            ) DELETE FROM public.monitor_history history USING selected
              WHERE history.id=selected.id AND history.check_time=selected.check_time`,
            [codes],
          );
          removed = result.rowCount ?? 0;
        } while (removed === 500);
        await refreshAll();
      }
    }, 30_000);

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
