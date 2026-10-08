import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  ilike,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';
import { createDb, type Db } from '../client';
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
export const MAX_ASIN_EXPORT_GROUP_PAGE_SIZE = 50;
export const ASIN_EXPORT_QUERY_TIMEOUT_MS = 60_000;
// SQL work has its own 60-second statement timeout. The read-only MVCC
// snapshot also contains bounded compression/drain pauses, so its lifetime
// follows the export task deadline rather than a shorter storage-speed cap.
const ASIN_EXPORT_TRANSACTION_TIMEOUT_MS = 30 * 60_000;
export interface AsinGroupQuery {
  keyword?: string;
  country?: string;
  variantStatus?: 'BROKEN' | 'NORMAL';
  current: number;
  pageSize: number;
}
export interface AsinGroupReadResult {
  groups: (VariantGroup & {
    asinCount?: number;
    exportIsBroken?: boolean;
    exportHasAutoBroken?: boolean;
    exportHasManualBroken?: boolean;
    exportCursorTime?: string | null;
  })[];
  asins: Asin[];
  total: number;
  totalASINs: number;
}
export interface AsinExportCursor {
  id: string;
  createTime: string | null;
}
export type AsinExportChild = Asin & { exportCursorTime: string | null };
export interface AsinExportChildrenCursor extends AsinExportCursor {
  groupId: string;
}
export interface AsinQueryUnit extends RoleWriteUnit {
  list(query: AsinGroupQuery): Promise<AsinGroupReadResult>;
  detail(groupId: string): Promise<AsinGroupReadResult>;
}
export interface AsinQueryRepositoryPort {
  read<T>(operation: (unit: AsinQueryUnit) => Promise<T>): Promise<T>;
}
export interface AsinExportQueryUnit extends AsinQueryUnit {
  listExportGroups(
    query: AsinGroupQuery,
    cursor?: AsinExportCursor,
    includeTotal?: boolean,
  ): Promise<AsinGroupReadResult>;
  listExportChildren(
    groupId: string,
    cursor?: AsinExportCursor,
  ): Promise<AsinExportChild[]>;
  listExportChildrenPage(
    groupIds: readonly string[],
    cursor?: AsinExportChildrenCursor,
  ): Promise<AsinExportChild[]>;
}
export interface AsinExportQueryRepositoryPort {
  read<T>(
    operation: (
      unit: AsinExportQueryUnit,
      ensureOpen: () => void,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
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
const exportHasAutoBroken = sql`(COALESCE(${g.isBroken}, false)
  OR EXISTS (SELECT 1 FROM ${asins} AS state_child WHERE ${child.variantGroupId}=${g.id}
    AND COALESCE(${child.isBroken}, false)))`;
const exportHasManualBroken = sql`(COALESCE(${g.manualBroken}, false)
  OR EXISTS (SELECT 1 FROM ${asins} AS state_child WHERE ${child.variantGroupId}=${g.id}
    AND COALESCE(${child.manualBroken}, false)))`;
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
function validateGroupId(groupId: string) {
  if (
    typeof groupId !== 'string' ||
    !groupId ||
    [...groupId].length > 50 ||
    /[\x00-\x1f\x7f]/.test(groupId)
  )
    throw new AsinQueryRepositoryError('input');
}
function validateExportCursor(cursor?: AsinExportCursor) {
  if (!cursor) return;
  validateGroupId(cursor.id);
  if (
    cursor.createTime !== null &&
    (typeof cursor.createTime !== 'string' ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(
        cursor.createTime,
      ))
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
  implements AsinExportQueryUnit
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
  listExportGroups(
    query: AsinGroupQuery,
    cursor?: AsinExportCursor,
    includeTotal = true,
  ) {
    if (query.current !== 1) throw new AsinQueryRepositoryError('input');
    validateExportCursor(cursor);
    return this.query(query, undefined, false, cursor, includeTotal);
  }
  async listExportChildren(
    groupId: string,
    cursor?: AsinExportCursor,
  ): Promise<AsinExportChild[]> {
    validateGroupId(groupId);
    validateExportCursor(cursor);
    const after = cursor
      ? cursor.createTime === null
        ? or(
            and(sql`${asins.createTime} IS NULL`, gt(asins.id, cursor.id)),
            sql`${asins.createTime} IS NOT NULL`,
          )
        : or(
            sql`${asins.createTime} > (${cursor.createTime}::timestamp)`,
            and(
              sql`${asins.createTime} = (${cursor.createTime}::timestamp)`,
              gt(asins.id, cursor.id),
            ),
          )
      : undefined;
    this.ensureOpen();
    const children = await this.db
      .select({
        ...getTableColumns(asins),
        exportCursorTime: sql<string | null>`${asins.createTime}::text`.as(
          'export_cursor_time',
        ),
      })
      .from(asins)
      .where(and(eq(asins.variantGroupId, groupId), after))
      .orderBy(sql`${asins.createTime} ASC NULLS FIRST`, asc(asins.id))
      .limit(MAX_ASIN_QUERY_CHILDREN);
    this.ensureOpen();
    return children;
  }
  /** One bounded child query covers an ordered group page. The native cursor
   * can continue a dense group and then its later siblings without N+1 reads. */
  async listExportChildrenPage(
    groupIds: readonly string[],
    cursor?: AsinExportChildrenCursor,
  ): Promise<AsinExportChild[]> {
    if (
      !Array.isArray(groupIds) ||
      !groupIds.length ||
      groupIds.length > MAX_ASIN_EXPORT_GROUP_PAGE_SIZE ||
      new Set(groupIds).size !== groupIds.length
    )
      throw new AsinQueryRepositoryError('input');
    groupIds.forEach(validateGroupId);
    validateExportCursor(cursor);
    const position = cursor ? groupIds.indexOf(cursor.groupId) : -1;
    if (cursor && position < 0) throw new AsinQueryRepositoryError('input');
    const selected = sql.join(
      groupIds.map((id, index) => sql`(${id}::text,${index}::integer)`),
      sql`, `,
    );
    const after = cursor
      ? sql`selected.ordinal>${position} OR (selected.ordinal=${position} AND ${
          cursor.createTime === null
            ? sql`((a.create_time IS NULL AND a.id COLLATE "C">${cursor.id}) OR a.create_time IS NOT NULL)`
            : sql`(a.create_time>${cursor.createTime}::timestamp OR (a.create_time=${cursor.createTime}::timestamp AND a.id COLLATE "C">${cursor.id}))`
        })`
      : sql`true`;
    this.ensureOpen();
    const result = await this.db.execute(sql`
      WITH selected(id,ordinal) AS (VALUES ${selected})
      SELECT a.*,a.create_time::text AS export_cursor_time
      FROM ${asins} AS a INNER JOIN selected ON a.variant_group_id=selected.id
      WHERE ${after}
      ORDER BY selected.ordinal,a.create_time ASC NULLS FIRST,a.id COLLATE "C" ASC
      LIMIT ${MAX_ASIN_QUERY_CHILDREN}
    `);
    this.ensureOpen();
    if (
      !Array.isArray(result.rows) ||
      result.rows.length > MAX_ASIN_QUERY_CHILDREN
    )
      throw new AsinQueryRepositoryError('result');
    let previous = cursor;
    return result.rows.map((row: Record<string, unknown>) => {
      if (
        typeof row.variant_group_id !== 'string' ||
        typeof row.id !== 'string' ||
        (row.export_cursor_time !== null &&
          typeof row.export_cursor_time !== 'string')
      )
        throw new AsinQueryRepositoryError('result');
      const next = {
        groupId: row.variant_group_id,
        id: row.id,
        createTime: row.export_cursor_time as string | null,
      };
      validateExportCursor(next);
      const ordinal = groupIds.indexOf(next.groupId);
      if (ordinal < 0) throw new AsinQueryRepositoryError('result');
      if (previous) {
        const before = groupIds.indexOf(previous.groupId);
        const advances =
          ordinal > before ||
          (ordinal === before &&
            (previous.createTime === null
              ? next.createTime !== null ||
                Buffer.compare(Buffer.from(next.id), Buffer.from(previous.id)) >
                  0
              : next.createTime !== null &&
                (next.createTime > previous.createTime ||
                  (next.createTime === previous.createTime &&
                    Buffer.compare(
                      Buffer.from(next.id),
                      Buffer.from(previous.id),
                    ) > 0))));
        if (!advances) throw new AsinQueryRepositoryError('result');
      }
      previous = next;
      return { ...hydrate(asins, row), exportCursorTime: next.createTime };
    });
  }
  detail(groupId: string) {
    validateGroupId(groupId);
    return this.query({ current: 1, pageSize: 1 }, groupId);
  }
  private async query(
    query: AsinGroupQuery,
    groupId?: string,
    includeChildren = true,
    exportCursor?: AsinExportCursor,
    includeTotal = true,
  ): Promise<AsinGroupReadResult> {
    validateQuery(query);
    const keyword = textFilter(query.keyword);
    const groupWhere =
      and(
        groupId === undefined ? undefined : eq(g.id, groupId),
        exportCursor
          ? exportCursor.createTime === null
            ? and(sql`${g.createTime} IS NULL`, lt(g.id, exportCursor.id))
            : or(
                sql`${g.createTime} < (${exportCursor.createTime}::timestamp)`,
                sql`${g.createTime} IS NULL`,
                and(
                  sql`${g.createTime} = (${exportCursor.createTime}::timestamp)`,
                  lt(g.id, exportCursor.id),
                ),
              )
          : undefined,
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
    // API list/detail counts, selected groups and children share one statement
    // snapshot. Export uses keyset pages and counts groups only on the first page.
    const total =
      groupId === undefined && includeTotal
        ? sql`(SELECT count(*)::text FROM ${variantGroups} AS g WHERE ${groupWhere})`
        : sql`'0'`;
    const totalASINs =
      groupId === undefined && includeChildren
        ? sql`(SELECT count(*)::text FROM ${asins} AS a LEFT JOIN ${variantGroups} AS g ON ${g.id}=${a.variantGroupId} WHERE ${asinWhere})`
        : sql`'0'`;
    const asinCount = includeChildren
      ? sql`(SELECT count(*)::text FROM ${asins} AS a WHERE ${
          a.variantGroupId
        }=${g.id} AND ${keyword ?? sql`true`})`
      : sql`NULL::text`;
    const childPage = includeChildren
      ? sql`, child_page AS MATERIALIZED (
        SELECT a.* FROM ${asins} AS a INNER JOIN selected p ON p.id=${
          a.variantGroupId
        }
        ORDER BY ${a.variantGroupId}, ${a.createTime} ASC NULLS FIRST, ${a.id}
        LIMIT ${MAX_ASIN_QUERY_CHILDREN + 1}
      )`
      : sql``;
    const selectedChildren = includeChildren
      ? sql`COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.variant_group_id, c.create_time ASC NULLS FIRST, c.id) FROM child_page c), '[]'::jsonb)`
      : sql`'[]'::jsonb`;
    const exportGroupBroken = includeChildren
      ? sql`NULL::boolean`
      : groupBroken;
    const exportAutoBroken = includeChildren
      ? sql`NULL::boolean`
      : exportHasAutoBroken;
    const exportManualBroken = includeChildren
      ? sql`NULL::boolean`
      : exportHasManualBroken;
    const exportCursorTime = includeChildren
      ? sql`NULL::text`
      : sql`${g.createTime}::text`;
    this.ensureOpen();
    const result = await this.db.execute(sql`
      WITH selected AS MATERIALIZED (
        SELECT g.*, ${asinCount} AS asin_count,
          ${exportGroupBroken} AS export_group_broken,
          ${exportAutoBroken} AS export_has_auto_broken,
          ${exportManualBroken} AS export_has_manual_broken,
          ${exportCursorTime} AS export_cursor_time
        FROM ${variantGroups} AS g WHERE ${groupWhere}
        ORDER BY ${g.createTime} DESC NULLS LAST, ${g.id} DESC
        LIMIT ${query.pageSize} OFFSET ${
      includeChildren ? (query.current - 1) * query.pageSize : 0
    }
      ) ${childPage}
      SELECT ${total} AS total, ${totalASINs} AS total_asins,
        COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.create_time DESC NULLS LAST, p.id DESC) FROM selected p), '[]'::jsonb) AS groups,
        ${selectedChildren} AS asins
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
      groups: payload.groups.map((row: Record<string, unknown>) => {
        if (!includeChildren && typeof row.export_group_broken !== 'boolean')
          throw new AsinQueryRepositoryError('result');
        if (
          !includeChildren &&
          (typeof row.export_has_auto_broken !== 'boolean' ||
            typeof row.export_has_manual_broken !== 'boolean')
        )
          throw new AsinQueryRepositoryError('result');
        if (
          !includeChildren &&
          row.export_cursor_time !== null &&
          typeof row.export_cursor_time !== 'string'
        )
          throw new AsinQueryRepositoryError('result');
        return {
          ...hydrate(variantGroups, row),
          ...(groupId === undefined && includeChildren
            ? { asinCount: count(row.asin_count) }
            : {}),
          ...(!includeChildren
            ? {
                exportIsBroken: row.export_group_broken as boolean,
                exportHasAutoBroken: row.export_has_auto_broken as boolean,
                exportHasManualBroken: row.export_has_manual_broken as boolean,
                exportCursorTime: row.export_cursor_time as string | null,
              }
            : {}),
        };
      }),
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

/** Export reads have their own bounded connection and transaction lifetime. */
export async function withAsinExportDatabaseTransaction<T>(
  pool: Pool,
  operation: (db: Db, ensureOpen: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const client: PoolClient = await pool.connect();
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectionError!: (error: Error) => void;
  const connectionFailure = new Promise<never>((_resolve, reject) => {
    connectionError = reject;
  });
  client.on('error', connectionError);
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    client.release(true);
  };
  const ensureOpen = () => {
    signal?.throwIfAborted();
    if (destroyed) throw new Error('ASIN_EXPORT_QUERY_TIMEOUT');
  };
  const abort = () => {
    destroy();
    connectionError(new Error('ASIN_EXPORT_QUERY_CANCELLED'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await Promise.race([
      connectionFailure,
      (async () => {
        ensureOpen();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        ensureOpen();
        await client.query(
          `SET LOCAL statement_timeout = ${ASIN_EXPORT_QUERY_TIMEOUT_MS}`,
        );
        ensureOpen();
        // Authorization was checked at acceptance and is checked again at
        // download. This business snapshot must leave role administration free.
        const result = await operation(createDb(client), ensureOpen);
        ensureOpen();
        await client.query('COMMIT');
        return result;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          destroy();
          reject(new Error('ASIN_EXPORT_QUERY_TIMEOUT'));
        }, ASIN_EXPORT_TRANSACTION_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    destroy();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    client.removeListener('error', connectionError);
    if (!destroyed) client.release();
  }
}

export class PgAsinExportQueryRepository
  implements AsinExportQueryRepositoryPort
{
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async read<T>(
    operation: (
      unit: AsinExportQueryUnit,
      ensureOpen: () => void,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.active >= 2) throw new AsinQueryRepositoryError('capacity');
    this.active++;
    try {
      return await withAsinExportDatabaseTransaction(
        this.pool,
        (db, ensureOpen) =>
          operation(new DrizzleAsinQueryUnit(db, ensureOpen), ensureOpen),
        signal,
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
