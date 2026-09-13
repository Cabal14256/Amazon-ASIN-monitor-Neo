import type { MonitorGranularity } from './monitor-calendar';

export const MONITOR_ANALYTICS_OPERATIONS = [
  'statistics',
  'by-time',
  'by-country',
  'by-variant-group',
  'peak-hours',
  'analytics-monthly-breakdown',
  'peak-mark-areas',
  'all-countries-summary',
  'region-summary',
  'period-summary',
  'period-summary/details',
  'asin-by-country',
  'asin-by-variant-group',
  'abnormal-duration-statistics',
] as const;
export type MonitorAnalyticsOperation =
  (typeof MONITOR_ANALYTICS_OPERATIONS)[number];
export class MonitorAnalyticsQueryError extends Error {
  constructor(
    readonly code: 'input' | 'capacity' | 'invalid-result' | 'timeout',
  ) {
    super('Monitor analytics query could not be completed');
    this.name = 'MonitorAnalyticsQueryError';
  }
}
export interface MonitorAnalyticsQuery {
  operation: MonitorAnalyticsOperation;
  country?: string;
  startTime?: string;
  endTime?: string;
  variantGroupId?: string;
  asinId?: string;
  checkType?: string;
  groupBy?: MonitorGranularity | string;
  timeSlotGranularity?: MonitorGranularity;
  month?: string;
  site?: string;
  brand?: string;
  limit?: number;
  current?: number;
  pageSize?: number;
  asinIds?: string[];
  asinCodes?: string[];
  asinType?: string;
  asinName?: string;
  variantGroupName?: string;
  includeSeries?: '0' | '1';
}
const ranges = ['startTime', 'endTime'] as const;
const countryRange = ['country', ...ranges] as const;
const period = [
  ...countryRange,
  'site',
  'brand',
  'timeSlotGranularity',
] as const;
const fields: Record<
  MonitorAnalyticsOperation,
  readonly (keyof MonitorAnalyticsQuery)[]
