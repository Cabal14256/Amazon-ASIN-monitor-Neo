import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addMonitorGranularity,
  alignMonitorSlot,
  buildMonitorSlotTexts,
  floorMonitorDate,
  formatMonitorPeriod,
  formatMonitorSqlDate,
  getMonitorBucketRange,
  getMonitorDurationBucketHours,
  getMonitorDurationSourceGranularity,
  getMonitorExpectedSlotCount,
  parseMonitorDate,
  type MonitorGranularity,
  type MonitorSourceGranularity,
} from '../src/domain/monitor-calendar';
import {
  buildMonitorDurationRowsByGroup,
  type MonitorDurationSourceRow,
} from '../src/domain/monitor-duration-groups';

// The actual Legacy model runs in its own UTC+8 process. Its functions and Date
// implementation are untouched, so the oracle cannot inherit the Neo host TZ.
const oracleScript = `
const fs = require('node:fs'), vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const contextModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(input.filename, 'utf8') + '\\nmodule.exports = { MonitorHistory, parseDateTimeInput, floorDateToGranularity, addGranularity, formatDateToSqlText, getBucketRangeByPeriod, alignTimeToSlotText, getExpectedSlotCount, buildSlotTexts };', {
  module: contextModule,
  require: name => {
    if (['../config/database', '../services/cacheService', '../services/analyticsCacheService', '../services/analyticsAggService', '../utils/logger'].includes(name)) return {};
    throw new Error('Unexpected Legacy calendar dependency');
  },
});
const l = contextModule.exports, m = l.MonitorHistory;
const text = date => date ? l.formatDateToSqlText(date) : null;
const result = input.cases.map(c => {
  if (c.kind === 'calendar') {
    const date = l.parseDateTimeInput(c.value);
    return { floor: text(l.floorDateToGranularity(date, c.g)), add: text(l.addGranularity(date, c.g, c.step)), period: m.formatSlotToTargetPeriod(c.value, c.g) };
  }
  if (c.kind === 'bucket') {
    const range = l.getBucketRangeByPeriod(c.period, c.g);
    return { start: text(range.bucketStart), end: text(range.bucketEnd), hours: m.getDurationBucketHours(c.period, c.g, l.parseDateTimeInput(c.start), l.parseDateTimeInput(c.end)) };
  }
  if (c.kind === 'slots') {
    const start = l.alignTimeToSlotText(c.start, c.g), end = l.alignTimeToSlotText(c.end, c.g);
    return { start, end, count: l.getExpectedSlotCount(start, end, c.g), slots: l.buildSlotTexts(start, end, c.g) };
  }
  if (c.kind === 'source') return m.getDurationSourceGranularity(c.g, c.start, c.end);
  if (c.kind === 'groups') return m.buildDurationRowsByGroup(c.rows, {
    sourceGranularity: c.source, targetGranularity: c.target,
    queryStartDate: l.parseDateTimeInput(c.start), queryEndDate: l.parseDateTimeInput(c.end),
    buildGroupKey: (period, row) => row.country === 'SKIP' ? '' : period + '|' + row.country,
    buildGroupMeta: (period, row) => ({ time_period: period, country: row.country, site: row.site, ratioAllTime: -99, ratio_all_time: -98 }),
  });
  throw new Error('Unknown oracle operation');
});
process.stdout.write(JSON.stringify(result));
`;
function legacy(cases: unknown[]): unknown[] {
  return JSON.parse(
    execFileSync(process.execPath, ['-e', oracleScript], {
      env: { ...process.env, TZ: 'Asia/Shanghai' },
      input: JSON.stringify({
        filename: resolve(
          __dirname,
          '../../../server/src/models/MonitorHistory.js',
        ),
        cases,
      }),
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}
const format = (date: Date | null) =>
  date ? formatMonitorSqlDate(date) : null;
const granularities: MonitorGranularity[] = ['hour', 'day', 'week', 'month'];
const calendarCases = [
  '2015-12-31 23:45:22',
  '2016-01-01 00:01:00',
  '2016-01-04 08:09:10',
  '2019-12-30 00:00:00',
  '2020-02-29 12:34:56',
  '2021-01-03 23:59:59',
  '2024-02-28 19:45:00',
  '2024-03-31 01:30:00',
  '2024-11-03 01:30:00',
  '2026-09-13 18:02:03',
  '2026-12-31T23:59:59',
].flatMap((value) =>
  granularities.flatMap((g) =>
    [-2, 0, 1, 5].map((step) => ({ kind: 'calendar', value, g, step })),
  ),
);

describe('monitor calendar / actual Legacy UTC+8 oracle', () => {
  it('matches 176 calendar cases across ISO years, leap days and month overflow', () => {
    const expected = legacy(calendarCases);
    const actual = calendarCases.map(({ value, g, step }) => ({
      floor: format(floorMonitorDate(value, g)),
      add: format(addMonitorGranularity(value, g, step)),
      period: formatMonitorPeriod(value, g),
    }));
    expect(actual).toEqual(expected);
    expect(formatMonitorPeriod('2021-01-03 23:59:59', 'week')).toBe('2020-53');
    expect(format(floorMonitorDate('2021-01-03 23:59:59', 'week'))).toBe(
      '2020-12-28 00:00:00',
    );
  });

  it('keeps instants distinct from UTC+8 wall strings and copies Date inputs', () => {
    const instant = new Date('2026-09-12T16:30:00Z');
    const parsed = parseMonitorDate(instant);
    expect(parsed).not.toBe(instant);
    expect(parsed?.getTime()).toBe(instant.getTime());
    expect(formatMonitorPeriod(instant, 'day')).toBe('2026-09-13');
    expect(parseMonitorDate('2026-09-13 00:30:00')?.toISOString()).toBe(
      instant.toISOString(),
    );
    expect(parseMonitorDate('2026-09-13T00:30:00+08:00')?.toISOString()).toBe(
      instant.toISOString(),
    );
    expect(parseMonitorDate('2026-09-13 00:30:00.125')?.toISOString()).toBe(
      '2026-09-12T16:30:00.125Z',
    );
    for (const invalid of ['', 'nonsense', '09/13/2026', new Date(NaN)])
      expect(parseMonitorDate(invalid)).toBeNull();
  });

  it.each(['UTC', 'America/New_York', 'Asia/Shanghai'])(
    'does not depend on host TZ=%s',
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
        expect(
          calendarCases.map(({ value, g, step }) => ({
            floor: format(floorMonitorDate(value, g)),
            add: format(addMonitorGranularity(value, g, step)),
            period: formatMonitorPeriod(value, g),
          })),
        ).toEqual(legacy(calendarCases));
        expect(getMonitorDurationBucketHours('2024-03-10', 'day')).toBe(24);
        expect(getMonitorDurationBucketHours('2024-11-03', 'day')).toBe(24);
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    },
  );

  it('clips hour/day/month buckets only when both query bounds exist', () => {
    const sources: { period: string; g: MonitorSourceGranularity }[] = [
      { period: '2024-02-29 23:00:00', g: 'hour' },
      { period: '2024-02-29', g: 'day' },
      { period: '2024-02', g: 'month' },
      { period: 'bad', g: 'hour' },
    ];
    const cases = sources.flatMap((source) =>
      [
        { start: '', end: '' },
        { start: '2024-02-29 23:15:00', end: '2024-03-01 00:15:00' },
        { start: '2024-02-29 23:15:00', end: '' },
        { start: '', end: '2024-02-29 23:15:00' },
        { start: '2024-02-29 23:15:00', end: '2024-02-29 23:15:00' },
        { start: '2024-03-01 00:00:00', end: '2024-02-29 23:00:00' },
      ].map((range) => ({ kind: 'bucket', ...source, ...range })),
    );
    expect(
      cases.map((c) => {
        const range = getMonitorBucketRange(c.period, c.g);
        return {
          start: format(range.bucketStart),
          end: format(range.bucketEnd),
          hours: getMonitorDurationBucketHours(
            c.period,
            c.g,
            parseMonitorDate(c.start),
            parseMonitorDate(c.end),
          ),
        };
      }),
    ).toEqual(legacy(cases));
    expect(getMonitorDurationBucketHours('2024-02', 'month')).toBe(696);
    expect(
      getMonitorDurationBucketHours(
        '2024-02-29 23:00:00',
        'hour',
        parseMonitorDate('2024-02-29 23:15:00'),
        parseMonitorDate('2024-03-01 00:15:00'),
      ),
    ).toBe(0.75);
    expect(format(getMonitorBucketRange('2020-53', 'week').bucketEnd)).toBe(
      '2021-01-04 00:00:00',
    );
  });

  it('uses inclusive aligned coverage slots, including empty/invalid/reversed ranges', () => {
    const cases = (['hour', 'day', 'month'] as const).flatMap((g) =>
      [
        { start: '2023-12-31 23:15:00', end: '2024-01-02 01:30:00' },
        { start: '2024-02-01 00:00:00', end: '2024-03-01 00:00:00' },
        { start: '2026-09-13 01:59:59', end: '2026-09-13 01:59:59' },
        { start: '2026-09-14 00:00:00', end: '2026-09-13 00:00:00' },
        { start: '', end: 'bad' },
      ].map((range) => ({ kind: 'slots', g, ...range })),
    );
    expect(
      cases.map(({ start: a, end: b, g }) => {
        const start = alignMonitorSlot(a, g),
          end = alignMonitorSlot(b, g);
        return {
          start,
          end,
          count: getMonitorExpectedSlotCount(start, end, g),
          slots: buildMonitorSlotTexts(start, end, g),
        };
      }),
    ).toEqual(legacy(cases));
    expect(
      buildMonitorSlotTexts(
        '2026-01-01 00:00:00',
        '2026-01-01 02:00:00',
        'hour',
        2,
      ),
    ).toBeNull();
    expect(
      buildMonitorSlotTexts(
        '1900-01-01 00:00:00',
        '2100-01-01 00:00:00',
        'day',
      ),
    ).toBeNull();
    expect(() => buildMonitorSlotTexts('', '', 'hour', Infinity)).toThrow(
      RangeError,
    );
    expect(() => buildMonitorSlotTexts('', '', 'hour', 5001)).toThrow(
      RangeError,
    );
  });

  it('changes daily source granularity strictly above 31 days and uses days for ISO weeks', () => {
    const cases = granularities.flatMap((g) =>
      [
        { start: '', end: '' },
        { start: 'bad', end: 'bad' },
        { start: '2024-01-01 00:00:00', end: '2024-02-01 00:00:00' },
        { start: '2024-01-01 00:00:00', end: '2024-02-01 00:00:01' },
        { start: '2024-02-01 00:00:00', end: '2024-01-01 00:00:00' },
      ].map((range) => ({ kind: 'source', g, ...range })),
    );
    expect(
      cases.map((c) =>
        getMonitorDurationSourceGranularity(c.g, c.start, c.end),
      ),
    ).toEqual(legacy(cases));
  });

  it('groups clipped durations with first-row metadata, stable order and per-group ASIN deduplication', () => {
    const rows: MonitorDurationSourceRow[] = [
      {
        slot_period: '2024-02-28 23:00:00',
        country: 'US',
        site: 'first',
        asin_key: 'A',
        total_checks: 3,
        broken_count: 1,
        has_peak: 1,
      },
      {
        slot_period: '2024-02-28 23:00:00',
        country: 'UK',
        site: 'UK',
        asin_key: 'A',
        total_checks: 1,
        broken_count: 1,
      },
      {
        slot_period: '2024-02-29 00:00:00',
        country: 'US',
        site: 'later',
        asin_key: 'A',
        total_checks: 1,
        broken_count: 1,
      },
      {
        slot_period: '2024-02-29 00:00:00',
        country: 'US',
        site: 'other',
        asin_key: 'B',
        total_checks: '2',
        broken_count: '1',
        has_peak: true,
      },
      {
        slot_period: '2024-02-29 01:00:00',
        country: 'SKIP',
        asin_key: 'X',
        total_checks: 1,
      },
      {
        slot_period: '2024-03-01 00:00:00',
        country: 'US',
        asin_key: 'C',
        total_checks: 1,
      },
      { slot_period: '', country: 'US', asin_key: 'D', total_checks: 1 },
    ];
    const cases = granularities.flatMap((target) =>
      (['hour', 'day', 'month'] as const).map((source) => ({
        kind: 'groups',
        source,
        target,
        start: '2024-02-28 23:30:00',
        end: '2024-02-29 00:45:00',
        rows: rows.map((row) => ({
          ...row,
          slot_period: row.slot_period
            ? formatMonitorPeriod(row.slot_period, source)
            : '',
        })),
      })),
    );
    const actual = cases.map((c) =>
      buildMonitorDurationRowsByGroup(c.rows, {
        sourceGranularity: c.source,
        targetGranularity: c.target,
        queryStartDate: parseMonitorDate(c.start),
        queryEndDate: parseMonitorDate(c.end),
        buildGroupKey: (period, row) =>
          row.country === 'SKIP' ? '' : period + '|' + row.country,
        buildGroupMeta: (period, row) => ({
          time_period: period,
          country: row.country,
          site: row.site,
          ratioAllTime: -99,
          ratio_all_time: -98,
        }),
      }),
    );
    // JSON normalizes undefined optional metadata in the subprocess result.
    expect(JSON.parse(JSON.stringify(actual))).toEqual(legacy(cases));
    expect(actual[0][0]).toMatchObject({
      site: 'first',
      totalDurationHours: 0.5,
      abnormalDurationHours: 0.1667,
      ratioAllTime: 33.34,
    });
    expect(actual[0][2]).toMatchObject({
      totalAsinsDedup: 2,
      totalDurationHours: 1.5,
      abnormalDurationHours: 1.125,
      ratioAllTime: 75,
    });
  });
});
