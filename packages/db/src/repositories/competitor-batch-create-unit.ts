import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  ASIN_BATCH_CREATE_CHUNK_SIZE,
  addBatchAsinFailure,
  addBatchAsinSuccess,
  batchAsinFitsStorage,
  batchAsinKey,
  batchCountry,
  batchDuplicateMessage,
  prepareCompetitorBatchAsins,
  type BatchAsinItem,
} from '../domain/asin-batch-create';
import {
  competitorAsins as a,
  competitorVariantGroups as g,
} from '../schema-competitor';
import {
  duplicateCompetitorAsin,
  recoverableCompetitorBatchError,
} from './competitor-write-errors';

const now = sql`statement_timestamp() AT TIME ZONE 'Asia/Shanghai'`;

/** Runs inside the existing authorized, bounded competitor write transaction. */
export class CompetitorBatchCreateUnit {
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

  async create(raw: unknown[]): Promise<BatchCreateAsinsData> {
    const { result, items } = prepareCompetitorBatchAsins(raw);
    if (!items.length) return result;
    const parentIds = [...new Set(items.map((item) => item.parentId!))].filter(
      (id) => !id.includes('\0') && [...id].length <= 50,
    );
    const rows = parentIds.length
      ? await this.query(() =>
          this.db
            .select({ id: g.id, country: g.country })
            .from(g)
            .where(
              sql`rtrim(${
                g.id
              }) COLLATE public.neo_competitor_query_ci = ANY(${sql.param(
                parentIds,
              )}::text[])`,
            )
            .orderBy(sql`${g.id} COLLATE "C"`)
            .for('update'),
        )
      : [];
    // Legacy's IN query is case/accent insensitive; its subsequent Map lookup is
    // exact. Preserve that batch-specific behavior instead of rewriting parent IDs.
    const groups = new Map(rows.map((row) => [row.id, row.country]));
    const groupValid: BatchAsinItem[] = [];
    for (const item of items) {
      if (!groups.has(item.parentId!))
        addBatchAsinFailure(result, item, '所属变体组不存在');
      else if (batchCountry(groups.get(item.parentId!)) !== item.country)
        addBatchAsinFailure(
          result,
          item,
          `ASIN国家必须与所属变体组一致（${batchCountry(
            groups.get(item.parentId!),
          )}）`,
        );
      else groupValid.push(item);
    }
    const existing = new Set<string>();
    for (
      let offset = 0;
      offset < groupValid.length;
      offset += ASIN_BATCH_CREATE_CHUNK_SIZE
    ) {
      const chunk = groupValid.slice(
        offset,
        offset + ASIN_BATCH_CREATE_CHUNK_SIZE,
      );
      const found = await this.query(() =>
        this.db.select({ asin: a.asin, country: a.country }).from(a)
          .where(sql`(rtrim(${a.asin}) COLLATE public.neo_competitor_query_ci,
                    rtrim(${
                      a.country
                    }) COLLATE public.neo_competitor_query_ci) IN (${sql.join(
          chunk.map((item) => sql`(${item.asin}, ${item.country})`),
          sql`,`,
        )})`),
      );
      for (const row of found)
        existing.add(
          batchAsinKey({
            asin: batchCountry(row.asin),
            country: batchCountry(row.country),
          }),
        );
    }
    const candidates: BatchAsinItem[] = [];
    for (const item of groupValid) {
      if (existing.has(batchAsinKey(item)))
        addBatchAsinFailure(result, item, batchDuplicateMessage(item));
      else candidates.push(item);
    }
    if (!candidates.length) return result;
    // Lock unique keys in database collation order across batches. Equivalent
    // keys retain original input priority, as in Legacy's per-row fallback.
    const order = await this.query(() =>
      this.db.execute(sql`
      SELECT ordinal FROM unnest(${sql.param(
        candidates.map((item) => item.asin),
      )}::text[],
        ${sql.param(candidates.map((item) => item.country))}::text[],
        ${sql.param(
          candidates.map((item) => item.index),
        )}::int[]) AS candidate(asin,country,ordinal)
      ORDER BY rtrim(asin) COLLATE public.neo_competitor_query_ci,
        rtrim(country) COLLATE public.neo_competitor_query_ci, ordinal
    `),
    );
    const byIndex = new Map(candidates.map((item) => [item.index, item]));
    const sorted = order.rows.map((row) => byIndex.get(Number(row.ordinal))!);
    const created = new Set<string>();
    const failed = new Map<string, string>();
    for (
      let offset = 0;
      offset < sorted.length;
      offset += ASIN_BATCH_CREATE_CHUNK_SIZE
    ) {
      const chunk = sorted
        .slice(offset, offset + ASIN_BATCH_CREATE_CHUNK_SIZE)
        .filter((item) => {
          if (batchAsinFitsStorage(item, false)) return true;
          failed.set(item.id, '创建失败');
          return false;
        });
      if (!chunk.length) continue;
      try {
        await this.insert(chunk);
        chunk.forEach((item) => created.add(item.id));
      } catch (error) {
        if (!recoverableCompetitorBatchError(error)) throw error;
        for (const item of chunk) {
          try {
            await this.insert([item]);
            created.add(item.id);
          } catch (rowError) {
            if (!recoverableCompetitorBatchError(rowError)) throw rowError;
            failed.set(
              item.id,
              duplicateCompetitorAsin(rowError)
                ? batchDuplicateMessage(item)
                : '创建失败',
            );
          }
        }
      }
    }
    const createdItems = candidates.filter((item) => created.has(item.id));
    const touched = [...new Set(createdItems.map((item) => item.parentId!))];
    if (touched.length)
      await this.query(() =>
        this.db
          .update(g)
          .set({ updateTime: now })
          .where(inArray(g.id, touched)),
      );
    for (const item of candidates) {
      const message = failed.get(item.id);
      if (message) addBatchAsinFailure(result, item, message);
    }
    createdItems.forEach((item) => addBatchAsinSuccess(result, item));
    return result;
  }

  private async insert(items: BatchAsinItem[]) {
    await this.query(() =>
      this.db.execute(sql`SAVEPOINT competitor_batch_row`),
    );
    try {
      await this.query(() =>
        this.db.insert(a).values(
          items.map((item) => ({
            id: item.id,
            asin: item.asin,
            name: item.name,
            asinType: item.asinType,
            country: item.country,
            brand: item.brand!,
            variantGroupId: item.parentId!,
            isBroken: false,
            variantStatus: 'NORMAL',
            feishuNotifyEnabled: false,
            createTime: now,
            updateTime: now,
          })),
        ),
      );
      await this.query(() =>
        this.db.execute(sql`RELEASE SAVEPOINT competitor_batch_row`),
      );
    } catch (error) {
      await this.query(() =>
        this.db.execute(sql`ROLLBACK TO SAVEPOINT competitor_batch_row`),
      );
      await this.query(() =>
        this.db.execute(sql`RELEASE SAVEPOINT competitor_batch_row`),
      );
      throw error;
    }
  }
}
