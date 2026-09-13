import { monthlyBreakdownDataSchema } from '@asin-monitor/contracts';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMonitorMonthlyBreakdown,
  buildMonitorPeakMarkAreas,
  resolveMonitorMonthlyRange,
  type MonitorMonthlySourceRow,
} from '../src/monitor/monitor-analytics-view';

const now = new Date('2026-09-30T16:01:00Z');
const oracleScript = `
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const localRequire = createRequire(input.filename);
const fixedDate = class extends Date { constructor(...args) { super(...(args.length ? args : [input.now])); } };
const model = { exports: {} };
vm.runInNewContext(fs.readFileSync(input.filename, 'utf8'), {
  module: model, Date: fixedDate,
  require: name => {
    if (name === '../utils/peakHours') return localRequire(name);
    throw new Error('Unexpected Legacy analytics view dependency');
  },
});
process.stdout.write(JSON.stringify(input.cases.map(c => c.kind === 'monthly'
  ? model.exports.buildMonthlyBreakdownRows(c.rows, c.month)
  : model.exports.buildPeakHoursMarkAreas(c.params))));
`;
function legacy(cases: unknown[]): unknown[] {
  return JSON.parse(
    execFileSync(process.execPath, ['-e', oracleScript], {
      input: JSON.stringify({
        filename: resolve(
          __dirname,
          '../../../server/src/services/analyticsViewService.js',
        ),
        now: now.toISOString(),
        cases,
      }),
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Shanghai' },
      timeout: 10_000,
    }),
  );
}

describe('monitor analytics views / actual Legacy oracle', () => {
  const monthlyRows: MonitorMonthlySourceRow[] = [
    {
      time_period: '2024-02-01',
      totalDurationHours: 99,
      abnormalDurationHours: 99,
    },
    {
      time_period: '2024-02-01 12:00:00',
      totalDurationHours: '1',
      abnormalDurationHours: '1',
    },
    {
      time_period: '2024-02-02',
      total_duration_hours: '3',
      abnormal_duration_hours: '0',
    },
    {
      time_period: '2024-02-03',
      totalDurationHours: 0,
      total_duration_hours: 9,
      abnormalDurationHours: 0,
      abnormal_duration_hours: 9,
      ratioAllTime: 0,
      ratio_all_time: 80,
    },
    { time_period: '2024-02-04', ratio_all_time: '12.5' },
    {
      time_period: '2024-02-05',
      totalDurationHours: 'NaN',
      abnormalDurationHours: 'Infinity',
      ratioAllTime: 'Infinity',
    },
    {
      time_period: '2024-02-29',
      totalDurationHours: null,
      total_duration_hours: 4,
      abnormalDurationHours: null,
      abnormal_duration_hours: 1,
    },
    {
      time_period: '2024-03-01',
      totalDurationHours: 999,
      abnormalDurationHours: 999,
    },
  ];

  it('fills leap month gaps, keeps last duplicate/zero aliases, and computes a weighted summary', () => {
    const result = buildMonitorMonthlyBreakdown(monthlyRows, '2024-02', now);
    expect(result).toEqual(
      legacy([{ kind: 'monthly', rows: monthlyRows, month: '2024-02' }])[0],
    );
    expect(monthlyBreakdownDataSchema.parse(result)).toEqual(result);
    expect(result.rows).toHaveLength(29);
    expect(result.summary).toEqual({
      abnormalDurationTotal: 2,
      totalDurationTotal: 8,
      averageRatio: 25,
    });
    expect(result.rows[2].abnormalDurationRate).toBe(0);
    expect(result.rows[3].abnormalDurationRate).toBe(12.5);
    expect(result.rows[4].abnormalDurationRate).toBe(0);
  });

  it('preserves month fallback and clamp rules using the UTC+8 current month', () => {
    const months = [
      '',
      'not-a-month',
      '2024-00',
      '2024-13',
      '0000-02',
      '2023-02',
      '2024-02',
    ];
    expect(
      months.map((month) => buildMonitorMonthlyBreakdown([], month, now)),
    ).toEqual(
      legacy(months.map((month) => ({ kind: 'monthly', rows: [], month }))),
    );
    expect(resolveMonitorMonthlyRange({}, now)).toEqual({
      month: '2026-10',
      startTime: '2026-10-01 00:00:00',
      endTime: '2026-10-31 23:59:59',
      groupBy: 'day',
      sourceGranularity: 'day',
    });
    expect(
      resolveMonitorMonthlyRange({ startTime: '2024-02-09 15:30:00' }, now),
    ).toMatchObject({
      month: '2024-02',
      startTime: '2024-02-09 15:30:00',
      endTime: '2024-02-29 23:59:59',
    });
    expect(
      resolveMonitorMonthlyRange(
        { month: '2023-02', endTime: '2024-02-02 00:00:00' },
        now,
      ),
    ).toMatchObject({
      month: '2023-02',
      startTime: '2023-02-01 00:00:00',
      endTime: '2024-02-02 00:00:00',
    });
  });

  const peakCases = [
    '',
    'US',
    'UK',
    'DE',
    'FR',
    'ES',
    'IT',
    'EU',
    'us',
    'JP',
  ].flatMap((country) =>
    ['hour', 'day'].map((groupBy) => ({
      country,
      groupBy,
      startTime: '2024-02-29 14:15:00',
      endTime: '2024-03-01 01:00:00',
    })),
  );
  it('retains chart colors, region selection, complete boundary days and midnight rollover', () => {
    const results = peakCases.map(buildMonitorPeakMarkAreas);
    expect(results).toEqual(
      legacy(peakCases.map((params) => ({ kind: 'peaks', params }))),
    );
    expect(results[0].map((region) => region.name)).toEqual([
      'US',
      'UK',
      'EU_OTHER',
    ]);
    expect(results[0][1].areas[0]).toEqual([
      { name: 'UK高峰期', xAxis: '2024-02-29 22:00' },
      { xAxis: '2024-03-01 00:00' },
    ]);
    expect(results[0][0].areas[0][0].xAxis).toBe('2024-02-29 02:00');
    expect(results[0][0].areas).toHaveLength(4);
  });

  it.each(['UTC', 'America/New_York', 'Asia/Shanghai'])(
    'renders the same view under host TZ=%s',
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
        expect(buildMonitorMonthlyBreakdown([], undefined, now).month).toBe(
          '2026-10',
        );
        expect(peakCases.map(buildMonitorPeakMarkAreas)).toEqual(
          legacy(peakCases.map((params) => ({ kind: 'peaks', params }))),
        );
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    },
  );

  it('bounds peak mark expansion and handles empty or reversed dates without looping', () => {
    expect(
      buildMonitorPeakMarkAreas({ startTime: '', endTime: 'bad' }),
    ).toEqual([]);
    expect(
      buildMonitorPeakMarkAreas({
        startTime: '2024-03-02',
        endTime: '2024-02-29',
      }),
    ).toEqual([]);
    expect(() =>
      buildMonitorPeakMarkAreas({
        startTime: '1900-01-01',
        endTime: '2100-01-01',
      }),
    ).toThrow(RangeError);
    expect(
      buildMonitorPeakMarkAreas({
        startTime: '1900-01-01',
        endTime: '2100-01-01',
        country: 'EU',
      }),
    ).toEqual([]);
  });
});
