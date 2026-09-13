import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMonitorAbnormalFromBuckets,
  buildMonitorAbnormalFromIntervals,
  getMonitorAbnormalGranularity,
  MonitorAnalyticsResultLimitError,
  type MonitorAbnormalBucketRow,
  type MonitorAbnormalQueryRange,
  type MonitorStatusIntervalRow,
} from '../src/domain/monitor-abnormal-duration';
import { formatMonitorPeriod } from '../src/domain/monitor-calendar';

const now = new Date('2024-03-01T16:00:00Z');
const script = `
const fs = require('node:fs'), vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const model = { exports: {} };
const fixedDate = class extends Date { constructor(...args) { super(...(args.length ? args : [input.now])); } };
let current;
vm.runInNewContext(fs.readFileSync(input.filename, 'utf8') + '\\nmodule.exports = { MonitorHistory, parseDateTimeInput, buildAbnormalDurationSummaryFromIntervals, buildAbnormalDurationSeriesFromIntervals };', {
  module: model, Date: fixedDate,
  require: name => {
    if (name === '../config/database') return { query: async () => current.rows };
    if (['../services/cacheService', '../services/analyticsCacheService', '../services/analyticsAggService', '../utils/logger'].includes(name)) return {};
    throw new Error('Unexpected Legacy abnormal-duration dependency');
  },
});
const l = model.exports;
// Only select the raw branch. SQL parity is covered separately by integration;
// the production post-query mapping, granularity and fill code remain intact.
l.MonitorHistory.canUseStatusIntervalForRange = async () => false;
(async () => {
  const results = [];
  for (const c of input.cases) {
    current = c;
    if (c.kind === 'buckets') { results.push(await l.MonitorHistory.getAbnormalDurationStatistics(c.query)); continue; }
    const saved = current;
    current = { rows: [] };
    const { timeGranularity } = await l.MonitorHistory.getAbnormalDurationStatistics({ ...c.query, includeSeries: '0' });
    current = saved;
    const start = l.parseDateTimeInput(c.query.startTime), end = l.parseDateTimeInput(c.query.endTime);
    results.push({ timeGranularity,
      data: c.query.includeSeries === '0' ? [] : l.buildAbnormalDurationSeriesFromIntervals(c.rows, timeGranularity, start, end),
      summary: l.buildAbnormalDurationSummaryFromIntervals(c.rows, c.query.startTime, c.query.endTime, start, end),
    });
  }
  process.stdout.write(JSON.stringify(results));
})().catch(() => { process.exitCode = 1; });
`;
function legacy(cases: unknown[]): unknown[] {
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      input: JSON.stringify({
        filename: resolve(
          __dirname,
          '../../../server/src/models/MonitorHistory.js',
        ),
        now: now.toISOString(),
        cases,
      }),
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Shanghai' },
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}
const shortRange = {
  startTime: '2024-02-29 23:15:00',
  endTime: '2024-03-01 02:00:00',
};
const bucketRows: MonitorAbnormalBucketRow[] = [
  {
    time_period: '2024-02-29 23:00:00',
    asin_id: 'a',
    asin: 'A',
    country: 'US',
    total_checks: '3',
    broken_count: '1',
  },
  {
    time_period: '2024-03-01 00:00:00',
    asin_id: 'a',
    asin: 'A',
    country: 'US',
    total_checks: 2,
    broken_count: 2,
  },
  {
    time_period: '2024-03-01 01:00:00',
    asin_id: 'a',
    asin: 'A',
    country: 'UK',
    total_checks: 2,
    broken_count: 1,
  },
  {
    time_period: '2024-03-01 01:00:00',
    asin_id: 'b',
    asin: null,
    country: null,
    total_checks: 1,
    broken_count: 0,
  },
];
const intervalRows: MonitorStatusIntervalRow[] = [
  {
    asin_id: 'a',
    asin: 'A',
    country: 'US',
    interval_start: '2024-02-29 22:00:00',
    interval_end: '2024-03-01 00:30:00',
    is_broken: 1,
  },
  {
    asin_id: 'a',
    asin: 'A',
    country: 'US',
    interval_start: '2024-03-01 00:30:00',
    interval_end: '2024-03-01 01:00:00',
    is_broken: false,
  },
  {
    asin_id: 'a',
    asin: 'A',
    country: 'US',
    interval_start: '2024-03-01 01:00:00',
    interval_end: null,
    is_broken: true,
  },
  {
    asin_id: 'a',
    asin: 'A',
    country: 'UK',
    interval_start: '2024-03-01 00:00:00',
    interval_end: '2024-03-01 01:00:00',
    is_broken: '1',
  },
  {
    asin_id: null,
    asin_key: 'orphan',
    country: '',
    interval_start: '2024-03-01 00:00:00',
    interval_end: '2024-03-01 01:00:00',
    is_broken: 1,
  },
  {
    asin_id: 'outside',
    asin: '',
    country: null,
    interval_start: '2024-03-03 00:00:00',
    interval_end: '2024-03-04 00:00:00',
    is_broken: 1,
  },
  {
    asin_id: 'invalid',
    asin: 'INVALID',
    country: 'US',
    interval_start: 'bad',
    interval_end: null,
    is_broken: 1,
  },
];

