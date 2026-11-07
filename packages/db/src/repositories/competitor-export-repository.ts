import { isNeoCatalogId } from '@asin-monitor/contracts';
import { and, getTableColumns, or, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import { CompetitorQueryError } from '../domain/competitor-query';
import type { Asin, VariantGroup } from '../schema';
import {
  competitorAsins as asins,
  competitorVariantGroups as groups,
} from '../schema-competitor';
import {
  MAX_ASIN_EXPORT_GROUP_PAGE_SIZE,
  MAX_ASIN_QUERY_CHILDREN,
  withAsinExportDatabaseTransaction,
  type AsinExportChildrenCursor,
  type AsinExportCursor,
  type AsinGroupQuery,
  type AsinGroupReadResult,
  type CatalogExportQueryRepositoryPort,
  type CatalogExportQueryUnit,
} from './asin-query-repository';

const equal = (left: unknown, right: unknown) =>
  sql`rtrim(${left}) COLLATE public.neo_competitor_query_ci = rtrim(${right})`;
const like = (column: unknown, keyword: string) =>
  sql`public.neo_competitor_query_like(${column}, ${`%${keyword}%`})`;
const emptyManual = {
  site: '',
  manualBroken: false,
  manualBrokenReason: null,
  manualBrokenUpdatedAt: null,
  manualBrokenUpdatedBy: null,
  manualExcludedFromGroup: false,
  manualExcludedReason: null,
  manualExcludedUpdatedAt: null,
  manualExcludedUpdatedBy: null,
};
function cursor(value?: AsinExportCursor) {
  if (
    value &&
    (!isNeoCatalogId(value.id) ||
      (value.createTime !== null &&
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(
          value.createTime,
        )))
  )
    throw new CompetitorQueryError('input');
}
function count(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '')
    throw new CompetitorQueryError('result');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new CompetitorQueryError('result');
  return parsed;
}

/** Competitor-only business snapshot. Authorization remains on the primary
 * acceptance/download path and never holds a primary lock through compression.
 * The structural projection shares the existing bounded XLSX execution engine;
 * competitor rows have no manual/site fields and only raw automatic status. */
export class PgCompetitorExportRepository
  implements CatalogExportQueryRepositoryPort
{
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async read<T>(
    action: (
      unit: CatalogExportQueryUnit,
      ensureOpen: () => void,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.active >= 2) throw new CompetitorQueryError('capacity');
    this.active++;
    try {
      return await withAsinExportDatabaseTransaction(
        this.pool,
        (db, ensureOpen) => {
          const query = new CompetitorExportUnit(db, ensureOpen);
          return action(
            {
              listExportGroups: query.listExportGroups.bind(query),
              listExportChildrenPage: query.listExportChildrenPage.bind(query),
            },
            ensureOpen,
          );
        },
        signal,
      );
    } finally {
      this.active--;
    }
  }
}

