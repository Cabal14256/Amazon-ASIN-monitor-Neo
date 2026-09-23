import type { DashboardData, WsMessage } from '@asin-monitor/contracts';
import type { QueryClient } from '@tanstack/react-query';

export const DASHBOARD_QUERY_KEY = ['dashboard', 'home'] as const;
export const DASHBOARD_SERVER_TTL_MS = 30_000;

export async function refreshDashboardQuery(
  queryClient: Pick<QueryClient, 'cancelQueries' | 'invalidateQueries'>,
  phase: 'event' | 'after-cache',
  visible: boolean,
): Promise<void> {
  const filter = { queryKey: DASHBOARD_QUERY_KEY };
  if (!visible) {
    await queryClient.invalidateQueries({ ...filter, refetchType: 'none' });
    return;
  }
  // An initial request may still be running after the server cache expires.
  // Cancelling it before invalidation forces a fresh post-completion read.
  if (phase === 'after-cache') await queryClient.cancelQueries(filter);
  await queryClient.invalidateQueries(filter);
}

/** A completion may hit the server's still-valid snapshot; read again after its TTL. */
export function subscribeDashboardChanges(
  subscribe: (handler: (message: WsMessage) => void) => () => void,
  refresh: (phase: 'event' | 'after-cache') => void | Promise<void>,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const unsubscribe = subscribe((message) => {
    if (
      message.type !== 'stats_update' &&
      (message.type !== 'monitor_complete' || message.isCompetitor)
    )
      return;
    const current = ++generation;
    if (timer !== undefined) clearTimeout(timer);
    const schedule = () => {
      if (current !== generation) return;
      timer = setTimeout(() => {
        timer = undefined;
        void Promise.resolve(refresh('after-cache')).catch(() => undefined);
      }, DASHBOARD_SERVER_TTL_MS + 1000);
    };
    // The first invalidation can reuse a read started before the monitor event.
    // Start the cache-expiry clock only after that read has settled.
    void Promise.resolve(refresh('event')).then(schedule, schedule);
  });
  return () => {
    generation++;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  };
}

export const COUNTRIES = [
  ['ALL', '全部站点'],
  ['US', '美国'],
  ['UK', '英国'],
  ['DE', '德国'],
  ['FR', '法国'],
  ['IT', '意大利'],
  ['ES', '西班牙'],
] as const;
export type DashboardCountry = (typeof COUNTRIES)[number][0];

export function countryLabel(country: string): string {
  return COUNTRIES.find(([code]) => code === country)?.[1] ?? country;
}

export function countryOverview(
  data: DashboardData,
  country: DashboardCountry,
) {
  return country === 'ALL'
    ? data.overview
    : data.overview.overviewByCountry[country];
}

/** Alert fields are deliberately narrow; the contract keeps unknown Legacy data. */
export function alertText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value.slice(0, 160) : '';
}

export function alertsForCountry(
  data: DashboardData,
  country: DashboardCountry,
) {
  const rows = [
    ...data.realtimeAlerts.brokenGroups.map((row) => ({ kind: '变体组', row })),
    ...data.realtimeAlerts.brokenASINs.map((row) => ({ kind: 'ASIN', row })),
  ];
  return country === 'ALL'
    ? rows
    : rows.filter(({ row }) => alertText(row, 'country') === country);
}

export function activitiesForCountry(
  data: DashboardData,
  country: DashboardCountry,
) {
  return country === 'ALL'
    ? data.recentActivities
    : data.recentActivities.filter((row) => row.country === country);
}
