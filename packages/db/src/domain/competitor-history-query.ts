import type { MonitorHistoryRecord } from '@asin-monitor/contracts';
import { competitorMonitorHistory } from '../schema-competitor';
import {
  MonitorHistoryQueryError,
  monitorHistorySafeCount,
} from './monitor-history-query';

export interface CompetitorHistorySelectedRow {
  id: bigint;
  variant_group_id: string | null;
  variant_group_name: string | null;
  asin_id: string | null;
  asin_code: string | null;
  asin_name: string | null;
  check_type: string | null;
  country: string;
  is_broken: boolean | null;
  check_time: Date;
  check_result: string | null;
  notification_sent: boolean | null;
  create_time: Date | null;
  asin: string | null;
  parent_asin: string | null;
}

function parentFromResult(source: string | null): string | null {
  if (!source) return null;
  let value: unknown = source;
  for (let index = 0; index < 2 && typeof value === 'string'; index++) {
    if (!value.includes('parentAsin')) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nested = (item: unknown, key: string): unknown =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)[key]
      : null;
  const candidate =
    record.parentAsin ||
    nested(record.details, 'parentAsin') ||
    nested(nested(record.result, 'details'), 'parentAsin');
  return candidate ? String(candidate).trim().toUpperCase() : null;
}

/** Full Legacy row: raw snake_case columns plus its seven camelCase aliases. */
export function mapCompetitorHistoryRecord(
  row: CompetitorHistorySelectedRow,
): MonitorHistoryRecord & { parentAsin: string | null } {
  const binary = (value: boolean | null) =>
    value === null ? null : value ? 1 : 0;
  const checkTime = row.check_time.toISOString();
  const createTime = row.create_time?.toISOString() ?? null;
  const isBroken = binary(row.is_broken);
  const notificationSent = binary(row.notification_sent);
  return {
    id: monitorHistorySafeCount(row.id, true),
    variant_group_id: row.variant_group_id,
    variant_group_name: row.variant_group_name,
    asin_id: row.asin_id,
    asin_code: row.asin_code,
    asin_name: row.asin_name,
    check_type: row.check_type,
    country: row.country,
    is_broken: isBroken,
    check_time: checkTime,
    check_result: row.check_result,
    notification_sent: notificationSent,
    create_time: createTime,
    asin: row.asin,
    parent_asin: row.parent_asin,
    checkTime,
    checkType: row.check_type,
    isBroken,
    notificationSent,
    variantGroupName: row.variant_group_name,
    asinName: row.asin_name,
    parentAsin: parentFromResult(row.check_result) || row.parent_asin || null,
    createTime,
  };
}

export function decodeCompetitorHistoryRow(
  value: unknown,
): CompetitorHistorySelectedRow {
  const invalid = (): never => {
    throw new MonitorHistoryQueryError('invalid-result');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  const nullableString = (key: string): string | null => {
    const item = raw[key];
    return item === null || typeof item === 'string' ? item : invalid();
  };
  const nullableBoolean = (key: string): boolean | null => {
    const item = raw[key];
    return item === null || typeof item === 'boolean' ? item : invalid();
  };
  const timestamp = (key: string, nullable: boolean): Date | null => {
    const item = raw[key];
    if (nullable && item === null) return null;
    if (typeof item !== 'string') invalid();
    try {
      const date = competitorMonitorHistory.checkTime.mapFromDriverValue(item);
      return date instanceof Date && Number.isFinite(date.getTime())
        ? date
        : invalid();
    } catch {
      return invalid();
    }
  };
  return {
    id: BigInt(monitorHistorySafeCount(raw.id, true)),
    variant_group_id: nullableString('variant_group_id'),
    variant_group_name: nullableString('variant_group_name'),
    asin_id: nullableString('asin_id'),
    asin_code: nullableString('asin_code'),
    asin_name: nullableString('asin_name'),
    check_type: nullableString('check_type'),
    country: typeof raw.country === 'string' ? raw.country : invalid(),
    is_broken: nullableBoolean('is_broken'),
    check_time: timestamp('check_time', false)!,
    check_result: nullableString('check_result'),
    notification_sent: nullableBoolean('notification_sent'),
    create_time: timestamp('create_time', true),
    asin: nullableString('asin'),
    parent_asin: nullableString('parent_asin'),
  };
}
