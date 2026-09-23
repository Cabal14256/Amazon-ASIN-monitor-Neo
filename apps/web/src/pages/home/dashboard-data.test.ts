import type { DashboardData, WsMessage } from '@asin-monitor/contracts';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  activitiesForCountry,
  alertsForCountry,
  alertText,
  countryOverview,
  DASHBOARD_QUERY_KEY,
  DASHBOARD_SERVER_TTL_MS,
  refreshDashboardQuery,
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
  it('reads immediately and again after cache expiry; ignores competitor events and cancels on unmount', async () => {
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
      expect(refresh).toHaveBeenNthCalledWith(1, 'event');
      await vi.advanceTimersByTimeAsync(DASHBOARD_SERVER_TTL_MS - 1);
      expect(refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1001);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenNthCalledWith(2, 'after-cache');
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
      await vi.runAllTimersAsync();
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('starts the server cache window after a long initial read settles', async () => {
    vi.useFakeTimers();
    try {
      let emit: (message: WsMessage) => void = () => undefined;
      let settle: () => void = () => undefined;
      const refresh = vi.fn((phase: 'event' | 'after-cache') =>
        phase === 'event'
          ? new Promise<void>((resolve) => {
              settle = resolve;
            })
          : Promise.resolve(),
      );
      const dispose = subscribeDashboardChanges((handler) => {
        emit = handler;
        return () => undefined;
      }, refresh);
      emit({ type: 'stats_update' });
      await vi.advanceTimersByTimeAsync(DASHBOARD_SERVER_TTL_MS + 1000);
      expect(refresh).toHaveBeenCalledTimes(1);
      settle();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(DASHBOARD_SERVER_TTL_MS);
      expect(refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenNthCalledWith(2, 'after-cache');
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it('cancels an in-flight initial read before the post-cache refetch', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let calls = 0;
    const queryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      calls++;
      if (calls === 1)
        return new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('before-monitor'), {
            once: true,
          });
        });
      return Promise.resolve('after-monitor');
    });
    const observer = new QueryObserver(client, {
      queryKey: DASHBOARD_QUERY_KEY,
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      expect(queryFn).toHaveBeenCalledTimes(1);
      const immediate = refreshDashboardQuery(client, 'event', true);
      expect(queryFn).toHaveBeenCalledTimes(1);
      await refreshDashboardQuery(client, 'after-cache', true);
      await immediate;
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(observer.getCurrentResult().data).toBe('after-monitor');
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
