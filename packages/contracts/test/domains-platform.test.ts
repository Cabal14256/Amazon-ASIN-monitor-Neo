import { describe, expect, it } from 'vitest';

import {
  dashboardResultSchema,
  feishuConfigListResultSchema,
  healthSchema,
  opsOverviewResultSchema,
  rateLimiterStatusQuerySchema,
  rateLimiterStatusResultSchema,
  refreshAnalyticsRequestSchema,
  spApiDisplayConfigListResultSchema,
  systemAlertResultSchema,
  toggleFeishuConfigRequestSchema,
  updateSpApiConfigsRequestSchema,
} from '../src';

describe('feishu 域', () => {
  it('兼容列表的驼峰形态与详情的旧蛇形形态', () => {
    expect(
      feishuConfigListResultSchema.parse({
        success: true,
        data: [
          {
            id: 1,
            country: 'US',
            webhookUrl: '***MASKED***',
            enabled: 1,
          },
          {
            id: 2,
            country: 'EU',
            webhook_url: '***MASKED***',
            enabled: true,
          },
        ],
      }).data,
    ).toHaveLength(2);
  });

  it('toggle 只接受 boolean 或 0/1', () => {
    expect(toggleFeishuConfigRequestSchema.parse({ enabled: 0 }).enabled).toBe(
      0,
    );
    expect(() =>
      toggleFeishuConfigRequestSchema.parse({ enabled: 'false' }),
    ).toThrow();
  });
});

describe('sp-api-config 域', () => {
  it('批量更新至少需要一个配置项', () => {
    expect(() =>
      updateSpApiConfigsRequestSchema.parse({ configs: [] }),
    ).toThrow();
    expect(
      updateSpApiConfigsRequestSchema.parse({
        configs: [
          {
            configKey: 'MONITOR_US_SCHEDULE_MINUTES',
            configValue: 30,
          },
        ],
      }).configs[0].configKey,
    ).toBe('MONITOR_US_SCHEDULE_MINUTES');
  });

  it('显示配置保留真实值与脱敏显示值两个字段的契约', () => {
    const parsed = spApiDisplayConfigListResultSchema.parse({
      success: true,
      data: [
        {
          id: null,
          configKey: 'SP_API_US_REFRESH_TOKEN',
          configValue: '***MASKED***',
          displayValue: '***MASKED***',
          hasValue: true,
          description: 'US Refresh Token',
          createTime: null,
          updateTime: null,
        },
      ],
    });
    expect(parsed.data?.[0].hasValue).toBe(true);
  });

  it('限流快照兼容单区域查询', () => {
    expect(rateLimiterStatusQuerySchema.parse({ region: 'us' }).region).toBe(
      'US',
    );
    const parsed = rateLimiterStatusResultSchema.parse({
      success: true,
      data: {
        US: {
          mode: 'redis-distributed',
          lastMode: 'redis-distributed',
          redisAvailable: true,
          name: 'US',
          secondTokens: 1,
          minuteTokens: 44,
          hourTokens: 2699,
          limits: { second: 2, minute: 45, hour: 2700 },
          windows: {
            minute: { used: 1, remaining: 44, limit: 45, windowMs: 60000 },
          },
          limitSource: 'config',
          limitUpdatedAt: null,
        },
      },
    });
    expect(parsed.data?.US.redisAvailable).toBe(true);
  });
});

describe('dashboard / ops / system / health 域', () => {
  it('解析仪表盘四块数据', () => {
    const counters = {
      totalGroups: 1,
      totalASINs: 2,
      brokenGroups: 0,
      brokenASINs: 1,
      todayChecks: 3,
      todayBroken: 1,
      normalGroups: 1,
      normalASINs: 1,
    };
    const parsed = dashboardResultSchema.parse({
      success: true,
      data: {
        overview: { ...counters, overviewByCountry: { US: counters } },
        realtimeAlerts: { brokenGroups: [], brokenASINs: [] },
        distribution: {
          byCountry: [{ country: 'US', total: 1, broken: 0, normal: 1 }],
        },
        recentActivities: [],
      },
    });
    expect(parsed.data?.overview.totalASINs).toBe(2);
  });

  it('解析运维概览与聚合刷新参数', () => {
    const parsed = opsOverviewResultSchema.parse({
      success: true,
      data: {
        processRole: 'api',
        schedulerEnabled: true,
        workerRegisteredQueues: ['monitor'],
        workerProcessorDetails: {},
        cache: {},
        analyticsCache: { prefixes: ['latest:'], lastClearedAt: null },
        riskControl: {},
        scheduler: {},
        analyticsAgg: {},
        queues: {
          monitor: { counts: { waiting: 0 }, isPaused: false, limiter: {} },
          competitor: {
            counts: { waiting: 0 },
            isPaused: false,
            limiter: {},
          },
        },
      },
    });
    expect(parsed.data?.processRole).toBe('api');
    expect(
      refreshAnalyticsRequestSchema.parse({ granularity: 'day' }).granularity,
    ).toBe('day');
  });

  it('解析系统告警与非信封 health', () => {
    expect(
      systemAlertResultSchema.parse({
        success: true,
        data: { message: '', type: 'info' },
      }).data?.type,
    ).toBe('info');

    expect(
      healthSchema.parse({
        status: 'ok',
        timestamp: '2026-08-24T18:00:00+08:00',
        uptime: 10,
        database: { status: 'ok', connected: true, usagePercent: '1.00' },
      }).status,
    ).toBe('ok');
  });
});
