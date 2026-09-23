import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { and, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Db } from '../client';
import { type BatchAsinItem } from '../domain/asin-batch-create';
import { competitorVariantGroups as groups } from '../schema-competitor';
import {
  AsinImportRepositoryError,
  type ImportChunkResult,
  type ImportRepositoryPort,
  type ImportWriteUnit,
} from './asin-import-repository';
import { CompetitorBatchCreateUnit } from './competitor-batch-create-unit';
import {
  CompetitorTransactionError,
  PgCompetitorTransactions,
} from './competitor-transactions';
import { prepareCompetitorWrites } from './competitor-write-policy';

const now = sql`statement_timestamp() AT TIME ZONE 'Asia/Shanghai'`;

class DrizzleCompetitorImportUnit {
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
  async findOrCreateImportGroup(fields: {
    name: string;
    country: string;
    site: string;
    brand: string;
  }): Promise<string> {
    if (
      fields.site !== '' ||
      [
        [fields.name, 255],
        [fields.country, 10],
        [fields.brand, 100],
      ].some(
        ([value, length]) =>
          typeof value !== 'string' ||
          !value ||
          value.includes('\0') ||
          [...value].length > (length as number),
      )
    )
      throw new AsinImportRepositoryError('invalid-group');
    // Legacy import reuses a matching group. Serialize find/create in this
    // isolated database so concurrent imports do not create the same group.
    await this.query(() =>
      this.db.execute(sql`SELECT pg_advisory_xact_lock(1095977296, 1)`),
    );
    const [existing] = await this.query(() =>
      this.db
        .select({ id: groups.id })
        .from(groups)
        .where(
          and(
            sql`rtrim(${groups.name}) COLLATE public.neo_competitor_query_ci = rtrim(${fields.name})`,
            sql`rtrim(${groups.country}) COLLATE public.neo_competitor_query_ci = rtrim(${fields.country})`,
            sql`rtrim(${groups.brand}) COLLATE public.neo_competitor_query_ci = rtrim(${fields.brand})`,
          ),
        )
        .orderBy(desc(groups.createTime), desc(groups.id))
        .limit(1)
        .for('update'),
    );
    if (existing) return existing.id;
    const id = randomUUID();
    try {
      await this.query(() =>
        this.db.insert(groups).values({
          id,
          name: fields.name,
          country: fields.country,
          brand: fields.brand,
          isBroken: false,
          variantStatus: 'NORMAL',
          feishuNotifyEnabled: false,
          createTime: now,
          updateTime: now,
        }),
      );
    } catch (error) {
      let current: unknown = error;
      for (
        let depth = 0;
        depth < 3 && current && typeof current === 'object';
        depth++
      ) {
        const value = current as { code?: unknown; cause?: unknown };
        if (
          typeof value.code === 'string' &&
          /^(?:22|23)[A-Z0-9]{3}$|^P0001$/.test(value.code)
        )
          throw new AsinImportRepositoryError('invalid-group');
        current = value.cause;
      }
      throw error;
    }
    return id;
  }
  async writeImportChunk(items: BatchAsinItem[]): Promise<ImportChunkResult> {
    if (!items.length || items.length > 1000)
      throw new AsinImportRepositoryError('capacity');
    const phases = new Map<
      number,
      ImportChunkResult['errors'][number]['phase']
    >();
    const result: BatchCreateAsinsData = {
      total: items.length,
      successCount: 0,
      failedCount: 0,
      results: [],
      errors: [],
    };
    await new CompetitorBatchCreateUnit(
      this.db,
      this.ensureOpen,
    ).createPrepared({ items, result }, (index, phase) =>
      phases.set(index, phase),
    );
    return {
      successCount: result.successCount,
      failedCount: result.failedCount,
      errors: result.errors.map((error) => {
        const phase = phases.get(error.index!);
        if (!phase) throw new Error('IMPORT_FAILURE_PHASE_MISSING');
        return { ...error, phase };
      }),
    };
  }
}

/** API calls first use the primary authorization unit; accepted Worker tasks
 * use the same bounded transaction transport without depending on a session. */
export class PgCompetitorImportRepository implements ImportRepositoryPort {
  private readonly transactions: PgCompetitorTransactions;
  constructor(primary: Pool, competitor: Pool) {
    this.transactions = new PgCompetitorTransactions(primary, competitor, 1);
  }
  transaction<T>(operation: (unit: ImportWriteUnit) => Promise<T>): Promise<T> {
    return this.transactions.run(
      false,
      async ({ authorization, database, ensureOpen }) => {
        let unit: Promise<DrizzleCompetitorImportUnit> | undefined,
          executed = false;
        const business = () =>
          (unit ??= (async () => {
            const db = await database();
            await prepareCompetitorWrites(db, ensureOpen);
            return new DrizzleCompetitorImportUnit(db, ensureOpen);
          })());
        const once = async <R>(
          action: (business: DrizzleCompetitorImportUnit) => Promise<R>,
        ) => {
          if (executed) throw new CompetitorTransactionError('capacity');
          executed = true;
          return action(await business());
        };
        return operation({
          ...authorization,
          findOrCreateImportGroup: (fields) =>
            once((unit) => unit.findOrCreateImportGroup(fields)),
          writeImportChunk: (items) =>
            once((unit) => unit.writeImportChunk(items)),
        });
      },
    );
  }
  close() {
    this.transactions.close();
  }
}
