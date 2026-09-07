import { asc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { asins, variantGroups, type Asin, type VariantGroup } from '../schema';
import {
  DrizzleAsinQueryUnit,
  withAsinDatabaseTransaction,
  type AsinGroupReadResult,
  type AsinQueryUnit,
} from './asin-query-repository';
import { prepareAsinTimestampWrites } from './asin-timestamp-policy';

export interface VariantGroupWriteFields {
  name: string;
  country: string;
  site: string;
  brand: string;
}
export interface AsinWriteFields {
  asin: string;
  name: string | null;
  asinType: '1' | '2' | null;
  country: string;
  site: string;
  brand: string;
}
export interface AsinWriteSnapshot {
  asin: Asin;
  group: VariantGroup;
}
export interface AsinWriteUnit extends AsinQueryUnit {
  createGroup(fields: VariantGroupWriteFields): Promise<AsinGroupReadResult>;
  updateGroup(
    groupId: string,
    fields: VariantGroupWriteFields,
  ): Promise<AsinGroupReadResult>;
  createAsin(
    fields: AsinWriteFields & { parentId: string },
  ): Promise<AsinWriteSnapshot>;
  updateAsin(
    asinId: string,
    fields: AsinWriteFields,
  ): Promise<AsinWriteSnapshot>;
  moveAsin(asinId: string, targetGroupId: string): Promise<AsinWriteSnapshot>;
  deleteGroup(groupId: string): Promise<void>;
  deleteAsin(asinId: string): Promise<void>;
  updateGroupNotify(
    groupId: string,
    enabled: boolean,
  ): Promise<AsinGroupReadResult>;
  updateAsinNotify(
    asinId: string,
    enabled: boolean,
  ): Promise<AsinWriteSnapshot>;
}
export interface AsinWriteRepositoryPort {
  transaction<T>(operation: (unit: AsinWriteUnit) => Promise<T>): Promise<T>;
}
export class AsinWriteRepositoryError extends Error {
  constructor(
    readonly code:
      | 'capacity'
      | 'asin-not-found'
      | 'group-not-found'
      | 'duplicate'
      | 'parent-changed',
  ) {
    super('ASIN write could not be completed');
    this.name = 'AsinWriteRepositoryError';
  }
}
// Statements execute after business locks: an older waiting transaction must
// not restore an earlier transaction-start timestamp over a newer modification.
const now = sql`statement_timestamp() AT TIME ZONE 'Asia/Shanghai'`;
const groupFields = (value: VariantGroupWriteFields) => ({
  name: value.name,
  country: value.country,
  site: value.site,
  brand: value.brand,
});
const asinFields = (value: AsinWriteFields) => ({
  asin: value.asin,
  name: value.name,
  asinType: value.asinType,
  country: value.country,
  site: value.site,
  brand: value.brand,
});

class DrizzleAsinWriteUnit
  extends DrizzleAsinQueryUnit
  implements AsinWriteUnit
{
  private async lockGroups(ids: string[]): Promise<Map<string, VariantGroup>> {
    this.ensureOpen();
    const rows = await this.db
      .select()
      .from(variantGroups)
      .where(inArray(variantGroups.id, [...new Set(ids)]))
      .orderBy(asc(variantGroups.id))
      .for('update');
    this.ensureOpen();
    return new Map(rows.map((row) => [row.id, row]));
  }
  private async lockAsin(asinId: string, targetGroupId?: string) {
    this.ensureOpen();
    const [candidate] = await this.db
      .select({ parentId: asins.variantGroupId })
      .from(asins)
      .where(eq(asins.id, asinId));
    if (!candidate) throw new AsinWriteRepositoryError('asin-not-found');
    const groups = await this.lockGroups([
      candidate.parentId,
      ...(targetGroupId === undefined ? [] : [targetGroupId]),
    ]);
    if (
      !groups.has(candidate.parentId) ||
      (targetGroupId !== undefined && !groups.has(targetGroupId))
    )
      throw new AsinWriteRepositoryError('group-not-found');
    this.ensureOpen();
    const [asin] = await this.db
      .select()
      .from(asins)
      .where(eq(asins.id, asinId))
      .for('update');
    this.ensureOpen();
    if (!asin) throw new AsinWriteRepositoryError('asin-not-found');
    // Never acquire a different source group after locking in the original order.
    if (asin.variantGroupId !== candidate.parentId)
      throw new AsinWriteRepositoryError('parent-changed');
    return { asin, groups };
  }
  private async snapshot(asinId: string): Promise<AsinWriteSnapshot> {
    this.ensureOpen();
    const [result] = await this.db
      .select({ asin: asins, group: variantGroups })
      .from(asins)
      .innerJoin(variantGroups, eq(asins.variantGroupId, variantGroups.id))
      .where(eq(asins.id, asinId));
    this.ensureOpen();
    if (!result) throw new AsinWriteRepositoryError('asin-not-found');
    return result;
  }
  async deleteGroup(groupId: string) {
    if (!(await this.lockGroups([groupId])).has(groupId)) return;
    await this.db.delete(variantGroups).where(eq(variantGroups.id, groupId));
    this.ensureOpen();
  }
  async deleteAsin(asinId: string) {
    let parentId: string;
    try {
      parentId = (await this.lockAsin(asinId)).asin.variantGroupId;
    } catch (error) {
      if (error instanceof AsinWriteRepositoryError) {
        if (error.code === 'asin-not-found') return;
        if (error.code === 'group-not-found') {
          // The candidate parent may have been deleted with its children while
          // we waited. A still-existing ASIN has moved, so do not delete it or
          // touch its old parent without acquiring its new parent's lock.
          this.ensureOpen();
          const [remaining] = await this.db
            .select({ id: asins.id })
            .from(asins)
            .where(eq(asins.id, asinId));
          this.ensureOpen();
          if (!remaining) return;
          throw new AsinWriteRepositoryError('parent-changed');
        }
      }
      throw error;
    }
    await this.db.delete(asins).where(eq(asins.id, asinId));
    this.ensureOpen();
    await this.db
      .update(variantGroups)
      .set({ updateTime: now })
      .where(eq(variantGroups.id, parentId));
    this.ensureOpen();
  }
  async updateGroupNotify(groupId: string, enabled: boolean) {
    if (!(await this.lockGroups([groupId])).has(groupId))
      throw new AsinWriteRepositoryError('group-not-found');
    await this.db
      .update(variantGroups)
      .set({ feishuNotifyEnabled: enabled, updateTime: now })
      .where(eq(variantGroups.id, groupId));
    this.ensureOpen();
    return this.detail(groupId);
  }
  async updateAsinNotify(asinId: string, enabled: boolean) {
    await this.lockAsin(asinId);
    await this.db
      .update(asins)
      .set({ feishuNotifyEnabled: enabled, updateTime: now })
      .where(eq(asins.id, asinId));
    this.ensureOpen();
    return this.snapshot(asinId);
  }
  async createGroup(fields: VariantGroupWriteFields) {
    const id = randomUUID();
    this.ensureOpen();
    await this.db.insert(variantGroups).values({
      id,
      ...groupFields(fields),
      isBroken: false,
      variantStatus: 'NORMAL',
      createTime: now,
      updateTime: now,
    });
    this.ensureOpen();
    return this.detail(id);
  }
  async updateGroup(groupId: string, fields: VariantGroupWriteFields) {
    if (!(await this.lockGroups([groupId])).has(groupId))
      throw new AsinWriteRepositoryError('group-not-found');
    await this.db
      .update(variantGroups)
      .set({ ...groupFields(fields), updateTime: now })
      .where(eq(variantGroups.id, groupId));
    this.ensureOpen();
    return this.detail(groupId);
  }
  async createAsin(fields: AsinWriteFields & { parentId: string }) {
    if (!(await this.lockGroups([fields.parentId])).has(fields.parentId))
      throw new AsinWriteRepositoryError('group-not-found');
    const id = randomUUID();
    await this.db.insert(asins).values({
      id,
      ...asinFields(fields),
      variantGroupId: fields.parentId,
      isBroken: false,
      variantStatus: 'NORMAL',
      createTime: now,
      updateTime: now,
    });
    this.ensureOpen();
    await this.db
      .update(variantGroups)
      .set({ updateTime: now })
      .where(eq(variantGroups.id, fields.parentId));
    return this.snapshot(id);
  }
  async updateAsin(asinId: string, fields: AsinWriteFields) {
    await this.lockAsin(asinId);
    await this.db
      .update(asins)
      .set({ ...asinFields(fields), updateTime: now })
      .where(eq(asins.id, asinId));
    // Legacy edits do not advance the parent group's modification time.
    return this.snapshot(asinId);
  }
  async moveAsin(asinId: string, targetGroupId: string) {
    const { asin } = await this.lockAsin(asinId, targetGroupId);
    await this.db
      .update(asins)
      .set({ variantGroupId: targetGroupId, updateTime: now })
      .where(eq(asins.id, asinId));
    this.ensureOpen();
    await this.db
      .update(variantGroups)
      .set({ updateTime: now })
      .where(
        inArray(variantGroups.id, [
          ...new Set([asin.variantGroupId, targetGroupId]),
        ]),
      );
    return this.snapshot(asinId);
  }
}
function duplicateAsin(error: unknown): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === 'object';
    depth++
  ) {
    const value = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (
      value.code === '23505' &&
      typeof value.constraint === 'string' &&
      ['uk_asins_asin_country', 'uq_asins_asin_country_ci'].includes(
        value.constraint,
      )
    )
      return true;
    current = value.cause;
  }
  return false;
}
export class PgAsinWriteRepository implements AsinWriteRepositoryPort {
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async transaction<T>(
    operation: (unit: AsinWriteUnit) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 16) throw new AsinWriteRepositoryError('capacity');
    this.active++;
    try {
      return await withAsinDatabaseTransaction(
        this.pool,
        async (db, ensureOpen) => {
          await prepareAsinTimestampWrites(db, ensureOpen);
          return operation(new DrizzleAsinWriteUnit(db, ensureOpen));
        },
      );
    } catch (error) {
      if (duplicateAsin(error)) throw new AsinWriteRepositoryError('duplicate');
      throw error;
    } finally {
      this.active--;
    }
  }
}
