import type { DashboardData } from '@asin-monitor/contracts';
import { countryLabel, type DashboardCountry } from './dashboard-data';

type SourceRow = DashboardData['distribution']['byCountry'][number];
export interface CountryStatusRow {
  country: string;
  label: string;
  normal: number;
  broken: number;
  total: number;
}
export type CountryStatusData =
  | { kind: 'ready'; rows: CountryStatusRow[] }
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string };

const invalid = (): CountryStatusData => ({
  kind: 'invalid',
  message: '站点计数不完整或不一致，暂时无法绘制状态图。请刷新后重试。',
});
function count(value: number | string): number | undefined {
  if (typeof value === 'string' && !/^\d+(?:\.0+)?$/.test(value))
    return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/** Use the selected snapshot's actual counts; never derive or clamp a category. */
export function countryStatusData(
  source: readonly SourceRow[],
  country: DashboardCountry,
): CountryStatusData {
  const selected = source.filter(
    (row) => country === 'ALL' || row.country === country,
  );
  if (selected.length === 0) return { kind: 'empty' };
  const countries = new Set<string>();
  const rows: CountryStatusRow[] = [];
  for (const row of selected) {
    const normal = count(row.normal);
    const broken = count(row.broken);
    const total = count(row.total);
    if (
      !row.country.trim() ||
      countries.has(row.country) ||
      normal === undefined ||
      broken === undefined ||
      total === undefined ||
      normal + broken !== total
    )
      return invalid();
    countries.add(row.country);
    rows.push({
      country: row.country,
      label: countryLabel(row.country),
      normal,
      broken,
      total,
    });
  }
  return { kind: 'ready', rows };
}
