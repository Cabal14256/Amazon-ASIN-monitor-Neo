import {
  and,
  eq,
  getTableColumns,
  ilike,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import {
  asins,
  sessions,
  users,
  variantGroups,
  type Asin,
  type VariantGroup,
} from '../schema';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';
import { DrizzleRoleUnit, type RoleWriteUnit } from './role-repository';

export const MAX_ASIN_QUERY_CHILDREN = 5000;
export interface AsinGroupQuery {
  keyword?: string;
  country?: string;
  variantStatus?: 'BROKEN' | 'NORMAL';
  current: number;
  pageSize: number;
}
export interface AsinGroupReadResult {
  groups: (VariantGroup & { asinCount?: number })[];
  asins: Asin[];
  total: number;
  totalASINs: number;
}
export interface AsinQueryUnit extends RoleWriteUnit {
  list(query: AsinGroupQuery): Promise<AsinGroupReadResult>;
  detail(groupId: string): Promise<AsinGroupReadResult>;
}
export interface AsinQueryRepositoryPort {
  read<T>(operation: (unit: AsinQueryUnit) => Promise<T>): Promise<T>;
}
export class AsinQueryRepositoryError extends Error {
  constructor(
    readonly code: 'capacity' | 'input' | 'result' | 'too-many-children',
  ) {
    super('ASIN query could not be completed');
    this.name = 'AsinQueryRepositoryError';
  }
}
const g = alias(variantGroups, 'g');
const a = alias(asins, 'a');
const child = alias(asins, 'state_child');
function childBroken(table: typeof a | typeof child): SQL {
  return sql`(COALESCE(${table.isBroken}, false) OR COALESCE(${table.manualBroken}, false)
    OR (COALESCE(${g.manualBroken}, false) AND NOT COALESCE(${table.manualExcludedFromGroup}, false)))`;
}
const groupBroken = sql`(COALESCE(${g.isBroken}, false) OR COALESCE(${
  g.manualBroken
}, false)
  OR EXISTS (SELECT 1 FROM ${asins} AS state_child WHERE ${
  child.variantGroupId
}=${g.id} AND ${childBroken(child)}))`;
const countryFilter = (
  column: typeof g.country | typeof a.country,
  value?: string,
) => (value ? sql`lower(${column})=lower(${value})` : undefined);
const textFilter = (keyword?: string) =>
  keyword
    ? or(
        ilike(g.name, `%${keyword}%`),
        ilike(g.id, `%${keyword}%`),
        ilike(a.asin, `%${keyword}%`),
      )
    : undefined;
function stateFilter(expression: SQL, status?: 'BROKEN' | 'NORMAL') {
  return status
    ? status === 'BROKEN'
      ? expression
      : sql`NOT ${expression}`
    : undefined;
}
function validateQuery(query: AsinGroupQuery) {
  const offset = (query.current - 1) * query.pageSize;
  if (
    !Number.isSafeInteger(query.current) ||
    query.current < 1 ||
    !Number.isInteger(query.pageSize) ||
    query.pageSize < 1 ||
    query.pageSize > 100 ||
    !Number.isSafeInteger(offset) ||
    offset > 1_000_000 ||
    (query.keyword !== undefined &&
      (typeof query.keyword !== 'string' || query.keyword.length > 200)) ||
    (query.country !== undefined &&
      (typeof query.country !== 'string' || query.country.length > 10)) ||
    (query.variantStatus !== undefined &&
      !['BROKEN', 'NORMAL'].includes(query.variantStatus))
  )
    throw new AsinQueryRepositoryError('input');
}
function count(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new AsinQueryRepositoryError('result');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new AsinQueryRepositoryError('result');
  return result;
}
/** to_jsonb timestamps are database wall clocks. Reuse every schema column's
 * driver codec, including D8's Shanghai timestamp conversion, before API mapping.
 */
function hydrate<T extends PgTable>(
  table: T,
  value: unknown,
): T['$inferSelect'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AsinQueryRepositoryError('result');
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => {
      if (!Object.hasOwn(input, column.name))
        throw new AsinQueryRepositoryError('result');
      const raw = input[column.name];
      return [key, raw === null ? null : column.mapFromDriverValue(raw)];
    }),
  ) as T['$inferSelect'];
}

