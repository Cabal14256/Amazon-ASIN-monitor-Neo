import {
  competitorMonitorJobSchema,
  type CompetitorMonitorJob,
} from '@asin-monitor/contracts';
import { inArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import {
  assertCompetitorMonitorNotificationCandidate,
  COMPETITOR_MONITOR_MAX_GROUPS,
  COMPETITOR_MONITOR_MAX_MEMBERS,
  COMPETITOR_MONITOR_MAX_SNAPSHOT_BYTES,
  competitorMonitorSnapshotDigest,
  competitorMonitorSnapshotText,
  type CompetitorMonitorControlUnit,
  type CompetitorMonitorGroup,
  type CompetitorMonitorNotificationCandidate,
} from '../domain/competitor-monitor';
import { competitorAsins, competitorVariantGroups } from '../schema-competitor';
import { assertCatalogWriteExecution } from './catalog-operation-execution';
import { PgCompetitorTransactions } from './competitor-transactions';
import type { NotificationClaim } from './primary-monitor-repository';

type Authorize = (unit: CompetitorMonitorControlUnit) => Promise<void>;
/** Owns only competitor business storage. The short primary control transaction
 * stays locked until each snapshot/claim commit, never during upstream I/O. */
export class PgCompetitorMonitorRepository {
  private readonly transactions: PgCompetitorTransactions;
  constructor(primary: Pool, competitor: Pool) {
    this.transactions = new PgCompetitorTransactions(primary, competitor, 4, {
      durationMs: 15000,
      statementTimeoutMs: 5000,
    });
  }
  private run<T>(
    authorize: Authorize,
    action: (db: Db, ensureOpen: () => void) => Promise<T>,
    signal?: AbortSignal,
  ) {
    return this.transactions.run(
      false,
      async ({ authorization, database, ensureOpen }) => {
        await authorize(authorization);
        ensureOpen();
        const result = await action(await database(), ensureOpen);
        ensureOpen();
        await authorize(authorization);
        return result;
      },
      signal,
    );
  }
  control(authorize: Authorize, signal?: AbortSignal) {
    return this.transactions.run(
      false,
      async ({ authorization, ensureOpen }) => {
        await authorize(authorization);
        ensureOpen();
      },
      signal,
    );
  }
  async assertReady() {
    return this.run(
      async () => {},
      async (db) => {
        await db.execute(sql`SELECT run.task_id,notice.country,history.monitor_task_id
        FROM competitor_monitor_runs run LEFT JOIN competitor_monitor_notifications notice ON notice.task_id=run.task_id
        LEFT JOIN competitor_monitor_history history ON history.monitor_task_id=run.task_id LIMIT 0`);
      },
    );
  }
  private async existing(
    db: Db,
    job: CompetitorMonitorJob,
    lock: boolean,
  ): Promise<CompetitorMonitorGroup[] | undefined> {
    const parsed = competitorMonitorJobSchema.parse(job);
    if (lock)
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('neo:competitor-monitor:' || ${parsed.taskId},0))`,
      );
    const stored =
      await db.execute(sql`SELECT user_id,task_created_at,countries,groups,
      expires_at=${parsed.expiresAt}::timestamptz AS expiry_matches
      FROM competitor_monitor_runs WHERE task_id=${parsed.taskId}`);
    const row = stored.rows[0];
    if (!row) return undefined;
    if (
      row.user_id !== parsed.userId ||
      row.task_created_at !== parsed.createdAt ||
      JSON.stringify(row.countries) !== JSON.stringify(parsed.countries) ||
      row.expiry_matches !== true ||
      !Array.isArray(row.groups) ||
      row.groups.length > COMPETITOR_MONITOR_MAX_GROUPS ||
      new Set(row.groups.map((g: CompetitorMonitorGroup) => g?.groupId))
        .size !== row.groups.length ||
      row.groups.some(
        (g: CompetitorMonitorGroup) =>
          !g ||
          typeof g.groupId !== 'string' ||
          !g.groupId ||
          [...g.groupId].length > 50 ||
          !parsed.countries.includes(g.country) ||
          typeof g.snapshotDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(g.snapshotDigest),
      )
    )
      throw new Error('COMPETITOR_MONITOR_SNAPSHOT_IDENTITY_CHANGED');
    return row.groups as CompetitorMonitorGroup[];
  }
  groups(
    job: CompetitorMonitorJob,
    authorize: Authorize,
    signal?: AbortSignal,
  ) {
    return this.run(
      authorize,
      async (db, ensureOpen) => {
        assertCatalogWriteExecution(db, 'competitor', 'scheduled-system');
        const existing = await this.existing(db, job, true);
        if (existing) return existing;
        const groups = await db
          .select()
          .from(competitorVariantGroups)
          .where(
            sql`upper(rtrim(${
              competitorVariantGroups.country
            })) = ANY(${sql.param(job.countries)}::text[])`,
          )
          .orderBy(
            sql`array_position(${sql.param(
              job.countries,
            )}::text[],upper(rtrim(${competitorVariantGroups.country})))`,
            sql`${competitorVariantGroups.id} COLLATE "C"`,
          )
          .limit(COMPETITOR_MONITOR_MAX_GROUPS + 1);
        ensureOpen();
        if (groups.length > COMPETITOR_MONITOR_MAX_GROUPS)
          throw new Error('COMPETITOR_MONITOR_SNAPSHOT_CAPACITY');
        const members = groups.length
          ? await db
              .select()
              .from(competitorAsins)
              .where(
                inArray(
                  competitorAsins.variantGroupId,
                  groups.map((g) => g.id),
                ),
              )
              .orderBy(
                sql`${competitorAsins.variantGroupId} COLLATE "C"`,
                sql`${competitorAsins.id} COLLATE "C"`,
              )
              .limit(COMPETITOR_MONITOR_MAX_MEMBERS + 1)
          : [];
        ensureOpen();
        if (members.length > COMPETITOR_MONITOR_MAX_MEMBERS)
          throw new Error('COMPETITOR_MONITOR_SNAPSHOT_CAPACITY');
        let bytes = 0;
        const selected: CompetitorMonitorGroup[] = groups.map((group) => {
          const snapshot = {
            group,
            asins: members.filter((a) => a.variantGroupId === group.id),
          };
          bytes += Buffer.byteLength(competitorMonitorSnapshotText(snapshot));
          if (bytes > COMPETITOR_MONITOR_MAX_SNAPSHOT_BYTES)
            throw new Error('COMPETITOR_MONITOR_SNAPSHOT_CAPACITY');
          return {
            groupId: group.id,
            country: group.country
              .replace(/ +$/, '')
              .toUpperCase() as CompetitorMonitorGroup['country'],
            snapshotDigest: competitorMonitorSnapshotDigest(snapshot),
          };
        });
        await db.execute(sql`INSERT INTO competitor_monitor_runs(task_id,user_id,task_created_at,countries,groups,expires_at)
        VALUES (${job.taskId},${job.userId},${job.createdAt},${JSON.stringify(
          job.countries,
        )}::jsonb,${JSON.stringify(selected)}::jsonb,${
          job.expiresAt
        }::timestamptz)`);
        return selected;
      },
      signal,
    );
  }
  private async notificationInputs(
    db: Db,
    job: CompetitorMonitorJob,
    country: CompetitorMonitorGroup['country'],
    candidates: CompetitorMonitorNotificationCandidate[],
  ) {
    if (
      !job.countries.includes(country) ||
      !candidates.length ||
      candidates.length > COMPETITOR_MONITOR_MAX_MEMBERS ||
      new Set(candidates.map((candidate) => candidate.asinId)).size !==
        candidates.length
    )
      throw new Error('COMPETITOR_MONITOR_NOTIFICATION_INPUT_INVALID');
    const fixed = await this.existing(db, job, true);
    if (
      !fixed ||
      candidates.some(
        (candidate) =>
          !fixed.some(
            (group) =>
              group.groupId === candidate.groupId && group.country === country,
          ),
      )
    )
      throw new Error('COMPETITOR_MONITOR_NOTIFICATION_IDENTITY_CHANGED');
    const groupIds = [
      ...new Set(candidates.map((candidate) => candidate.groupId)),
    ];
    const groups = await db
      .select()
      .from(competitorVariantGroups)
      .where(inArray(competitorVariantGroups.id, groupIds))
      .orderBy(sql`${competitorVariantGroups.id} COLLATE "C"`)
      .for('update');
    const asins = await db
      .select()
      .from(competitorAsins)
      .where(
        inArray(
          competitorAsins.id,
          candidates.map((candidate) => candidate.asinId),
        ),
      )
      .orderBy(sql`${competitorAsins.id} COLLATE "C"`)
      .for('update');
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const asinById = new Map(asins.map((asin) => [asin.id, asin]));
    for (const candidate of candidates)
      assertCompetitorMonitorNotificationCandidate(
        country,
        candidate,
        groupById.get(candidate.groupId),
        asinById.get(candidate.asinId),
      );
  }
  assertNotificationInputs(
    job: CompetitorMonitorJob,
    country: CompetitorMonitorGroup['country'],
    candidates: CompetitorMonitorNotificationCandidate[],
    authorize: Authorize,
    signal?: AbortSignal,
  ) {
    return this.run(
      authorize,
      (db) => this.notificationInputs(db, job, country, candidates),
      signal,
    );
  }
  /** A persisted delivery belongs to the immutable run, not to today's catalog.
   * Reading it still requires current control, but cannot authorize a new POST. */
  readNotification(
    job: CompetitorMonitorJob,
    country: CompetitorMonitorGroup['country'],
    authorize: Authorize,
    signal?: AbortSignal,
  ): Promise<Exclude<NotificationClaim, 'new'> | undefined> {
    return this.run(
      authorize,
      async (db) => {
        if (
          !job.countries.includes(country) ||
          !(await this.existing(db, job, true))
        )
          throw new Error('COMPETITOR_MONITOR_CLAIM_IDENTITY_CHANGED');
        const existing = await db.execute(
          sql`SELECT state FROM competitor_monitor_notifications WHERE task_id=${job.taskId} AND country=${country}`,
        );
        if (!existing.rows.length) return undefined;
        const state = existing.rows[0].state;
        if (!['claimed', 'sent', 'failed'].includes(String(state)))
          throw new Error('COMPETITOR_MONITOR_CLAIM_LOST');
        return state as Exclude<NotificationClaim, 'new'>;
      },
      signal,
    );
  }
  claimNotification(
    job: CompetitorMonitorJob,
    country: CompetitorMonitorGroup['country'],
    candidates: CompetitorMonitorNotificationCandidate[],
    authorize: Authorize,
    signal?: AbortSignal,
  ): Promise<NotificationClaim> {
    return this.run(
      authorize,
      async (db) => {
        assertCatalogWriteExecution(db, 'competitor', 'scheduled-system');
        await this.notificationInputs(db, job, country, candidates);
        const inserted =
          await db.execute(sql`INSERT INTO competitor_monitor_notifications(task_id,country)
        VALUES (${job.taskId},${country}) ON CONFLICT DO NOTHING RETURNING state`);
        if (inserted.rowCount) return 'new';
        const existing = await db.execute(
          sql`SELECT state FROM competitor_monitor_notifications WHERE task_id=${job.taskId} AND country=${country}`,
        );
        const state = existing.rows[0]?.state;
        if (!['claimed', 'sent', 'failed'].includes(String(state)))
          throw new Error('COMPETITOR_MONITOR_CLAIM_LOST');
        return state as NotificationClaim;
      },
      signal,
    );
  }
  completeNotification(
    job: CompetitorMonitorJob,
    country: CompetitorMonitorGroup['country'],
    sent: boolean,
    authorize: Authorize,
    signal?: AbortSignal,
  ) {
    return this.run(
      authorize,
      async (db) => {
        assertCatalogWriteExecution(db, 'competitor', 'scheduled-system');
        if (
          !job.countries.includes(country) ||
          !(await this.existing(db, job, true))
        )
          throw new Error('COMPETITOR_MONITOR_CLAIM_IDENTITY_CHANGED');
        const changed =
          await db.execute(sql`UPDATE competitor_monitor_notifications SET state=${
            sent ? 'sent' : 'failed'
          },completed_at=now()
        WHERE task_id=${
          job.taskId
        } AND country=${country} AND state='claimed'`);
        if (changed.rowCount !== 1)
          throw new Error('COMPETITOR_MONITOR_CLAIM_CHANGED');
        if (sent)
          await db.execute(sql`UPDATE competitor_monitor_history SET notification_sent=true
        WHERE monitor_task_id=${job.taskId} AND upper(rtrim(country))=${country} AND is_broken=true`);
      },
      signal,
    );
  }
  purgeExpiredRuns() {
    return this.run(
      async () => {},
      async (db) => {
        const removed =
          await db.execute(sql`DELETE FROM competitor_monitor_runs WHERE task_id IN
        (SELECT task_id FROM competitor_monitor_runs WHERE expires_at<now() ORDER BY expires_at,task_id LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
        return removed.rowCount ?? 0;
      },
    );
  }
  close() {
    this.transactions.close();
  }
}
