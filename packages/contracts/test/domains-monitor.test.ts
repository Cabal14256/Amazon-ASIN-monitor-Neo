import { describe, expect, it } from 'vitest';

import {
  monitorHistoryListResultSchema,
  monitorStatisticsResultSchema,
  periodSummaryResultSchema,
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
      meta: { source: 'agg', cacheHit: false, generatedAt: '2026-08-24' },
    });
    expect(parsed.meta?.source).toBe('agg');
    expect(parsed.data?.[0].time_period).toBe('2026-08-24');
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
