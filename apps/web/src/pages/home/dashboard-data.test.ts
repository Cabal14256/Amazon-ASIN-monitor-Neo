import type { DashboardData, WsMessage } from '@asin-monitor/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  activitiesForCountry,
  alertsForCountry,
  alertText,
  countryOverview,
  DASHBOARD_SERVER_TTL_MS,
  subscribeDashboardChanges,
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

describe('dashboard server cache refresh', () => {
  it('reads immediately and again after cache expiry; ignores competitor events and cancels on unmount', () => {
    vi.useFakeTimers();
    try {
      let emit: (message: WsMessage) => void = () => undefined;
      const unsubscribe = vi.fn();
      const refresh = vi.fn();
      const dispose = subscribeDashboardChanges((handler) => {
        emit = handler;
        return unsubscribe;
      }, refresh);
      emit({ type: 'stats_update' });
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(DASHBOARD_SERVER_TTL_MS - 1);
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1001);
      expect(refresh).toHaveBeenCalledTimes(2);
      emit({
        type: 'monitor_complete',
        success: true,
        totalChecked: 0,
        totalBroken: 0,
        totalNormal: 0,
        duration: 0,
        countryResults: {},
        timestamp: '2026-09-23T00:00:00.000Z',
        isCompetitor: true,
      });
      expect(refresh).toHaveBeenCalledTimes(2);
      emit({ type: 'stats_update' });
      dispose();
      vi.runAllTimers();
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
