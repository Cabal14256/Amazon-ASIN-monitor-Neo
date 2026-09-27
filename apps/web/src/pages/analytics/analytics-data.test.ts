import { afterEach, describe, expect, it } from 'vitest';
import { formatBeijingNow } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import {
  analyticsCountryQuery,
  analyticsError,
  applyAnalyticsFilters,
  count,
  COUNTRIES,
  initialAnalyticsFilters,
  latestPeakIntervals,
  monthlyRowsInRange,
  overviewAsinMetric,
  overviewStatisticsQuery,
  peakHoursQuery,
  percent,
  periodDetailsQuery,
  periodPageCount,
  selectOverviewSummary,
  sumAbnormalSeriesByPeriod,
} from './analytics-data';

describe('analytics page filters and display values', () => {
  it('keeps the combined Europe filter available', () => {
    expect(COUNTRIES.some((country) => country.value === 'EU')).toBe(true);
  });

  it('distinguishes monitored ASINs from affected ASINs in the KPI', () => {
    expect(overviewAsinMetric({ asinCount: 12 })).toEqual({
      label: '监控 ASIN',
      value: '12',
      hint: '当前筛选范围',
    });
    expect(
      overviewAsinMetric({ totalAsinsDedup: 12, brokenAsinsDedup: 3 }),
    ).toEqual({
      label: '受影响 ASIN',
      value: '3',
      hint: '监控 ASIN 12',
    });
  });

  it('makes later period summary pages reachable', () => {
    expect(periodPageCount(0, 20)).toBe(1);
    expect(periodPageCount(41, 20)).toBe(3);
  });

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

  it('uses country statistics for selected-country KPIs and global metrics otherwise', () => {
    const selected = { totalChecks: 2, brokenCount: 1 };
    const global = { totalChecks: 20, brokenCount: 8 };
    expect(selectOverviewSummary('US', selected, global)).toBe(selected);
    expect(selectOverviewSummary('US', undefined, global)).toBeUndefined();
    expect(selectOverviewSummary('', selected, global)).toBe(global);
    expect(selectOverviewSummary('', selected, undefined)).toBe(selected);
  });

  it('shows the latest peak intervals in chronological order', () => {
    const intervals = Array.from({ length: 10 }, (_, index) => index);
    expect(latestPeakIntervals(intervals)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(latestPeakIntervals([1, 2])).toEqual([1, 2]);
  });

  it('uses ASIN-only root KPIs and reserves the US fallback for peak hours', () => {
    const filters = {
      country: 'DE',
      startTime: '2026-09-01 00:00:00',
      endTime: '2026-09-10 23:59:59',
      groupBy: 'day' as const,
    };
    expect(overviewStatisticsQuery(filters)).toEqual({
      country: 'DE',
      startTime: filters.startTime,
      endTime: filters.endTime,
      checkType: 'ASIN',
    });
    expect(peakHoursQuery(filters).country).toBe('DE');

    const allCountries = { ...filters, country: '' };
    expect(analyticsCountryQuery(allCountries).country).toBeUndefined();
    expect(overviewStatisticsQuery(allCountries).country).toBeUndefined();
    expect(peakHoursQuery(allCountries).country).toBe('US');
  });

  it('loads period details using the selected row and matching granularity', () => {
    const filters = {
      country: '',
      startTime: '2026-09-01 00:00:00',
      endTime: '2026-09-10 23:59:59',
      groupBy: 'week' as const,
    };
    expect(
      periodDetailsQuery(filters, {
        country: 'UK',
        site: 'amazon.co.uk',
        brand: 'Brand A',
      }),
    ).toEqual({
      country: 'UK',
      site: 'amazon.co.uk',
      brand: 'Brand A',
      startTime: filters.startTime,
      endTime: filters.endTime,
      timeSlotGranularity: 'week',
    });
  });

  it('combines ASIN rows into one abnormal-duration point per time period', () => {
    const rows = [
      { timePeriod: '2026-09-02', abnormalDuration: 2, totalDuration: 4 },
      { timePeriod: '2026-09-01', abnormalDuration: 1, totalDuration: 2 },
      { timePeriod: '2026-09-02', abnormalDuration: 1, totalDuration: 2 },
    ];
    expect(sumAbnormalSeriesByPeriod(rows)).toEqual([
      {
        timePeriod: '2026-09-01',
        abnormalDuration: 1,
        totalDuration: 2,
        abnormalRatio: 50,
      },
      {
        timePeriod: '2026-09-02',
        abnormalDuration: 3,
        totalDuration: 6,
        abnormalRatio: 50,
      },
    ]);
  });

  it('excludes zero-filled month days outside the selected range before charting', () => {
    const month = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      abnormalDurationHours: index + 1 <= 10 ? 2 : 0,
    }));
    const visible = monthlyRowsInRange(
      month,
      '2026-09-01 08:00:00',
      '2026-09-10 12:00:00',
    );
    expect(visible).toHaveLength(10);
    expect(visible[0]).toMatchObject({
      date: '2026-09-01',
      abnormalDurationHours: 2,
    });
    expect(visible.at(-1)?.date).toBe('2026-09-10');
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
