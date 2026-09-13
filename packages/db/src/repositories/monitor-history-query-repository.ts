import type { MonitorHistoryRecord } from '@asin-monitor/contracts';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  type MonitorHistoryReadQuery,
  validateMonitorHistoryReadQuery,
} from '../domain/monitor-history-filters';
import {
  decodeMonitorHistorySelectedRow,
  mapMonitorHistoryRecord,
  MonitorHistoryQueryError,
  monitorHistorySafeCount,
} from '../domain/monitor-history-query';
import {
  asins,
  monitorHistory,
  sessions,
  users,
  variantGroups,
} from '../schema';
import { withAsinDatabaseTransaction } from './asin-query-repository';
import { DrizzleRoleUnit, type RoleWriteUnit } from './role-repository';

export const MAX_MONITOR_HISTORY_RESPONSE_BYTES = 64 * 1024 * 1024;
export interface MonitorHistoryReadResult {
  list: MonitorHistoryRecord[];
  total: number;
}
export interface MonitorHistoryQueryUnit extends RoleWriteUnit {
  listHistory(
    query: MonitorHistoryReadQuery,
  ): Promise<MonitorHistoryReadResult>;
  historyById(id: number): Promise<MonitorHistoryRecord | null>;
}
export interface MonitorHistoryQueryRepositoryPort {
  read<T>(action: (unit: MonitorHistoryQueryUnit) => Promise<T>): Promise<T>;
}
const from = sql`FROM ${monitorHistory} AS mh
  LEFT JOIN ${variantGroups} AS vg ON rtrim(vg.id) COLLATE public.neo_import_group_ci=rtrim(mh.variant_group_id)
  LEFT JOIN ${asins} AS a ON rtrim(a.id) COLLATE public.neo_import_group_ci=rtrim(mh.asin_id)`;
