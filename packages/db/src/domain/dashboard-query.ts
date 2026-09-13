import type { DashboardData } from '@asin-monitor/contracts';
import { formatShanghaiTimestamp, parseShanghaiTimestamp } from '../timestamps';

export const MAX_DASHBOARD_RESPONSE_BYTES = 32 * 1024 * 1024;
export const DASHBOARD_COUNTRIES = [
  'US',
  'UK',
  'DE',
  'FR',
  'IT',
  'ES',
] as const;
export class DashboardQueryError extends Error {
  constructor(readonly code: 'input' | 'result' | 'too-large') {
    super('Dashboard query could not be completed');
  }
}
export function dashboardDayStart(now: Date): string {
  try {
    return `${formatShanghaiTimestamp(now).slice(0, 10)} 00:00:00`;
  } catch {
    throw new DashboardQueryError('input');
  }
}
function invalid(): never {
  throw new DashboardQueryError('result');
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}
function text(value: unknown, nullable = true): string | null {
  if (nullable && value === null) return null;
  return typeof value === 'string' ? value : invalid();
}
function count(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') return invalid();
  if (typeof value === 'string' && !/^\d+$/.test(value)) return invalid();
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : invalid();
}
function date(value: unknown, nullable = true): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') return invalid();
  const result = parseShanghaiTimestamp(value);
  return Number.isFinite(result.getTime()) ? result.toISOString() : invalid();
}
function flag(value: unknown): 0 | 1 | null {
  return value === null
    ? null
    : value === true
    ? 1
    : value === false
    ? 0
    : invalid();
}
function rows(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value.map(record);
}
function alert(row: Record<string, unknown>, asin: boolean) {
  const result: Record<string, unknown> = {};
  for (const field of [
    'id',
    'name',
    'country',
    'site',
    'brand',
    'variant_status',
  ])
    result[field] = text(
      row[field],
      field === 'name' || field === 'variant_status',
    );
  result.update_time = date(row.update_time);
  if (asin) {
    result.asin = text(row.asin, false);
    result.variant_group_name = text(row.variant_group_name);
  }
  return result;
}
function activity(row: Record<string, unknown>) {
  // Dashboard uses the live joined names. It does not use MonitorHistory's
  // snapshot fallback or add its checkResult/asinType aliases.
  const value: Record<string, unknown> = {};
  for (const field of [
    'variant_group_id',
    'variant_group_name',
    'asin_id',
    'asin_code',
    'asin_name',
    'site_snapshot',
    'brand_snapshot',
    'check_type',
    'country',
    'asin',
    'check_result',
  ])
    value[field] = text(row[field], field !== 'country');
  for (const field of [
    'check_time',
    'hour_ts',
    'day_ts',
    'month_ts',
    'create_time',
  ])
    value[field] = date(row[field], field === 'create_time');
  const isBroken = flag(row.is_broken),
    notificationSent = flag(row.notification_sent);
  const id = count(row.id);
  if (!id) return invalid();
  return {
    ...value,
    id,
    is_broken: isBroken,
    notification_sent: notificationSent,
    checkTime: value.check_time as string,
    checkType: value.check_type as string | null,
    isBroken,
    notificationSent,
    variantGroupName: value.variant_group_name as string | null,
    asinName: value.asin_name as string | null,
    createTime: value.create_time as string | null,
  };
}
interface CountryCounts {
  country: string;
  total: number;
  broken: number;
}
function countries(value: unknown, ensureOpen: () => void): CountryCounts[] {
  return rows(value, 65_536).map((row) => {
    ensureOpen();
    const total = count(row.total),
      broken = count(row.broken);
    if (broken > total) return invalid();
    return { country: text(row.country, false)!, total, broken };
  });
}
function counters(values: readonly number[]) {
  const [
    totalGroups,
    totalASINs,
    brokenGroups,
    brokenASINs,
    todayChecks,
    todayBroken,
  ] = values;
  if (
    values.length !== 6 ||
    brokenGroups > totalGroups ||
    brokenASINs > totalASINs ||
    todayBroken > todayChecks
  )
    return invalid();
  return {
    totalGroups,
    totalASINs,
    brokenGroups,
    brokenASINs,
    todayChecks,
    todayBroken,
    normalGroups: totalGroups - brokenGroups,
    normalASINs: totalASINs - brokenASINs,
  };
}
/** Convert the one-snapshot SQL result to the complete Legacy dashboard shape. */
export function mapDashboardData(
  raw: unknown,
  ensureOpen: () => void = () => {},
): DashboardData {
  const source = record(raw),
    summary = record(source.overview);
  const overview = counters(
    [
      'totalGroups',
      'totalASINs',
      'brokenGroups',
      'brokenASINs',
      'todayChecks',
      'todayBroken',
    ].map((key) => count(summary[key])),
  );
  const groups = countries(source.groupsByCountry, ensureOpen);
  const asins = countries(source.asinsByCountry, ensureOpen);
  const today = countries(source.todayByCountry, ensureOpen);
  const valuesFor = (country: string) => {
    const g = groups.find((row) => row.country === country);
    const a = asins.find((row) => row.country === country);
    const t = today.find((row) => row.country === country);
    return [
      g?.total ?? 0,
      a?.total ?? 0,
      g?.broken ?? 0,
      a?.broken ?? 0,
      t?.total ?? 0,
      t?.broken ?? 0,
    ];
  };
  const overviewByCountry: DashboardData['overview']['overviewByCountry'] = {};
  for (const country of DASHBOARD_COUNTRIES)
    overviewByCountry[country] = counters(valuesFor(country));
  overviewByCountry.EU_TOTAL = counters(
    Array.from({ length: 6 }, (_, index) =>
      count(
        DASHBOARD_COUNTRIES.slice(1).reduce(
          (sum, country) => sum + valuesFor(country)[index],
          0,
        ),
      ),
    ),
  );
  ensureOpen();
  return {
    overview: { ...overview, overviewByCountry },
    realtimeAlerts: {
      brokenGroups: rows(source.brokenGroups, 10).map((row) =>
        alert(row, false),
      ),
      brokenASINs: rows(source.brokenASINs, 10).map((row) => alert(row, true)),
    },
    distribution: {
      byCountry: groups.map((row) => ({
        country: row.country,
        total: row.total,
        broken: String(row.broken),
        normal: row.total - row.broken,
      })),
    },
    recentActivities: rows(source.recentActivities, 20).map((row) => {
      ensureOpen();
      return activity(row);
    }),
  };
}
