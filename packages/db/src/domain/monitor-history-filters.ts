import { MonitorHistoryQueryError } from './monitor-history-query';

export interface MonitorHistoryReadQuery {
  variantGroupId?: string;
  asinId?: string;
  asin?: string | string[];
  variantGroupName?: string;
  asinName?: string;
  asinType?: string;
  country?: string;
  checkType?: string;
  isBroken?: boolean;
  startTime?: string;
  endTime?: string;
  current: number;
  pageSize: number;
}
const invalid = (): never => {
  throw new MonitorHistoryQueryError('input');
};
const text = (value: unknown, max: number, whitespace = false): string => {
  if (
    typeof value !== 'string' ||
    [...value].length > max ||
    (whitespace ? /[\x00-\x08\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)
  )
    return invalid();
  return value;
};
/** Frontend sends Shanghai DATETIME, independent of the API host time zone.
 * Date-only bounds mean midnight. Offset-bearing instants are not silently
 * interpreted as wall clocks; they must first be formatted by the caller. */
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
/** Normalize the actual Legacy controller/model query rules before SQL assembly. */
export function parseMonitorHistoryQuery(
  value: unknown,
): MonitorHistoryReadQuery {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 25
  )
    return invalid();
  const raw = value as Record<string, unknown>;
  if (Object.values(raw).some((item) => typeof item !== 'string'))
    return invalid();
  const current = Number(raw.current || 1),
    pageSize = Number(raw.pageSize || 10);
  const offset = (current - 1) * pageSize;
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !Number.isSafeInteger(offset) ||
    offset > 1_000_000
  )
    return invalid();
  const result: MonitorHistoryReadQuery = { current, pageSize };
  for (const [key, max] of [
    ['variantGroupId', 50],
    ['asinId', 50],
    ['variantGroupName', 255],
    ['asinName', 500],
    ['asinType', 50],
    ['country', 10],
    ['checkType', 50],
  ] as const) {
    if (raw[key] !== undefined) {
      const source = text(raw[key], max);
      const normalized =
        key === 'asinType' || key === 'checkType' ? source.trim() : source;
      if (normalized) result[key] = normalized;
    }
  }
  if (raw.asin !== undefined) {
    const source = text(raw.asin, 21_000, true);
    const items = [
      ...new Set(
        source
          .trim()
          .split(/[,\s]+/)
          .filter(Boolean),
      ),
    ];
    if (items.length > 1000 || items.some((item) => [...item].length > 200))
      return invalid();
    if (items.length) result.asin = items.length === 1 ? items[0] : items;
  }
  if (raw.isBroken !== undefined && raw.isBroken !== '') {
    text(raw.isBroken, 20);
    result.isBroken = raw.isBroken === '1';
  }
  for (const key of ['startTime', 'endTime'] as const)
    if (raw[key] !== undefined && raw[key] !== '')
      result[key] = wallTime(text(raw[key], 30));
  return result;
}
export function parseMonitorHistoryId(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) return invalid();
  return result;
}
/** Non-HTTP callers must satisfy the same limits; never trust a TypeScript cast. */
export function validateMonitorHistoryReadQuery(
  query: MonitorHistoryReadQuery,
): void {
  if (!query || typeof query !== 'object' || Array.isArray(query))
    return invalid();
  const raw: Record<string, unknown> = {
    ...query,
    current: String(query.current),
    pageSize: String(query.pageSize),
  };
  if (query.asin !== undefined) {
    if (Array.isArray(query.asin)) {
      if (
        query.asin.length < 2 ||
        query.asin.some(
          (item) => typeof item !== 'string' || !item || /[,\s]/.test(item),
        )
      )
        return invalid();
      raw.asin = query.asin.join(',');
    } else raw.asin = query.asin;
  }
  if (query.isBroken !== undefined) {
    if (typeof query.isBroken !== 'boolean') return invalid();
    raw.isBroken = query.isBroken ? '1' : '0';
  }
  const normalized = parseMonitorHistoryQuery(raw);
  for (const key of Object.keys(query))
    if (
      JSON.stringify(query[key as keyof MonitorHistoryReadQuery]) !==
      JSON.stringify(normalized[key as keyof MonitorHistoryReadQuery])
    )
      return invalid();
}