describe('monitor abnormal duration / actual Legacy oracle', () => {
  it('preserves bucket ratios, per-check summary and inclusive zero-filled terminal hour', () => {
    const result = buildMonitorAbnormalFromBuckets(bucketRows, shortRange);
    expect(result).toEqual(
      legacy([{ kind: 'buckets', rows: bucketRows, query: shortRange }])[0],
    );
    expect(result.data).toHaveLength(12);
    expect(result.summary[0]).toMatchObject({
      key: 'a-US',
      abnormalCount: 3,
      averageAbnormalDuration: 0.42,
      minAbnormalDuration: 0.25,
      maxAbnormalDuration: 0.5,
      maxAbnormalTime: '2024-03-01 00:00:00',
    });
    expect(result.data[3]).toMatchObject({
      timePeriod: '2024-03-01 02:00:00',
      totalDuration: 0,
      totalChecks: 0,
    });
  });

  it('counts clipped/open intervals as occurrences and splits across buckets independently of checks', () => {
    const result = buildMonitorAbnormalFromIntervals(
      intervalRows,
      shortRange,
      now,
    );
    expect(result).toEqual(
      legacy([{ kind: 'intervals', rows: intervalRows, query: shortRange }])[0],
    );
    expect(result.summary[0]).toMatchObject({
      key: 'a-US',
      abnormalCount: 2,
      averageAbnormalDuration: 1.13,
      minAbnormalDuration: 1,
      maxAbnormalDuration: 1.25,
      maxAbnormalTime: '2024-02-29 23:15:00',
    });
    expect(
      result.data.find(
        (row) =>
          row.asinId === 'a' &&
          row.country === 'US' &&
          row.timePeriod === '2024-03-01 00:00:00',
      ),
    ).toMatchObject({
      totalDuration: 1,
      abnormalDuration: 0.5,
      totalChecks: 2,
      brokenCount: 1,
      abnormalRatio: 50,
    });
  });

  it('retains distinct empty-input behavior, missing-bound behavior and summary-only results', () => {
    const queries: MonitorAbnormalQueryRange[] = [
      shortRange,
      { ...shortRange, includeSeries: '0' },
      {},
      { startTime: shortRange.startTime },
      { endTime: shortRange.endTime },
      { startTime: shortRange.endTime, endTime: shortRange.startTime },
    ];
    const cases = queries.flatMap((query) =>
      ['buckets', 'intervals'].flatMap((kind) =>
        [[], kind === 'buckets' ? bucketRows : intervalRows].map((rows) => ({
          kind,
          query,
          rows,
        })),
      ),
    );
    const actual = cases.map((c) =>
      c.kind === 'buckets'
        ? buildMonitorAbnormalFromBuckets(
            c.rows as MonitorAbnormalBucketRow[],
            c.query,
          )
        : buildMonitorAbnormalFromIntervals(
            c.rows as MonitorStatusIntervalRow[],
            c.query,
            now,
          ),
    );
    expect(actual).toEqual(legacy(cases));
    expect(buildMonitorAbnormalFromBuckets([], shortRange).data).toHaveLength(
      4,
    );
    expect(buildMonitorAbnormalFromIntervals([], shortRange, now).data).toEqual(
      [],
    );
  });

  it('uses hour/day/ISO week thresholds and matches raw mapping over long ranges', () => {
    const queries = [
      { startTime: '2024-01-01 00:00:00', endTime: '2024-01-08 00:00:00' },
      { startTime: '2024-01-01 00:00:00', endTime: '2024-01-08 00:00:01' },
      { startTime: '2024-01-01 00:00:00', endTime: '2024-01-31 00:00:00' },
      { startTime: '2023-12-31 00:00:00', endTime: '2024-02-01 00:00:00' },
    ];
    expect(queries.map(getMonitorAbnormalGranularity)).toEqual([
      'hour',
      'day',
      'day',
      'week',
    ]);
    const cases = queries.map((query) => ({
      kind: 'buckets',
      query,
      rows: bucketRows.map((row, i) => ({
        ...row,
        time_period: formatMonitorPeriod(
          `2024-01-0${i + 1} 13:00:00`,
          getMonitorAbnormalGranularity(query),
        ),
      })),
    }));
    expect(
      cases.map((c) => buildMonitorAbnormalFromBuckets(c.rows, c.query)),
    ).toEqual(legacy(cases));
    const intervalCases = queries.map((query) => ({
      kind: 'intervals',
      query,
      rows: [
        {
          asin_id: 'year',
          asin: 'YEAR',
          country: 'US',
          interval_start: '2023-12-30 20:00:00',
          interval_end: '2024-02-02 00:00:00',
          is_broken: 1,
        },
      ],
    }));
    expect(
      intervalCases.map((c) =>
        buildMonitorAbnormalFromIntervals(c.rows, c.query, now),
      ),
    ).toEqual(legacy(intervalCases));
  });

  it('retains duplicate snapshot identity, clamped broken fractions and two/four digit rounding', () => {
    const rows = [
      ...bucketRows,
      { ...bucketRows[0], asin: 'Changed', total_checks: 1, broken_count: 2 },
      {
        ...bucketRows[1],
        asin_id: '',
        asin: null,
        country: '',
        total_checks: 0,
        broken_count: 0,
      },
      { ...bucketRows[2], broken_count: -1 },
    ];
    expect(buildMonitorAbnormalFromBuckets(rows, shortRange)).toEqual(
      legacy([{ kind: 'buckets', query: shortRange, rows }])[0],
    );
    const overlapping = [
      ...intervalRows,
      {
        ...intervalRows[0],
        interval_start: '2024-03-01 00:00:01',
        interval_end: '2024-03-01 00:20:00',
      },
      {
        ...intervalRows[0],
        interval_start: '2024-03-01 00:00:01',
        interval_end: '2024-03-01 00:20:00',
      },
    ];
    expect(
      buildMonitorAbnormalFromIntervals(overlapping, shortRange, now),
    ).toEqual(
      legacy([{ kind: 'intervals', query: shortRange, rows: overlapping }])[0],
    );
  });

  it.each(['UTC', 'America/New_York', 'Asia/Shanghai'])(
    'keeps abnormal duration stable under host TZ=%s',
    (tz) => {
      const previous = process.env.TZ;
      try {
        process.env.TZ = tz;
        expect(new Date('2024-01-01T00:00:00Z').getTimezoneOffset()).toBe(
          (
            {
              UTC: 0,
              'America/New_York': 300,
              'Asia/Shanghai': -480,
            } as Record<string, number>
          )[tz],
        );
        expect([
          buildMonitorAbnormalFromBuckets(bucketRows, shortRange),
          buildMonitorAbnormalFromIntervals(intervalRows, shortRange, now),
        ]).toEqual(
          legacy([
            { kind: 'buckets', rows: bucketRows, query: shortRange },
            { kind: 'intervals', rows: intervalRows, query: shortRange },
          ]),
        );
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    },
  );

  it('rejects source/series expansion beyond the bounded response and work budgets', () => {
    expect(() =>
      buildMonitorAbnormalFromBuckets(Array(50_001).fill(bucketRows[0]), {
        includeSeries: '0',
      }),
    ).toThrow(MonitorAnalyticsResultLimitError);
    const manyRows = Array.from({ length: 12_501 }, (_, index) => ({
      ...bucketRows[0],
      asin_id: String(index),
    }));
    expect(() => buildMonitorAbnormalFromBuckets(manyRows, shortRange)).toThrow(
      MonitorAnalyticsResultLimitError,
    );
    expect(
      buildMonitorAbnormalFromBuckets(manyRows, {
        ...shortRange,
        includeSeries: '0',
      }).summary,
    ).toHaveLength(12_501);
    expect(() =>
      buildMonitorAbnormalFromIntervals(
        manyRows.map((row) => ({ ...intervalRows[0], asin_id: row.asin_id })),
        shortRange,
        now,
      ),
    ).toThrow(MonitorAnalyticsResultLimitError);
    expect(() =>
      buildMonitorAbnormalFromBuckets([], {
        startTime: '1900-01-01 00:00:00',
        endTime: '2100-01-01 00:00:00',
      }),
    ).toThrow(MonitorAnalyticsResultLimitError);
    const overlapping = Array(2000).fill({
      ...intervalRows[0],
      interval_start: '2024-01-01 00:00:00',
      interval_end: null,
    });
    expect(() =>
      buildMonitorAbnormalFromIntervals(
        overlapping,
        { startTime: '2024-01-01 00:00:00', endTime: '2024-01-08 00:00:00' },
        now,
      ),
    ).toThrow(MonitorAnalyticsResultLimitError);
  });
});
