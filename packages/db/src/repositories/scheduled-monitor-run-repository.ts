import type { ScheduledMonitorJob } from '@asin-monitor/contracts';
import type { Pool } from 'pg';
import {
  evaluateScheduledMonitorFreshness,
  parseScheduledMonitorJob,
  scheduledMonitorGroupBatch,
  scheduledMonitorJobDigest,
} from '../domain/scheduled-monitor-policy';
import {
  assertScheduledMonitorFollowUp,
  createScheduledMonitorFollowUp,
  freezeScheduledMonitorSnapshot,
  parseScheduledMonitorSnapshot,
  SCHEDULED_MONITOR_MAX_GROUPS,
  SCHEDULED_MONITOR_MAX_MEMBERS,
  SCHEDULED_MONITOR_MAX_RESULT_BYTES,
  scheduledMonitorBusinessResultSchema,
  scheduledMonitorGroupOperation,
  ScheduledMonitorRunError,
  scheduledMonitorRunStateSchema,
  scheduledMonitorSnapshotDigest,
  scheduledMonitorStorageBytes,
  type ScheduledMonitorBusinessResult,
  type ScheduledMonitorGroupSnapshot,
  type ScheduledMonitorRun,
} from '../domain/scheduled-monitor-run';
import { decodeVariantCheckReceiptResult } from '../domain/variant-check-receipt';
import {
  PgScheduledMonitorTransactions,
  ScheduledMonitorSerializationRetry,
  type ScheduledMonitorTransaction,
} from './scheduled-monitor-transaction';

type Domain = 'primary' | 'competitor';
type Row = Record<string, unknown>;
const MAX_CATALOG_GROUPS = 100_000;
const PAGE_SIZE = 1000;
const terminal = new Set([
  'completed',
  'skipped-expired',
  'cancelled',
  'failed',
]);
const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
function receiptCounts(
  value: unknown,
  group: ScheduledMonitorGroupSnapshot,
): { brokenGroups: number; brokenMembers: number } {
  const result = record(value),
    snapshot = record(result.groupSnapshot);
  const children = snapshot.children,
    broken = result.brokenASINs;
  const members = new Map(group.members.map((member) => [member.id, member]));
  const codes = new Set(group.members.map((member) => member.asin));
  if (
    typeof result.isBroken !== 'boolean' ||
    snapshot.id !== group.group.id ||
    snapshot.name !== group.group.name ||
    typeof snapshot.country !== 'string' ||
    snapshot.country.replace(/ +$/, '').toUpperCase() !== group.country ||
    !Array.isArray(children) ||
    children.length !== members.size ||
    new Set(children.map((child) => record(child).id)).size !==
      children.length ||
    children.some((child) => {
      const row = record(child),
        member = typeof row.id === 'string' ? members.get(row.id) : undefined;
      return !member || row.asin !== member.asin;
    }) ||
    !Array.isArray(broken) ||
    broken.length > members.size ||
    new Set(broken.map((member) => record(member).asin)).size !==
      broken.length ||
    broken.some(
      (member) =>
        typeof record(member).asin !== 'string' ||
        !codes.has(record(member).asin as string),
    )
  )
    throw new ScheduledMonitorRunError('identity');
  return {
    brokenGroups: result.isBroken ? 1 : 0,
    brokenMembers: broken.length,
  };
}
const iso = (value: unknown): string | null => {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new ScheduledMonitorRunError('identity');
  return value.toISOString();
};
/** SQL identifiers are constructor-owned, never derived from a queued payload.
 * Custom schemas support isolated service fixtures without touching live data. */
const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value))
    throw new ScheduledMonitorRunError('input');
  return `"${value}"`;
};
const nativeFields = (alias: string, fields: string[]) =>
  `jsonb_build_object(${fields
    .map(
      (field) =>
        `'${field}',to_char(${alias}.${field},'YYYY-MM-DD HH24:MI:SS.US')`,
    )
    .join(',')})`;

/** Private system-only storage. No user/session repository or public task index
 * is consulted, and replay never loads today's groups or children. */
