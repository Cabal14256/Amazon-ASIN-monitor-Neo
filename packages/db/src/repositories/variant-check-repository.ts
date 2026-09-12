import {
  decodeCatalogVariantResult,
  decodeGroupCatalogResult,
  normalizeCountry,
  type CatalogVariantResult,
} from '@asin-monitor/sp-api';
import { asc, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  VariantCheckError,
  type AsinCheckObservation,
  type CheckCommitGuard,
  type CommittedGroupCheck,
  type CommittedSingleCheck,
  type GroupCheckSnapshot,
  type SingleCheckSnapshot,
  type VariantCheckRepositoryPort,
  type VariantCheckUnit,
} from '../domain/variant-check';
import { resolveAsinVariantStatus } from '../domain/variant-status';
import {
  asins,
  monitorHistory,
  variantGroups,
  type Asin,
  type VariantGroup,
} from '../schema';
import {
  DrizzleAsinQueryUnit,
  MAX_ASIN_QUERY_CHILDREN,
  withAsinDatabaseTransaction,
} from './asin-query-repository';
import { prepareAsinTimestampWrites } from './asin-timestamp-policy';

const equalTime = (a: Date | null, b: Date | null) =>
  a === null ? b === null : b !== null && a.getTime() === b.getTime();
function sameGroup(current: VariantGroup, expected: VariantGroup): boolean {
  return (
    current.id === expected.id &&
    current.country === expected.country &&
    equalTime(current.createTime, expected.createTime)
  );
}
function sameAsin(current: Asin, expected: Asin): boolean {
  return (
    current.id === expected.id &&
    current.asin === expected.asin &&
    current.country === expected.country &&
    current.variantGroupId === expected.variantGroupId &&
    equalTime(current.createTime, expected.createTime) &&
    equalTime(current.lastCheckTime, expected.lastCheckTime)
  );
}
const id = (value: string) => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 50 ||
    value.includes('\0')
  )
    throw new VariantCheckError('invalid-input');
};

