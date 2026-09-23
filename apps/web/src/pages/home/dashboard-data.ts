import type { DashboardData } from '@asin-monitor/contracts';

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
