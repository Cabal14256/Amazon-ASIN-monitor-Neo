import { describe, expect, it, vi } from 'vitest';
import type { RequestOptions } from '../lib/http';
import { HttpClient } from '../lib/http';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import {
  getAbnormalDurationStatistics,
  getAllCountriesSummary,
  getAsinStatisticsByCountry,
  getAsinStatisticsByVariantGroup,
  getMonitorStatistics,
  getMonthlyBreakdown,
  getPeakHoursStatistics,
  getPeakMarkAreas,
  getPeriodSummary,
  getPeriodSummaryDetails,
  getRegionSummary,
  getStatisticsByCountry,
  getStatisticsByTime,
  getStatisticsByVariantGroup,
} from './monitor-analytics';

const metricRow = {
  totalDurationHours: 2,
  abnormalDurationHours: 1,
  normalDurationHours: 1,
  peakDurationHours: 1,
  peakAbnormalDurationHours: 0.5,
  lowDurationHours: 1,
  lowAbnormalDurationHours: 0.5,
  totalChecks: 2,
  brokenCount: 1,
  totalAsinsDedup: 2,
  brokenAsinsDedup: 1,
  ratioAllAsin: 50,
  ratioAllTime: 50,
  globalPeakRate: 50,
  globalLowRate: 50,
  ratioHigh: 50,
  ratioLow: 50,
};

const cases = [
  {
    path: '/api/v1/monitor-history/statistics',
    run: (http: Parameters<typeof getMonitorStatistics>[0]) =>
      getMonitorStatistics(http, { country: 'US' }),
    data: {
      totalChecks: 2,
      brokenCount: 1,
      normalCount: 1,
      groupCount: 1,
      asinCount: 2,
      totalDurationHours: 2,
      abnormalDurationHours: 1,
      normalDurationHours: 1,
      ratioAllAsin: 50,
      ratioAllTime: 50,
    },
  },
  {
    path: '/api/v1/monitor-history/statistics/by-time',
    run: (http: Parameters<typeof getStatisticsByTime>[0]) =>
      getStatisticsByTime(http, { groupBy: 'day' }),
    data: [],
  },
  {
    path: '/api/v1/monitor-history/statistics/by-country',
    run: (http: Parameters<typeof getStatisticsByCountry>[0]) =>
      getStatisticsByCountry(http, {}),
    data: [],
  },
  {
    path: '/api/v1/monitor-history/statistics/by-variant-group',
    run: (http: Parameters<typeof getStatisticsByVariantGroup>[0]) =>
      getStatisticsByVariantGroup(http, { limit: 20 }),
    data: [],
  },
  {
    path: '/api/v1/monitor-history/statistics/peak-hours',
    run: (http: Parameters<typeof getPeakHoursStatistics>[0]) =>
      getPeakHoursStatistics(http, { country: 'US' }),
    data: {
      peakBroken: 0,
      peakTotal: 0,
      peakRate: 0,
      offPeakBroken: 0,
      offPeakTotal: 0,
      offPeakRate: 0,
      peakDurationHours: 0,
      peakAbnormalDurationHours: 0,
      peakDurationRate: 0,
      offPeakDurationHours: 0,
      offPeakAbnormalDurationHours: 0,
      offPeakDurationRate: 0,
    },
  },
  {
    path: '/api/v1/monitor-history/statistics/analytics-monthly-breakdown',
    run: (http: Parameters<typeof getMonthlyBreakdown>[0]) =>
      getMonthlyBreakdown(http, { month: '2026-09' }),
    data: {
      month: '2026-09',
      rows: [],
      summary: {
        abnormalDurationTotal: 0,
        totalDurationTotal: 0,
        averageRatio: 0,
      },
    },
  },
  {
    path: '/api/v1/monitor-history/statistics/peak-mark-areas',
    run: (http: Parameters<typeof getPeakMarkAreas>[0]) =>
      getPeakMarkAreas(http, {
        startTime: '2026-09-01',
        endTime: '2026-09-30',
      }),
    data: [],
  },
  {
    path: '/api/v1/monitor-history/statistics/all-countries-summary',
    run: (http: Parameters<typeof getAllCountriesSummary>[0]) =>
      getAllCountriesSummary(http, {}),
    data: { timeRange: 'range', ...metricRow },
  },
  {
    path: '/api/v1/monitor-history/statistics/region-summary',
    run: (http: Parameters<typeof getRegionSummary>[0]) =>
      getRegionSummary(http, {}),
    data: ['US', 'EU_TOTAL', 'UK', 'DE', 'FR', 'ES', 'IT'].map((region) => ({
      region,
      regionCode: region,
      timeRange: 'range',
      ...metricRow,
    })),
  },
  {
    path: '/api/v1/monitor-history/statistics/period-summary',
    run: (http: Parameters<typeof getPeriodSummary>[0]) =>
      getPeriodSummary(http, { current: 1, pageSize: 20 }),
    data: { list: [], total: 0, current: 1, pageSize: 20 },
  },
  {
    path: '/api/v1/monitor-history/statistics/period-summary/details',
    run: (http: Parameters<typeof getPeriodSummaryDetails>[0]) =>
      getPeriodSummaryDetails(http, {}),
    data: [],
  },
  {
    path: '/api/v1/monitor-history/statistics/asin-by-country',
    run: (http: Parameters<typeof getAsinStatisticsByCountry>[0]) =>
      getAsinStatisticsByCountry(http, {}),
    data: [],
  },
  {
    path: '/api/v1/monitor-history/statistics/asin-by-variant-group',
    run: (http: Parameters<typeof getAsinStatisticsByVariantGroup>[0]) =>
      getAsinStatisticsByVariantGroup(http, { limit: 50 }),
    data: [],
  },
  {
    path: '/api/v1/monitor-history/abnormal-duration-statistics',
    run: (http: Parameters<typeof getAbnormalDurationStatistics>[0]) =>
      getAbnormalDurationStatistics(http, {
        asinIds: ['a1', 'a2'],
        includeSeries: '1',
      }),
    data: { timeGranularity: 'day', data: [], summary: [] },
  },
] as const;

