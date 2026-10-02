import { parseMonitorHistoryWallTime } from './monitor-history-filters';

export interface MonitorStatusIntervalReadQuery {
  country?: string;
  variantGroupId?: string;
  asinId?: string;
  startTime: string;
  endTime: string;
  current: number;
  pageSize: number;
}

export class MonitorStatusIntervalQueryError extends Error {
  constructor(
    readonly code: 'input' | 'capacity' | 'invalid-result' | 'too-large',
  ) {
    super('Monitor status interval query could not be completed');
    this.name = 'MonitorStatusIntervalQueryError';
  }
}

const invalid = (): never => {
  throw new MonitorStatusIntervalQueryError('input');
};

const text = (value: unknown, max: number): string => {
  if (
    typeof value !== 'string' ||
    [...value].length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return invalid();
  return value;
};

/** Parse the strict, Shanghai wall-clock query used by the interval endpoint. */
export function parseMonitorStatusIntervalQuery(
  value: unknown,
): MonitorStatusIntervalReadQuery {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 7
  )
    return invalid();
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    'country',
    'variantGroupId',
    'asinId',
    'startTime',
    'endTime',
    'current',
    'pageSize',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return invalid();
  if (Object.values(raw).some((item) => typeof item !== 'string'))
    return invalid();
  for (const key of ['current', 'pageSize'] as const)
    if (
      raw[key] !== undefined &&
      raw[key] !== '' &&
      !/^\d+$/.test(raw[key] as string)
    )
      return invalid();
  let startTime: string, endTime: string;
  try {
    startTime = parseMonitorHistoryWallTime(text(raw.startTime, 30));
    endTime = parseMonitorHistoryWallTime(text(raw.endTime, 30));
  } catch {
    return invalid();
  }
  if (startTime >= endTime) return invalid();
  const current = Number(raw.current || 1);
  const pageSize = Number(raw.pageSize || 50);
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
  const result: MonitorStatusIntervalReadQuery = {
    startTime,
    endTime,
    current,
    pageSize,
  };
  for (const [key, max] of [
    ['country', 10],
    ['variantGroupId', 50],
    ['asinId', 50],
  ] as const) {
    if (raw[key] === undefined || raw[key] === '') continue;
    const value = text(raw[key], max).trim();
    if (value) result[key] = value;
  }
  return result;
}

export function validateMonitorStatusIntervalQuery(
  query: MonitorStatusIntervalReadQuery,
): void {
  const raw: Record<string, unknown> = {
    ...query,
    current: String(query.current),
    pageSize: String(query.pageSize),
  };
  const normalized = parseMonitorStatusIntervalQuery(raw);
  const keys = Object.keys(query) as (keyof MonitorStatusIntervalReadQuery)[];
  if (
    keys.length !== Object.keys(normalized).length ||
    keys.some((key) => query[key] !== normalized[key])
  )
    return invalid();
}
