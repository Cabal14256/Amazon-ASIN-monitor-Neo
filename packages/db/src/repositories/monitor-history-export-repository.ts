import {
  monitorHistoryExportParamsSchema,
  type MonitorHistoryExportJobData,
} from '@asin-monitor/contracts';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import { parseMonitorHistoryWallTime } from '../domain/monitor-history-filters';
import {
  MonitorHistoryQueryError,
  monitorHistorySafeCount,
} from '../domain/monitor-history-query';
import { asins, monitorHistory, variantGroups } from '../schema';
import { withAsinExportDatabaseTransaction } from './asin-query-repository';

export const MONITOR_HISTORY_EXPORT_PAGE_SIZE = 500;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
export interface MonitorHistoryExportCursor {
  checkTime: string;
  id: string;
}
export interface MonitorHistoryExportRecord {
  checkTime: string;
  checkType: string | null;
  variantGroupName: string | null;
  asin: string | null;
  asinName: string | null;
  asinType: string | null;
  country: string;
  isBroken: 0 | 1 | null;
  checkResult: string | null;
}
export interface MonitorHistoryExportRow {
  record: MonitorHistoryExportRecord;
  cursor: MonitorHistoryExportCursor;
}
export interface MonitorHistoryExportUnit {
  page(
    params: MonitorHistoryExportJobData['params'],
    after?: MonitorHistoryExportCursor,
  ): Promise<MonitorHistoryExportRow[]>;
}
export interface MonitorHistoryExportRepositoryPort {
  read<T>(
    action: (
      unit: MonitorHistoryExportUnit,
      ensureOpen: () => void,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
const validCursor = (value: MonitorHistoryExportCursor) => {
  if (
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(
      value.checkTime,
    ) ||
    !/^[1-9]\d{0,18}$/.test(value.id) ||
    BigInt(value.id) > 9223372036854775807n
  )
    throw new MonitorHistoryQueryError('input');
  parseMonitorHistoryWallTime(value.checkTime.slice(0, 19));
};
/** Business-only bounded MVCC snapshot. Authorization uses a separate short
 * primary transaction so two export snapshots cannot exhaust the auth pool. */
export class PgMonitorHistoryExportRepository
  implements MonitorHistoryExportRepositoryPort
{
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async read<T>(
    action: (
      unit: MonitorHistoryExportUnit,
      ensureOpen: () => void,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.active >= 2) throw new MonitorHistoryQueryError('capacity');
    this.active++;
    try {
      return await withAsinExportDatabaseTransaction(
        this.pool,
        (db, ensure) =>
          action(new DrizzleMonitorHistoryExportUnit(db, ensure), ensure),
        signal,
      );
    } finally {
      this.active--;
    }
  }
}
export class DrizzleMonitorHistoryExportUnit
  implements MonitorHistoryExportUnit
{
  constructor(private readonly db: Db, private readonly ensure: () => void) {}
  async page(
    raw: MonitorHistoryExportJobData['params'],
    after?: MonitorHistoryExportCursor,
  ) {
    const params = monitorHistoryExportParamsSchema.parse(raw);
    if (!params.endTime) throw new MonitorHistoryQueryError('input');
    if (after) validCursor(after);
    const country =
      params.country === 'EU'
        ? sql`rtrim(mh.country) COLLATE public.neo_import_group_ci IN ('UK','DE','FR','IT','ES')`
        : params.country
        ? sql`rtrim(mh.country) COLLATE public.neo_import_group_ci=rtrim(${params.country})`
        : sql`true`;
    const start = params.startTime
      ? sql`mh.check_time>=${parseMonitorHistoryWallTime(
          params.startTime,
        )}::timestamp`
      : sql`true`;
    const end = sql`mh.check_time<=${parseMonitorHistoryWallTime(
      params.endTime,
    )}::timestamp`;
    const next = after
      ? sql`(mh.check_time<${after.checkTime}::timestamp OR (mh.check_time=${after.checkTime}::timestamp AND mh.id<${after.id}::bigint))`
      : sql`true`;
    this.ensure();
    const result = await this.db.execute(sql`
      WITH RECURSIVE page_keys AS MATERIALIZED (
        SELECT mh.check_time,mh.id,row_number() OVER (ORDER BY mh.check_time DESC,mh.id DESC) AS ordinal
        FROM ${monitorHistory} mh WHERE ${country} AND ${start} AND ${end} AND ${next}
        ORDER BY mh.check_time DESC,mh.id DESC LIMIT ${MONITOR_HISTORY_EXPORT_PAGE_SIZE}
      ), size_bound(ordinal,bytes) AS (
        SELECT 0::bigint,0::bigint UNION ALL
        SELECT p.ordinal,previous.bytes+16384::bigint+2::bigint*COALESCE(octet_length(to_json(mh.check_result::text)::text),4)
        FROM size_bound previous INNER JOIN page_keys p ON p.ordinal=previous.ordinal+1
        INNER JOIN ${monitorHistory} mh ON p.id=mh.id AND p.check_time=mh.check_time
        WHERE previous.bytes<=${MAX_PAGE_BYTES}
      ), measured AS MATERIALIZED (SELECT max(bytes) AS bytes FROM size_bound)
      SELECT measured.bytes::text AS bytes,CASE WHEN measured.bytes<=${MAX_PAGE_BYTES} THEN (
        SELECT COALESCE(jsonb_agg(to_jsonb(record) ORDER BY record.check_time DESC,record.sort_id DESC),'[]'::jsonb)
        FROM (SELECT mh.id::text AS id,mh.id AS sort_id,mh.variant_group_id,mh.asin_id,mh.check_type,mh.country,
          mh.is_broken,mh.check_time,mh.check_time::text AS export_cursor_time,mh.check_result::text AS check_result,
          mh.notification_sent,mh.create_time,COALESCE(mh.variant_group_name,vg.name) AS variant_group_name,
          COALESCE(mh.asin_code,a.asin) AS asin,COALESCE(mh.asin_name,a.name) AS asin_name,a.asin_type
          FROM ${monitorHistory} mh INNER JOIN page_keys p ON p.id=mh.id AND p.check_time=mh.check_time
          LEFT JOIN ${variantGroups} vg ON rtrim(vg.id) COLLATE public.neo_import_group_ci=rtrim(mh.variant_group_id)
          LEFT JOIN ${asins} a ON rtrim(a.id) COLLATE public.neo_import_group_ci=rtrim(mh.asin_id)
        ) record
      ) ELSE NULL END AS records FROM measured
    `);
    this.ensure();
    const selected = result.rows[0];
    if (!selected) throw new MonitorHistoryQueryError('invalid-result');
    if (monitorHistorySafeCount(selected.bytes) > MAX_PAGE_BYTES)
      throw new MonitorHistoryQueryError('too-large');
    if (
      !Array.isArray(selected.records) ||
      selected.records.length > MONITOR_HISTORY_EXPORT_PAGE_SIZE
    )
      throw new MonitorHistoryQueryError('invalid-result');
    let previous = after;
    return selected.records.map((raw: Record<string, unknown>) => {
      if (
        typeof raw.id !== 'string' ||
        typeof raw.export_cursor_time !== 'string'
      )
        throw new MonitorHistoryQueryError('invalid-result');
      const cursor = { id: raw.id, checkTime: raw.export_cursor_time };
      validCursor(cursor);
      if (
        previous &&
        !(
          cursor.checkTime < previous.checkTime ||
          (cursor.checkTime === previous.checkTime &&
            BigInt(cursor.id) < BigInt(previous.id))
        )
      )
        throw new MonitorHistoryQueryError('invalid-result');
      previous = cursor;
      const text = (key: string): string | null => {
        const value = raw[key];
        if (value === null || typeof value === 'string') return value;
        throw new MonitorHistoryQueryError('invalid-result');
      };
      if (
        typeof raw.country !== 'string' ||
        (raw.is_broken !== null && typeof raw.is_broken !== 'boolean')
      )
        throw new MonitorHistoryQueryError('invalid-result');
      const record: MonitorHistoryExportRecord = {
        checkTime: cursor.checkTime.slice(0, 19),
        checkType: text('check_type'),
        variantGroupName: text('variant_group_name'),
        asin: text('asin'),
        asinName: text('asin_name'),
        asinType: text('asin_type'),
        country: raw.country,
        isBroken: raw.is_broken === null ? null : raw.is_broken ? 1 : 0,
        checkResult: text('check_result'),
      };
      return { record, cursor };
    });
  }
}
