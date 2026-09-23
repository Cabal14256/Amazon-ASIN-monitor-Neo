import type { DashboardData } from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import {
  activitiesForCountry,
  alertText,
  alertsForCountry,
  countryOverview,
} from './dashboard-data';

const counters = {
  totalGroups: 2,
  totalASINs: 3,
  brokenGroups: 1,
  brokenASINs: 1,
  todayChecks: 4,
  todayBroken: 1,
  normalGroups: 1,
  normalASINs: 2,
};
const data: DashboardData = {
  overview: {
    ...counters,
    overviewByCountry: {
      US: counters,
      UK: { ...counters, totalGroups: 0, brokenGroups: 0 },
    },
  },
  realtimeAlerts: {
    brokenGroups: [
      { id: 'g1', country: 'US', name: 'US group' },
      { id: 'g2', country: 'UK', name: 'UK group' },
    ],
    brokenASINs: [{ id: 'a1', country: 'US', asin: 'B000000001' }],
  },
  distribution: { byCountry: [] },
  recentActivities: [
    { id: 1, country: 'US', check_time: '2026-09-23T08:00:00.000Z' },
    { id: 2, country: 'UK', check_time: '2026-09-23T08:00:00.000Z' },
  ],
};

describe('dashboard country view', () => {
  it('keeps counters, alerts and recent activity within one selected country', () => {
    expect(countryOverview(data, 'US')).toEqual(counters);
    expect(alertsForCountry(data, 'US').map(({ row }) => row.id)).toEqual([
      'g1',
      'a1',
    ]);
    expect(activitiesForCountry(data, 'US').map((row) => row.id)).toEqual([1]);
    expect(alertsForCountry(data, 'ALL')).toHaveLength(3);
  });
  it('renders only bounded text from unknown Legacy alert fields', () => {
    expect(alertText({ name: { secret: 'hidden' } }, 'name')).toBe('');
    expect(alertText({ name: 'a'.repeat(300) }, 'name')).toHaveLength(160);
  });
});
