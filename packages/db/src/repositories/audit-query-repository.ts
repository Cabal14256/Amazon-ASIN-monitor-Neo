import type {
  NeoAuditLog,
  NeoAuditLogListData,
  NeoAuditLogListQuery,
  NeoAuditStatisticsQuery,
} from '@asin-monitor/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Pool } from 'pg';
import { auditLogs } from '../schema';
import { AuditQueryDeadline, AuditQueryError } from './audit-query-deadline';

export interface AuditQueryRepositoryPort {
  list(query: NeoAuditLogListQuery): Promise<NeoAuditLogListData>;
  detail(id: number): Promise<NeoAuditLog | null>;
  actions(
    query: NeoAuditStatisticsQuery,
  ): Promise<{ action: string; count: number }[]>;
  resources(
    query: NeoAuditStatisticsQuery,
  ): Promise<{ resource: string | null; count: number }[]>;
}

function safeNumber(value: bigint | string, positive = false): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0))
    throw new AuditQueryError('invalid-result');
  return number;
}
function format(row: typeof auditLogs.$inferSelect): NeoAuditLog {
  return {
    id: safeNumber(row.id, true),
    userId: row.userId,
    username: row.username,
    action: row.action,
    resource: row.resource,
    resourceId: row.resourceId,
    resourceName: row.resourceName,
    method: row.method,
    path: row.path,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    requestData: row.requestData,
    responseStatus: row.responseStatus,
    errorMessage: row.errorMessage,
    ...(row.createTime ? { createTime: row.createTime.toISOString() } : {}),
  };
}
function range(query: NeoAuditStatisticsQuery): SQL[] {
  const filters: SQL[] = [];
  if (query.startTime)
    filters.push(gte(auditLogs.createTime, new Date(query.startTime)));
  if (query.endTime)
    filters.push(lte(auditLogs.createTime, new Date(query.endTime)));
  return filters;
}
const countRows = sql<string>`count(*)`;

export class AuditQueryRepository implements AuditQueryRepositoryPort {
  private readonly deadline: AuditQueryDeadline;
  constructor(pool: Pool) {
    this.deadline = new AuditQueryDeadline(pool);
  }

  list(query: NeoAuditLogListQuery): Promise<NeoAuditLogListData> {
    const filters = range(query);
    for (const key of ['userId', 'action', 'resource', 'resourceId'] as const) {
      if (query[key])
        filters.push(sql`lower(${auditLogs[key]}) = lower(${query[key]})`);
    }
    if (query.username)
      filters.push(ilike(auditLogs.username, `%${query.username}%`));
    const where = and(...filters);
    return this.deadline.run(async (db, ensureOpen) => {
      const [total] = await db
        .select({ count: countRows })
        .from(auditLogs)
        .where(where);
      ensureOpen();
      const rows = await db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(
          sql`${auditLogs.createTime} DESC NULLS LAST`,
          desc(auditLogs.id),
        )
        .limit(query.pageSize)
        .offset((query.current - 1) * query.pageSize);
      return {
        list: rows.map(format),
        total: safeNumber(total.count),
        current: query.current,
        pageSize: query.pageSize,
      };
    });
  }
  detail(id: number): Promise<NeoAuditLog | null> {
    return this.deadline.run(async (db) => {
      const [row] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.id, BigInt(id)))
        .limit(1);
      return row ? format(row) : null;
    });
  }
  actions(query: NeoAuditStatisticsQuery) {
    const action = sql<string>`min(${auditLogs.action})`;
    return this.deadline.run(async (db) => {
      const rows = await db
        .select({ action, count: countRows })
        .from(auditLogs)
        .where(and(...range(query)))
        .groupBy(sql`lower(${auditLogs.action})`)
        .orderBy(desc(countRows), asc(action));
      return rows.map((row) => ({
        action: row.action,
        count: safeNumber(row.count),
      }));
    });
  }
  resources(query: NeoAuditStatisticsQuery) {
    const resource = sql<string | null>`min(${auditLogs.resource})`;
    return this.deadline.run(async (db) => {
      const rows = await db
        .select({ resource, count: countRows })
        .from(auditLogs)
        .where(and(...range(query)))
        .groupBy(sql`lower(${auditLogs.resource})`)
        .orderBy(desc(countRows), asc(resource));
      return rows.map((row) => ({
        resource: row.resource,
        count: safeNumber(row.count),
      }));
    });
  }
}
