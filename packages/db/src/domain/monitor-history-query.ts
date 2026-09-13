import type { MonitorHistoryRecord } from '@asin-monitor/contracts';
import { monitorHistory } from '../schema';

/** Selected SQL fields only; joins have already applied the Legacy snapshot
 * COALESCE rules. check_result is JSONB::text, not a parsed/truncated object. */
export interface MonitorHistorySelectedRow {
  id: bigint;
  variant_group_id: string | null;
  asin_id: string | null;
  check_type: string | null;
  country: string;
  is_broken: boolean | null;
  check_time: Date;
  check_result: string | null;
  notification_sent: boolean | null;
  create_time: Date | null;
  variant_group_name: string | null;
  asin: string | null;
  asin_name: string | null;
  asin_type: string | null;
}
export class MonitorHistoryQueryError extends Error {
  constructor(
    readonly code: 'input' | 'capacity' | 'invalid-result' | 'too-large',
  ) {
    super('Monitor history query could not be completed');
    this.name = 'MonitorHistoryQueryError';
  }
}
export function monitorHistorySafeCount(
  value: unknown,
  positive = false,
): number {
  if (!['number', 'string', 'bigint'].includes(typeof value))
    throw new MonitorHistoryQueryError('invalid-result');
  if (typeof value === 'string' && !/^\d+$/.test(value))
    throw new MonitorHistoryQueryError('invalid-result');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < (positive ? 1 : 0))
    throw new MonitorHistoryQueryError('invalid-result');
  return result;
}

/** Preserve the complete Legacy JSON shape, including SQL NULL and both aliases. */
export function mapMonitorHistoryRecord(
  row: MonitorHistorySelectedRow,
): MonitorHistoryRecord {
  const binary = (value: boolean | null) =>
    value === null ? null : value ? 1 : 0;
  const checkTime = row.check_time.toISOString();
  const createTime = row.create_time?.toISOString() ?? null;
  const isBroken = binary(row.is_broken);
  const notificationSent = binary(row.notification_sent);
  return {
    id: monitorHistorySafeCount(row.id, true),
    variant_group_id: row.variant_group_id,
    asin_id: row.asin_id,
    check_type: row.check_type,
    country: row.country,
    is_broken: isBroken,
    check_time: checkTime,
    check_result: row.check_result,
    notification_sent: notificationSent,
    create_time: createTime,
    variant_group_name: row.variant_group_name,
    asin: row.asin,
    asin_name: row.asin_name,
    asin_type: row.asin_type,
    checkTime,
    checkType: row.check_type,
    isBroken,
    checkResult: row.check_result,
    notificationSent,
    variantGroupName: row.variant_group_name,
    asinName: row.asin_name,
    asinType: row.asin_type,
    createTime,
  };
}

/** jsonb_agg timestamps bypass Drizzle row mapping. Use the actual D8 codecs
 * explicitly, so the API never depends on the API host's local time zone. */
export function decodeMonitorHistorySelectedRow(
  value: unknown,
): MonitorHistorySelectedRow {
  const invalid = (): never => {
    throw new MonitorHistoryQueryError('invalid-result');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const row = value as Record<string, unknown>;
  const nullableString = (key: string): string | null => {
    const value = row[key];
    return value === null || typeof value === 'string' ? value : invalid();
  };
  const boolean = (key: string): boolean | null => {
    const value = row[key];
    return value === null || typeof value === 'boolean' ? value : invalid();
  };
  const timestamp = (key: string, nullable: boolean): Date | null => {
    const value = row[key];
    if (nullable && value === null) return null;
    if (typeof value !== 'string') return invalid();
    try {
      const parsed = monitorHistory.checkTime.mapFromDriverValue(value);
      return parsed instanceof Date && Number.isFinite(parsed.getTime())
        ? parsed
        : invalid();
    } catch {
      return invalid();
    }
  };
  return {
    id: BigInt(monitorHistorySafeCount(row.id, true)),
    variant_group_id: nullableString('variant_group_id'),
    asin_id: nullableString('asin_id'),
    check_type: nullableString('check_type'),
    country: typeof row.country === 'string' ? row.country : invalid(),
    is_broken: boolean('is_broken'),
    check_time: timestamp('check_time', false)!,
    check_result: nullableString('check_result'),
    notification_sent: boolean('notification_sent'),
    create_time: timestamp('create_time', true),
    variant_group_name: nullableString('variant_group_name'),
    asin: nullableString('asin'),
    asin_name: nullableString('asin_name'),
    asin_type: nullableString('asin_type'),
  };
}
