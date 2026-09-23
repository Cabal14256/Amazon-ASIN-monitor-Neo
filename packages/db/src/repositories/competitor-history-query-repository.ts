import type { MonitorHistoryRecord } from '@asin-monitor/contracts';
import { and, sql, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import {
  type CompetitorHistoryReadQuery,
  validateCompetitorHistoryQuery,
} from '../domain/competitor-history-filters';
import {
  decodeCompetitorHistoryRow,
  mapCompetitorHistoryRecord,
} from '../domain/competitor-history-query';
import type { CompetitorQueryUnit } from '../domain/competitor-query';
import {
  MonitorHistoryQueryError,
  monitorHistorySafeCount,
} from '../domain/monitor-history-query';
import {
  competitorAsins,
  competitorMonitorHistory,
  competitorVariantGroups,
} from '../schema-competitor';
import {
  CompetitorTransactionError,
  PgCompetitorTransactions,
} from './competitor-transactions';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
type Authorization = Pick<
  CompetitorQueryUnit,
  'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
>;
export interface CompetitorHistoryQueryUnit extends Authorization {
  listHistory(query: CompetitorHistoryReadQuery): Promise<{
    list: (MonitorHistoryRecord & { parentAsin: string | null })[];
    total: number;
  }>;
  historyById(
    id: number,
  ): Promise<(MonitorHistoryRecord & { parentAsin: string | null }) | null>;
}
export interface CompetitorHistoryQueryRepositoryPort {
  read<T>(
    action: (unit: CompetitorHistoryQueryUnit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  close?(): void;
}

const comparison = (column: SQL) =>
  sql`rtrim(${column}) COLLATE public.neo_competitor_query_ci`;
const from = sql`FROM ${competitorMonitorHistory} AS mh
  LEFT JOIN ${competitorAsins} AS a
    ON ${comparison(sql`a.id`)}=rtrim(mh.asin_id)`;
function filters(query: CompetitorHistoryReadQuery): SQL {
  const conditions: SQL[] = [];
  const equal = (column: SQL, value?: string) => {
    if (value) conditions.push(sql`${comparison(column)}=rtrim(${value})`);
  };
  equal(sql`mh.variant_group_id`, query.variantGroupId);
  equal(sql`mh.asin_id`, query.asinId);
  if (query.asin)
    conditions.push(
      sql`public.neo_competitor_query_like(COALESCE(mh.asin_code,a.asin),${`%${query.asin}%`})`,
    );
  equal(sql`mh.country`, query.country);
  equal(sql`mh.check_type`, query.checkType);
  if (query.isBroken !== undefined)
    conditions.push(sql`mh.is_broken=${query.isBroken}`);
  if (query.startTime)
    conditions.push(sql`mh.check_time>=${query.startTime}::timestamp`);
  if (query.endTime)
    conditions.push(sql`mh.check_time<=${query.endTime}::timestamp`);
  return and(...conditions) ?? sql`true`;
}

class DrizzleCompetitorHistoryQueryUnit {
  constructor(
    private readonly db: Db,
    private readonly ensureOpen: () => void,
  ) {}
  listHistory(query: CompetitorHistoryReadQuery) {
    validateCompetitorHistoryQuery(query);
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
    if (result.total > 1) throw new MonitorHistoryQueryError('invalid-result');
    return result.list[0] ?? null;
  }
  private async select(where: SQL, limit: number, offset: number) {
    this.ensureOpen();
    const response = await this.db.execute(sql`
      WITH page_keys AS MATERIALIZED (
        SELECT mh.id,mh.check_time ${from} WHERE ${where}
        ORDER BY mh.check_time DESC,mh.id DESC LIMIT ${limit} OFFSET ${offset}
      ), size_bound AS MATERIALIZED (
        SELECT COALESCE(sum(16384::bigint + 2::bigint * COALESCE(octet_length(to_json(mh.check_result::text)::text),4)),0)::text AS bytes
        FROM ${competitorMonitorHistory} AS mh INNER JOIN page_keys p ON p.id=mh.id
      )
      SELECT (SELECT count(*)::text ${from} WHERE ${where}) AS total,
        size_bound.bytes,
        CASE WHEN size_bound.bytes::numeric<=${MAX_RESPONSE_BYTES} THEN (
          SELECT COALESCE(jsonb_agg(to_jsonb(record) ORDER BY record.check_time DESC,record.sort_id DESC),'[]'::jsonb)
          FROM (
            SELECT mh.id::text AS id,mh.id AS sort_id,mh.variant_group_id,
              COALESCE(mh.variant_group_name,vg.name) AS variant_group_name,
              mh.asin_id,mh.asin_code,COALESCE(mh.asin_name,a.name) AS asin_name,
              mh.check_type,mh.country,mh.is_broken,mh.check_time,
              mh.check_result::text AS check_result,mh.notification_sent,mh.create_time,
              COALESCE(mh.asin_code,a.asin) AS asin,parent.parent_asin
            FROM ${competitorMonitorHistory} AS mh
            INNER JOIN page_keys p ON p.id=mh.id
            LEFT JOIN ${competitorVariantGroups} AS vg
              ON ${comparison(sql`vg.id`)}=rtrim(mh.variant_group_id)
            LEFT JOIN ${competitorAsins} AS a
              ON ${comparison(sql`a.id`)}=rtrim(mh.asin_id)
            LEFT JOIN LATERAL (
              SELECT max(child.asin COLLATE public.neo_competitor_query_ci) AS parent_asin
              FROM ${competitorAsins} AS child
              WHERE ${comparison(
                sql`child.variant_group_id`,
              )}=rtrim(mh.variant_group_id)
                AND child.asin_type IN ('1','MAIN_LINK')
            ) AS parent ON true
          ) AS record
        ) ELSE NULL END AS records FROM size_bound
    `);
    this.ensureOpen();
    const row = response.rows[0];
    if (!row) throw new MonitorHistoryQueryError('invalid-result');
    if (monitorHistorySafeCount(row.bytes) > MAX_RESPONSE_BYTES)
      throw new MonitorHistoryQueryError('too-large');
    if (!Array.isArray(row.records) || row.records.length > limit)
      throw new MonitorHistoryQueryError('invalid-result');
    return {
      list: row.records.map((value) =>
        mapCompetitorHistoryRecord(decodeCompetitorHistoryRow(value)),
      ),
      total: monitorHistorySafeCount(row.total),
    };
  }
}

function translate(error: unknown): never {
  if (error instanceof CompetitorTransactionError)
    throw new MonitorHistoryQueryError(
      error.code === 'capacity' ? 'capacity' : 'invalid-result',
    );
  throw error;
}
export class PgCompetitorHistoryQueryRepository
  implements CompetitorHistoryQueryRepositoryPort
{
  private readonly transactions: PgCompetitorTransactions;
  constructor(primary: Pool, competitor: Pool) {
    try {
      this.transactions = new PgCompetitorTransactions(primary, competitor, 2);
    } catch (error) {
      translate(error);
    }
  }
  async read<T>(
    action: (unit: CompetitorHistoryQueryUnit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await this.transactions.run(
        true,
        async ({ authorization, database, ensureOpen }) => {
          let queried = false;
          const business = async () => {
            if (queried) throw new MonitorHistoryQueryError('capacity');
            queried = true;
            return new DrizzleCompetitorHistoryQueryUnit(
              await database(),
              ensureOpen,
            );
          };
          return action({
            ...authorization,
            listHistory: async (query) => (await business()).listHistory(query),
            historyById: async (id) => (await business()).historyById(id),
          });
        },
        signal,
      );
    } catch (error) {
      return translate(error);
    }
  }
  close() {
    this.transactions.close();
  }
}
