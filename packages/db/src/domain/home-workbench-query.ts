import {
  homeWorkbenchDataSchema,
  homeWorkbenchQuerySchema,
  type HomeWorkbenchData,
  type HomeWorkbenchQuery,
} from '@asin-monitor/contracts';
import { formatShanghaiTimestamp, parseShanghaiTimestamp } from '../timestamps';

export const MAX_HOME_WORKBENCH_BYTES = 512 * 1024;
export const MAX_HOME_WORKBENCH_FACETS = 200;
export class HomeWorkbenchQueryError extends Error {
  constructor(readonly code: 'input' | 'result' | 'too-large') {
    super('Home workbench query could not be completed');
  }
}
export function parseHomeWorkbenchQuery(value: unknown): HomeWorkbenchQuery {
  const parsed = homeWorkbenchQuerySchema.safeParse(value);
  if (!parsed.success) throw new HomeWorkbenchQueryError('input');
  return parsed.data;
}
/** Database timestamps are Shanghai wall clocks, independent of host TZ. */
export function homeWorkbenchDays(now: Date): string[] {
  try {
    const today = formatShanghaiTimestamp(now).slice(0, 10);
    const date = new Date(`${today}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) throw new Error('invalid date');
    return Array.from({ length: 7 }, (_, index) =>
      new Date(date.getTime() + (index - 6) * 86_400_000)
        .toISOString()
        .slice(0, 10),
    );
  } catch {
    throw new HomeWorkbenchQueryError('input');
  }
}
function invalid(): never {
  throw new HomeWorkbenchQueryError('result');
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}
function rows(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value.map(record);
}
function count(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return invalid();
  if (typeof value === 'string' && !/^\d+$/.test(value)) return invalid();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : invalid();
}
function date(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return invalid();
  const parsed = parseShanghaiTimestamp(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : invalid();
}
export function mapHomeWorkbenchData(
  value: unknown,
  query: HomeWorkbenchQuery,
  now: Date,
  trendsAuthorized: boolean,
): HomeWorkbenchData {
  const input = record(value),
    days = homeWorkbenchDays(now);
  const list = rows(input.list, query.pageSize).map((row) => ({
    id: row.id,
    name: row.name,
    country: row.country,
    site: row.site,
    brand: row.brand,
    asinCount: count(row.asin_count),
    isBroken: row.broken,
    lastCheckTime: date(row.last_check_time),
    trend: trendsAuthorized
      ? rows(row.trend, 7).map((point) => ({
          day: point.day,
          checks: count(point.checks),
          brokenChecks: count(point.broken_checks),
          unknownChecks: count(point.unknown_checks),
        }))
      : row.trend === null
      ? null
      : invalid(),
  }));
  const facetRows = rows(input.facets, MAX_HOME_WORKBENCH_FACETS + 1);
  const data = {
    generatedAt: now.toISOString(),
    days,
    current: query.current,
    pageSize: query.pageSize,
    total: count(input.total),
    list,
    facets: facetRows.slice(0, MAX_HOME_WORKBENCH_FACETS).map((row) => ({
      country: row.country,
      site: row.site,
      brand: row.brand,
      totalGroups: count(row.total_groups),
    })),
    facetsTruncated: facetRows.length > MAX_HOME_WORKBENCH_FACETS,
    facetCurrent: query.facetCurrent,
    trendsAuthorized,
  };
  const parsed = homeWorkbenchDataSchema.safeParse(data);
  return parsed.success ? parsed.data : invalid();
}