/** Raw column names are fixed code. Every caller value stays a SQL parameter. */
function filters(query: MonitorHistoryReadQuery): SQL {
  const conditions: SQL[] = [];
  const ci = (column: SQL) =>
    sql`rtrim(${column}) COLLATE public.neo_import_group_ci`;
  const equal = (column: SQL, value?: string) => {
    if (value) conditions.push(sql`${ci(column)}=rtrim(${value})`);
  };
  const like = (column: SQL, value?: string) => {
    if (value)
      conditions.push(sql`public.neo_monitor_like(${column},${`%${value}%`})`);
  };
  equal(sql`mh.variant_group_id`, query.variantGroupId);
  equal(sql`mh.asin_id`, query.asinId);
  const asin = sql`COALESCE(mh.asin_code,a.asin)`;
  if (Array.isArray(query.asin))
    conditions.push(
      sql`${ci(asin)} IN (${sql.join(
        query.asin.map((value) => sql`rtrim(${value})`),
        sql`, `,
      )})`,
    );
  else like(asin, query.asin);
  like(sql`COALESCE(mh.variant_group_name,vg.name)`, query.variantGroupName);
  like(sql`COALESCE(mh.asin_name,a.name)`, query.asinName);
  if (query.asinType === '1' || query.asinType === 'MAIN_LINK')
    conditions.push(sql`${ci(sql`a.asin_type`)} IN ('1','MAIN_LINK')`);
  else if (query.asinType === '2' || query.asinType === 'SUB_REVIEW')
    conditions.push(sql`${ci(sql`a.asin_type`)} IN ('2','SUB_REVIEW')`);
  else equal(sql`a.asin_type`, query.asinType);
  if (query.country === 'EU')
    conditions.push(sql`${ci(sql`mh.country`)} IN ('UK','DE','FR','IT','ES')`);
  else equal(sql`mh.country`, query.country);
  equal(sql`mh.check_type`, query.checkType);
  if (query.isBroken !== undefined)
    conditions.push(sql`mh.is_broken=${query.isBroken}`);
  if (query.startTime)
    conditions.push(sql`mh.check_time>=${query.startTime}::timestamp`);
  if (query.endTime)
    conditions.push(sql`mh.check_time<=${query.endTime}::timestamp`);
  return and(...conditions) ?? sql`true`;
}
export class DrizzleMonitorHistoryQueryUnit
  extends DrizzleRoleUnit
  implements MonitorHistoryQueryUnit
{
  override async lockOperator(userId: string) {
    this.ensureOpen();
    const [row] = await this.db
      .select({
        id: users.id,
        status: users.status,
        lockedUntil: users.lockedUntil,
        forcePasswordChange: users.forcePasswordChange,
        passwordExpiresAt: users.passwordExpiresAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('share');
    return row;
  }
  override async lockSession(userId: string, sessionId: string) {
    this.ensureOpen();
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .for('share');
    return row;
  }
  listHistory(query: MonitorHistoryReadQuery) {
    validateMonitorHistoryReadQuery(query);
    return this.select(
      filters(query),
      query.pageSize,
      (query.current - 1) * query.pageSize,
    );
  }
  async historyById(id: number) {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new MonitorHistoryQueryError('input');
    const result = await this.select(sql`mh.id=${String(id)}::bigint`, 2, 0);
    // Imported/identity-generated IDs are globally unique. A manually corrupted
    // Timescale composite key must not make this ID-only endpoint pick arbitrarily.
    if (result.total > 1) throw new MonitorHistoryQueryError('invalid-result');
    return result.list[0] ?? null;
  }
  private async select(
    where: SQL,
    limit: number,
    offset: number,
  ): Promise<MonitorHistoryReadResult> {
    this.ensureOpen();
    const response = await this.db.execute(sql`
      WITH page_keys AS MATERIALIZED (
        SELECT mh.check_time,mh.id ${from} WHERE ${where}
        ORDER BY mh.check_time DESC,mh.id DESC LIMIT ${limit} OFFSET ${offset}
      ), size_bound AS MATERIALIZED (
        SELECT COALESCE(sum(16384::bigint + 2::bigint * COALESCE(octet_length(to_json(mh.check_result::text)::text),4)),0)::text AS bytes
        FROM ${monitorHistory} AS mh INNER JOIN page_keys p ON p.id=mh.id AND p.check_time=mh.check_time
      )
      SELECT (SELECT count(*)::text ${from} WHERE ${where}) AS total,
        size_bound.bytes,
        CASE WHEN size_bound.bytes::numeric<=${MAX_MONITOR_HISTORY_RESPONSE_BYTES} THEN (
          SELECT COALESCE(jsonb_agg(to_jsonb(record) ORDER BY record.check_time DESC,record.sort_id DESC),'[]'::jsonb)
          FROM (
            SELECT mh.id::text AS id,mh.id AS sort_id,mh.variant_group_id,mh.asin_id,mh.check_type,mh.country,
              mh.is_broken,mh.check_time,mh.check_result::text AS check_result,mh.notification_sent,mh.create_time,
              COALESCE(mh.variant_group_name,vg.name) AS variant_group_name,
              COALESCE(mh.asin_code,a.asin) AS asin,COALESCE(mh.asin_name,a.name) AS asin_name,a.asin_type
            ${from} INNER JOIN page_keys p ON p.id=mh.id AND p.check_time=mh.check_time
          ) AS record
        ) ELSE NULL END AS records FROM size_bound
    `);
    this.ensureOpen();
    const row = response.rows[0];
    if (!row) throw new MonitorHistoryQueryError('invalid-result');
    if (monitorHistorySafeCount(row.bytes) > MAX_MONITOR_HISTORY_RESPONSE_BYTES)
      throw new MonitorHistoryQueryError('too-large');
    if (!Array.isArray(row.records) || row.records.length > limit)
      throw new MonitorHistoryQueryError('invalid-result');
    const list = row.records.map((value) =>
      mapMonitorHistoryRecord(decodeMonitorHistorySelectedRow(value)),
    );
    return { list, total: monitorHistorySafeCount(row.total) };
  }
}
export class PgMonitorHistoryQueryRepository
  implements MonitorHistoryQueryRepositoryPort
{
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async read<T>(
    action: (unit: MonitorHistoryQueryUnit) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 4) throw new MonitorHistoryQueryError('capacity');
    this.active++;
    try {
      return await withAsinDatabaseTransaction(this.pool, (db, ensureOpen) =>
        action(new DrizzleMonitorHistoryQueryUnit(db, ensureOpen)),
      );
    } finally {
      this.active--;
    }
  }
}