describe('monitor analytics transport', () => {
  it.each(cases)(
    'maps the endpoint $path and caps its response',
    async (testCase) => {
      const calls: { path: string; options: RequestOptions }[] = [];
      const request = async (path: string, options: RequestOptions) => {
        calls.push({ path, options });
        return { success: true, data: testCase.data };
      };
      await testCase.run({ request } as never);
      expect(calls[0].path).toBe(testCase.path);
      expect(calls[0].options).toMatchObject({
        timeoutMs: 120_000,
        maxResponseBytes: 32 * 1024 * 1024,
      });
      if (testCase.path.endsWith('abnormal-duration-statistics'))
        expect(calls[0].options.query).toMatchObject({ asinIds: 'a1,a2' });
    },
  );

  it('parses complete Neo results through the normalized request URL', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: [], meta: { source: 'agg' } }),
      );
    const http = new HttpClient({
      baseURL: 'https://api.test/gateway/api/',
      pageOrigin: 'https://app.test',
      session: sessionFixture().store,
      fetch: fetcher,
    });
    try {
      await expect(
        getStatisticsByTime(http, {
          country: 'US',
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-30 23:59:59',
          groupBy: 'day',
        }),
      ).resolves.toEqual([]);
      const url = String(fetcher.mock.calls[0][0]);
      expect(url).toContain(
        '/gateway/api/v1/monitor-history/statistics/by-time',
      );
      expect(url).not.toContain('/api/api/');
      expect(new URL(url).searchParams.get('groupBy')).toBe('day');
    } finally {
      http.close();
    }
  });

  it('rejects malformed payloads and missing data instead of fabricating empty analytics', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = new HttpClient({
      pageOrigin: 'https://app.test',
      session: sessionFixture().store,
      fetch: fetcher,
    });
    try {
      fetcher.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [{}] }),
      );
      await expect(getStatisticsByTime(http, {})).rejects.toMatchObject({
        kind: 'INVALID_RESPONSE',
      });
      fetcher.mockResolvedValueOnce(jsonResponse({ success: true }));
      await expect(getStatisticsByTime(http, {})).rejects.toMatchObject({
        kind: 'INVALID_RESPONSE',
      });
    } finally {
      http.close();
    }
  });

  it('keeps concurrent analytics transport within the API two request limit', async () => {
    const responses = [
      deferred<Response>(),
      deferred<Response>(),
      deferred<Response>(),
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => responses[0].promise)
      .mockImplementationOnce(() => responses[1].promise)
      .mockImplementationOnce(() => responses[2].promise);
    const http = new HttpClient({
      pageOrigin: 'https://app.test',
      session: sessionFixture().store,
      fetch: fetcher,
    });
    try {
      const first = getStatisticsByTime(http, {});
      const second = getStatisticsByTime(http, {});
      const third = getStatisticsByTime(http, {});
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      responses[0].resolve(jsonResponse({ success: true, data: [] }));
      responses[1].resolve(jsonResponse({ success: true, data: [] }));
      await Promise.all([first, second]);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
      responses[2].resolve(jsonResponse({ success: true, data: [] }));
      await expect(third).resolves.toEqual([]);
    } finally {
      http.close();
    }
  });
});
