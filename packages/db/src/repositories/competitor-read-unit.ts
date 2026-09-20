import { and, getTableColumns, or, sql, type SQL } from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import {
  CompetitorQueryError,
  type CompetitorGroupQuery,
  type CompetitorGroupReadResult,
} from '../domain/competitor-query';
import { competitorAsins, competitorVariantGroups } from '../schema-competitor';

const MAX_CHILDREN = 5000;
const g = alias(competitorVariantGroups, 'g');
const a = alias(competitorAsins, 'a');
const child = alias(competitorAsins, 'state_child');
const equal = (left: unknown, right: unknown) =>
  sql`rtrim(${left}) COLLATE public.neo_competitor_query_ci = rtrim(${right})`;
const like = (column: unknown, keyword: string) =>
  sql`public.neo_competitor_query_like(${column}, ${`%${keyword}%`})`;
const parentBroken = sql`(COALESCE(${
  g.isBroken
},false) OR EXISTS(SELECT 1 FROM ${competitorAsins} AS state_child WHERE ${equal(
  child.variantGroupId,
  g.id,
)} AND COALESCE(${child.isBroken},false)))`;
const status = (value: SQL, selected?: 'BROKEN' | 'NORMAL') =>
  selected ? (selected === 'BROKEN' ? value : sql`NOT ${value}`) : undefined;
const count = (value: unknown) => {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '')
    throw new CompetitorQueryError('result');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new CompetitorQueryError('result');
  return result;
};
function hydrate<T extends PgTable>(
  table: T,
  value: unknown,
): T['$inferSelect'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CompetitorQueryError('result');
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => {
      if (!Object.hasOwn(input, column.name))
        throw new CompetitorQueryError('result');
      return [
        key,
        input[column.name] === null
          ? null
          : column.mapFromDriverValue(input[column.name]),
      ];
    }),
  ) as T['$inferSelect'];
}
function validate(query: CompetitorGroupQuery) {
  const offset = (query.current - 1) * query.pageSize;
  if (
    !Number.isSafeInteger(query.current) ||
    query.current < 1 ||
    !Number.isInteger(query.pageSize) ||
    query.pageSize < 1 ||
    query.pageSize > 100 ||
    !Number.isSafeInteger(offset) ||
    offset > 1_000_000 ||
    [query.keyword, query.country].some(
      (value) =>
        value !== undefined &&
        (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)),
    ) ||
    (query.keyword?.length ?? 0) > 200 ||
    (query.country?.length ?? 0) > 10 ||
    (query.variantStatus !== undefined &&
      !['BROKEN', 'NORMAL'].includes(query.variantStatus))
  )
    throw new CompetitorQueryError('input');
}
/** All counts, selected parents and complete children share one MVCC statement. */
export class DrizzleCompetitorReadUnit {
  constructor(private readonly db: Db, private readonly ensure: () => void) {}
  list(query: CompetitorGroupQuery) {
    return this.query(query);
  }
  detail(id: string) {
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      id.length > 100 ||
      [...id].length > 50 ||
      /[\x00-\x1f\x7f]/.test(id)
    )
      throw new CompetitorQueryError('input');
    return this.query({ current: 1, pageSize: 1 }, id);
  }
  private async query(
    query: CompetitorGroupQuery,
    id?: string,
  ): Promise<CompetitorGroupReadResult> {
    validate(query);
    const keyword = query.keyword
      ? or(
          like(g.name, query.keyword),
          like(g.id, query.keyword),
          like(a.asin, query.keyword),
        )
      : undefined;
    const groupWhere =
      id !== undefined
        ? equal(g.id, id)
        : and(
            query.keyword
              ? or(
                  like(g.name, query.keyword),
                  like(g.id, query.keyword),
                  sql`EXISTS(SELECT 1 FROM ${competitorAsins} AS a WHERE ${equal(
                    a.variantGroupId,
                    g.id,
                  )} AND ${like(a.asin, query.keyword)})`,
                )
              : undefined,
            query.country ? equal(g.country, query.country) : undefined,
            status(parentBroken, query.variantStatus),
          ) ?? sql`true`;
    const asinWhere =
      and(
        keyword,
        query.country ? equal(a.country, query.country) : undefined,
        status(sql`COALESCE(${a.isBroken},false)`, query.variantStatus),
      ) ?? sql`true`;
    const total =
      id === undefined
        ? sql`(SELECT count(*)::text FROM ${competitorVariantGroups} AS g WHERE ${groupWhere})`
        : sql`'0'`;
    const totalASINs =
      id === undefined
        ? sql`(SELECT count(*)::text FROM ${competitorAsins} AS a LEFT JOIN ${competitorVariantGroups} AS g ON ${equal(
            a.variantGroupId,
            g.id,
          )} WHERE ${asinWhere})`
        : sql`'0'`;
    const asinCount = sql`(SELECT count(*)::text FROM ${competitorAsins} AS a WHERE ${equal(
      a.variantGroupId,
      g.id,
    )} AND ${keyword ?? sql`true`})`;
    this.ensure();
    const result = await this.db.execute(sql`
      WITH selected AS MATERIALIZED (
        SELECT g.*, ${asinCount} AS asin_count FROM ${competitorVariantGroups} AS g WHERE ${groupWhere}
        ORDER BY ${g.createTime} DESC NULLS LAST, ${g.id} DESC
        LIMIT ${query.pageSize} OFFSET ${(query.current - 1) * query.pageSize}
      ), child_page AS MATERIALIZED (
        SELECT a.* FROM ${competitorAsins} AS a INNER JOIN selected p ON rtrim(a.variant_group_id) COLLATE public.neo_competitor_query_ci = rtrim(p.id)
        ORDER BY ${a.variantGroupId}, ${a.createTime} ASC NULLS FIRST, ${a.id}
        LIMIT ${MAX_CHILDREN + 1}
      )
      SELECT ${total} AS total, ${totalASINs} AS total_asins,
        COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.create_time DESC NULLS LAST,p.id DESC) FROM selected p),'[]'::jsonb) AS groups,
        COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.variant_group_id,c.create_time ASC NULLS FIRST,c.id) FROM child_page c),'[]'::jsonb) AS asins
    `);
    this.ensure();
    const payload = result.rows[0];
    if (
      !payload ||
      !Array.isArray(payload.groups) ||
      !Array.isArray(payload.asins) ||
      payload.groups.length > query.pageSize
    )
      throw new CompetitorQueryError('result');
    if (
      payload.asins.length > MAX_CHILDREN ||
      Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024 * 1024
    )
      throw new CompetitorQueryError('too-many-children');
    return {
      groups: payload.groups.map((value: Record<string, unknown>) => ({
        ...hydrate(competitorVariantGroups, value),
        ...(id === undefined ? { asinCount: count(value.asin_count) } : {}),
      })),
      asins: payload.asins.map((value) => hydrate(competitorAsins, value)),
      total: count(payload.total),
      totalASINs: count(payload.total_asins),
    };
  }
}
