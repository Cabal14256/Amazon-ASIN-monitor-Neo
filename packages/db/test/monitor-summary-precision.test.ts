import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/client';
import { parseMonitorAnalyticsQuery } from '../src/domain/monitor-analytics-query';
import {
  finalizeSqlRawDurationSummary,
  type DurationMetricSource,
  type DurationMetricsAccumulator,
} from '../src/domain/monitor-duration';
import { monitorAggregateDurationSelect } from '../src/repositories/monitor-analytics-aggregate-query';
import { readMonitorDurationQuery } from '../src/repositories/monitor-duration-query';

// Run the actual frozen Legacy raw arithmetic. SQL sufficient statistics must
// finish with this rounding order, rather than the MySQL aggregate DECIMAL
// temporary-table protocol used by the separate period/aggregate leaf path.
const filename = resolve(
  __dirname,
  '../../../server/src/models/MonitorHistory.js',
);
const module = { exports: {} };
vm.runInNewContext(
  readFileSync(filename, 'utf8') +
    '\nmodule.exports = { createDurationMetricsAccumulator, accumulateDurationMetrics, finalizeDurationMetrics };',
  {
    module,
    require: (name: string) => {
      if (
        [
          '../config/database',
          '../services/cacheService',
          '../services/analyticsCacheService',
          '../services/analyticsAggService',
          '../utils/logger',
        ].includes(name)
      )
        return {};
      throw new Error('Unexpected Legacy summary oracle dependency');
    },
  },
  { filename },
);
const legacy = module.exports as {
  createDurationMetricsAccumulator(): DurationMetricsAccumulator;
  accumulateDurationMetrics(
    state: DurationMetricsAccumulator,
    row: DurationMetricSource,
    hours: number,
  ): void;
  finalizeDurationMetrics(
    state: DurationMetricsAccumulator,
  ): Record<string, number>;
};

function sufficientStatistics(
  buckets: { row: DurationMetricSource; hours: number }[],
) {
  const state = legacy.createDurationMetricsAccumulator();
  for (const { row, hours } of buckets)
    legacy.accumulateDurationMetrics(state, row, hours);
  const { asinMetrics, ...totals } = state;
  const perAsin = [...asinMetrics.values()].filter(
    (value) => value.totalDurationHours > 0,
  );
  const sqlRow = {
    ...totals,
    sumAsinDurationRate: perAsin.reduce(
      (sum, value) =>
        sum + value.abnormalDurationHours / value.totalDurationHours,
      0,
    ),
    totalAsinsDedup: perAsin.length,
    brokenAsinsDedup: perAsin.filter((value) => value.abnormalDurationHours > 0)
      .length,
  };
  return { sqlRow, expected: legacy.finalizeDurationMetrics(state) };
}
function compare(buckets: { row: DurationMetricSource; hours: number }[]) {
  const { sqlRow, expected } = sufficientStatistics(buckets);
  const result = finalizeSqlRawDurationSummary(sqlRow);
  expect(result).toEqual(expected);
  return result;
}
function readerFixture(row: Record<string, unknown>) {
  const statements: string[] = [];
  const db = {
    execute: async (statement: Parameters<Db['execute']>[0]) => {
      const compiled = new PgDialect().sqlToQuery(
        statement as Parameters<PgDialect['sqlToQuery']>[0],
      );
      statements.push(compiled.sql);
      return {
        rows: compiled.sql.startsWith('FETCH')
          ? [{ covered: true, group_key: 'ALL', group_label: 'ALL', ...row }]
          : [],
      };
    },
  } as unknown as Db;
  return { db, statements };
}

