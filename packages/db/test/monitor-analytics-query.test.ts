import {
  abnormalDurationQuerySchema,
  aggregateSummaryQuerySchema,
  asinStatisticsByCountryQuerySchema,
  asinStatisticsByVariantGroupQuerySchema,
  monitorStatisticsQuerySchema,
  monthlyBreakdownQuerySchema,
  peakHoursStatisticsQuerySchema,
  peakMarkAreasQuerySchema,
  periodSummaryDetailsQuerySchema,
  periodSummaryQuerySchema,
  statisticsByCountryQuerySchema,
  statisticsByTimeQuerySchema,
  statisticsByVariantGroupQuerySchema,
} from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import {
  MONITOR_ANALYTICS_OPERATIONS,
  MonitorAnalyticsQueryError,
  parseMonitorAnalyticsQuery,
  validateMonitorAnalyticsQuery,
  type MonitorAnalyticsOperation,
  type MonitorAnalyticsQuery,
} from '../src/domain/monitor-analytics-query';

const schemas = {
  statistics: monitorStatisticsQuerySchema,
  'by-time': statisticsByTimeQuerySchema,
  'by-country': statisticsByCountryQuerySchema,
  'by-variant-group': statisticsByVariantGroupQuerySchema,
  'peak-hours': peakHoursStatisticsQuerySchema,
  'analytics-monthly-breakdown': monthlyBreakdownQuerySchema,
  'peak-mark-areas': peakMarkAreasQuerySchema,
  'all-countries-summary': aggregateSummaryQuerySchema,
  'region-summary': aggregateSummaryQuerySchema,
  'period-summary': periodSummaryQuerySchema,
  'period-summary/details': periodSummaryDetailsQuerySchema,
  'asin-by-country': asinStatisticsByCountryQuerySchema,
  'asin-by-variant-group': asinStatisticsByVariantGroupQuerySchema,
  'abnormal-duration-statistics': abnormalDurationQuerySchema,
};
describe('bounded monitor analytics HTTP and repository queries', () => {
  it.each(MONITOR_ANALYTICS_OPERATIONS)(
    'keeps %s within its frozen contract and ignores unrelated endpoint fields',
    (operation) => {
      const query = parseMonitorAnalyticsQuery(operation, {
        startTime: '2024-02-29T00:00:00.1',
        endTime: '2024-03-01',
        country: 'EU',
        current: '2',
        pageSize: '30',
        checkType: 'ASIN',
        site: 'Shop',
        brand: 'Brand',
        variantGroupId: 'group',
        asinId: 'asin',
        limit: '12',
        unrelated: 'ignored',
      });
      expect(query).toMatchObject({
        operation,
        startTime: '2024-02-29 00:00:00.100',
        endTime: '2024-03-01 00:00:00',
      });
      expect(schemas[operation].safeParse(query).success).toBe(true);
      expect(() => validateMonitorAnalyticsQuery(query)).not.toThrow();
      expect(query).not.toHaveProperty('unrelated');
      if (operation !== 'period-summary')
        expect(query).not.toHaveProperty('pageSize');
      if (
        operation === 'by-country' ||
        operation === 'all-countries-summary' ||
        operation === 'region-summary'
      )
        expect(query).not.toHaveProperty('country');
    },
  );

  it('preserves defaults, case, literal LIKE syntax and endpoint-specific list behavior', () => {
    expect(parseMonitorAnalyticsQuery('by-time', {})).toEqual({
      operation: 'by-time',
      groupBy: 'day',
    });
    expect(parseMonitorAnalyticsQuery('period-summary', {})).toEqual({
      operation: 'period-summary',
      timeSlotGranularity: 'day',
      current: 1,
      pageSize: 10,
    });
    expect(
      parseMonitorAnalyticsQuery('abnormal-duration-statistics', {
        asinIds: ' first, second ,,first ',
        asinCodes: ['  B  ', '', 'C'],
        asinType: ' MAIN_LINK ',
        country: 'eu',
        asinName: String.raw`%A_\B'`,
        includeSeries: 'false',
      }),
    ).toEqual({
      operation: 'abnormal-duration-statistics',
      asinIds: ['first', 'second', 'first'],
      asinCodes: ['  B  ', '', 'C'],
      asinType: 'MAIN_LINK',
      country: 'eu',
      asinName: String.raw`%A_\B'`,
      includeSeries: '1',
    });
    expect(
      parseMonitorAnalyticsQuery('statistics', {
        checkType: ' ASIN ',
        country: 'US ',
      }),
    ).toMatchObject({ checkType: ' ASIN ', country: 'US ' });
    expect(
      parseMonitorAnalyticsQuery('asin-by-variant-group', { limit: '101' })
        .limit,
    ).toBe(100);
    expect(
      parseMonitorAnalyticsQuery('peak-mark-areas', {
        startTime: '2024-02-29',
        endTime: '2024-03-01',
        groupBy: 'not-hour',
      }).groupBy,
    ).toBe('not-hour');
  });

  it('does not invent missing bounds or discard reversed bounds', () => {
    expect(
      parseMonitorAnalyticsQuery('statistics', { startTime: '2024-03-01' }),
    ).toEqual({ operation: 'statistics', startTime: '2024-03-01 00:00:00' });
    expect(
      parseMonitorAnalyticsQuery('statistics', {
        startTime: '2024-03-01',
        endTime: '2024-02-29',
      }),
    ).toMatchObject({
      startTime: '2024-03-01 00:00:00',
      endTime: '2024-02-29 00:00:00',
    });
    expect(() => parseMonitorAnalyticsQuery('peak-hours', {})).toThrow(
      MonitorAnalyticsQueryError,
    );
    expect(() =>
      parseMonitorAnalyticsQuery('peak-mark-areas', {
        startTime: '2024-02-29',
      }),
    ).toThrow(MonitorAnalyticsQueryError);
  });

  it.each([
    ['statistics', { country: ['US', 'UK'] }],
    ['statistics', { asinId: { value: 'A' } }],
    ['statistics', { startTime: '2023-02-29' }],
    ['statistics', { endTime: '2024-02-30' }],
    ['statistics', { startTime: '0999-01-01' }],
    ['statistics', { startTime: '2024-03-01T00:00:00Z' }],
    ['statistics', { endTime: '2024-03-01 24:00:00' }],
    ['statistics', { endTime: '2024-03-01 00:00:00.1234' }],
    ['statistics', { country: 'US\u0000' }],
    ['statistics', { asinId: 'x'.repeat(51) }],
    ['by-time', { groupBy: 'minute' }],
    ['region-summary', { timeSlotGranularity: 'day; DROP TABLE users' }],
    ['by-variant-group', { limit: '101' }],
    ['by-variant-group', { limit: '1.5' }],
    ['asin-by-variant-group', { limit: 'Infinity' }],
    ['asin-by-variant-group', { limit: '-1' }],
    ['period-summary', { current: '10002', pageSize: '100' }],
    ['period-summary', { current: '1e100' }],
    ['period-summary', { pageSize: '101' }],
    ['period-summary', { pageSize: 10 }],
    ['abnormal-duration-statistics', { asinIds: [null] }],
    ['abnormal-duration-statistics', { asinIds: Array(1001).fill('a') }],
    ['abnormal-duration-statistics', { asinCodes: ['x'.repeat(201)] }],
    ['abnormal-duration-statistics', { asinCodes: { x: 'B' } }],
    ['abnormal-duration-statistics', { includeSeries: ['0'] }],
    ['statistics', { unknown: 'x'.repeat(21_001) }],
    ['statistics', null],
    ['statistics', []],
    ['unknown-operation', {}],
  ])(
    'rejects malformed or excessive %s inputs before repository access',
    (operation, raw) => {
      expect(() =>
        parseMonitorAnalyticsQuery(operation as MonitorAnalyticsOperation, raw),
      ).toThrow(MonitorAnalyticsQueryError);
    },
  );

  it('bounds pagination without truncating accepted results', () => {
    expect(
      parseMonitorAnalyticsQuery('period-summary', {
        current: '10001',
        pageSize: '100',
      }),
    ).toMatchObject({ current: 10001, pageSize: 100 });
    expect(
      parseMonitorAnalyticsQuery('abnormal-duration-statistics', {
        asinCodes: Array(1000).fill('A'),
      }).asinCodes,
    ).toHaveLength(1000);
    expect(() =>
      parseMonitorAnalyticsQuery(
        'statistics',
        Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`key${index}`, '']),
        ),
      ),
    ).toThrow(MonitorAnalyticsQueryError);
  });

  it('checks direct repository calls for unknown fields, missing defaults and noncanonical values', () => {
    const valid = parseMonitorAnalyticsQuery('period-summary', {
      current: '2',
      pageSize: '20',
      startTime: '2024-02-29',
    });
    expect(() => validateMonitorAnalyticsQuery(valid)).not.toThrow();
    for (const patch of [
      { current: -1 },
      { pageSize: 0 },
      { startTime: '2024-02-29T00:00:00' },
      { country: '' },
      { asinId: 'unrelated' },
      { timeSlotGranularity: undefined },
      { extra: 'unsafe' },
    ]) {
      expect(() =>
        validateMonitorAnalyticsQuery({
          ...valid,
          ...patch,
        } as MonitorAnalyticsQuery),
      ).toThrow(MonitorAnalyticsQueryError);
    }
    expect(() =>
      validateMonitorAnalyticsQuery({ operation: 'by-time' }),
    ).toThrow(MonitorAnalyticsQueryError);
  });
});
