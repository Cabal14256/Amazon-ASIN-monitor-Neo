import { parseMonitorHistoryWallTime } from './monitor-history-filters';
import { MonitorHistoryQueryError } from './monitor-history-query';

export interface CompetitorHistoryReadQuery {
  variantGroupId?: string;
  asinId?: string;
  asin?: string;
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
const inputText = (value: unknown, maximum: number): string => {
  if (
    typeof value !== 'string' ||
    [...value].length > maximum ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return invalid();
  return value;
};

/** Competitor ASIN is a single SQL LIKE pattern, unlike the primary history
 * multi-ASIN filter. Keep its wildcard semantics while bounding work. */
export function parseCompetitorHistoryQuery(
  value: unknown,
): CompetitorHistoryReadQuery {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 20
  )
    return invalid();
  const raw = value as Record<string, unknown>;
  if (Object.values(raw).some((item) => typeof item !== 'string'))
    return invalid();
  const current = Number(raw.current || 1);
  const pageSize = Number(raw.pageSize || 10);
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
  const query: CompetitorHistoryReadQuery = { current, pageSize };
  for (const [key, maximum] of [
    ['variantGroupId', 50],
    ['asinId', 50],
    ['asin', 200],
    ['country', 10],
    ['checkType', 20],
  ] as const) {
    if (raw[key] === undefined) continue;
    const text = inputText(raw[key], maximum);
    if (text) query[key] = text;
  }
  if (raw.isBroken !== undefined && raw.isBroken !== '') {
    inputText(raw.isBroken, 20);
    query.isBroken = raw.isBroken === '1';
  }
  for (const key of ['startTime', 'endTime'] as const)
    if (raw[key] !== undefined && raw[key] !== '')
      query[key] = parseMonitorHistoryWallTime(inputText(raw[key], 30));
  return query;
}

export function validateCompetitorHistoryQuery(
  query: CompetitorHistoryReadQuery,
): void {
  if (!query || typeof query !== 'object' || Array.isArray(query)) invalid();
  const raw: Record<string, unknown> = {
    ...query,
    current: String(query.current),
    pageSize: String(query.pageSize),
  };
  if (query.isBroken !== undefined) {
    if (typeof query.isBroken !== 'boolean') invalid();
    raw.isBroken = query.isBroken ? '1' : '0';
  }
  const parsed = parseCompetitorHistoryQuery(raw);
  for (const key of new Set([...Object.keys(query), ...Object.keys(parsed)]))
    if (
      JSON.stringify(query[key as keyof CompetitorHistoryReadQuery]) !==
      JSON.stringify(parsed[key as keyof CompetitorHistoryReadQuery])
    )
      invalid();
}
