import type { MonitorHistoryListQuery } from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import { historyStatisticsQueries } from './history-statistics-query';

describe('history statistics query scopes', () => {
  it('maps only each endpoint’s supported fields from the applied history query', () => {
    const query: MonitorHistoryListQuery = {
      variantGroupId: 'group-1',
      asinId: 'asin-1',
      country: 'US',
      checkType: 'ASIN',
      startTime: '2026-10-01 09:30:00',
      endTime: '2026-10-02 10:00:00',
      variantGroupName: 'Group name',
      asinName: 'ASIN name',
      asin: 'B000000001,B000000002',
      asinType: 'MAIN',
      isBroken: '1',
      current: 4,
      pageSize: 50,
    };
    expect(historyStatisticsQueries(query)).toEqual({
      statistics: {
        variantGroupId: 'group-1',
        asinId: 'asin-1',
        country: 'US',
        checkType: 'ASIN',
        startTime: '2026-10-01 09:30:00',
        endTime: '2026-10-02 10:00:00',
      },
      peakHours: {
        country: 'US',
        checkType: 'ASIN',
        startTime: '2026-10-01 09:30:00',
        endTime: '2026-10-02 10:00:00',
      },
    });
    expect(query.current).toBe(4);
    expect(query.asinName).toBe('ASIN name');
  });

  it.each([undefined, ''])(
    'does not request peak hours without a country (%s)',
    (country) => {
      expect(
        historyStatisticsQueries({ country, variantGroupId: 'group-1' }),
      ).toEqual({ statistics: { variantGroupId: 'group-1' }, peakHours: null });
    },
  );

  it('omits blank optional filters and never fills an implicit time window', () => {
    expect(
      historyStatisticsQueries({
        variantGroupId: '',
        asinId: '',
        country: 'UK',
        checkType: '',
        startTime: '',
        endTime: '',
      }),
    ).toEqual({ statistics: { country: 'UK' }, peakHours: { country: 'UK' } });
    expect(historyStatisticsQueries({ current: 1, pageSize: 10 })).toEqual({
      statistics: {},
      peakHours: null,
    });
  });

  it('preserves literal IDs and wall-clock bounds without trimming or converting to UTC', () => {
    expect(
      historyStatisticsQueries({
        variantGroupId: ' group ',
        asinId: ' asin ',
        startTime: '2026-10-08 00:00:00',
      }).statistics,
    ).toEqual({
      variantGroupId: ' group ',
      asinId: ' asin ',
      startTime: '2026-10-08 00:00:00',
    });
  });
});
