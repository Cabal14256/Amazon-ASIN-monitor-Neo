import { describe, expect, it } from 'vitest';

import {
  allCountriesSummaryResultSchema,
  monitorHistoryListResultSchema,
  monitorStatisticsResultSchema,
  monthlyBreakdownResultSchema,
  peakHoursStatisticsResultSchema,
  periodSummaryDetailsQuerySchema,
  periodSummaryQuerySchema,
  periodSummaryResultSchema,
  statisticsByCountryResultSchema,
  statisticsByTimeQuerySchema,
  statisticsByTimeResultSchema,
  triggerMonitorResultSchema,
} from '../src/domains/monitor';

/**
 * monitor 域契约测试。
 */

describe('monitor 域', () => {
  it('历史列表 data 为分页形态，行含驼峰别名', () => {
    const parsed = monitorHistoryListResultSchema.parse({
      success: true,
      errorCode: 0,
      data: {
        list: [
          {
            id: 1,
            asin: 'B0ABC12345',
            check_type: 'GROUP',
            is_broken: 1,
            check_time: '2026-08-24 10:00:00',
            checkTime: '2026-08-24 10:00:00',
            isBroken: 1,
            variantGroupName: '组A',
          },
        ],
        total: 1,
        current: 1,
        pageSize: 10,
      },
    });
    expect(parsed.data?.list[0].isBroken).toBe(1);
  });

  it('skipCount 路径下 total 允许为 null', () => {
    const parsed = monitorHistoryListResultSchema.parse({
      success: true,
      data: { list: [], total: null, current: 1, pageSize: 10 },
    });
    expect(parsed.data?.total).toBeNull();
  });

  it('总体统计 data 含五基数与时长字段', () => {
    const parsed = monitorStatisticsResultSchema.parse({
      success: true,
      data: {
        totalChecks: 100,
        brokenCount: 5,
        normalCount: 95,
        groupCount: 3,
        asinCount: 20,
        totalDurationHours: 2400,
        abnormalDurationHours: 12.5,
      },
    });
    expect(parsed.data?.brokenCount).toBe(5);
  });

  it('总体统计兼容 mysql2 的 SUM 数字字符串', () => {
    const parsed = monitorStatisticsResultSchema.parse({
      success: true,
      data: {
        totalChecks: 100,
        brokenCount: '5',
        normalCount: '95',
        groupCount: 3,
        asinCount: 20,
      },
    });
    expect(parsed.data?.brokenCount).toBe('5');
    expect(parsed.data?.normalCount).toBe('95');
  });

  it('时间分组 query 保留控制器支持的 groupBy', () => {
    expect(statisticsByTimeQuerySchema.parse({ groupBy: 'hour' }).groupBy).toBe(
      'hour',
    );
    expect(() =>
      statisticsByTimeQuerySchema.parse({ groupBy: 'quarter' }),
    ).toThrow();
  });

  it('时间分组统计带顶层 meta', () => {
    const parsed = statisticsByTimeResultSchema.parse({
      success: true,
      errorCode: 0,
      data: [
        {
          time_period: '2026-08-24',
          totalChecks: 24,
          brokenCount: 1,
          abnormalDurationHours: 0.5,
        },
      ],
      meta: {
        source: 'agg',
        cacheHit: false,
        cacheTime: null,
        dataFreshness: 'fresh',
        lastUpdatedAt: '2026-08-24',
        busyFallback: false,
        busyReason: null,
      },
    });
    expect(parsed.meta?.source).toBe('agg');
    expect(parsed.data?.[0].time_period).toBe('2026-08-24');
  });

  it('按国家统计兼容 mysql2 的 SUM 数字字符串', () => {
    const parsed = statisticsByCountryResultSchema.parse({
      success: true,
      data: [
        {
          country: 'US',
          total_checks: 10,
          broken_count: '2',
          normal_count: '8',
        },
      ],
    });
    expect(parsed.data?.[0].broken_count).toBe('2');
    expect(parsed.data?.[0].normal_count).toBe('8');
  });

  it('周期汇总 query 保留维度、粒度和分页筛选', () => {
    expect(
      periodSummaryQuerySchema.parse({
        country: 'US',
        site: 'amazon.com',
        brand: 'Brand A',
        startTime: '2026-08-01',
        endTime: '2026-08-24',
        timeSlotGranularity: 'day',
        current: '2',
        pageSize: '20',
      }),
    ).toMatchObject({
      site: 'amazon.com',
      brand: 'Brand A',
      timeSlotGranularity: 'day',
      current: 2,
      pageSize: 20,
    });
    expect(
      periodSummaryDetailsQuerySchema.parse({
        site: 'amazon.com',
        brand: 'Brand A',
        timeSlotGranularity: 'hour',
      }),
    ).toMatchObject({ site: 'amazon.com', timeSlotGranularity: 'hour' });
  });

  it('周期汇总为分页形态且含 meta', () => {
    const parsed = periodSummaryResultSchema.parse({
      success: true,
      data: {
        list: [{ time_period: '2026-08-24', totalChecks: 10 }],
        total: 1,
        current: 1,
        pageSize: 10,
      },
      meta: { source: 'raw' },
    });
    expect(parsed.data?.list).toHaveLength(1);
  });

  it('月度异常时长 data 包含 month、rows 与 summary', () => {
    const parsed = monthlyBreakdownResultSchema.parse({
      success: true,
      data: {
        month: '2026-08',
        rows: [
          {
            date: '2026-08-01',
            day: 1,
            abnormalDurationHours: 2,
            totalDurationHours: 24,
            abnormalDurationRate: 8.33,
          },
        ],
        summary: {
          abnormalDurationTotal: 2,
          totalDurationTotal: 24,
          averageRatio: 8.33,
        },
      },
    });
    expect(parsed.data?.rows[0].day).toBe(1);
    expect(() =>
      monthlyBreakdownResultSchema.parse({ success: true, data: [] }),
    ).toThrow();
  });

  it('高峰期统计 data 为汇总对象而非小时数组', () => {
    const data = {
      peakBroken: 1,
      peakTotal: 10,
      peakRate: 10,
      offPeakBroken: 2,
      offPeakTotal: 20,
      offPeakRate: 10,
      peakDurationHours: 6,
      peakAbnormalDurationHours: 1,
      peakDurationRate: 16.67,
      offPeakDurationHours: 18,
      offPeakAbnormalDurationHours: 2,
      offPeakDurationRate: 11.11,
    };
    expect(
      peakHoursStatisticsResultSchema.parse({ success: true, data }).data,
    ).toMatchObject({ peakBroken: 1, offPeakTotal: 20 });
    expect(() =>
      peakHoursStatisticsResultSchema.parse({ success: true, data: [] }),
    ).toThrow();
  });

  it('全部国家汇总 data 为单个汇总对象', () => {
    const data = {
      timeRange: '2026-08-01 ~ 2026-08-24',
      totalDurationHours: 24,
      abnormalDurationHours: 2,
      normalDurationHours: 22,
      peakDurationHours: 8,
      peakAbnormalDurationHours: 1,
      lowDurationHours: 16,
      lowAbnormalDurationHours: 1,
      ratioAllAsin: 8.33,
      ratioAllTime: 8.33,
      globalPeakRate: 12.5,
      globalLowRate: 6.25,
      ratioHigh: 12.5,
      ratioLow: 6.25,
      totalChecks: 100,
      brokenCount: 8,
      totalAsinsDedup: 20,
      brokenAsinsDedup: 2,
    };
    const parsed = allCountriesSummaryResultSchema.parse({
      success: true,
      data,
      meta: { source: 'agg' },
    });
    expect(parsed.data?.totalChecks).toBe(100);
    expect(() =>
      allCountriesSummaryResultSchema.parse({ success: true, data: [data] }),
    ).toThrow();
  });

  it('手动触发 data 含 queued/jobId/countries', () => {
    const parsed = triggerMonitorResultSchema.parse({
      success: true,
      errorCode: 0,
      data: {
        message: '监控任务已入队',
        queued: true,
        jobId: 'job-1',
        countries: ['US', 'DE'],
      },
    });
    expect(parsed.data?.countries).toContain('US');
  });
});
