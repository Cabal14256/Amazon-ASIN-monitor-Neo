import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  accumulateDurationMetrics,
  createDurationMetricsAccumulator,
  finalizeDurationMetrics,
  normalizeSqlDurationMetricRow,
  type DurationMetricSource,
} from '../src/domain/monitor-duration';

// Execute the actual private functions in the Legacy model. Exporting handles
// in this test context does not replace their implementation or SQL behavior.
function legacyArithmetic() {
  const filename = resolve(
    __dirname,
    '../../../server/src/models/MonitorHistory.js',
  );
  const module = { exports: {} };
  vm.runInNewContext(
    readFileSync(filename, 'utf8') +
      '\nmodule.exports = { createDurationMetricsAccumulator, accumulateDurationMetrics, finalizeDurationMetrics, normalizeSqlDurationMetricRow };',
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
        throw new Error('Unexpected Legacy arithmetic dependency');
      },
    },
    { filename },
  );
  return module.exports as {
    createDurationMetricsAccumulator: typeof createDurationMetricsAccumulator;
    accumulateDurationMetrics: typeof accumulateDurationMetrics;
    finalizeDurationMetrics: typeof finalizeDurationMetrics;
    normalizeSqlDurationMetricRow: typeof normalizeSqlDurationMetricRow;
  };
}
const legacy = legacyArithmetic();
type Bucket = { row: DurationMetricSource | null; hours: number };
function compare(buckets: Bucket[]) {
  const neoState = createDurationMetricsAccumulator(),
    oldState = legacy.createDurationMetricsAccumulator();
  for (const { row, hours } of buckets) {
    accumulateDurationMetrics(neoState, row, hours);
    legacy.accumulateDurationMetrics(oldState, row, hours);
  }
  const result = finalizeDurationMetrics(neoState);
  expect(result).toEqual(legacy.finalizeDurationMetrics(oldState));
  expect(normalizeSqlDurationMetricRow(result, { label: 'fixture' })).toEqual(
    legacy.normalizeSqlDurationMetricRow(result, { label: 'fixture' }),
  );
  return result;
}
describe('monitor duration arithmetic / actual Legacy oracle', () => {
  it('keeps per-ASIN average duration separate from global time and check-count ratios', () => {
    const value = compare([
      {
        row: { asin_key: 'A', total_checks: 1, broken_count: 1, has_peak: 1 },
        hours: 1,
      },
      { row: { asin_key: 'A', total_checks: 1, broken_count: 0 }, hours: 3 },
      { row: { asin_key: 'B', total_checks: 1, broken_count: 1 }, hours: 1 },
    ]);
    expect(value).toMatchObject({
      totalDurationHours: 5,
      abnormalDurationHours: 2,
      totalChecks: 3,
      brokenCount: 2,
      totalAsinsDedup: 2,
      brokenAsinsDedup: 2,
      ratioAllAsin: 62.5,
      ratioAllTime: 40,
      globalPeakRate: 20,
      globalLowRate: 20,
      ratioHigh: 100,
      ratioLow: 25,
    });
  });
  it('retains Legacy rounding order for partial hours and global denominators', () => {
    expect(
      compare([
        {
          row: { asin_key: 'A', total_checks: '3', broken_count: '1' },
          hours: 1,
        },
      ]),
    ).toMatchObject({
      abnormalDurationHours: 0.3333,
      normalDurationHours: 0.6667,
      ratioAllAsin: 33.3333,
      ratioAllTime: 33.33,
    });
  });
  it('retains nullish field precedence, numeric strings and exact-case ASIN keys', () => {
    expect(
      compare([
        {
          row: {
            asin_key: ' A ',
            asinKey: 'ignored',
            total_checks: 0,
            check_count: 2,
            broken_count: 0,
            brokenCount: 1,
            has_peak: 0,
            is_peak: 1,
          },
          hours: 1,
        },
        {
          row: {
            asinKey: 'A',
            check_count: '2',
            brokenCount: '1',
            is_peak: true,
          },
          hours: 0.5,
        },
        {
          row: {
            asin_key: 'a',
            total_checks: null,
            check_count: 2,
            broken_count: null,
            brokenCount: 2,
          },
          hours: 0.5,
        },
      ]),
    ).toMatchObject({
      totalAsinsDedup: 2,
      brokenAsinsDedup: 2,
      peakDurationHours: 0.5,
      lowDurationHours: 1.5,
      totalChecks: 4,
      brokenCount: 3,
    });
  });
  it.each(
    (
      [
        [],
        [{ row: null, hours: 0 }],
        [{ row: {}, hours: -1 }],
        [{ row: { total_checks: 2, broken_count: 1 }, hours: 0.25 }],
      ] as Bucket[][]
    ).map((rows) => ({ rows })),
  )(
    'handles empty/missing-key and nonpositive duration case %#',
    ({ rows }) => {
      compare(rows);
    },
  );
  it('clamps abnormal duration while preserving raw count totals', () => {
    expect(
      compare([
        {
          row: { asin_key: 'A', total_checks: '2', broken_count: '5' },
          hours: 0.5,
        },
      ]),
    ).toMatchObject({
      abnormalDurationHours: 0.5,
      normalDurationHours: 0,
      totalChecks: 2,
      brokenCount: 5,
    });
    compare([
      { row: { asin_key: 'B', total_checks: 2, broken_count: -1 }, hours: 0.5 },
    ]);
  });
  it('matches one hundred deterministic mixed bucket series', () => {
    let state = 109;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let run = 0; run < 100; run++) {
      const rows: Bucket[] = [];
      for (let index = 0; index < 25; index++) {
        const total = next() % 21;
        rows.push({
          row: {
            asin_key: ['', ' A ', 'A', 'a', 'B', 'C'][next() % 6],
            total_checks: String(total),
            broken_count: String(next() % (total + 2)),
            has_peak: next() % 3,
          },
          hours: (next() % 3001) / 1000,
        });
      }
      compare(rows);
    }
  });
  it('normalizes every SQL metric and alias, replacing colliding extras in Legacy order', () => {
    const row = {
      totalChecks: '15',
      brokenCount: null,
      ratioAllAsin: '20.25',
      ratioAllTime: 30.5,
      totalAsinsDedup: '7',
      brokenAsinsDedup: 3,
    };
    const extra = {
      ratioAllAsin: 999,
      ratio_all_time: 999,
      retained: 'metadata',
    };
    expect(normalizeSqlDurationMetricRow(row, extra)).toEqual(
      legacy.normalizeSqlDurationMetricRow(row, extra),
    );
  });
});
