import { inArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import {
  batchDeleteSyncResult,
  buildBatchDeleteAnalysis,
  parseBatchDeleteRequest,
  type BatchDeleteExecutionUnit,
  type BatchDeleteIds,
} from '../domain/asin-batch-delete';
import type { CompetitorQueryUnit } from '../domain/competitor-query';
import {
  competitorAsins as a,
  competitorVariantGroups as g,
} from '../schema-competitor';
import { AsinBatchDeleteRepositoryError } from './asin-batch-delete-repository';
import {
  CompetitorTransactionError,
  PgCompetitorTransactions,
} from './competitor-transactions';
import { prepareCompetitorWrites } from './competitor-write-policy';

export interface CompetitorBatchDeleteUnit
  extends BatchDeleteExecutionUnit,
    Pick<
      CompetitorQueryUnit,
      'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
    > {}
export interface CompetitorBatchDeleteRepositoryPort {
  transaction<T>(
    operation: (unit: CompetitorBatchDeleteUnit) => Promise<T>,
  ): Promise<T>;
  close?(): void;
}

class DrizzleCompetitorBatchDeleteUnit implements BatchDeleteExecutionUnit {
  constructor(
    private readonly db: Db,
    private readonly ensureOpen: () => void,
  ) {}
  private async query<T>(action: () => PromiseLike<T>): Promise<T> {
    this.ensureOpen();
    const result = await action();
    this.ensureOpen();
    return result;
  }
  private async asins(ids: string[], lock = false) {
    if (!ids.length) return [];
    const query = this.db
      .select({ id: a.id, variantGroupId: a.variantGroupId })
      .from(a)
      .where(
        sql`rtrim(${
          a.id
        }) COLLATE public.neo_competitor_query_ci = ANY(${sql.param(
          ids,
        )}::text[])`,
      )
      .orderBy(sql`${a.id} COLLATE "C"`);
    const rows = await this.query(() => (lock ? query.for('update') : query));
    const exact = new Set(ids);
    // The actual Legacy service filters its CI SQL result through an exact Map.
    return rows.filter((row) => exact.has(row.id));
  }
  private async groups(ids: string[], lock = false) {
    if (!ids.length) return [];
    const query = this.db
      .select({ id: g.id })
      .from(g)
      .where(
        sql`rtrim(${
          g.id
        }) COLLATE public.neo_competitor_query_ci = ANY(${sql.param([
          ...new Set(ids),
        ])}::text[])`,
      )
      .orderBy(sql`${g.id} COLLATE "C"`);
    const rows = await this.query(() => (lock ? query.for('update') : query));
    const exact = new Set(ids);
    return rows.filter((row) => exact.has(row.id)).map((row) => row.id);
  }
  private async nested(ids: string[]) {
    if (!ids.length) return 0;
    const [row] = await this.query(() =>
      this.db
        .select({ total: sql<string>`count(*)::text` })
        .from(a)
        .where(inArray(a.variantGroupId, ids)),
    );
    const count = Number(row?.total);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid competitor deletion count');
    return count;
  }
  async analyze(raw: BatchDeleteIds) {
    const ids = parseBatchDeleteRequest(raw);
    const groups = await this.groups(ids.groupIds),
      rows = await this.asins(ids.asinIds);
    return buildBatchDeleteAnalysis(
      ids,
      groups,
      rows,
      await this.nested(groups),
      'competitor',
    );
  }
  async execute(raw: BatchDeleteIds) {
    const ids = parseBatchDeleteRequest(raw);
    const candidates = await this.asins(ids.asinIds);
    const locked = new Set(
      await this.groups(
        [...ids.groupIds, ...candidates.map((row) => row.variantGroupId)],
        true,
      ),
    );
    const rows = await this.asins(ids.asinIds, true);
    const before = new Map(
      candidates.map((row) => [row.id, row.variantGroupId]),
    );
    if (
      rows.some(
        (row) =>
          before.get(row.id) !== row.variantGroupId ||
          !locked.has(row.variantGroupId),
      )
    )
      throw new AsinBatchDeleteRepositoryError('parent-changed');
    const groups = ids.groupIds.filter((id) => locked.has(id));
    const analysis = buildBatchDeleteAnalysis(
      ids,
      groups,
      rows,
      await this.nested(groups),
      'competitor',
    );
    if (analysis.directAsinIds.length) {
      const removed = await this.query(() =>
        this.db
          .delete(a)
          .where(inArray(a.id, analysis.directAsinIds))
          .returning({ id: a.id }),
      );
      if (removed.length !== analysis.deletedDirectAsinCount)
        throw new AsinBatchDeleteRepositoryError('delete-mismatch');
    }
    if (groups.length) {
      const removed = await this.query(() =>
        this.db.delete(g).where(inArray(g.id, groups)).returning({ id: g.id }),
      );
      if (removed.length !== analysis.deletedGroupCount)
        throw new AsinBatchDeleteRepositoryError('delete-mismatch');
    }
    if (analysis.directAsinGroupIds.length)
      await this.query(() =>
        this.db
          .update(g)
          .set({
            updateTime: sql`statement_timestamp() AT TIME ZONE 'Asia/Shanghai'`,
          })
          .where(inArray(g.id, analysis.directAsinGroupIds)),
      );
    return batchDeleteSyncResult(analysis);
  }
}

/** API authorizes on the primary unit before business access. Accepted Workers
 * use the same bounded transport after verifying immutable task/lease identity. */
export class PgCompetitorBatchDeleteRepository
  implements CompetitorBatchDeleteRepositoryPort
{
  private readonly transactions: PgCompetitorTransactions;
  constructor(primary: Pool, competitor: Pool, maximumOperations = 8) {
    this.transactions = new PgCompetitorTransactions(
      primary,
      competitor,
      maximumOperations,
    );
  }
  transaction<T>(operation: (unit: CompetitorBatchDeleteUnit) => Promise<T>) {
    return this.transactions.run(
      false,
      async ({ authorization, database, ensureOpen }) => {
        let unit: Promise<DrizzleCompetitorBatchDeleteUnit> | undefined,
          executed = false;
        const business = () =>
          (unit ??= (async () => {
            const db = await database();
            await prepareCompetitorWrites(db, ensureOpen);
            return new DrizzleCompetitorBatchDeleteUnit(db, ensureOpen);
          })());
        return operation({
          ...authorization,
          analyze: async (ids) => (await business()).analyze(ids),
          execute: async (ids) => {
            if (executed) throw new CompetitorTransactionError('capacity');
            executed = true;
            return (await business()).execute(ids);
          },
        });
      },
    );
  }
  close() {
    this.transactions.close();
  }
}
