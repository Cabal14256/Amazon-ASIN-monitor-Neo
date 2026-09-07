import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  addBatchAsinFailure,
  addBatchAsinSuccess,
  ASIN_BATCH_CREATE_CHUNK_SIZE,
  batchAsinFitsStorage,
  batchAsinKey,
  batchCountry,
  batchDuplicateMessage,
  prepareBatchAsins,
  type BatchAsinItem,
} from '../domain/asin-batch-create';
import {
  asinManualHistory,
  groupManualHistory,
  manualActor,
  nextAsinManualState,
  type AsinManualFields,
  type GroupManualFields,
} from '../domain/asin-manual-history';
import {
  asins,
  monitorHistory,
  users,
  variantGroups,
  type Asin,
  type NewMonitorHistory,
  type VariantGroup,
} from '../schema';
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
  batchCreateAsins(items: unknown[]): Promise<BatchCreateAsinsData>;
  updateGroupManual(
    groupId: string,
    fields: GroupManualFields,
    operatorId: string,
  ): Promise<AsinGroupReadResult>;
  updateAsinManual(
    asinId: string,
    fields: AsinManualFields,
    operatorId: string,
  ): Promise<AsinWriteSnapshot>;
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
  async batchCreateAsins(raw: unknown[]): Promise<BatchCreateAsinsData> {
    const { result, items } = prepareBatchAsins(raw);
    if (!items.length) return result;
    const parentIds = items
      .map((item) => item.parentId!)
      .filter((id) => !id.includes('\0') && [...id].length <= 50);
    const groups = parentIds.length
      ? await this.lockGroups(parentIds)
      : new Map<string, VariantGroup>();
    const groupValid: BatchAsinItem[] = [];
    for (const item of items) {
      const group = groups.get(item.parentId!);
      if (!group) addBatchAsinFailure(result, item, '所属变体组不存在');
      else if (batchCountry(group.country) !== item.country)
        addBatchAsinFailure(
          result,
          item,
          `ASIN国家必须与所属变体组一致（${batchCountry(group.country)}）`,
        );
      else groupValid.push(item);
    }
    const existing = new Set<string>();
    for (
      let offset = 0;
      offset < groupValid.length;
      offset += ASIN_BATCH_CREATE_CHUNK_SIZE
    ) {
      this.ensureOpen();
      const chunk = groupValid.slice(
        offset,
        offset + ASIN_BATCH_CREATE_CHUNK_SIZE,
      );
      const rows = await this.db
        .select({ asin: asins.asin, country: asins.country })
        .from(asins)
        .where(
          sql`(lower(${asins.asin}), lower(${asins.country})) IN (${sql.join(
            chunk.map(
              (item) => sql`(lower(${item.asin}), lower(${item.country}))`,
            ),
            sql`,`,
          )})`,
        );
      rows.forEach((row) =>
        existing.add(
          batchAsinKey({
            asin: batchCountry(row.asin),
            country: batchCountry(row.country),
          }),
        ),
      );
    }
    const candidates: BatchAsinItem[] = [];
    for (const item of groupValid) {
      if (existing.has(batchAsinKey(item)))
        addBatchAsinFailure(result, item, batchDuplicateMessage(item));
      else candidates.push(item);
    }
    // Stable unique-key order also serializes overlapping batches in different
    // parent groups. Public results retain their original validation phase order.
    const sorted = [...candidates].sort((left, right) =>
      batchAsinKey(left) < batchAsinKey(right)
        ? -1
        : batchAsinKey(left) > batchAsinKey(right)
        ? 1
        : 0,
    );
    const created = new Set<string>();
    const failed = new Map<string, string>();
    for (
      let offset = 0;
      offset < sorted.length;
      offset += ASIN_BATCH_CREATE_CHUNK_SIZE
    ) {
      const chunk = sorted.slice(offset, offset + ASIN_BATCH_CREATE_CHUNK_SIZE);
      const valid = chunk.filter((item) => {
        if (batchAsinFitsStorage(item)) return true;
        failed.set(item.id, '创建失败');
        return false;
      });
      if (!valid.length) continue;
      try {
        await this.insertBatchWithSavepoint(valid);
        valid.forEach((item) => created.add(item.id));
      } catch (error) {
        if (!recoverableBatchRowError(error)) throw error;
        for (const item of valid) {
          try {
            await this.insertBatchWithSavepoint([item]);
            created.add(item.id);
          } catch (rowError) {
            if (!recoverableBatchRowError(rowError)) throw rowError;
            failed.set(
              item.id,
              duplicateAsin(rowError)
                ? batchDuplicateMessage(item)
                : '创建失败',
            );
          }
        }
      }
    }
    this.ensureOpen();
    const createdItems = candidates.filter((item) => created.has(item.id));
    const touched = [...new Set(createdItems.map((item) => item.parentId!))];
    if (touched.length)
      await this.db
        .update(variantGroups)
        .set({ updateTime: now })
        .where(inArray(variantGroups.id, touched));
    this.ensureOpen();
    for (const item of candidates) {
      const message = failed.get(item.id);
      if (message) addBatchAsinFailure(result, item, message);
    }
    createdItems.forEach((item) => addBatchAsinSuccess(result, item));
    return result;
  }
  private async insertBatchWithSavepoint(items: BatchAsinItem[]) {
    this.ensureOpen();
    await this.db.execute(sql`SAVEPOINT asin_batch_row`);
    try {
      await this.db.insert(asins).values(
        items.map((item) => ({
          id: item.id,
          asin: item.asin,
          name: item.name,
          asinType: item.asinType,
          country: item.country,
          site: item.site!,
          brand: item.brand!,
          variantGroupId: item.parentId!,
          isBroken: false,
          variantStatus: 'NORMAL',
          createTime: now,
          updateTime: now,
        })),
      );
      this.ensureOpen();
      await this.db.execute(sql`RELEASE SAVEPOINT asin_batch_row`);
    } catch (error) {
      this.ensureOpen();
      // PostgreSQL aborts the current statement scope on error. Recover before
      // classifying/falling back; a failed rollback itself aborts the whole batch.
      await this.db.execute(sql`ROLLBACK TO SAVEPOINT asin_batch_row`);
      await this.db.execute(sql`RELEASE SAVEPOINT asin_batch_row`);
      throw error;
    }
  }
  private async manualContext(operatorId: string) {
    this.ensureOpen();
    // authorizeAdministration already holds this current user's shared row lock.
    const [operator] = await this.db
      .select({
        realName: users.realName,
        username: users.username,
        id: users.id,
      })
      .from(users)
      .where(eq(users.id, operatorId));
    const clock = await this.db.execute<{ milliseconds: string }>(
      sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS milliseconds`,
    );
    this.ensureOpen();
    // Drizzle returns raw timestamp strings; epoch is independent of session TZ.
    const time = new Date(Number(clock.rows[0]?.milliseconds));
    if (!operator || !Number.isFinite(time.getTime()))
      throw new Error('Invalid manual operation context');
    return {
      actor: operator.realName || operator.username || operator.id,
      time,
    };
  }
  private async insertManualHistory(entries: Iterable<NewMonitorHistory>) {
    let batch: NewMonitorHistory[] = [];
    for (const entry of entries) {
      batch.push(entry);
      if (batch.length === 500) {
        this.ensureOpen();
        await this.db.insert(monitorHistory).values(batch);
        batch = [];
      }
    }
    this.ensureOpen();
    if (batch.length) await this.db.insert(monitorHistory).values(batch);
    this.ensureOpen();
  }
  async updateGroupManual(
    groupId: string,
    fields: GroupManualFields,
    operatorId: string,
  ) {
    if (!(await this.lockGroups([groupId])).has(groupId))
      throw new AsinWriteRepositoryError('group-not-found');
    // Read the bounded complete before-state under the parent lock before mutation.
    const previous = await this.detail(groupId);
    const { actor, time } = await this.manualContext(operatorId);
    await this.db
      .update(variantGroups)
      .set({
        manualBroken: fields.markedBroken,
        manualBrokenReason: fields.markedBroken ? fields.reason || null : null,
        manualBrokenUpdatedAt: fields.markedBroken ? time : null,
        manualBrokenUpdatedBy: fields.markedBroken ? manualActor(actor) : null,
        updateTime: now,
      })
      .where(eq(variantGroups.id, groupId));
    this.ensureOpen();
    if (!fields.markedBroken) {
      await this.db
        .update(asins)
        .set({
          manualExcludedFromGroup: false,
          manualExcludedReason: null,
          manualExcludedUpdatedAt: null,
          manualExcludedUpdatedBy: null,
          updateTime: now,
        })
        .where(
          and(
            eq(asins.variantGroupId, groupId),
            eq(asins.manualExcludedFromGroup, true),
          ),
        );
      this.ensureOpen();
    }
    const current = await this.detail(groupId);
    await this.insertManualHistory(
      groupManualHistory(previous, current, fields, time, actor),
    );
    return current;
  }
  async updateAsinManual(
    asinId: string,
    fields: AsinManualFields,
    operatorId: string,
  ) {
    const { asin: previous, groups } = await this.lockAsin(asinId);
    const group = groups.get(previous.variantGroupId)!;
    const { actor, time } = await this.manualContext(operatorId);
    await this.db
      .update(asins)
      .set({
        ...nextAsinManualState(previous, fields, time, actor),
        updateTime: now,
      })
      .where(eq(asins.id, asinId));
    this.ensureOpen();
    await this.db
      .update(variantGroups)
      .set({ updateTime: now })
      .where(eq(variantGroups.id, group.id));
    const current = await this.snapshot(asinId);
    await this.insertManualHistory([
      asinManualHistory(previous, current.asin, group, fields, time, actor),
    ]);
    return current;
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
function recoverableBatchRowError(error: unknown): boolean {
  let current = error;
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
      return true;
    current = value.cause;
  }
  // Connection, timeout, resource and transaction/deadlock failures abort all.
  return false;
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
