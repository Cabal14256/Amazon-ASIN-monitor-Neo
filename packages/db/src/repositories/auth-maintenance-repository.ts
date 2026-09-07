import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import { formatShanghaiTimestamp } from '../timestamps';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';

export interface MaintenanceBatchResult {
  processed: number;
  hasMore: boolean;
  busy: boolean;
}
export interface AuthMaintenanceRepositoryPort {
  cleanupSessions(limit?: number, now?: Date): Promise<MaintenanceBatchResult>;
  archiveAuditLogs(
    retentionDays?: number,
    limit?: number,
    now?: Date,
  ): Promise<MaintenanceBatchResult>;
}

function timestamp(now: Date): string {
  const formatted = formatShanghaiTimestamp(now);
  if (!/^(?!0000)\d{4}-\d{2}-\d{2} /.test(formatted))
    throw new Error('Unsupported maintenance timestamp');
  return formatted;
}
function batchSize(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Invalid maintenance batch size');
}
function result(count: unknown, hasMore: unknown): MaintenanceBatchResult {
  const processed = Number(count);
  if (
    !Number.isSafeInteger(processed) ||
    processed < 0 ||
    typeof hasMore !== 'boolean'
  )
    throw new Error('Invalid maintenance result');
  return { processed, hasMore, busy: false };
}
const busy: MaintenanceBatchResult = {
  processed: 0,
  hasMore: true,
  busy: true,
};