> = {
  statistics: [...countryRange, 'variantGroupId', 'asinId', 'checkType'],
  'by-time': [...countryRange, 'groupBy'],
  'by-country': ranges,
  'by-variant-group': [...countryRange, 'limit'],
  'peak-hours': [...countryRange, 'checkType'],
  'analytics-monthly-breakdown': [...countryRange, 'month'],
  'peak-mark-areas': [...countryRange, 'groupBy'],
  'all-countries-summary': [...ranges, 'timeSlotGranularity'],
  'region-summary': [...ranges, 'timeSlotGranularity'],
  'period-summary': [...period, 'current', 'pageSize'],
  'period-summary/details': period,
  'asin-by-country': countryRange,
  'asin-by-variant-group': [...countryRange, 'limit'],
  'abnormal-duration-statistics': [
    ...countryRange,
    'variantGroupId',
    'asinIds',
    'asinCodes',
    'asinType',
    'asinName',
    'variantGroupName',
    'includeSeries',
  ],
};
const invalid = (): never => {
  throw new MonitorAnalyticsQueryError('input');
};
const scalar = (value: unknown, maximum: number): string => {
  if (
    typeof value !== 'string' ||
    value.length > maximum * 2 ||
    [...value].length > maximum ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return invalid();
  return value;
};
function wallTime(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      value,
    );
  if (!match) return invalid();
  const [
    ,
    year,
    month,
    day,
    hour = '00',
    minute = '00',
    second = '00',
    fraction = '',
  ] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(
    3,
    '0',
  )}Z`;
  const date = new Date(iso);
  if (
    Number(year) < 1000 ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== iso
  )
    return invalid();
  return `${year}-${month}-${day} ${hour}:${minute}:${second}${
    fraction ? `.${fraction.padEnd(3, '0')}` : ''
  }`;
}
function identifiers(value: unknown, max: number): string[] {
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else
    items = scalar(value, 21_000)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  if (items.length > 1000) return invalid();
  // Legacy HTTP arrays retain spaces/empty items; comma-separated text trims.
  return items.map((item) => scalar(item, max));
}
function positiveInteger(
  value: string | undefined,
  fallback: number,
  max: number,
) {
  const result = Number(value || fallback);
  if (!Number.isSafeInteger(result) || result < 1 || result > max)
    return invalid();
  return result;
}

/** Each endpoint consumes only its actual Legacy fields. Scalar arrays/objects
 * are rejected before SQL; IDs lists are the sole repeated query parameters.
 * Reversed or missing date bounds retain Legacy meaning (no implicit range). */
export function parseMonitorAnalyticsQuery(
  operation: MonitorAnalyticsOperation,
  value: unknown,
): MonitorAnalyticsQuery {
  if (
    !MONITOR_ANALYTICS_OPERATIONS.includes(operation) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 32
  )
    return invalid();
  const raw = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(raw)) {
    if (
      operation === 'abnormal-duration-statistics' &&
      (key === 'asinIds' || key === 'asinCodes')
    )
      continue;
    scalar(item, 21_000);
  }
  const result: MonitorAnalyticsQuery = { operation };
  const allowed = fields[operation];
  for (const key of ranges)
    if (raw[key]) result[key] = wallTime(scalar(raw[key], 30));
  for (const [key, max] of [
    ['country', 10],
    ['variantGroupId', 50],
    ['asinId', 50],
    ['checkType', 50],
    ['site', 100],
    ['brand', 255],
    ['month', 50],
    ['asinType', 50],
    ['asinName', 500],
    ['variantGroupName', 255],
  ] as const) {
    if (!allowed.includes(key) || raw[key] === undefined) continue;
    const source = scalar(raw[key], max);
    const text = key === 'asinType' ? source.trim() : source;
    if (text) result[key] = text;
  }
  if (allowed.includes('groupBy')) {
    const text = scalar(
      raw.groupBy ?? (operation === 'peak-mark-areas' ? 'hour' : 'day'),
      50,
    );
    if (
      operation !== 'peak-mark-areas' &&
      !['hour', 'day', 'week', 'month'].includes(text)
    )
      return invalid();
    result.groupBy = text;
  }
  if (allowed.includes('timeSlotGranularity')) {
    const text = scalar(raw.timeSlotGranularity ?? 'day', 50);
    if (!['hour', 'day', 'week', 'month'].includes(text)) return invalid();
    result.timeSlotGranularity = text as MonitorGranularity;
  }
  if (allowed.includes('limit')) {
    const text = raw.limit === undefined ? undefined : scalar(raw.limit, 20);
    const limit = positiveInteger(
      text,
      10,
      operation === 'asin-by-variant-group' ? Number.MAX_SAFE_INTEGER : 100,
    );
    result.limit = Math.min(100, limit);
  }
  if (operation === 'period-summary') {
    result.current = positiveInteger(
      raw.current as string | undefined,
      1,
      1_000_001,
    );
    result.pageSize = positiveInteger(
      raw.pageSize as string | undefined,
      10,
      100,
    );
    if ((result.current - 1) * result.pageSize > 1_000_000) return invalid();
  }
  if (operation === 'abnormal-duration-statistics') {
    for (const key of ['asinIds', 'asinCodes'] as const)
      if (raw[key] !== undefined)
        result[key] = identifiers(raw[key], key === 'asinIds' ? 50 : 200);
    result.includeSeries = raw.includeSeries === '0' ? '0' : '1';
  }
  if (operation === 'peak-hours' && !result.country) return invalid();
  if (operation === 'peak-mark-areas' && (!result.startTime || !result.endTime))
    return invalid();
  return result;
}

/** Repository callers must pass the normalized bounded shape, not a type cast. */
export function validateMonitorAnalyticsQuery(
  query: MonitorAnalyticsQuery,
): void {
  if (!query || typeof query !== 'object' || Array.isArray(query))
    return invalid();
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === 'operation') continue;
    raw[key] =
      ['current', 'pageSize', 'limit'].includes(key) &&
      typeof value === 'number'
        ? String(value)
        : value;
  }
  const normalized = parseMonitorAnalyticsQuery(query.operation, raw);
  const keys = new Set([...Object.keys(normalized), ...Object.keys(query)]);
  for (const key of keys)
    if (
      JSON.stringify(normalized[key as keyof MonitorAnalyticsQuery]) !==
      JSON.stringify(query[key as keyof MonitorAnalyticsQuery])
    )
      return invalid();
}
