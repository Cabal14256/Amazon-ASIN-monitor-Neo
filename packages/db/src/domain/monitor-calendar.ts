import { formatShanghaiTimestamp } from '../timestamps';

export type MonitorGranularity = 'hour' | 'day' | 'week' | 'month';
export type MonitorSourceGranularity = Exclude<MonitorGranularity, 'week'>;
export type MonitorDateInput = string | Date | null | undefined;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OFFSET = 8 * HOUR;
const validDate = (value: Date) => Number.isFinite(value.getTime());

/** D8: Date values are instants; unzoned database/input strings are UTC+8.
 * Calendar operations use UTC fields on a shifted copy, never host-local fields.
 * HTTP validation is responsible for rejecting invalid/unsupported date ranges. */
export function parseMonitorDate(value: MonitorDateInput): Date | null {
  if (!value) return null;
  if (value instanceof Date) return validDate(value) ? new Date(value) : null;
  const normalized = value.trim();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(
      normalized,
    );
  let parsed: Date;
  if (match) {
    const [
      ,
      year,
      month,
      day,
      hour = '0',
      minute = '0',
      second = '0',
      fraction = '0',
    ] = match;
    parsed = new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(fraction.padEnd(3, '0')),
      ) - OFFSET,
    );
  } else if (
    /^\d{4}-\d{2}$/.test(normalized) ||
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
  ) {
    // Month tokens and explicitly zoned timestamps have ECMAScript instant semantics.
    parsed = new Date(normalized);
  } else {
    return null;
  }
  return validDate(parsed) ? parsed : null;
}

function wallDate(instant: Date): Date {
  return new Date(instant.getTime() + OFFSET);
}
function instantDate(wall: Date): Date {
  return new Date(wall.getTime() - OFFSET);
}
export function formatMonitorSqlDate(instant: Date): string {
  return formatShanghaiTimestamp(instant).slice(0, 19);
}

function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  jan4.setUTCDate(
    jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1 + (week - 1) * 7,
  );
  return instantDate(jan4);
}
function isoWeek(instant: Date): { year: number; week: number } {
  const target = wallDate(instant);
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCDate(target.getUTCDate() - ((target.getUTCDay() + 6) % 7) + 3);
  const year = target.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7) + 3);
  return {
    year,
    week: 1 + Math.round((target.getTime() - first.getTime()) / (7 * DAY)),
  };
}

export function floorMonitorDate(
  value: MonitorDateInput,
  granularity: MonitorGranularity,
): Date | null {
  const instant = parseMonitorDate(value);
  if (!instant) return null;
  if (granularity === 'week') {
    const { year, week } = isoWeek(instant);
    return isoWeekStart(year, week);
  }
  const wall = wallDate(instant);
  if (granularity === 'month') wall.setUTCDate(1);
  if (granularity === 'month' || granularity === 'day')
    wall.setUTCHours(0, 0, 0, 0);
  else wall.setUTCMinutes(0, 0, 0);
  return instantDate(wall);
}

export function addMonitorGranularity(
  value: MonitorDateInput,
  granularity: MonitorGranularity,
  step = 1,
): Date | null {
  const instant = parseMonitorDate(value);
  if (!instant || !Number.isSafeInteger(step)) return null;
  const wall = wallDate(instant);
  if (granularity === 'month') wall.setUTCMonth(wall.getUTCMonth() + step);
  else if (granularity === 'week' || granularity === 'day')
    wall.setUTCDate(
      wall.getUTCDate() + step * (granularity === 'week' ? 7 : 1),
    );
  else wall.setUTCHours(wall.getUTCHours() + step);
  const result = instantDate(wall);
  return validDate(result) ? result : null;
}

export function formatMonitorPeriod(
  value: MonitorDateInput,
  granularity: MonitorGranularity = 'day',
): string {
  const instant = parseMonitorDate(value);
  if (!instant) return '';
  if (granularity === 'week') {
    const { year, week } = isoWeek(instant);
    return `${year}-${String(week).padStart(2, '0')}`;
  }
  const text = formatMonitorSqlDate(instant);
  if (granularity === 'month') return text.slice(0, 7);
  if (granularity === 'day') return text.slice(0, 10);
  return `${text.slice(0, 13)}:00:00`;
}

