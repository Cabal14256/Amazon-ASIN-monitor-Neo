import dayjs from 'dayjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as legacy from '../../../../src/utils/beijingTime';
import {
  BEIJING_TIMEZONE,
  formatBeijing,
  formatBeijingDate,
  formatBeijingNow,
  toBeijingDayjs,
} from './beijingTime';

afterEach(() => vi.useRealTimers());
describe('Beijing time compatibility', () => {
  it('uses the named Shanghai timezone and preserves the default date format', () => {
    expect(BEIJING_TIMEZONE).toBe('Asia/Shanghai');
    expect(formatBeijing('2026-01-01 07:08:09.123')).toBe(
      '2026-01-01 07:08:09',
    );
    expect(formatBeijingDate('2025-12-31T16:00:00Z')).toBe('2026-01-01');
  });
  it.each([
    ['2026-01-01', '2026-01-01 00:00:00.000'],
    ['2026-01-01 07:08', '2026-01-01 07:08:00.000'],
    ['2026-01-01T07:08:09.123', '2026-01-01 07:08:09.123'],
    [' 2026-01-01 07:08:09 ', '2026-01-01 07:08:09.000'],
    ['2025-12-31T16:00:00Z', '2026-01-01 00:00:00.000'],
    ['2026-01-01T07:08:09+08:00', '2026-01-01 07:08:09.000'],
    ['2026-01-01T07:08:09+0800', '2026-01-01 07:08:09.000'],
    ['2026-01-01T23:00:00-05:00', '2026-01-02 12:00:00.000'],
    ['2024-02-29T23:59:59.123+08:00', '2024-02-29 23:59:59.123'],
    ['2024-02-29T16:00:00Z', '2024-03-01 00:00:00.000'],
    ['2026-07-01T12:00:00-04:00', '2026-07-02 00:00:00.000'],
  ])(
    'normalizes %s without interpreting an unzoned value in the host timezone',
    (input, expected) => {
      const pattern = 'YYYY-MM-DD HH:mm:ss.SSS';
      expect(formatBeijing(input, pattern)).toBe(expected);
      expect(formatBeijing(input, pattern)).toBe(
        legacy.formatBeijing(input, pattern),
      );
      expect(toBeijingDayjs(input).utcOffset()).toBe(480);
    },
  );
  it.each([undefined, null, '', '   '])(
    'uses now for the Legacy empty input %s',
    (input) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T16:30:45.123Z'));
      expect(formatBeijing(input)).toBe('2026-01-02 00:30:45');
      expect(formatBeijingNow('YYYY-MM-DD HH:mm:ss.SSS')).toBe(
        '2026-01-02 00:30:45.123',
      );
    },
  );
  it('accepts Date, epoch zero and Dayjs without mutating the caller value', () => {
    const instant = new Date('2025-12-31T16:00:00Z');
    const value = dayjs(instant);
    expect(formatBeijing(instant)).toBe('2026-01-01 00:00:00');
    expect(formatBeijing(value)).toBe('2026-01-01 00:00:00');
    expect(formatBeijing(0)).toBe('1970-01-01 08:00:00');
    expect(instant.toISOString()).toBe('2025-12-31T16:00:00.000Z');
    expect(value.valueOf()).toBe(instant.getTime());
  });
  it('preserves invalid input results rather than silently replacing them with now', () => {
    for (const input of ['not-a-date', new Date(NaN)]) {
      expect(toBeijingDayjs(input).isValid()).toBe(false);
      expect(formatBeijing(input)).toBe('Invalid Date');
      expect(formatBeijing(input)).toBe(legacy.formatBeijing(input));
    }
  });
});
