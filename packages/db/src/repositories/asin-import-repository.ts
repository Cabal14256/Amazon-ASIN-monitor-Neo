import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { and, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  MAX_ASIN_BATCH_CREATE_ITEMS,
  type BatchAsinItem,
} from '../domain/asin-batch-create';
import { variantGroups } from '../schema';
import { withAsinDatabaseTransaction } from './asin-query-repository';
import { prepareAsinTimestampWrites } from './asin-timestamp-policy';
import {
  DrizzleAsinWriteUnit,
  type AsinWriteUnit,
  type VariantGroupWriteFields,
} from './asin-write-repository';

export type ImportWritePhase = 'group' | 'existing' | 'write';
export interface ImportChunkResult {
  successCount: number;
  failedCount: number;
  errors: (BatchCreateAsinsData['errors'][number] & {
    phase: ImportWritePhase;
  })[];
}
export interface AsinImportUnit extends AsinWriteUnit {
  findOrCreateImportGroup(fields: VariantGroupWriteFields): Promise<string>;
  writeImportChunk(items: BatchAsinItem[]): Promise<ImportChunkResult>;
}
export interface AsinImportRepositoryPort {
  transaction<T>(operation: (unit: AsinImportUnit) => Promise<T>): Promise<T>;
}
export class AsinImportRepositoryError extends Error {
  constructor(readonly code: 'capacity' | 'invalid-group') {
    super('ASIN import could not be completed');
  }
}
class DrizzleAsinImportUnit
  extends DrizzleAsinWriteUnit
  implements AsinImportUnit
{
  async findOrCreateImportGroup(
    fields: VariantGroupWriteFields,
  ): Promise<string> {
    const checks = [
      [fields.name, 255],
      [fields.country, 10],
      [fields.site, 100],
      [fields.brand, 100],
    ] as const;
    if (
      checks.some(
        ([value, length]) =>
          typeof value !== 'string' ||
          !value ||
          value.includes('\0') ||
          [...value].length > length,
      )
    )
      throw new AsinImportRepositoryError('invalid-group');
    this.ensureOpen();
    // Serialize concurrent imports of the same logical group without adding a
    // uniqueness constraint: ordinary group CRUD historically allows duplicates.
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(1095977296, hashtext(jsonb_build_array(rtrim(${fields.name}::text), rtrim(${fields.country}::text), rtrim(${fields.site}::text), rtrim(${fields.brand}::text))::text COLLATE neo_import_group_ci))`,
    );
    this.ensureOpen();
    const [existing] = await this.db
      .select({ id: variantGroups.id })
      .from(variantGroups)
      .where(
        and(
          sql`rtrim(${variantGroups.name}) COLLATE neo_import_group_ci = rtrim(${fields.name})`,
          sql`rtrim(${variantGroups.country}) COLLATE neo_import_group_ci = rtrim(${fields.country})`,
          sql`rtrim(${variantGroups.site}) COLLATE neo_import_group_ci = rtrim(${fields.site})`,
          sql`rtrim(${variantGroups.brand}) COLLATE neo_import_group_ci = rtrim(${fields.brand})`,
        ),
      )
      .orderBy(desc(variantGroups.createTime), desc(variantGroups.id))
      .limit(1)
      .for('update');
    this.ensureOpen();
    if (existing) return existing.id;
    const id = randomUUID();
    const now = sql`statement_timestamp() AT TIME ZONE 'Asia/Shanghai'`;
    try {
      await this.db.insert(variantGroups).values({
        id,
        ...fields,
        isBroken: false,
        variantStatus: 'NORMAL',
        createTime: now,
        updateTime: now,
      });
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
    this.ensureOpen();
    return id;
  }
  async writeImportChunk(items: BatchAsinItem[]): Promise<ImportChunkResult> {
    if (!items.length || items.length > MAX_ASIN_BATCH_CREATE_ITEMS)
      throw new AsinImportRepositoryError('capacity');
    const phases = new Map<number, ImportWritePhase>();
    const result = await this.writePreparedAsins(
      {
        items,
        result: {
          total: items.length,
          successCount: 0,
          failedCount: 0,
          results: [],
          errors: [],
        },
      },
      (index, phase) => phases.set(index, phase),
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
export class PgAsinImportRepository implements AsinImportRepositoryPort {
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async transaction<T>(
    operation: (unit: AsinImportUnit) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 8) throw new AsinImportRepositoryError('capacity');
    this.active++;
    try {
      return await withAsinDatabaseTransaction(
        this.pool,
        async (db, ensureOpen) => {
          await prepareAsinTimestampWrites(db, ensureOpen);
          // 0004 takes table locks, so the 0005 rollback cannot race this probe
          // and silently switch comparison semantics during an import chunk.
          const collation = await db.execute(sql`
            SELECT count(*)::int AS installed FROM pg_catalog.pg_collation c
            JOIN pg_catalog.pg_class t ON t.oid=to_regclass('variant_groups')
            WHERE c.oid=to_regcollation('neo_import_group_ci')
              AND c.collnamespace=t.relnamespace AND c.collprovider='i'
              AND NOT c.collisdeterministic AND c.colliculocale='und-u-ks-level1'
              AND c.collversion=pg_catalog.pg_collation_actual_version(c.oid)
          `);
          ensureOpen();
          if (collation.rows[0]?.installed !== 1)
            throw new Error('Import group collation upgrade is required');
          return operation(new DrizzleAsinImportUnit(db, ensureOpen));
        },
      );
    } finally {
      this.active--;
    }
  }
}
