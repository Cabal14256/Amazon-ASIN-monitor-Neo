import { timescaleAggregateEvidenceManifest } from '@asin-monitor/contracts';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPgPool } from '../src/client';
import { parseMonitorAnalyticsQuery } from '../src/domain/monitor-analytics-query';
import type { MonitorSourceGranularity } from '../src/domain/monitor-calendar';
import {
  monitorAggregateCoverageSelect,
  type MonitorAggregateFamily,
} from '../src/repositories/monitor-aggregate-coverage';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'monitor analytics / actual Timescale 2.29.2 refresh coverage',
  () => {
    let pool: Pool;
    let disposableVerified = false;
    const range = {
      startTime: '1998-04-18 03:00:00',
      endTime: '1998-04-18 03:59:59',
    };
    const query = parseMonitorAnalyticsQuery('by-time', range);
    const families: MonitorAggregateFamily[] = ['asin', 'dim', 'variant_group'];
    const granularities: MonitorSourceGranularity[] = ['hour', 'day', 'month'];
    async function refresh(
      name: string,
      start = '1998-04-01 00:00:00',
      end = '1998-05-01 00:00:00',
    ) {
      await pool.query(
        'CALL public.refresh_continuous_aggregate($1::regclass,$2::timestamp,$3::timestamp,force=>true)',
        [`public.${name}`, start, end],
      );
    }
    async function refreshAll(end?: string) {
      for (const item of timescaleAggregateEvidenceManifest)
        await refresh(item.caggRelation, undefined, end);
    }
    async function insert(
      code: string,
      time = '1998-04-18 03:10:00',
      broken = false,
    ) {
      await pool.query(
        `INSERT INTO public.monitor_history(asin_code,country,check_type,is_broken,check_time,variant_group_id,variant_group_name,site_snapshot,brand_snapshot)
      VALUES($1,'US','ASIN',$2,$3::timestamp,'coverage-109-group','Coverage 109','coverage-site','coverage-brand')`,
        [code, broken, time],
      );
    }
    async function coverage(
      family: MonitorAggregateFamily = 'asin',
      granularity: MonitorSourceGranularity = 'hour',
      raw = range,
    ) {
      const result = await createDb(pool).execute(
        monitorAggregateCoverageSelect(
          parseMonitorAnalyticsQuery('by-time', raw),
          family,
          granularity,
        ),
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0].covered;
    }
    beforeAll(async () => {
      if (
        process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
        'amazon_asin_monitor_ci'
      )
        throw new Error(
          'Coverage integration requires the explicitly disposable CI database',
        );
      pool = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 3000,
      });
      const { rows } = await pool.query('SELECT current_database() AS name');
      if (rows[0].name !== 'amazon_asin_monitor_ci')
        throw new Error('Unexpected coverage integration database');
      disposableVerified = true;
    });
    beforeEach(async () => {
      await pool.query(
        "DELETE FROM public.monitor_history WHERE asin_code LIKE 'B109COV%'",
      );
      await insert('B109COV001');
      await insert('B109COV002', '1998-04-18 03:20:00', true);
      await refreshAll();
    });
    afterAll(async () => {
      if (!pool) return;
      try {
        if (disposableVerified) {
          await pool.query(
            "DELETE FROM public.monitor_history WHERE asin_code LIKE 'B109COV%'",
          );
          await refreshAll('1998-08-01 00:00:00');
        }
      } finally {
        await pool.end();
      }
    });

    it('recognizes all nine real projections after refresh and stays independent of SQL session timezone', async () => {
      for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
        await pool.query("SELECT set_config('TimeZone',$1,false)", [tz]);
        for (const family of families)
          for (const granularity of granularities)
            expect(await coverage(family, granularity)).toBe(true);
      }
      const result = await createDb(pool).execute(sql`
      WITH coverage AS MATERIALIZED (${monitorAggregateCoverageSelect(
        query,
        'asin',
        'hour',
      )})
      SELECT coverage.covered,
        (SELECT sum(check_count)::text FROM public.monitor_history_agg_v2
          WHERE granularity='hour' AND time_slot='1998-04-18 03:00:00' AND asin_key COLLATE "C" LIKE 'B109COV%') AS checks
      FROM coverage
    `);
      expect(result.rows).toEqual([{ covered: true, checks: '2' }]);
    });

    it('detects late inserts and per-projection invalidations even after another aggregate refresh consumes the raw log', async () => {
      await insert('B109COV003', '1998-04-18 03:15:00');
      for (const family of families) expect(await coverage(family)).toBe(false);
      await refresh('monitor_history_cagg_asin_hour');
      expect(await coverage('asin')).toBe(true);
      expect(await coverage('dim')).toBe(false);
      expect(await coverage('variant_group')).toBe(false);
      await refreshAll();
      for (const family of families) expect(await coverage(family)).toBe(true);
    });

    it('detects historical flag changes and deletions that leave the latest check timestamp unchanged', async () => {
      await pool.query(
        "UPDATE public.monitor_history SET is_broken=true WHERE asin_code='B109COV001'",
      );
      expect(await coverage()).toBe(false);
      await refresh('monitor_history_cagg_asin_hour');
      expect(await coverage()).toBe(true);
      await pool.query(
        "DELETE FROM public.monitor_history WHERE asin_code='B109COV001'",
      );
      expect(await coverage()).toBe(false);
      await refresh('monitor_history_cagg_asin_hour');
      expect(await coverage()).toBe(true);
    });

    it('rejects an unrefreshed interior gap despite a later watermark, then accepts the refreshed empty bucket', async () => {
      await insert('B109COV004', '1998-07-18 03:10:00');
      await refresh(
        'monitor_history_cagg_asin_hour',
        '1998-07-18 03:00:00',
        '1998-07-18 04:00:00',
      );
      await insert('B109COV005', '1998-07-17 03:10:00');
      await pool.query(
        "DELETE FROM public.monitor_history WHERE asin_code='B109COV005'",
      );
      const empty = {
        startTime: '1998-07-17 03:00:00',
        endTime: '1998-07-17 03:59:59',
      };
      expect(await coverage('asin', 'hour', empty)).toBe(false);
      await refresh(
        'monitor_history_cagg_asin_hour',
        '1998-07-17 03:00:00',
        '1998-07-17 04:00:00',
      );
      expect(await coverage('asin', 'hour', empty)).toBe(true);
    });

    it('does not treat a missing/unbounded range or an unmaterialized tail as coverage', async () => {
      for (const raw of [
        {},
        { startTime: range.startTime },
        { endTime: range.endTime },
        { startTime: range.endTime, endTime: range.startTime },
      ]) {
        const result = await createDb(pool).execute(
          monitorAggregateCoverageSelect(
            parseMonitorAnalyticsQuery('by-time', raw),
            'asin',
            'hour',
          ),
        );
        expect(result.rows).toEqual([{ covered: false }]);
      }
      expect(
        await coverage('asin', 'hour', {
          startTime: '2099-01-01 00:00:00',
          endTime: '2099-01-01 01:00:00',
        }),
      ).toBe(false);
    });

    it('requires independent group-name snapshots because dimension-table changes do not invalidate a CAGG', async () => {
      await pool.query(
        "UPDATE public.monitor_history SET variant_group_name=NULL WHERE asin_code='B109COV001'",
      );
      await refreshAll();
      for (const granularity of granularities)
        expect(await coverage('variant_group', granularity)).toBe(false);
      expect(await coverage('asin')).toBe(true);
      await pool.query(
        "UPDATE public.monitor_history SET variant_group_name='Coverage 109' WHERE asin_code='B109COV001'",
      );
      await refreshAll();
      for (const granularity of granularities)
        expect(await coverage('variant_group', granularity)).toBe(true);
    });
  },
);
