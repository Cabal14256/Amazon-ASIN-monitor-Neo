import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import type { Db } from '../client';
import { CompetitorQueryError } from '../domain/competitor-query';
import {
  CompetitorWriteError,
  type CompetitorAsinWriteFields,
  type CompetitorGroupWriteFields,
} from '../domain/competitor-write';
import {
  competitorAsins as a,
  competitorVariantGroups as g,
  type CompetitorAsin,
} from '../schema-competitor';
import { CompetitorBatchCreateUnit } from './competitor-batch-create-unit';
import { DrizzleCompetitorReadUnit } from './competitor-read-unit';

const ci = (left: unknown, right: unknown) =>
  sql`rtrim(${left}) COLLATE public.neo_competitor_query_ci = rtrim(${right})`;
const now = sql`statement_timestamp() AT TIME ZONE 'Asia/Shanghai'`;
const source = alias(a, 'source_child');
function text(
  value: unknown,
  max: number,
  required = true,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > max * 2 ||
    [...value].length > max ||
    /[\x00-\x1f\x7f]/.test(value) ||
    (required && !value.trim())
  )
    throw new CompetitorWriteError('input');
}
function groupFields(value: CompetitorGroupWriteFields) {
  text(value.name, 255);
  text(value.country, 10);
  text(value.brand, 100);
  if (value.country !== value.country.trim().toUpperCase())
    throw new CompetitorWriteError('input');
}
function asinFields(value: CompetitorAsinWriteFields) {
  text(value.asin, 20);
  text(value.country, 10);
  text(value.brand, 100);
  if (value.name !== null) text(value.name, 500, false);
  if (
    ![null, '1', '2'].includes(value.asinType) ||
    value.asin !== value.asin.trim().toUpperCase() ||
    value.country !== value.country.trim().toUpperCase()
  )
    throw new CompetitorWriteError('input');
}
const invalid = (message: string): never => {
  throw new CompetitorWriteError('validation', message);
};

/** All mutations run after current primary authorization in one competitor
 * transaction. Lock parents in one deterministic order, then affected children. */