export class DrizzleAsinQueryUnit
  extends DrizzleRoleUnit
  implements AsinQueryUnit
{
  // Shared row/advisory locks allow concurrent readers, but still serialize
  // against committed administration, password and session changes.
  override async lockOperator(userId: string) {
    this.ensureOpen();
    const [operator] = await this.db
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
    return operator;
  }
  override async lockSession(userId: string, sessionId: string) {
    this.ensureOpen();
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .for('share');
    return session;
  }
  list(query: AsinGroupQuery) {
    return this.query(query);
  }
  detail(groupId: string) {
    if (
      typeof groupId !== 'string' ||
      !groupId ||
      [...groupId].length > 50 ||
      /[\x00-\x1f\x7f]/.test(groupId)
    )
      throw new AsinQueryRepositoryError('input');
    return this.query({ current: 1, pageSize: 1 }, groupId);
  }
  private async query(
    query: AsinGroupQuery,
    groupId?: string,
  ): Promise<AsinGroupReadResult> {
    validateQuery(query);
    const keyword = textFilter(query.keyword);
    const groupWhere =
      and(
        groupId === undefined ? undefined : eq(g.id, groupId),
        query.keyword
          ? or(
              ilike(g.name, `%${query.keyword}%`),
              ilike(g.id, `%${query.keyword}%`),
              sql`EXISTS (SELECT 1 FROM ${asins} AS a WHERE ${
                a.variantGroupId
              }=${g.id} AND ${ilike(a.asin, `%${query.keyword}%`)})`,
            )
          : undefined,
        countryFilter(g.country, query.country),
        stateFilter(groupBroken, query.variantStatus),
      ) ?? sql`true`;
    const asinWhere =
      and(
        keyword,
        countryFilter(a.country, query.country),
        stateFilter(childBroken(a), query.variantStatus),
      ) ?? sql`true`;
    // All counts, selected groups and children are one MVCC statement snapshot.
    // Limiting before aggregation bounds materialization; overflow fails in full.
    const total =
      groupId === undefined
        ? sql`(SELECT count(*)::text FROM ${variantGroups} AS g WHERE ${groupWhere})`
        : sql`'0'`;
    const totalASINs =
      groupId === undefined
        ? sql`(SELECT count(*)::text FROM ${asins} AS a LEFT JOIN ${variantGroups} AS g ON ${g.id}=${a.variantGroupId} WHERE ${asinWhere})`
        : sql`'0'`;
    const asinCount = sql`(SELECT count(*)::text FROM ${asins} AS a WHERE ${
      a.variantGroupId
    }=${g.id} AND ${keyword ?? sql`true`})`;
    this.ensureOpen();
    const result = await this.db.execute(sql`
      WITH selected AS MATERIALIZED (
        SELECT g.*, ${asinCount} AS asin_count FROM ${variantGroups} AS g WHERE ${groupWhere}
        ORDER BY ${g.createTime} DESC NULLS LAST, ${g.id} DESC
        LIMIT ${query.pageSize} OFFSET ${(query.current - 1) * query.pageSize}
      ), child_page AS MATERIALIZED (
        SELECT a.* FROM ${asins} AS a INNER JOIN selected p ON p.id=${
      a.variantGroupId
    }
        ORDER BY ${a.variantGroupId}, ${a.createTime} ASC NULLS FIRST, ${a.id}
        LIMIT ${MAX_ASIN_QUERY_CHILDREN + 1}
      )
      SELECT ${total} AS total, ${totalASINs} AS total_asins,
        COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.create_time DESC NULLS LAST, p.id DESC) FROM selected p), '[]'::jsonb) AS groups,
        COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.variant_group_id, c.create_time ASC NULLS FIRST, c.id) FROM child_page c), '[]'::jsonb) AS asins
    `);
    this.ensureOpen();
    const payload = result.rows[0];
    if (
      !payload ||
      !Array.isArray(payload.groups) ||
      !Array.isArray(payload.asins) ||
      payload.groups.length > query.pageSize
    )
      throw new AsinQueryRepositoryError('result');
    if (payload.asins.length > MAX_ASIN_QUERY_CHILDREN)
      throw new AsinQueryRepositoryError('too-many-children');
    return {
      groups: payload.groups.map((row: Record<string, unknown>) => ({
        ...hydrate(variantGroups, row),
        ...(groupId === undefined ? { asinCount: count(row.asin_count) } : {}),
      })),
      asins: payload.asins.map((row) => hydrate(asins, row)),
      total: count(payload.total),
      totalASINs: count(payload.total_asins),
    };
  }
}
export class PgAsinQueryRepository implements AsinQueryRepositoryPort {
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async read<T>(operation: (unit: AsinQueryUnit) => Promise<T>): Promise<T> {
    if (this.active >= 16) throw new AsinQueryRepositoryError('capacity');
    this.active++;
    try {
      return await withAsinDatabaseTransaction(this.pool, (db, ensureOpen) =>
        operation(new DrizzleAsinQueryUnit(db, ensureOpen)),
      );
    } finally {
      this.active--;
    }
  }
}

/** Business writes share authorization locks with readers. Only administration
 * changes take the matching exclusive advisory lock; business row locks are
 * acquired afterwards in group -> ASIN order by the relevant unit.
 */
export function withAsinDatabaseTransaction<T>(
  pool: Pool,
  operation: Parameters<typeof withAuthDatabaseDeadline<T>>[1],
): Promise<T> {
  return withAuthDatabaseDeadline(pool, async (db, ensureOpen) => {
    ensureOpen();
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    ensureOpen();
    await db.execute(
      sql`SELECT pg_advisory_xact_lock_shared(1095977294,1380073795)`,
    );
    ensureOpen();
    return operation(db, ensureOpen);
  });
}