/** All SQL uses the application's configured schema; no table/SQL comes from job payloads. */
export class PgAuthMaintenanceRepository
  implements AuthMaintenanceRepositoryPort
{
  constructor(private readonly pool: Pool) {}
  private run(
    kind: 1 | 2,
    operation: (
      db: Db,
      ensureOpen: () => void,
    ) => Promise<MaintenanceBatchResult>,
  ) {
    return withAuthDatabaseDeadline(this.pool, async (db, ensureOpen) => {
      ensureOpen();
      const lock = await db.execute(
        sql`SELECT pg_try_advisory_xact_lock(1095977295, ${kind}) AS acquired`,
      );
      if (lock.rows[0]?.acquired !== true) return { ...busy };
      ensureOpen();
      return operation(db, ensureOpen);
    });
  }
  cleanupSessions(limit = 1000, now = new Date()) {
    batchSize(limit);
    const cutoff = timestamp(now);
    return this.run(1, async (db, ensureOpen) => {
      const removed = await db.execute(sql`
        WITH candidates AS (
          SELECT id FROM sessions
          WHERE expires_at IS NOT NULL AND expires_at <= ${cutoff}::timestamp
          ORDER BY expires_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
        ), deleted AS (
          DELETE FROM sessions target USING candidates
          WHERE target.id = candidates.id RETURNING target.id
        ) SELECT count(*)::text AS count FROM deleted`);
      ensureOpen();
      const remaining = await db.execute(sql`SELECT EXISTS (
        SELECT 1 FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ${cutoff}::timestamp
      ) AS present`);
      return result(removed.rows[0]?.count, remaining.rows[0]?.present);
    });
  }
  archiveAuditLogs(retentionDays = 90, limit = 1000, now = new Date()) {
    batchSize(limit);
    timestamp(now);
    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 3650
    )
      throw new Error('Invalid audit retention days');
    const cutoff = timestamp(
      new Date(now.getTime() - retentionDays * 86_400_000),
    );
    return this.run(2, async (db, ensureOpen) => {
      const oldest =
        await db.execute(sql`SELECT to_char(create_time, 'YYYY-MM') AS month,
        create_time >= TIMESTAMP '0001-01-01' AND create_time < TIMESTAMP '9999-12-01' AS supported
        FROM audit_logs WHERE create_time < ${cutoff}::timestamp
        ORDER BY create_time, id LIMIT 1`);
      const month = oldest.rows[0]?.month;
      if (month === undefined) return result(0, false);
      if (oldest.rows[0]?.supported !== true)
        throw new Error('Unsupported archive timestamp');
      if (
        typeof month !== 'string' ||
        !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)
      )
        throw new Error('Unsupported archive month');
      const year = Number(month.slice(0, 4));
      const monthNumber = Number(month.slice(5));
      const next =
        monthNumber === 12
          ? `${String(year + 1).padStart(4, '0')}-01`
          : `${month.slice(0, 4)}-${String(monthNumber + 1).padStart(2, '0')}`;
      if (next.length !== 7)
        throw new Error('Unsupported archive month boundary');
      const partitionName = `audit_logs_archive_${month.replace('-', '_')}`;
      const partition = sql.identifier(partitionName);
      // Identity IDs must remain unique across hot/archive storage. An external
      // reimport that duplicates a moved ID must be repaired before any more moves.
      ensureOpen();
      const conflicts = await db.execute(sql`SELECT EXISTS (
        SELECT 1 FROM audit_logs hot JOIN audit_logs_archive archive ON archive.id = hot.id
        WHERE hot.create_time < ${cutoff}::timestamp
          AND hot.create_time >= ${`${month}-01`}::timestamp AND hot.create_time < ${`${next}-01`}::timestamp
      ) AS present`);
      if (conflicts.rows[0]?.present !== false)
        throw new Error('Audit archive identity conflict');
      ensureOpen();
      // PostgreSQL partition bounds are DDL literals; both are constructed only
      // from the validated numeric month above, never from request/job text.
      const existing =
        await db.execute(sql`SELECT to_regclass(${partitionName}) AS relation,
        EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = to_regclass(${partitionName}) AND inhparent = 'audit_logs_archive'::regclass) AS attached`);
      if (
        existing.rows[0]?.relation !== null &&
        existing.rows[0]?.attached !== true
      )
        throw new Error('Unexpected audit archive partition');
      if (existing.rows[0]?.relation === null) {
        // ATTACH takes SHARE UPDATE EXCLUSIVE on the parent, compatible with
        // audit readers. CREATE TABLE ... PARTITION OF would block snapshots.
        ensureOpen();
        await db.execute(sql`CREATE TABLE ${partition} (
          LIKE audit_logs_archive INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES,
          CHECK (create_time >= ${sql.raw(
            `TIMESTAMP '${month}-01'`,
          )} AND create_time < ${sql.raw(`TIMESTAMP '${next}-01'`)})
        )`);
        ensureOpen();
        await db.execute(sql`ALTER TABLE audit_logs_archive ATTACH PARTITION ${partition}
          FOR VALUES FROM (${sql.raw(`'${month}-01'`)}) TO (${sql.raw(
          `'${next}-01'`,
        )})`);
      }
      ensureOpen();
      const moved = await db.execute(sql`
        WITH candidates AS MATERIALIZED (
          SELECT id FROM audit_logs WHERE create_time < ${cutoff}::timestamp
            AND create_time >= ${`${month}-01`}::timestamp AND create_time < ${`${next}-01`}::timestamp
          ORDER BY create_time, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
        ), deleted AS (
          DELETE FROM audit_logs target USING candidates WHERE target.id = candidates.id RETURNING target.*
        ), archived AS (
          INSERT INTO audit_logs_archive (
            id, user_id, username, action, resource, resource_id, resource_name,
            method, path, ip_address, user_agent, request_data, response_status, error_message, create_time
          ) SELECT id, user_id, username, action, resource, resource_id, resource_name,
            method, path, ip_address, user_agent, request_data, response_status, error_message, create_time
          FROM deleted RETURNING id
        ) SELECT count(*)::text AS count FROM archived`);
      ensureOpen();
      const remaining = await db.execute(sql`SELECT EXISTS (
        SELECT 1 FROM audit_logs WHERE create_time < ${cutoff}::timestamp
      ) AS present`);
      return result(moved.rows[0]?.count, remaining.rows[0]?.present);
    });
  }
}