export class DrizzleCompetitorWriteUnit {
  private readonly reader: DrizzleCompetitorReadUnit;
  constructor(
    private readonly db: Db,
    private readonly ensureOpen: () => void,
  ) {
    this.reader = new DrizzleCompetitorReadUnit(db, ensureOpen);
  }
  private async query<T>(action: () => PromiseLike<T>): Promise<T> {
    this.ensureOpen();
    const result = await action();
    this.ensureOpen();
    return result;
  }
  batchCreateAsins(items: unknown[]) {
    return new CompetitorBatchCreateUnit(this.db, this.ensureOpen).create(
      items,
    );
  }
  private async group(id: string, lock = true) {
    text(id, 50);
    const query = this.db.select().from(g).where(ci(g.id, id)).limit(2);
    const rows = await this.query(() => (lock ? query.for('update') : query));
    if (rows.length > 1) throw new CompetitorQueryError('result');
    return rows[0];
  }
  private async asin(id: string, lock = false) {
    text(id, 50);
    const query = this.db.select().from(a).where(ci(a.id, id)).limit(2);
    const rows = await this.query(() => (lock ? query.for('update') : query));
    if (rows.length > 1) throw new CompetitorQueryError('result');
    if (!rows[0]) throw new CompetitorWriteError('asin-not-found');
    return rows[0];
  }
  private async lockAsin(id: string, targetId?: string) {
    const candidate = await this.asin(id);
    const target =
      targetId === undefined ? undefined : await this.group(targetId, false);
    if (targetId !== undefined && !target) invalid('目标竞品变体组不存在');
    const ids = [
      ...new Set([candidate.variantGroupId, ...(target ? [target.id] : [])]),
    ];
    const groups = await this.query(() =>
      this.db
        .select()
        .from(g)
        .where(inArray(g.id, ids))
        .orderBy(sql`${g.id} COLLATE "C"`)
        .for('update'),
    );
    const asin = await this.asin(candidate.id, true);
    if (asin.variantGroupId !== candidate.variantGroupId)
      throw new CompetitorWriteError('parent-changed');
    const parent = groups.find((row) => row.id === asin.variantGroupId);
    if (!parent) invalid('所属竞品变体组不存在');
    const lockedTarget = target
      ? groups.find((row) => row.id === target.id)
      : undefined;
    if (target && !lockedTarget) invalid('目标竞品变体组不存在');
    return { asin, parent: parent!, target: lockedTarget };
  }
  private async checkDuplicate(
    fields: CompetitorAsinWriteFields,
    excludeId?: string,
  ) {
    const rows = await this.query(() =>
      this.db
        .select({ id: a.id })
        .from(a)
        .where(
          and(
            ci(a.asin, fields.asin),
            ci(a.country, fields.country),
            excludeId ? ne(a.id, excludeId) : undefined,
          ),
        )
        .limit(1),
    );
    if (rows.length)
      invalid(`ASIN ${fields.asin} 在国家 ${fields.country} 中已存在`);
  }
  private async touchGroups(ids: string[]) {
    await this.query(() =>
      this.db
        .update(g)
        .set({ updateTime: now })
        .where(inArray(g.id, [...new Set(ids)])),
    );
  }
  async deleteGroup(id: string) {
    const group = await this.group(id);
    if (!group) throw new CompetitorWriteError('group-not-found');
    // The real FK cascades children; monitor history has no FK and is retained.
    await this.query(() => this.db.delete(g).where(eq(g.id, group.id)));
  }
  async deleteAsin(id: string) {
    const { asin, parent } = await this.lockAsin(id);
    await this.query(() => this.db.delete(a).where(eq(a.id, asin.id)));
    await this.touchGroups([parent.id]);
  }
  async updateGroupNotify(id: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new CompetitorWriteError('input');
    const group = await this.group(id);
    if (!group) throw new CompetitorWriteError('group-not-found');
    await this.query(() =>
      this.db
        .update(g)
        .set({ feishuNotifyEnabled: enabled, updateTime: now })
        .where(eq(g.id, group.id)),
    );
    // A bounded complete response is part of the transaction; an oversized
    // group must fail before COMMIT rather than leave an unreported mutation.
    return this.reader.detail(group.id);
  }
  async updateAsinNotify(id: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new CompetitorWriteError('input');
    const { asin } = await this.lockAsin(id);
    await this.query(() =>
      this.db
        .update(a)
        .set({ feishuNotifyEnabled: enabled, updateTime: now })
        .where(eq(a.id, asin.id)),
    );
    // Legacy notification changes do not touch the parent group's timestamp.
    return this.asin(asin.id);
  }
  async createGroup(fields: CompetitorGroupWriteFields) {
    groupFields(fields);
    const id = randomUUID();
    await this.query(() =>
      this.db.insert(g).values({
        id,
        ...fields,
        isBroken: false,
        variantStatus: 'NORMAL',
        feishuNotifyEnabled: false,
        createTime: now,
        updateTime: now,
      }),
    );
    return this.reader.detail(id);
  }
  async updateGroup(id: string, fields: CompetitorGroupWriteFields) {
    groupFields(fields);
    const group = await this.group(id);
    if (!group) throw new CompetitorWriteError('group-not-found');
    const children = await this.query(() =>
      this.db
        .select({ id: a.id })
        .from(a)
        .where(eq(a.variantGroupId, group.id))
        .orderBy(sql`${a.id} COLLATE "C"`)
        .limit(5001)
        .for('update'),
    );
    if (children.length > 5000)
      throw new CompetitorQueryError('too-many-children');
    const countryChanged = group.country !== fields.country;
    if (countryChanged && children.length) {
      const conflicts = await this.query(() =>
        this.db
          .selectDistinct({ asin: a.asin })
          .from(a)
          .innerJoin(source, ci(a.asin, source.asin))
          .where(
            and(
              eq(source.variantGroupId, group.id),
              ne(a.variantGroupId, group.id),
              ci(a.country, fields.country),
            ),
          )
          .orderBy(a.asin)
          .limit(5),
      );
      if (conflicts.length)
        invalid(
          `变体组国家更新失败，目标国家已存在相同ASIN: ${conflicts
            .map((row) => row.asin)
            .join(', ')}`,
        );
    }
    await this.query(() =>
      this.db
        .update(g)
        .set({ ...fields, updateTime: now })
        .where(eq(g.id, group.id)),
    );
    if (countryChanged)
      await this.query(() =>
        this.db
          .update(a)
          .set({ country: fields.country, updateTime: now })
          .where(eq(a.variantGroupId, group.id)),
      );
    return this.reader.detail(group.id);
  }
  async createAsin(fields: CompetitorAsinWriteFields & { parentId: string }) {
    asinFields(fields);
    const parent = await this.group(fields.parentId);
    if (!parent) invalid('所属竞品变体组不存在');
    if (parent!.country !== fields.country)
      invalid(`ASIN国家必须与所属变体组一致（${parent!.country}）`);
    await this.checkDuplicate(fields);
    const id = randomUUID();
    const { parentId: _parentId, ...values } = fields;
    await this.query(() =>
      this.db.insert(a).values({
        id,
        ...values,
        variantGroupId: parent!.id,
        isBroken: false,
        variantStatus: 'NORMAL',
        feishuNotifyEnabled: false,
        createTime: now,
        updateTime: now,
      }),
    );
    await this.touchGroups([parent!.id]);
    return this.asin(id);
  }
  async updateAsin(id: string, fields: CompetitorAsinWriteFields) {
    asinFields(fields);
    const { asin, parent } = await this.lockAsin(id);
    if (parent.country !== fields.country)
      invalid(`ASIN国家必须与所属变体组一致（${parent.country}）`);
    await this.checkDuplicate(fields, asin.id);
    await this.query(() =>
      this.db
        .update(a)
        .set({ ...fields, updateTime: now })
        .where(eq(a.id, asin.id)),
    );
    await this.touchGroups([parent.id]);
    return this.asin(asin.id);
  }
  async moveAsin(id: string, targetGroupId: string): Promise<CompetitorAsin> {
    const { asin, target } = await this.lockAsin(id, targetGroupId);
    if (!target) invalid('目标竞品变体组不存在');
    if (target!.id === asin.variantGroupId) return asin;
    if (target!.country !== asin.country)
      invalid(
        `目标变体组国家为 ${target!.country}，与ASIN当前国家 ${
          asin.country
        } 不一致`,
      );
    await this.query(() =>
      this.db
        .update(a)
        .set({ variantGroupId: target!.id, updateTime: now })
        .where(eq(a.id, asin.id)),
    );
    await this.touchGroups([asin.variantGroupId, target!.id]);
    return this.asin(asin.id);
  }
}