export class PgScheduledMonitorRunRepository {
  private readonly transactions: PgScheduledMonitorTransactions;
  private readonly runs: string;
  private readonly receipts: string;
  private readonly groupTable: string;
  private readonly memberTable: string;
  private readonly schema: string;
  constructor(
    pool: Pool,
    private readonly domain: Domain,
    options: {
      schema?: string;
      maximumOperations?: number;
      durationMs?: number;
      statementTimeoutMs?: number;
    } = {},
  ) {
    if (!['primary', 'competitor'].includes(domain))
      throw new ScheduledMonitorRunError('input');
    this.schema = options.schema ?? 'public';
    const qualified = `${identifier(this.schema)}.`;
    this.runs = qualified + identifier(`${domain}_scheduled_monitor_runs`);
    this.receipts =
      qualified + identifier(`${domain}_scheduled_monitor_group_receipts`);
    this.groupTable =
      qualified +
      identifier(
        domain === 'primary' ? 'variant_groups' : 'competitor_variant_groups',
      );
    this.memberTable =
      qualified +
      identifier(domain === 'primary' ? 'asins' : 'competitor_asins');
    this.transactions = new PgScheduledMonitorTransactions(
      pool,
      options.maximumOperations,
      options.durationMs,
      options.statementTimeoutMs,
    );
  }
  getDiagnostics() {
    return this.transactions.getDiagnostics();
  }
  close() {
    this.transactions.close();
  }
  private job(value: unknown): ScheduledMonitorJob {
    let job: ScheduledMonitorJob;
    try {
      job = parseScheduledMonitorJob(value);
    } catch {
      throw new ScheduledMonitorRunError('input');
    }
    if (job.domain !== this.domain)
      throw new ScheduledMonitorRunError('identity');
    return job;
  }
  private async transaction<T>(
    action: (tx: ScheduledMonitorTransaction) => Promise<T>,
    signal?: AbortSignal,
    admission = false,
  ): Promise<T> {
    // A repeatable-read snapshot may predate an advisory-lock wait. Retry only
    // explicit PostgreSQL conflicts, never connection loss or COMMIT uncertainty.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.transactions.run(action, signal, admission);
      } catch (error) {
        if (!(error instanceof ScheduledMonitorSerializationRetry)) throw error;
      }
    }
    throw new ScheduledMonitorRunError('dependency');
  }
  private async lock(
    tx: ScheduledMonitorTransaction,
    job: ScheduledMonitorJob,
  ) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('neo:scheduled-monitor:' || $1,0))",
      [job.taskId],
    );
  }
  private async now(tx: ScheduledMonitorTransaction): Promise<string> {
    const rows = await tx.query<{ now_ms: string }>(
      'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms',
    );
    const value = rows[0]?.now_ms;
    if (
      typeof value !== 'string' ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new ScheduledMonitorRunError('dependency');
    return new Date(Number(value)).toISOString();
  }
  private decode(job: ScheduledMonitorJob, row: Row): ScheduledMonitorRun {
    const digest = scheduledMonitorJobDigest(job);
    let stored: ScheduledMonitorJob;
    try {
      stored = parseScheduledMonitorJob(row.job);
    } catch {
      throw new ScheduledMonitorRunError('identity');
    }
    if (
      scheduledMonitorJobDigest(stored) !== digest ||
      row.task_id !== job.taskId ||
      row.job_id !== job.jobId ||
      row.job_digest !== digest ||
      row.domain !== job.domain ||
      row.country !== job.country ||
      row.actor_kind !== 'system' ||
      row.actor_purpose !== 'scheduled-monitor' ||
      iso(row.planned_slot) !== job.plannedSlot ||
      iso(row.requested_at) !== job.requestedAt ||
      iso(row.created_at) !== job.createdAt ||
      iso(row.expires_at) !== job.expiresAt ||
      row.interval_minutes !== job.intervalMinutes ||
      row.batch_index !== job.batchConfig.batchIndex ||
      row.total_batches !== job.batchConfig.totalBatches ||
      typeof row.total_members !== 'number' ||
      typeof row.snapshot_digest !== 'string'
    )
      throw new ScheduledMonitorRunError('identity');
    const groups = parseScheduledMonitorSnapshot(
      job,
      row.groups,
      row.snapshot_digest,
      row.total_members,
    );
    const state = scheduledMonitorRunStateSchema.safeParse(row.state);
    if (!state.success) throw new ScheduledMonitorRunError('state');
    const businessCompletedAt = iso(row.business_completed_at),
      completedAt = iso(row.completed_at),
      cancelRequestedAt = iso(row.cancel_requested_at);
    if (
      terminal.has(state.data) !== (completedAt !== null) ||
      (['business-completed', 'completed'].includes(state.data) &&
        businessCompletedAt === null) ||
      (businessCompletedAt !== null &&
        (businessCompletedAt < job.createdAt ||
          !['business-completed', 'completed', 'cancelled', 'failed'].includes(
            state.data,
          ))) ||
      (completedAt !== null &&
        (completedAt < job.createdAt ||
          (businessCompletedAt !== null &&
            completedAt < businessCompletedAt))) ||
      (cancelRequestedAt !== null && cancelRequestedAt < job.createdAt)
    )
      throw new ScheduledMonitorRunError('state');
    let result: ScheduledMonitorBusinessResult | null = null;
    if (row.result !== null) {
      const parsed = scheduledMonitorBusinessResultSchema.safeParse(row.result);
      if (
        !parsed.success ||
        parsed.data.totalGroups !== groups.length ||
        parsed.data.totalMembers !== row.total_members ||
        businessCompletedAt === null
      )
        throw new ScheduledMonitorRunError('state');
      result = parsed.data;
    }
    if ((businessCompletedAt !== null) !== (result !== null))
      throw new ScheduledMonitorRunError('state');
    let followUpJob: ScheduledMonitorJob | null = null;
    if (row.follow_up_job !== null) {
      if (!businessCompletedAt || typeof row.follow_up_digest !== 'string')
        throw new ScheduledMonitorRunError('identity');
      followUpJob = assertScheduledMonitorFollowUp(
        job,
        businessCompletedAt,
        row.follow_up_job,
        row.follow_up_digest,
      );
      if (iso(row.follow_up_requested_at) !== followUpJob.requestedAt)
        throw new ScheduledMonitorRunError('identity');
    } else if (
      row.follow_up_digest !== null ||
      row.follow_up_requested_at !== null
    )
      throw new ScheduledMonitorRunError('identity');
    return {
      job: stored,
      jobDigest: digest,
      groups,
      snapshotDigest: row.snapshot_digest,
      totalMembers: row.total_members,
      state: state.data,
      businessCompletedAt,
      completedAt,
      cancelRequestedAt,
      result,
      followUpJob,
      followUpDigest: followUpJob
        ? scheduledMonitorJobDigest(followUpJob)
        : null,
    };
  }
  private async existing(
    tx: ScheduledMonitorTransaction,
    job: ScheduledMonitorJob,
  ): Promise<ScheduledMonitorRun | undefined> {
    const rows = await tx.query(
      `SELECT * FROM ${this.runs} WHERE task_id=$1 OR job_id=$2 FOR UPDATE`,
      [job.taskId, job.jobId],
    );
    if (rows.length > 1) throw new ScheduledMonitorRunError('identity');
    return rows[0] ? this.decode(job, rows[0]) : undefined;
  }
  private async require(
    tx: ScheduledMonitorTransaction,
    job: ScheduledMonitorJob,
  ) {
    await this.lock(tx, job);
    const run = await this.existing(tx, job);
    if (!run) throw new ScheduledMonitorRunError('identity');
    return run;
  }
  async assertReady(signal?: AbortSignal): Promise<void> {
    return this.transaction(async (tx) => {
      const opposite =
        this.domain === 'primary'
          ? 'competitor_variant_groups'
          : 'variant_groups';
      const wrong = await tx.query('SELECT to_regclass($1)::text AS opposite', [
        `${identifier(this.schema)}.${identifier(opposite)}`,
      ]);
      if (wrong[0]?.opposite !== null)
        throw new ScheduledMonitorRunError('identity');
      await tx.query(
        `SELECT run.job_digest,receipt.snapshot_digest FROM ${this.runs} run LEFT JOIN ${this.receipts} receipt ON receipt.task_id=run.task_id LIMIT 0`,
      );
      await tx.query(
        `SELECT g.id,a.id FROM ${this.groupTable} g LEFT JOIN ${this.memberTable} a ON a.variant_group_id=g.id LIMIT 0`,
      );
    }, signal);
  }
  read(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ScheduledMonitorRun | undefined> {
    const job = this.job(value);
    return this.transaction(async (tx) => {
      await this.lock(tx, job);
      return this.existing(tx, job);
    }, signal);
  }
  private async snapshot(
    tx: ScheduledMonitorTransaction,
    job: ScheduledMonitorJob,
  ): Promise<ScheduledMonitorGroupSnapshot[]> {
    const selected: string[] = [];
    let last: string | null = null,
      scanned = 0;
    while (true) {
      const page: { id: string }[] = await tx.query<{ id: string }>(
        `SELECT id FROM ${this.groupTable} WHERE upper(rtrim(country))=$1
         ${
           this.domain === 'primary'
             ? 'AND COALESCE(is_competitor,false)=false'
             : ''
         }
         AND ($2::text IS NULL OR id COLLATE "C" > $2::text COLLATE "C")
         ORDER BY id COLLATE "C" LIMIT $3`,
        [job.country, last, PAGE_SIZE],
      );
      for (const row of page) {
        if (typeof row.id !== 'string')
          throw new ScheduledMonitorRunError('snapshot');
        if (++scanned > MAX_CATALOG_GROUPS)
          throw new ScheduledMonitorRunError('capacity');
        if (
          scheduledMonitorGroupBatch(row.id, job.batchConfig.totalBatches) ===
          job.batchConfig.batchIndex
        ) {
          selected.push(row.id);
          if (selected.length > SCHEDULED_MONITOR_MAX_GROUPS)
            throw new ScheduledMonitorRunError('capacity');
        }
      }
      if (page.length < PAGE_SIZE) break;
      last = page[page.length - 1].id;
    }
    if (!selected.length) return [];
    const times = ['create_time', 'update_time', 'last_check_time'];
    const groupTimes =
      this.domain === 'primary'
        ? [...times, 'manual_broken_updated_at']
        : times;
    const memberTimes =
      this.domain === 'primary'
        ? [...groupTimes, 'manual_excluded_updated_at']
        : times;
    const rows = await tx.query<{ groups: unknown[]; members: unknown[] }>(
      `WITH groups AS MATERIALIZED (SELECT g.* FROM ${
        this.groupTable
      } g WHERE g.id=ANY($1::text[]) ORDER BY g.create_time ASC NULLS FIRST,g.id COLLATE "C"),
       members AS MATERIALIZED (SELECT a.* FROM ${
         this.memberTable
       } a INNER JOIN groups g ON g.id=a.variant_group_id ORDER BY a.create_time ASC NULLS FIRST,a.id COLLATE "C" LIMIT $2)
       SELECT COALESCE((SELECT jsonb_agg(to_jsonb(g) || ${nativeFields(
         'g',
         groupTimes,
       )} ORDER BY g.create_time ASC NULLS FIRST,g.id COLLATE "C") FROM groups g),'[]'::jsonb) AS groups,
       COALESCE((SELECT jsonb_agg(to_jsonb(a) || ${nativeFields(
         'a',
         memberTimes,
       )} ORDER BY a.create_time ASC NULLS FIRST,a.id COLLATE "C") FROM members a),'[]'::jsonb) AS members`,
      [selected, SCHEDULED_MONITOR_MAX_MEMBERS + 1],
    );
    if (
      !rows[0] ||
      !Array.isArray(rows[0].groups) ||
      rows[0].groups.length !== selected.length ||
      !Array.isArray(rows[0].members)
    )
      throw new ScheduledMonitorRunError('snapshot');
    return freezeScheduledMonitorSnapshot(job, rows[0].groups, rows[0].members);
  }
  /** First acceptance freezes one RR catalog. Stale jobs persist only an empty
   * skipped ledger, before touching business tables. Replay returns its original
   * snapshot even after deletion, rename, new membership or business completion. */
  accept(value: unknown, signal?: AbortSignal): Promise<ScheduledMonitorRun> {
    const job = this.job(value);
    return this.transaction(
      async (tx) => {
        await this.lock(tx, job);
        const existing = await this.existing(tx, job);
        if (existing) return existing;
        const now = await this.now(tx);
        const expired =
          Date.parse(job.expiresAt) <= Date.parse(now) ||
          evaluateScheduledMonitorFreshness(job, undefined, Date.parse(now))
            .stale;
        const groups = expired ? [] : await this.snapshot(tx, job);
        const totalMembers = groups.reduce(
          (sum, group) => sum + group.members.length,
          0,
        );
        await tx.query(
          `INSERT INTO ${this.runs}
        (task_id,job_id,job_digest,job,domain,country,planned_slot,requested_at,created_at,expires_at,interval_minutes,batch_index,total_batches,groups,snapshot_digest,total_members,state,completed_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::timestamptz)`,
          [
            job.taskId,
            job.jobId,
            scheduledMonitorJobDigest(job),
            JSON.stringify(job),
            job.domain,
            job.country,
            job.plannedSlot,
            job.requestedAt,
            job.createdAt,
            job.expiresAt,
            job.intervalMinutes,
            job.batchConfig.batchIndex,
            job.batchConfig.totalBatches,
            JSON.stringify(groups),
            scheduledMonitorSnapshotDigest(job, groups),
            totalMembers,
            expired ? 'skipped-expired' : 'pending',
            expired ? now : null,
          ],
        );
        return (await this.existing(tx, job))!;
      },
      signal,
      true,
    );
  }
  start(value: unknown, signal?: AbortSignal): Promise<ScheduledMonitorRun> {
    const job = this.job(value);
    return this.transaction(async (tx) => {
      const run = await this.require(tx, job);
      if (run.cancelRequestedAt)
        throw new ScheduledMonitorRunError('cancelled');
      if (!['pending', 'running'].includes(run.state))
        throw new ScheduledMonitorRunError('state');
      const now = await this.now(tx);
      if (
        Date.parse(job.expiresAt) <= Date.parse(now) ||
        evaluateScheduledMonitorFreshness(job, undefined, Date.parse(now)).stale
      )
        throw new ScheduledMonitorRunError('expired');
      if (run.state === 'pending')
        await tx.query(
          `UPDATE ${this.runs} SET state='running' WHERE task_id=$1`,
          [job.taskId],
        );
      return (await this.existing(tx, job))!;
    }, signal);
  }
  requestCancellation(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ScheduledMonitorRun> {
    const job = this.job(value);
    return this.transaction(async (tx) => {
      const run = await this.require(tx, job);
      if (['pending', 'running'].includes(run.state) && !run.cancelRequestedAt)
        await tx.query(
          `UPDATE ${this.runs} SET cancel_requested_at=$2::timestamptz WHERE task_id=$1`,
          [job.taskId, await this.now(tx)],
        );
      return (await this.existing(tx, job))!;
    }, signal);
  }
  finishWithoutBusiness(
    value: unknown,
    state: 'skipped-expired' | 'cancelled' | 'failed',
    signal?: AbortSignal,
  ): Promise<ScheduledMonitorRun> {
    const job = this.job(value);
    if (!['skipped-expired', 'cancelled', 'failed'].includes(state))
      throw new ScheduledMonitorRunError('input');
    return this.transaction(async (tx) => {
      const run = await this.require(tx, job);
      if (run.state === state) return run;
      if (
        !['pending', 'running'].includes(run.state) ||
        run.businessCompletedAt
      )
        throw new ScheduledMonitorRunError('state');
      if (state === 'cancelled' && !run.cancelRequestedAt)
        throw new ScheduledMonitorRunError('cancelled');
      const now = await this.now(tx);
      if (
        state === 'skipped-expired' &&
        Date.parse(job.expiresAt) > Date.parse(now) &&
        !evaluateScheduledMonitorFreshness(job, undefined, Date.parse(now))
          .stale
      )
        throw new ScheduledMonitorRunError('state');
      await tx.query(
        `UPDATE ${this.runs} SET state=$2,completed_at=$3::timestamptz WHERE task_id=$1`,
        [job.taskId, state, now],
      );
      return (await this.existing(tx, job))!;
    }, signal);
  }
  /** This prepares the durable boundary for #188; group receipts are created by
   * its business transaction adapter, never by this repository. */
  completeBusiness(
    value: unknown,
    inputResult: unknown,
    followUp = false,
    signal?: AbortSignal,
  ): Promise<ScheduledMonitorRun> {
    const job = this.job(value);
    if (
      typeof followUp !== 'boolean' ||
      (followUp && (job.domain !== 'primary' || job.country !== 'US'))
    )
      throw new ScheduledMonitorRunError('input');
    const result = scheduledMonitorBusinessResultSchema.safeParse(inputResult);
    if (
      !result.success ||
      scheduledMonitorStorageBytes(result.data) >
        SCHEDULED_MONITOR_MAX_RESULT_BYTES
    )
      throw new ScheduledMonitorRunError('input');
    return this.transaction(async (tx) => {
      const run = await this.require(tx, job);
      if (['business-completed', 'completed'].includes(run.state)) {
        if (
          JSON.stringify(result.data) !== JSON.stringify(run.result) ||
          followUp !== (run.followUpJob !== null)
        )
          throw new ScheduledMonitorRunError('identity');
        return run;
      }
      if (run.state !== 'running' || run.cancelRequestedAt)
        throw new ScheduledMonitorRunError(
          run.cancelRequestedAt ? 'cancelled' : 'state',
        );
      if (
        result.data.totalGroups !== run.groups.length ||
        result.data.totalMembers !== run.totalMembers
      )
        throw new ScheduledMonitorRunError('identity');
      const receipts = await tx.query(
        `SELECT * FROM ${this.receipts} WHERE task_id=$1 ORDER BY ordinal LIMIT $2`,
        [job.taskId, SCHEDULED_MONITOR_MAX_GROUPS + 1],
      );
      if (receipts.length !== run.groups.length)
        throw new ScheduledMonitorRunError('state');
      const now = await this.now(tx);
      if (Date.parse(job.expiresAt) <= Date.parse(now))
        throw new ScheduledMonitorRunError('expired');
      let brokenGroups = 0,
        brokenMembers = 0;
      for (const [ordinal, row] of receipts.entries()) {
        const operation = scheduledMonitorGroupOperation(
          job,
          run.groups[ordinal],
        );
        if (
          Object.entries(operation).some(
            ([key, value]) =>
              row[key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)] !==
              value,
          )
        )
          throw new ScheduledMonitorRunError('identity');
        const counts = receiptCounts(
          decodeVariantCheckReceiptResult(row.result, operation.resultKind),
          run.groups[ordinal],
        );
        const completedAt = iso(row.completed_at);
        if (!completedAt || completedAt < job.createdAt || completedAt > now)
          throw new ScheduledMonitorRunError('identity');
        brokenGroups += counts.brokenGroups;
        brokenMembers += counts.brokenMembers;
      }
      if (
        result.data.brokenGroups !== brokenGroups ||
        result.data.brokenMembers !== brokenMembers
      )
        throw new ScheduledMonitorRunError('identity');
      const child = followUp ? createScheduledMonitorFollowUp(job, now) : null;
      const updated = await tx.query(
        `UPDATE ${this.runs} SET state='business-completed',business_completed_at=$2::timestamptz,result=$3::jsonb,follow_up_job=$4::jsonb,follow_up_digest=$5,follow_up_requested_at=$6::timestamptz WHERE task_id=$1 AND expires_at > clock_timestamp() RETURNING task_id`,
        [
          job.taskId,
          now,
          JSON.stringify(result.data),
          child ? JSON.stringify(child) : null,
          child ? scheduledMonitorJobDigest(child) : null,
          child?.requestedAt ?? null,
        ],
      );
      if (updated.length !== 1) throw new ScheduledMonitorRunError('expired');
      return (await this.existing(tx, job))!;
    }, signal);
  }
  complete(value: unknown, signal?: AbortSignal): Promise<ScheduledMonitorRun> {
    const job = this.job(value);
    return this.transaction(async (tx) => {
      const run = await this.require(tx, job);
      if (run.state === 'completed') return run;
      if (run.state !== 'business-completed' || run.cancelRequestedAt)
        throw new ScheduledMonitorRunError(
          run.cancelRequestedAt ? 'cancelled' : 'state',
        );
      // Completion after business commit intentionally ignores the 25 minute
      // freshness clock. The original child is preserved; no catalog read occurs.
      await tx.query(
        `UPDATE ${this.runs} SET state='completed',completed_at=$2::timestamptz WHERE task_id=$1`,
        [job.taskId, await this.now(tx)],
      );
      return (await this.existing(tx, job))!;
    }, signal);
  }
}

export class PgPrimaryScheduledMonitorRunRepository extends PgScheduledMonitorRunRepository {
  constructor(
    pool: Pool,
    options?: ConstructorParameters<typeof PgScheduledMonitorRunRepository>[2],
  ) {
    super(pool, 'primary', options);
  }
}
export class PgCompetitorScheduledMonitorRunRepository extends PgScheduledMonitorRunRepository {
  constructor(
    pool: Pool,
    options?: ConstructorParameters<typeof PgScheduledMonitorRunRepository>[2],
  ) {
    super(pool, 'competitor', options);
  }
}
