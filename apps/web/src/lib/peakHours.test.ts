import { describe, expect, it } from 'vitest';
import * as legacy from '../../../../src/utils/peakHours';
import {
  getPeakHours,
  getTimeRangeStats,
  isOffPeakHour,
  isPeakHour,
} from './peakHours';

const eu = [
  { start: 20, end: 24 },
  { start: 2, end: 5 },
];
const fixtures = [
  [
    'US',
    [
      { start: 2, end: 6 },
      { start: 9, end: 12 },
    ],
  ],
  [
    'UK',
    [
      { start: 22, end: 24 },
      { start: 0, end: 2 },
      { start: 3, end: 6 },
    ],
  ],
  ...['DE', 'FR', 'ES', 'IT'].map((country) => [country, eu] as const),
] as const;

describe('Beijing peak hours compatibility', () => {
  for (const [country, periods] of fixtures) {
    it(`preserves all 24 hours and exact interval boundaries for ${country}`, () => {
      expect(getPeakHours(country)).toEqual(periods);
      for (let hour = 0; hour < 24; hour++) {
        const expected = periods.some(
          ({ start, end }) => hour >= start && hour < end,
        );
        for (const minute of [0, 59]) {
          const wall = `2026-01-01 ${String(hour).padStart(2, '0')}:${String(
            minute,
          ).padStart(2, '0')}:59`;
          const absolute = new Date(Date.UTC(2026, 0, 1, hour - 8, minute, 59));
          for (const value of [wall, absolute]) {
            expect(isPeakHour(value, country)).toBe(expected);
            expect(isOffPeakHour(value, country)).toBe(!expected);
            expect(isPeakHour(value, country)).toBe(
              legacy.isPeakHour(value, country),
            );
          }
        }
      }
      expect(
        getTimeRangeStats('2026-01-01 00:00', '2026-01-01 23:59:59', country),
      ).toEqual({
        peakHours: 7,
        offPeakHours: 17,
        totalHours: 24,
      });
    });
  }
  it('keeps countries case-sensitive and treats an unknown country as off-peak', () => {
    for (const country of ['', 'us', 'CA', 'UNKNOWN']) {
      expect(getPeakHours(country)).toEqual([]);
      expect(isPeakHour('2026-01-01 03:00', country)).toBe(false);
      expect(isOffPeakHour('2026-01-01 03:00', country)).toBe(true);
    }
  });
  it('returns fresh range objects so callers cannot mutate subsequent results', () => {
    const periods = getPeakHours('US');
    periods[0].start = 0;
    periods.push({ start: 12, end: 24 });
    expect(getPeakHours('US')).toEqual(fixtures[0][1]);
  });
  it.each([
    ['2026-01-01 02:30', '2026-01-01 02:45', 'US', 1, 0],
    ['2026-01-01 01:30', '2026-01-01 02:00', 'US', 1, 1],
    ['2026-01-01 02:30', '2026-01-01 04:45', 'US', 3, 0],
    ['2026-01-01 21:30', '2026-01-02 02:00', 'UK', 4, 2],
    ['2026-01-01 00:00', '2026-01-02 00:00', 'US', 7, 18],
    ['2026-01-01 00:00', '2026-01-02 00:00', 'UK', 8, 17],
    ['2026-01-02 02:30', '2026-01-01 04:45', 'US', 0, 0],
    ['2026-01-01 02:45', '2026-01-01 02:00', 'US', 1, 0],
    ['2026-01-01 02:00', '2026-01-01 04:00', 'UNKNOWN', 0, 3],
  ] as const)(
    'counts inclusive hour buckets for %s → %s (%s)',
    (start, end, country, peakHours, offPeakHours) => {
      const result = getTimeRangeStats(start, end, country);
      expect(result).toEqual({
        peakHours,
        offPeakHours,
        totalHours: peakHours + offPeakHours,
      });
      expect(result).toEqual(legacy.getTimeRangeStats(start, end, country));
    },
  );
});
