import { asc, inArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  batchDeleteSyncResult,
  buildBatchDeleteAnalysis,
  parseBatchDeleteRequest,
  type BatchDeleteAnalysis,
  type BatchDeleteIds,
} from '../domain/asin-batch-delete';
import { asins, variantGroups } from '../schema';
import {
  DrizzleAsinQueryUnit,
  withAsinDatabaseTransaction,
} from './asin-query-repository';
import { prepareAsinTimestampWrites } from './asin-timestamp-policy';
import type { RoleWriteUnit } from './role-repository';

export interface AsinBatchDeleteUnit extends RoleWriteUnit {
  analyze(ids: BatchDeleteIds): Promise<BatchDeleteAnalysis>;
  execute(
    ids: BatchDeleteIds,
  ): Promise<ReturnType<typeof batchDeleteSyncResult>>;
}
export interface AsinBatchDeleteRepositoryPort {
  transaction<T>(
    operation: (unit: AsinBatchDeleteUnit) => Promise<T>,
  ): Promise<T>;
}
export class AsinBatchDeleteRepositoryError extends Error {
  constructor(
    readonly code: 'capacity' | 'parent-changed' | 'delete-mismatch',
  ) {
    super('ASIN batch deletion could not be completed');
  }
}
class DrizzleAsinBatchDeleteUnit
  extends DrizzleAsinQueryUnit
  implements AsinBatchDeleteUnit
{
  private async requestedAsins(ids: string[], lock = false) {
    if (!ids.length) return [];
    this.ensureOpen();
    const query = this.db
      .select({ id: asins.id, variantGroupId: asins.variantGroupId })
      .from(asins)
      .where(inArray(asins.id, ids))
      .orderBy(asc(asins.id));
    const rows = await (lock ? query.for('update') : query);
    this.ensureOpen();
    return rows;
  }
  private async groups(ids: string[], lock = false) {
    if (!ids.length) return [];
    this.ensureOpen();
    const query = this.db
      .select({ id: variantGroups.id })
      .from(variantGroups)
      .where(inArray(variantGroups.id, [...new Set(ids)]))
      .orderBy(asc(variantGroups.id));
    const rows = await (lock ? query.for('update') : query);
    this.ensureOpen();
    return rows.map((row) => row.id);
  }
  private async nestedCount(ids: string[]) {
    if (!ids.length) return 0;
    this.ensureOpen();
    const [row] = await this.db
      .select({ total: sql<string>`count(*)::text` })
      .from(asins)
      .where(inArray(asins.variantGroupId, ids));
    this.ensureOpen();
    const count = Number(row?.total);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid batch deletion count');
    return count;
  }
  async analyze(raw: BatchDeleteIds): Promise<BatchDeleteAnalysis> {
    const ids = parseBatchDeleteRequest(raw);
    const groups = await this.groups(ids.groupIds),
      rows = await this.requestedAsins(ids.asinIds);
    return buildBatchDeleteAnalysis(
      ids,
      groups,
      rows,
      await this.nestedCount(groups),
    );
  }
  async execute(raw: BatchDeleteIds) {
    const ids = parseBatchDeleteRequest(raw);
    const candidates = await this.requestedAsins(ids.asinIds);
    // All Neo business writers acquire group locks before child rows. Group
    // FOR UPDATE also blocks FK inserts, so nested deletion counts stay valid.
    const lockedGroups = new Set(
      await this.groups(
        [...ids.groupIds, ...candidates.map((row) => row.variantGroupId)],
        true,
      ),
    );
    const rows = await this.requestedAsins(ids.asinIds, true);
    const before = new Map(
      candidates.map((row) => [row.id, row.variantGroupId]),
    );
    if (
      rows.some(
        (row) =>
          before.get(row.id) !== row.variantGroupId ||
          !lockedGroups.has(row.variantGroupId),
      )
    )
      throw new AsinBatchDeleteRepositoryError('parent-changed');
    const groups = ids.groupIds.filter((id) => lockedGroups.has(id));
    const analysis = buildBatchDeleteAnalysis(
      ids,
      groups,
      rows,
      await this.nestedCount(groups),
    );
    if (analysis.directAsinIds.length) {
      this.ensureOpen();
      const removed = await this.db
        .delete(asins)
        .where(inArray(asins.id, analysis.directAsinIds))
        .returning({ id: asins.id });
      this.ensureOpen();
      if (removed.length !== analysis.deletedDirectAsinCount)
        throw new AsinBatchDeleteRepositoryError('delete-mismatch');
    }
    if (groups.length) {
      this.ensureOpen();
      const removed = await this.db
        .delete(variantGroups)
        .where(inArray(variantGroups.id, groups))
        .returning({ id: variantGroups.id });
      this.ensureOpen();
      if (removed.length !== analysis.deletedGroupCount)
        throw new AsinBatchDeleteRepositoryError('delete-mismatch');
    }
    if (analysis.directAsinGroupIds.length) {
      this.ensureOpen();
      await this.db
        .update(variantGroups)
        .set({
          updateTime: sql`statement_timestamp() AT TIME ZONE 'Asia/Shanghai'`,
        })
        .where(inArray(variantGroups.id, analysis.directAsinGroupIds));
      this.ensureOpen();
    }
    return batchDeleteSyncResult(analysis);
  }
}
export class PgAsinBatchDeleteRepository
  implements AsinBatchDeleteRepositoryPort
{
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async transaction<T>(
    operation: (unit: AsinBatchDeleteUnit) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 16) throw new AsinBatchDeleteRepositoryError('capacity');
    this.active++;
    try {
      return await withAsinDatabaseTransaction(
        this.pool,
        async (db, ensureOpen) => {
          await prepareAsinTimestampWrites(db, ensureOpen);
          return operation(new DrizzleAsinBatchDeleteUnit(db, ensureOpen));
        },
      );
    } finally {
      this.active--;
    }
  }
}
