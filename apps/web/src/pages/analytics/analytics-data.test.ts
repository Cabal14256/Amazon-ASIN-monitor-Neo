import { afterEach, describe, expect, it } from 'vitest';
import { formatBeijingNow } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import {
  analyticsError,
  applyAnalyticsFilters,
  count,
  initialAnalyticsFilters,
  percent,
} from './analytics-data';

describe('analytics page filters and display values', () => {
  const timezone = process.env.TZ;
  afterEach(() => {
    if (timezone === undefined) delete process.env.TZ;
    else process.env.TZ = timezone;
  });

  it('defaults to the prior 30 days using Shanghai wall time', () => {
    process.env.TZ = 'America/Los_Angeles';
    const filters = initialAnalyticsFilters();
    expect(filters.endTime).toBe(formatBeijingNow('YYYY-MM-DDTHH:mm'));
    expect(filters.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(filters.groupBy).toBe('day');
  });

  it('keeps datetime-local input as a Shanghai wall clock and rejects invalid ranges', () => {
    const valid = applyAnalyticsFilters({
      country: 'US',
      startTime: '2026-09-01T08:30',
      endTime: '2026-09-02T09:45',
      groupBy: 'hour',
    });
    expect(valid).toEqual({
      ok: true,
      value: {
        country: 'US',
        startTime: '2026-09-01 08:30:00',
        endTime: '2026-09-02 09:45:00',
        groupBy: 'hour',
      },
    });
    expect(
      applyAnalyticsFilters({
        country: '',
        startTime: '2026-09-02T09:45',
        endTime: '2026-09-01T08:30',
        groupBy: 'day',
      }),
    ).toMatchObject({ ok: false, error: '结束时间应不早于开始时间。' });
  });

  it('formats percentage values and counts without turning invalid data into NaN', () => {
    expect(percent(12.34)).toBe('12.3%');
    expect(percent(120)).toBe('100%');
    expect(count('12345')).toBe('12,345');
    expect(count('invalid')).toBe('0');
  });

  it('gives actionable messages for authorization and result bounds', () => {
    expect(analyticsError(new ApiError('HTTP', 'forbidden', 403))).toContain(
      '读取权限',
    );
    expect(analyticsError(new ApiError('HTTP', 'large', 413))).toContain(
      '缩小时间范围',
    );
  });
});