describe('CAGG summary finalization / actual Legacy raw oracle', () => {
  it.each([4, 24])(
    'retains the unrounded 23:59:59 low bucket for %i ASINs',
    (asins) => {
      const result = compare(
        Array.from({ length: asins }, (_, index) => ({
          row: {
            asin_key: `ASIN-${index}`,
            total_checks: 11,
            broken_count: index % 2,
            has_peak: 0,
          },
          hours: 3599 / 3600,
        })),
      );
      expect(result.lowDurationHours).toBe(asins === 24 ? 23.9933 : 3.9989);
      expect(result.lowDurationHours).not.toBe(
        Number((asins * 0.9997).toFixed(4)),
      );
    },
  );

  it('keeps month normal and peak sums unrounded until final display', () => {
    const buckets = Array.from({ length: 24 }, (_, index) => ({
      row: {
        asin_key: `ASIN-${index}`,
        total_checks: 11,
        broken_count: (index % 4) + 1,
        has_peak: index % 2,
      },
      hours: 744 - 1 / 3600,
    }));
    const result = compare(buckets);
    expect(result.normalDurationHours).toBe(13797.813);
    expect(result.peakDurationHours).toBe(8927.9967);
  });

  it('computes global ratios from displayed totals and ASIN rates from unrounded totals', () => {
    expect(
      compare([
        {
          row: { asin_key: 'A', total_checks: 3, broken_count: 1 },
          hours: 1 / 3600,
        },
        {
          row: { asin_key: 'A', total_checks: 3, broken_count: 0, has_peak: 1 },
          hours: 1 / 3600,
        },
        {
          row: { asin_key: 'B', total_checks: 3, broken_count: 2, has_peak: 1 },
          hours: 1 / 3600,
        },
      ]),
    ).toMatchObject({
      ratioAllAsin: 41.6667,
      ratioAllTime: 37.5,
      ratioHigh: 33.3333,
    });
  });

  it('keeps empty and zero-duration summaries identical to Legacy', () => {
    compare([]);
    compare([
      { row: { asin_key: 'A', total_checks: 3, broken_count: 1 }, hours: 0 },
    ]);
  });

  it('keeps the default MySQL aggregate leaf protocol and confines raw summary arithmetic to the two summary operations', () => {
    const query = parseMonitorAnalyticsQuery('all-countries-summary', {
      startTime: '1997-10-01',
      endTime: '1997-10-31 23:59:59.123',
    });
    const dialect = new PgDialect();
    const original = dialect.sqlToQuery(
      monitorAggregateDurationSelect(query, 'hour'),
    );
    expect(original.sql).toContain('sum(round(base.bucket_hours,4))');
    expect(original.sql).toContain('public.monitor_history_agg_v2');
    const summary = dialect.sqlToQuery(
      monitorAggregateDurationSelect(query, 'hour', 'legacy-raw-summary'),
    );
    expect(summary.sql).toContain('public.monitor_history_agg_dim_v2');
    expect(summary.sql).toContain('normal_hours');
    expect(summary.sql).not.toContain('sum(round(base.bucket_hours,4))');
    expect(summary.sql).not.toContain("interval '0.5 seconds'");
    expect(summary.params).toContain('1997-10-31 23:59:59.123');
    expect(() =>
      monitorAggregateDurationSelect(
        parseMonitorAnalyticsQuery('by-time', query),
        'hour',
        'legacy-raw-summary',
      ),
    ).toThrow();
  });

  it('wires the production summary reader to raw sufficient statistics and its displayed-total ratios', async () => {
    const { sqlRow, expected } = sufficientStatistics(
      Array.from({ length: 24 }, (_, index) => ({
        row: {
          asin_key: `ASIN-${index}`,
          total_checks: 11,
          broken_count: (index % 4) + 1,
          has_peak: index % 2,
        },
        hours: 3599 / 3600,
      })),
    );
    const { db, statements } = readerFixture(sqlRow);
    const query = parseMonitorAnalyticsQuery('all-countries-summary', {
      startTime: '1997-10-01',
      endTime: '1997-10-31 23:59:59',
    });
    const actual = await readMonitorDurationQuery(db, query, () => {}, {
      aggregateEnabled: true,
      onAggregateFallback() {
        throw new Error('Unexpected fallback');
      },
    });
    expect(actual.source).toBe('agg');
    expect(actual.data).toEqual({
      timeRange: `${query.startTime} ~ ${query.endTime}`,
      ...expected,
      ratio_all_asin: expected.ratioAllAsin,
      ratio_all_time: expected.ratioAllTime,
      total_asins_dedup: expected.totalAsinsDedup,
      broken_asins_dedup: expected.brokenAsinsDedup,
    });
    expect(
      statements.find((statement) => statement.startsWith('DECLARE')),
    ).toContain('public.monitor_history_agg_dim_v2');
  });

  it.each([
    ['totalChecks', NaN],
    ['totalAsinsDedup', Infinity],
    ['brokenAsinsDedup', -1],
    ['sumAsinDurationRate', NaN],
    ['sumAsinDurationRate', 'invalid'],
    ['normalDurationHours', -0.1],
  ])(
    'rejects invalid SQL sufficient statistic %s without hiding it in zero/default ratios',
    async (key, value) => {
      const { sqlRow } = sufficientStatistics([
        { row: { asin_key: 'A', total_checks: 3, broken_count: 1 }, hours: 1 },
      ]);
      const { db } = readerFixture({ ...sqlRow, [String(key)]: value });
      const query = parseMonitorAnalyticsQuery('all-countries-summary', {
        startTime: '1997-10-01',
        endTime: '1997-10-31 23:59:59',
      });
      await expect(
        readMonitorDurationQuery(db, query, () => {}, {
          aggregateEnabled: true,
          onAggregateFallback() {
            throw new Error('Unexpected fallback');
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid-result' });
    },
  );
});
