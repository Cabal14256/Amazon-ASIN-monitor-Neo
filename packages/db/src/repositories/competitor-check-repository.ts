import { isNeoCatalogId } from '@asin-monitor/contracts';
import {
  decodeCatalogVariantResult,
  normalizeCountry,
  type CatalogVariantResult,
} from '@asin-monitor/sp-api';
import { asc, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import {
  type CommittedCompetitorGroupCheck,
  type CommittedCompetitorSingleCheck,
  type CompetitorCheckObservation,
  type CompetitorCheckRepositoryPort,
  type CompetitorCheckUnit,
  type CompetitorGroupCheckSnapshot,
  type CompetitorSingleCheckSnapshot,
} from '../domain/competitor-check';
import { competitorMonitorSnapshotDigest } from '../domain/competitor-monitor';
import { VariantCheckError } from '../domain/variant-check';
import type { VariantCheckOperation } from '../domain/variant-check-receipt';
import {
  assertVariantCheckOperationRequest,
  parseVariantCheckOperation,
} from '../domain/variant-check-receipt';
import {
  competitorAsins,
  competitorMonitorHistory,
  competitorVariantGroups,
  type CompetitorAsin,
  type CompetitorVariantGroup,
} from '../schema-competitor';
import {
  purgeCompetitorCheckReceipts,
  readCompetitorCheckReceipt,
  saveCompetitorCheckReceipt,
} from './competitor-check-receipt-repository';
import { PgCompetitorTransactions } from './competitor-transactions';
import { prepareCompetitorWrites } from './competitor-write-policy';

const MAX_CHILDREN = 5000;
const sameTime = (a: Date | null, b: Date | null) =>
  a === null ? b === null : b !== null && a.getTime() === b.getTime();
const validId = (id: string) => {
  if (!isNeoCatalogId(id)) throw new VariantCheckError('invalid-input');
};
function sameGroup(a: CompetitorVariantGroup, b: CompetitorVariantGroup) {
  return (
    a.id === b.id &&
    a.country === b.country &&
    a.name === b.name &&
    a.brand === b.brand &&
    a.feishuNotifyEnabled === b.feishuNotifyEnabled &&
    sameTime(a.createTime, b.createTime) &&
    sameTime(a.updateTime, b.updateTime) &&
    sameTime(a.lastCheckTime, b.lastCheckTime)
  );
}
function sameAsin(a: CompetitorAsin, b: CompetitorAsin) {
  return (
    a.id === b.id &&
    a.asin === b.asin &&
    a.country === b.country &&
    a.variantGroupId === b.variantGroupId &&
    a.name === b.name &&
    a.brand === b.brand &&
    a.asinType === b.asinType &&
    a.feishuNotifyEnabled === b.feishuNotifyEnabled &&
    sameTime(a.createTime, b.createTime) &&
    sameTime(a.updateTime, b.updateTime) &&
    sameTime(a.lastCheckTime, b.lastCheckTime)
  );
}
const broken = (result: CatalogVariantResult) =>
  !result.hasVariants || result.variantCount === 0;
const errorType = (result: CatalogVariantResult) =>
  result.errorType || (broken(result) ? 'NO_VARIANTS' : undefined);
const observationBroken = (observation: CompetitorCheckObservation) =>
  observation.kind !== 'checked' || broken(observation.result);

/** SQL is confined to the competitor connection. Primary authorization is
 * supplied separately by PgCompetitorTransactions in the same operation. */
class DrizzleCompetitorCheckUnit {
  constructor(
    private readonly db: Db,
    private readonly ensureOpen: () => void,
  ) {}
  private async query<T>(action: () => PromiseLike<T>): Promise<T> {
    this.ensureOpen();
    const value = await action();
    this.ensureOpen();
    return value;
  }
  readReceipt(operation: VariantCheckOperation, lock = false) {
    return readCompetitorCheckReceipt(
      this.db,
      this.ensureOpen,
      operation,
      lock,
    );
  }
  saveReceipt(operation: VariantCheckOperation, result: unknown) {
    return saveCompetitorCheckReceipt(
      this.db,
      this.ensureOpen,
      operation,
      result,
    );
  }
  purgeExpiredReceipts() {
    return purgeCompetitorCheckReceipts(this.db, this.ensureOpen);
  }
  async loadGroup(groupId: string): Promise<CompetitorGroupCheckSnapshot> {
    validId(groupId);
    const groups = await this.query(() =>
      this.db
        .select()
        .from(competitorVariantGroups)
        .where(eq(competitorVariantGroups.id, groupId))
        .limit(2),
    );
    if (!groups.length) throw new VariantCheckError('group-not-found');
    if (groups.length !== 1) throw new VariantCheckError('invalid-result');
    const asins = await this.query(() =>
      this.db
        .select()
        .from(competitorAsins)
        .where(eq(competitorAsins.variantGroupId, groups[0].id))
        .orderBy(asc(competitorAsins.createTime), asc(competitorAsins.id))
        .limit(MAX_CHILDREN + 1),
    );
    if (asins.length > MAX_CHILDREN) throw new VariantCheckError('capacity');
    return { group: groups[0], asins };
  }
  async loadSingle(asinId: string): Promise<CompetitorSingleCheckSnapshot> {
    validId(asinId);
    const rows = await this.query(() =>
      this.db
        .select()
        .from(competitorAsins)
        .where(eq(competitorAsins.id, asinId))
        .limit(2),
    );
    if (!rows.length) throw new VariantCheckError('asin-not-found');
    if (rows.length !== 1) throw new VariantCheckError('invalid-result');
    const [group] = await this.query(() =>
      this.db
        .select()
        .from(competitorVariantGroups)
        .where(eq(competitorVariantGroups.id, rows[0].variantGroupId)),
    );
    if (!group) throw new VariantCheckError('snapshot-changed');
    return { group, asin: rows[0] };
  }
  private async lockGroup(expected: CompetitorVariantGroup) {
    validId(expected.id);
    const [current] = await this.query(() =>
      this.db
        .select()
        .from(competitorVariantGroups)
        .where(eq(competitorVariantGroups.id, expected.id))
        .for('update'),
    );
    if (!current) throw new VariantCheckError('group-not-found');
    if (!sameGroup(current, expected))
      throw new VariantCheckError('snapshot-changed');
    return current;
  }
  private async timestamp() {
    const value = await this.query(() =>
      this.db.execute(
        sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS checked_at_ms`,
      ),
    );
    const raw = value.rows[0]?.checked_at_ms;
    const date = new Date(
      typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN,
    );
    if (!Number.isFinite(date.getTime()))
      throw new VariantCheckError('invalid-result');
    return date;
  }
  async commitSingle(
    expected: CompetitorSingleCheckSnapshot,
    raw: CatalogVariantResult,
    guard: () => Promise<void>,
  ): Promise<CommittedCompetitorSingleCheck> {
    const result = decodeCatalogVariantResult(
      raw,
      expected.asin.asin,
      normalizeCountry(expected.asin.country),
    );
    await prepareCompetitorWrites(this.db, this.ensureOpen);
    const group = await this.lockGroup(expected.group);
    validId(expected.asin.id);
    const [current] = await this.query(() =>
      this.db
        .select()
        .from(competitorAsins)
        .where(eq(competitorAsins.id, expected.asin.id))
        .for('update'),
    );
    if (!current || !sameAsin(current, expected.asin))
      throw new VariantCheckError('snapshot-changed');
    await guard();
    this.ensureOpen();
    const checkedAt = await this.timestamp();
    const [updated] = await this.query(() =>
      this.db
        .update(competitorAsins)
        .set({
          isBroken: broken(result),
          variantStatus: broken(result) ? 'BROKEN' : 'NORMAL',
          lastCheckTime: checkedAt,
          updateTime: checkedAt,
        })
        .where(eq(competitorAsins.id, current.id))
        .returning(),
    );
    if (!updated) throw new VariantCheckError('invalid-result');
    const aggregate = await this.query(() =>
      this.db.execute(
        sql`SELECT bool_or(is_broken IS TRUE) AS broken FROM ${competitorAsins} WHERE variant_group_id=${group.id}`,
      ),
    );
    const groupBroken = aggregate.rows[0]?.broken === true;
    const [updatedGroup] = await this.query(() =>
      this.db
        .update(competitorVariantGroups)
        .set({
          isBroken: groupBroken,
          variantStatus: groupBroken ? 'BROKEN' : 'NORMAL',
        })
        .where(eq(competitorVariantGroups.id, group.id))
        .returning(),
    );
    if (!updatedGroup) throw new VariantCheckError('invalid-result');
    await this.query(() =>
      this.db.insert(competitorMonitorHistory).values({
        asinId: updated.id,
        variantGroupId: updatedGroup.id,
        variantGroupName: updatedGroup.name,
        asinCode: updated.asin,
        asinName: updated.name,
        checkType: 'ASIN',
        country: updated.country,
        isBroken: broken(result),
        checkTime: checkedAt,
        checkResult: { asin: updated.asin, isBroken: broken(result), result },
      }),
    );
    await guard();
    return { asin: updated, group: updatedGroup, result };
  }
  async commitGroup(
    expected: CompetitorGroupCheckSnapshot,
    observations: CompetitorCheckObservation[],
    guard: () => Promise<void>,
    monitor?: { operation: VariantCheckOperation; snapshotDigest: string },
  ): Promise<CommittedCompetitorGroupCheck> {
    if (monitor) {
      const operation = parseVariantCheckOperation(monitor.operation);
      if (
        operation.taskType !== 'competitor-monitor' ||
        competitorMonitorSnapshotDigest(expected) !== monitor.snapshotDigest
      )
        throw new VariantCheckError('snapshot-changed');
      assertVariantCheckOperationRequest(operation, {
        groupId: expected.group.id,
        forceRefresh: false,
        snapshotDigest: monitor.snapshotDigest,
      });
    }
    if (
      observations.length !== expected.asins.length ||
      observations.length > MAX_CHILDREN ||
      new Set(observations.map((item) => item.asinId)).size !==
        observations.length
    )
      throw new VariantCheckError('invalid-input');
    const byId = new Map(observations.map((item) => [item.asinId, item]));
    const validated: CompetitorCheckObservation[] = expected.asins.map(
      (row) => {
        const item = byId.get(row.id);
        if (!item) throw new VariantCheckError('invalid-input');
        if (item.kind !== 'checked' && item.kind !== 'failed')
          throw new VariantCheckError('invalid-input');
        if (item.kind !== 'checked') return item;
        return {
          asinId: row.id,
          kind: 'checked' as const,
          result: decodeCatalogVariantResult(
            item.result,
            row.asin,
            normalizeCountry(row.country),
          ),
        };
      },
    );
    await prepareCompetitorWrites(this.db, this.ensureOpen);
    const group = await this.lockGroup(expected.group);
    const current = await this.query(() =>
      this.db
        .select()
        .from(competitorAsins)
        .where(eq(competitorAsins.variantGroupId, group.id))
        .orderBy(asc(competitorAsins.id))
        .limit(MAX_CHILDREN + 1)
        .for('update'),
    );
    const locked = new Map(current.map((row) => [row.id, row]));
    if (
      current.length !== expected.asins.length ||
      expected.asins.some(
        (row) => !locked.has(row.id) || !sameAsin(locked.get(row.id)!, row),
      )
    )
      throw new VariantCheckError('snapshot-changed');
    await guard();
    this.ensureOpen();
    // Legacy leaves an empty group untouched and emits no fabricated history.
    if (!current.length) {
      if (monitor)
        await this.query(() =>
          this.db.insert(competitorMonitorHistory).values({
            variantGroupId: group.id,
            variantGroupName: group.name,
            checkType: 'GROUP',
            country: group.country,
            isBroken: true,
            checkTime: new Date(monitor.operation.taskCreatedAt),
            monitorTaskId: monitor.operation.taskId,
            checkResult: {
              totalASINs: 0,
              brokenCount: 0,
              results: [],
              message: '竞品变体组中没有ASIN',
            },
          }),
        );
      await guard();
      return { group, asins: [], observations: [] };
    }
    const checkedAt = monitor
      ? new Date(monitor.operation.taskCreatedAt)
      : await this.timestamp();
    const state = validated.map(
      (item) =>
        sql`(${item.asinId}::varchar,${observationBroken(item)}::boolean)`,
    );
    const written = await this.query(() =>
      this.db.execute(sql`
        UPDATE ${competitorAsins} AS target SET
          is_broken = state.broken,
          variant_status = CASE WHEN state.broken THEN 'BROKEN' ELSE 'NORMAL' END,
          last_check_time = ${checkedAt.toISOString()}::timestamptz AT TIME ZONE 'Asia/Shanghai',
          update_time = ${checkedAt.toISOString()}::timestamptz AT TIME ZONE 'Asia/Shanghai'
        FROM (VALUES ${sql.join(state, sql`,`)}) AS state(id,broken)
        WHERE target.id=state.id AND target.variant_group_id=${group.id}
      `),
    );
    if (written.rowCount !== current.length)
      throw new VariantCheckError('snapshot-changed');
    const groupBroken = validated.some(observationBroken);
    const [updatedGroup] = await this.query(() =>
      this.db
        .update(competitorVariantGroups)
        .set({
          isBroken: groupBroken,
          variantStatus: groupBroken ? 'BROKEN' : 'NORMAL',
          lastCheckTime: checkedAt,
        })
        .where(eq(competitorVariantGroups.id, group.id))
        .returning(),
    );
    if (!updatedGroup) throw new VariantCheckError('invalid-result');
    const updatedRows = await this.query(() =>
      this.db
        .select()
        .from(competitorAsins)
        .where(eq(competitorAsins.variantGroupId, group.id))
        .orderBy(asc(competitorAsins.createTime), asc(competitorAsins.id))
        .limit(MAX_CHILDREN + 1),
    );
    const results = validated.map((item) => {
      const row = locked.get(item.asinId)!;
      const failed = item.kind !== 'checked';
      const result = failed ? undefined : item.result;
      const type = failed ? 'SP_API_ERROR' : errorType(item.result);
      return {
        asin: row.asin,
        ...(result
          ? {
              hasVariants: result.hasVariants,
              variantCount: result.variantCount,
            }
          : {}),
        ...(type ? { errorType: type } : {}),
        ...(failed ? { error: item.error } : {}),
      };
    });
    const resultById = new Map(
      validated.map((item, index) => [item.asinId, results[index]]),
    );
    const brokenCount = validated.filter(observationBroken).length;
    await this.query(() =>
      this.db.insert(competitorMonitorHistory).values({
        variantGroupId: group.id,
        variantGroupName: group.name,
        checkType: 'GROUP',
        country: group.country,
        isBroken: groupBroken,
        checkTime: checkedAt,
        monitorTaskId: monitor?.operation.taskId,
        checkResult: {
          totalASINs: current.length,
          brokenCount,
          results,
        },
      }),
    );
    // Bound parameter count per statement, preserving the one business TX.
    for (let offset = 0; offset < updatedRows.length; offset += 1000) {
      const rows = updatedRows.slice(offset, offset + 1000);
      await this.query(() =>
        this.db.insert(competitorMonitorHistory).values(
          rows.map((row) => {
            const observation = byId.get(row.id)!;
            const kind =
              observation.kind !== 'checked'
                ? 'SP_API_ERROR'
                : errorType(observation.result);
            return {
              asinId: row.id,
              variantGroupId: group.id,
              variantGroupName: group.name,
              asinCode: row.asin,
              asinName: row.name,
              checkType: 'ASIN',
              country: row.country,
              checkTime: checkedAt,
              monitorTaskId: monitor?.operation.taskId,
              isBroken: row.isBroken === true,
              checkResult: {
                asin: row.asin,
                isBroken: row.isBroken === true,
                ...(monitor
                  ? {
                      errorType: kind ?? null,
                      isDeferred: false,
                      currentResult: resultById.get(row.id) ?? null,
                    }
                  : {}),
              },
            };
          }),
        ),
      );
    }
    await guard();
    return {
      group: updatedGroup,
      asins: updatedRows,
      observations: validated,
    };
  }
}

export class PgCompetitorCheckRepository
  implements CompetitorCheckRepositoryPort
{
  private readonly transactions: PgCompetitorTransactions;
  constructor(primary: Pool, competitor: Pool) {
    this.transactions = new PgCompetitorTransactions(primary, competitor, 8, {
      durationMs: 15000,
      statementTimeoutMs: 5000,
    });
  }
  transaction<T>(
    action: (unit: CompetitorCheckUnit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.transactions.run(
      false,
      async ({ authorization, database, ensureOpen }) => {
        let selected: Promise<DrizzleCompetitorCheckUnit> | undefined;
        const business = () =>
          (selected ??= database().then(
            (db) => new DrizzleCompetitorCheckUnit(db, ensureOpen),
          ));
        return action({
          ...authorization,
          readReceipt: (operation, lock) =>
            business().then((unit) => unit.readReceipt(operation, lock)),
          saveReceipt: (operation, result) =>
            business().then((unit) => unit.saveReceipt(operation, result)),
          purgeExpiredReceipts: () =>
            business().then((unit) => unit.purgeExpiredReceipts()),
          loadGroup: (id) => business().then((unit) => unit.loadGroup(id)),
          loadSingle: (id) => business().then((unit) => unit.loadSingle(id)),
          commitGroup: (snapshot, values, guard, monitor) =>
            business().then((unit) =>
              unit.commitGroup(snapshot, values, guard, monitor),
            ),
          commitSingle: (snapshot, value, guard) =>
            business().then((unit) =>
              unit.commitSingle(snapshot, value, guard),
            ),
        });
      },
      signal,
    );
  }
  close() {
    this.transactions.close();
  }
}