export class CompetitorExportUnit {
  constructor(private readonly db: Db, private readonly ensure: () => void) {}
  async listExportGroups(
    query: AsinGroupQuery,
    after?: AsinExportCursor,
    includeTotal = true,
  ): Promise<AsinGroupReadResult> {
    cursor(after);
    if (
      query.current !== 1 ||
      !Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > MAX_ASIN_EXPORT_GROUP_PAGE_SIZE ||
      (query.keyword?.length ?? 0) > 200 ||
      (query.country?.length ?? 0) > 10 ||
      [query.keyword, query.country].some(
        (v) =>
          v !== undefined &&
          (typeof v !== 'string' || /[\x00-\x1f\x7f]/.test(v)),
      ) ||
      (query.variantStatus !== undefined &&
        !['NORMAL', 'BROKEN'].includes(query.variantStatus))
    )
      throw new CompetitorQueryError('input');
    const childMatch = sql`EXISTS (SELECT 1 FROM ${asins} a WHERE a.variant_group_id=${groups.id} AND a.variant_group_id COLLATE "C"=${groups.id} COLLATE "C" AND COALESCE(a.is_broken,false))`;
    // Legacy filters include persisted group broken state, but exported group
    // status is recomputed from children, including empty groups becoming normal.
    const filterBroken = sql`(COALESCE(${
      groups.isBroken
    },false) OR EXISTS(SELECT 1 FROM ${asins} a WHERE ${equal(
      sql`a.variant_group_id`,
      groups.id,
    )} AND COALESCE(a.is_broken,false)))`;
    const filter =
      and(
        query.keyword
          ? or(
              like(groups.name, query.keyword),
              like(groups.id, query.keyword),
              sql`EXISTS (SELECT 1 FROM ${asins} a WHERE ${equal(
                sql`a.variant_group_id`,
                groups.id,
              )} AND ${like(sql`a.asin`, query.keyword)})`,
            )
          : undefined,
        query.country ? equal(groups.country, query.country) : undefined,
        query.variantStatus
          ? query.variantStatus === 'BROKEN'
            ? filterBroken
            : sql`NOT ${filterBroken}`
          : undefined,
      ) ?? sql`true`;
    const next = after
      ? after.createTime === null
        ? sql`${groups.createTime} IS NULL AND ${groups.id} COLLATE "C" < ${after.id}`
        : sql`(${groups.createTime}<${after.createTime}::timestamp OR ${groups.createTime} IS NULL OR (${groups.createTime}=${after.createTime}::timestamp AND ${groups.id} COLLATE "C"<${after.id}))`
      : sql`true`;
    this.ensure();
    const rows = await this.db
      .select({
        ...getTableColumns(groups),
        exportCursorTime: sql<string | null>`${groups.createTime}::text`,
        exportIsBroken: sql<boolean>`${childMatch}`,
        total: includeTotal
          ? sql<string>`(SELECT count(*)::text FROM ${groups} WHERE ${filter})`
          : sql<string>`'0'`,
      })
      .from(groups)
      .where(and(filter, next))
      .orderBy(
        sql`${groups.createTime} DESC NULLS LAST`,
        sql`${groups.id} COLLATE "C" DESC`,
      )
      .limit(query.pageSize);
    this.ensure();
    if (Buffer.byteLength(JSON.stringify(rows)) > 8 * 1024 * 1024)
      throw new CompetitorQueryError('capacity');
    return {
      groups: rows.map(
        ({ total: _total, ...row }) =>
          ({
            ...emptyManual,
            ...row,
            isCompetitor: true,
            exportHasAutoBroken: row.exportIsBroken,
            exportHasManualBroken: false,
          } as VariantGroup & {
            exportCursorTime: string | null;
            exportIsBroken: boolean;
          }),
      ),
      asins: [],
      total: includeTotal && rows.length ? count(rows[0]!.total) : 0,
      totalASINs: 0,
    };
  }
  async listExportChildrenPage(
    ids: readonly string[],
    after?: AsinExportChildrenCursor,
  ) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > MAX_ASIN_EXPORT_GROUP_PAGE_SIZE ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !isNeoCatalogId(id))
    )
      throw new CompetitorQueryError('input');
    cursor(after);
    const position = after ? ids.indexOf(after.groupId) : -1;
    if (after && position < 0) throw new CompetitorQueryError('input');
    const selected = sql.join(
      ids.map((id, i) => sql`(${id}::text,${i}::integer)`),
      sql`, `,
    );
    const next = after
      ? sql`selected.ordinal>${position} OR (selected.ordinal=${position} AND ${
          after.createTime === null
            ? sql`((a.create_time IS NULL AND a.id COLLATE "C">${after.id}) OR a.create_time IS NOT NULL)`
            : sql`(a.create_time>${after.createTime}::timestamp OR (a.create_time=${after.createTime}::timestamp AND a.id COLLATE "C">${after.id}))`
        })`
      : sql`true`;
    this.ensure();
    const result = await this.db.execute(sql`
      WITH selected(id,ordinal) AS (VALUES ${selected})
      SELECT a.*,selected.id AS export_group_id,a.create_time::text AS export_cursor_time
      FROM ${asins} a JOIN selected ON a.variant_group_id=selected.id AND a.variant_group_id COLLATE "C"=selected.id COLLATE "C"
      WHERE ${next} ORDER BY selected.ordinal,a.create_time ASC NULLS FIRST,a.id COLLATE "C" ASC LIMIT ${MAX_ASIN_QUERY_CHILDREN}
    `);
    this.ensure();
    if (
      result.rows.length > MAX_ASIN_QUERY_CHILDREN ||
      Buffer.byteLength(JSON.stringify(result.rows)) > 16 * 1024 * 1024
    )
      throw new CompetitorQueryError('capacity');
    let previous = after;
    return result.rows.map((raw: Record<string, unknown>) => {
      if (
        typeof raw.export_group_id !== 'string' ||
        typeof raw.id !== 'string' ||
        (raw.export_cursor_time !== null &&
          typeof raw.export_cursor_time !== 'string')
      )
        throw new CompetitorQueryError('result');
      const next = {
        groupId: raw.export_group_id,
        id: raw.id,
        createTime: raw.export_cursor_time as string | null,
      };
      cursor(next);
      if (previous) {
        const ordinal = ids.indexOf(next.groupId),
          before = ids.indexOf(previous.groupId);
        if (
          !(
            ordinal > before ||
            (ordinal === before &&
              (previous.createTime === null
                ? next.createTime !== null ||
                  Buffer.compare(
                    Buffer.from(next.id),
                    Buffer.from(previous.id),
                  ) > 0
                : next.createTime !== null &&
                  (next.createTime > previous.createTime ||
                    (next.createTime === previous.createTime &&
                      Buffer.compare(
                        Buffer.from(next.id),
                        Buffer.from(previous.id),
                      ) > 0))))
          )
        )
          throw new CompetitorQueryError('result');
      }
      previous = next;
      const row = Object.fromEntries(
        Object.entries(getTableColumns(asins)).map(([key, column]) => {
          if (!Object.hasOwn(raw, column.name))
            throw new CompetitorQueryError('result');
          return [
            key,
            raw[column.name] === null
              ? null
              : column.mapFromDriverValue(raw[column.name]),
          ];
        }),
      ) as typeof asins.$inferSelect;
      return {
        ...emptyManual,
        ...row,
        variantGroupId: next.groupId,
        exportCursorTime: next.createTime,
      } as Asin & { exportCursorTime: string | null };
    });
  }
}