export function getMonitorBucketRange(
  period: string,
  granularity: MonitorGranularity,
): { bucketStart: Date | null; bucketEnd: Date | null } {
  const token = period.trim();
  let bucketStart: Date | null = null;
  if (granularity === 'hour') bucketStart = parseMonitorDate(token);
  else if (granularity === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(token))
    bucketStart = parseMonitorDate(`${token} 00:00:00`);
  else if (/^\d{4}-\d{2}$/.test(token)) {
    if (granularity === 'month')
      bucketStart = parseMonitorDate(`${token}-01 00:00:00`);
    else if (granularity === 'week')
      bucketStart = isoWeekStart(
        Number(token.slice(0, 4)),
        Number(token.slice(5, 7)),
      );
  }
  return {
    bucketStart,
    bucketEnd: bucketStart
      ? addMonitorGranularity(bucketStart, granularity)
      : null,
  };
}

export function getMonitorDurationBucketHours(
  period: string,
  granularity: MonitorGranularity,
  queryStart: Date | null = null,
  queryEnd: Date | null = null,
): number {
  const { bucketStart, bucketEnd } = getMonitorBucketRange(period, granularity);
  if (!bucketStart || !bucketEnd) return 0;
  // Legacy clips only when both bounds are present, including zero-length ranges.
  const start =
    queryStart && queryEnd
      ? Math.max(bucketStart.getTime(), queryStart.getTime())
      : bucketStart.getTime();
  const end =
    queryStart && queryEnd
      ? Math.min(bucketEnd.getTime(), queryEnd.getTime())
      : bucketEnd.getTime();
  const hours = (end - start) / HOUR;
  return Number.isFinite(hours) ? Math.max(0, hours) : 0;
}

export function getMonitorDurationSourceGranularity(
  target: MonitorGranularity = 'day',
  startTime: MonitorDateInput = '',
  endTime: MonitorDateInput = '',
): MonitorSourceGranularity {
  if (target === 'hour' || target === 'month') return target;
  if (target === 'week') return 'day';
  const start = parseMonitorDate(startTime),
    end = parseMonitorDate(endTime);
  if (!start || !end || end < start) return 'hour';
  return end.getTime() - start.getTime() <= 31 * DAY ? 'hour' : 'day';
}

export function alignMonitorSlot(
  value: MonitorDateInput,
  granularity: MonitorSourceGranularity,
): string {
  const date = floorMonitorDate(value, granularity);
  return date ? formatMonitorSqlDate(date) : '';
}

export function getMonitorExpectedSlotCount(
  alignedStart: string,
  alignedEnd: string,
  granularity: MonitorSourceGranularity,
): number {
  const start = parseMonitorDate(alignedStart),
    end = parseMonitorDate(alignedEnd);
  if (!start || !end || end < start) return 0;
  if (granularity === 'month') {
    const a = wallDate(start),
      b = wallDate(end);
    return (
      (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
      b.getUTCMonth() -
      a.getUTCMonth() +
      1
    );
  }
  return (
    Math.floor(
      (end.getTime() - start.getTime()) / (granularity === 'day' ? DAY : HOUR),
    ) + 1
  );
}

/** null means coverage cannot be enumerated within the budget: use raw fallback.
 * An empty array means no valid ordered range, not proof of aggregate coverage. */
export function buildMonitorSlotTexts(
  alignedStart: string,
  alignedEnd: string,
  granularity: MonitorSourceGranularity,
  limit = 5000,
): string[] | null {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
    throw new RangeError('Invalid monitor slot budget');
  const count = getMonitorExpectedSlotCount(
    alignedStart,
    alignedEnd,
    granularity,
  );
  if (count > limit) return null;
  const end = parseMonitorDate(alignedEnd);
  let cursor = parseMonitorDate(alignedStart);
  const slots: string[] = [];
  while (cursor && end && cursor <= end) {
    if (slots.length === limit) return null;
    slots.push(formatMonitorSqlDate(cursor));
    cursor = addMonitorGranularity(cursor, granularity);
  }
  return slots;
}