export class DrizzleVariantCheckUnit
  extends DrizzleAsinQueryUnit
  implements VariantCheckUnit
{
  async loadGroup(groupId: string): Promise<GroupCheckSnapshot> {
    id(groupId);
    const snapshot = await this.detail(groupId);
    if (snapshot.groups.length !== 1)
      throw new VariantCheckError('group-not-found');
    return { group: snapshot.groups[0], asins: snapshot.asins };
  }
  async loadSingle(asinId: string): Promise<SingleCheckSnapshot> {
    id(asinId);
    this.ensureOpen();
    const [snapshot] = await this.db
      .select({ asin: asins, group: variantGroups })
      .from(asins)
      .innerJoin(variantGroups, eq(variantGroups.id, asins.variantGroupId))
      .where(eq(asins.id, asinId));
    this.ensureOpen();
    if (!snapshot) throw new VariantCheckError('asin-not-found');
    return snapshot;
  }
  private async lockGroup(expected: VariantGroup): Promise<VariantGroup> {
    id(expected.id);
    await prepareAsinTimestampWrites(this.db, this.ensureOpen);
    const [group] = await this.db
      .select()
      .from(variantGroups)
      .where(eq(variantGroups.id, expected.id))
      .for('update');
    this.ensureOpen();
    if (!group) throw new VariantCheckError('group-not-found');
    if (!sameGroup(group, expected))
      throw new VariantCheckError('snapshot-changed');
    return group;
  }
  private async timestamp(): Promise<Date> {
    const value = await this.db.execute(
      sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS checked_at_ms`,
    );
    this.ensureOpen();
    const raw = value.rows[0]?.checked_at_ms;
    const date = new Date(
      typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN,
    );
    if (!Number.isFinite(date.getTime()))
      throw new VariantCheckError('invalid-result');
    return date;
  }
  async commitSingle(
    expected: SingleCheckSnapshot,
    value: CatalogVariantResult,
    guard: CheckCommitGuard,
  ): Promise<CommittedSingleCheck> {
    const result = decodeCatalogVariantResult(
      value,
      expected.asin.asin,
      normalizeCountry(expected.asin.country),
    );
    const group = await this.lockGroup(expected.group);
    id(expected.asin.id);
    const [current] = await this.db
      .select()
      .from(asins)
      .where(eq(asins.id, expected.asin.id))
      .for('update');
    this.ensureOpen();
    if (!current) throw new VariantCheckError('asin-not-found');
    if (
      !sameAsin(current, expected.asin) ||
      current.variantGroupId !== group.id
    )
      throw new VariantCheckError('snapshot-changed');
    await guard();
    this.ensureOpen();
    const checkedAt = await this.timestamp();
    const [updated] = await this.db
      .update(asins)
      .set({
        isBroken: !result.hasVariants,
        variantStatus: result.hasVariants ? 'NORMAL' : 'BROKEN',
        lastCheckTime: checkedAt,
        updateTime: checkedAt,
      })
      .where(eq(asins.id, current.id))
      .returning();
    this.ensureOpen();
    if (!updated) throw new VariantCheckError('invalid-result');
    const effective = resolveAsinVariantStatus(updated, group);
    const writtenHistory = await this.db
      .insert(monitorHistory)
      .values({
        asinId: current.id,
        asinCode: current.asin || null,
        asinName: current.name || null,
        siteSnapshot: current.site || null,
        brandSnapshot: current.brand || null,
        variantGroupId: group.id,
        variantGroupName: group.name || null,
        checkType: 'ASIN',
        country: current.country,
        isBroken: effective.isBroken === 1,
        checkTime: checkedAt,
        checkResult: {
          ...result,
          statusSource: effective.statusSource,
          manualBrokenReason: effective.manualBrokenReason || '',
        },
      })
      .returning({ id: monitorHistory.id });
    this.ensureOpen();
    if (writtenHistory.length !== 1)
      throw new VariantCheckError('invalid-result');
    let updatedGroup = group;
    if (result.errorType === 'NOT_FOUND') {
      [updatedGroup] = await this.db
        .update(variantGroups)
        .set({
          isBroken: true,
          variantStatus: 'BROKEN',
          lastCheckTime: checkedAt,
          updateTime: group.updateTime,
        })
        .where(eq(variantGroups.id, group.id))
        .returning();
      this.ensureOpen();
      if (!updatedGroup) throw new VariantCheckError('invalid-result');
    }
    await guard();
    this.ensureOpen();
    return { asin: updated, group: updatedGroup, result };
  }
  async commitGroup(
    expected: GroupCheckSnapshot,
    observations: AsinCheckObservation[],
    guard: CheckCommitGuard,
  ): Promise<CommittedGroupCheck> {
    if (
      !Array.isArray(observations) ||
      observations.length !== expected.asins.length ||
      observations.length > MAX_ASIN_QUERY_CHILDREN
    )
      throw new VariantCheckError('invalid-input');
    const byId = new Map(observations.map((value) => [value.asinId, value]));
    if (byId.size !== observations.length)
      throw new VariantCheckError('invalid-input');
    const country = normalizeCountry(expected.group.country);
    // Validate every observation before touching business rows, including callers
    // outside the HTTP process. Deferred errors cannot replace automatic state.
    const checked = expected.asins.map((row): AsinCheckObservation => {
      const value = byId.get(row.id);
      if (!value) throw new VariantCheckError('invalid-input');
      if (value.kind === 'checked')
        return {
          asinId: row.id,
          kind: 'checked',
          result: decodeGroupCatalogResult(value.result, row.asin, country),
        };
      if (
        !['failed', 'deferred'].includes(value.kind) ||
        typeof value.error !== 'string' ||
        value.error.length > 200
      )
        throw new VariantCheckError('invalid-result');
      return { asinId: row.id, kind: value.kind, error: value.error };
    });
    const group = await this.lockGroup(expected.group);
    if (!equalTime(group.lastCheckTime, expected.group.lastCheckTime))
      throw new VariantCheckError('snapshot-changed');
    const rows = await this.db
      .select()
      .from(asins)
      .where(eq(asins.variantGroupId, group.id))
      .orderBy(asc(asins.id))
      .limit(MAX_ASIN_QUERY_CHILDREN + 1)
      .for('update');
    this.ensureOpen();
    const current = new Map(rows.map((row) => [row.id, row]));
    if (
      rows.length !== expected.asins.length ||
      expected.asins.some(
        (row) => !current.has(row.id) || !sameAsin(current.get(row.id)!, row),
      )
    )
      throw new VariantCheckError('snapshot-changed');
    await guard();
    this.ensureOpen();
    // Legacy's empty-group response is a read; it does not fabricate check times.
    if (!rows.length) return { group, asins: [], observations: [] };
    const checkedAt = await this.timestamp();
    const cases = checked.map(
      (value) =>
        sql`(${value.asinId}::varchar, ${
          value.kind === 'deferred'
            ? null
            : value.kind === 'failed' || !value.result.hasVariants
        }::boolean)`,
    );
    // One bounded statement updates all children atomically under the group lock.
    // No network call or per-ASIN transaction can leave a partially checked group.
    const written = await this.db.execute(sql`
      UPDATE ${asins} AS target SET
        is_broken = COALESCE(state.broken, target.is_broken),
        variant_status = CASE WHEN state.broken IS NULL THEN target.variant_status WHEN state.broken THEN 'BROKEN' ELSE 'NORMAL' END,
        last_check_time = ${checkedAt.toISOString()}::timestamptz AT TIME ZONE 'Asia/Shanghai',
        update_time = ${checkedAt.toISOString()}::timestamptz AT TIME ZONE 'Asia/Shanghai'
      FROM (VALUES ${sql.join(
        cases,
        sql`, `,
      )}) AS state(id, broken) WHERE target.id=state.id
    `);
    this.ensureOpen();
    if (written.rowCount !== rows.length)
      throw new VariantCheckError('invalid-result');
    const autoBroken = checked.some(
      (value) =>
        value.kind === 'failed' ||
        (value.kind === 'checked' && !value.result.hasVariants),
    );
    const [updatedGroup] = await this.db
      .update(variantGroups)
      .set({
        isBroken: autoBroken,
        variantStatus: autoBroken ? 'BROKEN' : 'NORMAL',
        lastCheckTime: checkedAt,
        updateTime: group.updateTime,
      })
      .where(eq(variantGroups.id, group.id))
      .returning();
    this.ensureOpen();
    if (!updatedGroup) throw new VariantCheckError('invalid-result');
    const updatedRows = await this.db
      .select()
      .from(asins)
      .where(eq(asins.variantGroupId, group.id))
      .orderBy(sql`${asins.createTime} ASC NULLS FIRST`, asc(asins.id))
      .limit(MAX_ASIN_QUERY_CHILDREN + 1);
    this.ensureOpen();
    await guard();
    this.ensureOpen();
    return { group: updatedGroup, asins: updatedRows, observations: checked };
  }
}

/** Short transactions only; the caller owns the pool and network check phase. */
export class PgVariantCheckRepository implements VariantCheckRepositoryPort {
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async transaction<T>(
    action: (unit: VariantCheckUnit) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 16) throw new VariantCheckError('capacity');
    this.active++;
    try {
      return await withAsinDatabaseTransaction(this.pool, (db, ensureOpen) =>
        action(new DrizzleVariantCheckUnit(db, ensureOpen)),
      );
    } finally {
      this.active--;
    }
  }
}
