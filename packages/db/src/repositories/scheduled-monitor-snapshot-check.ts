import type { ScheduledMonitorJob } from '@asin-monitor/contracts';
import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  parseScheduledMonitorJob,
  scheduledMonitorJobDigest,
} from '../domain/scheduled-monitor-policy';
import {
  freezeScheduledMonitorGroupSnapshot,
  parseScheduledMonitorGroupSnapshot,
  parseScheduledMonitorSnapshot,
  ScheduledMonitorRunError,
  type ScheduledMonitorCheck,
  type ScheduledMonitorGroupSnapshot,
} from '../domain/scheduled-monitor-run';
import { VariantCheckError } from '../domain/variant-check';

const fields = (alias: string, names: readonly string[]) =>
  `jsonb_build_object(${names
    .map(
      (name) =>
        `'${name}',to_char(${alias}.${name},'YYYY-MM-DD HH24:MI:SS.US')`,
    )
    .join(',')})`;

const ledgerTable = (domain: ScheduledMonitorJob['domain']) =>
  sql.raw(`"${domain}_scheduled_monitor_runs"`);

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

export interface ScheduledMonitorLedgerIdentity {
  job: ScheduledMonitorJob;
  jobDigest: string;
  group: ScheduledMonitorGroupSnapshot;
}

/** Lock and validate the private ledger row before touching catalog state. */
export async function assertScheduledMonitorLedger(
  db: Db,
  check: ScheduledMonitorCheck,
  ensureOpen: () => void,
  options: { active?: boolean } = {},
): Promise<ScheduledMonitorLedgerIdentity> {
  const job = parseScheduledMonitorJob(check.job);
  const group = parseScheduledMonitorGroupSnapshot(job, check.group);
  const expectedDigest = scheduledMonitorJobDigest(job);
  const rows = await db.execute(sql`
    SELECT task_id,job_id,job,job_digest,domain,country,interval_minutes,
      batch_index,total_batches,groups,snapshot_digest,total_members,state,
      business_completed_at,completed_at,cancel_requested_at,
      expires_at > clock_timestamp() AS fresh
    FROM ${ledgerTable(job.domain)}
    WHERE task_id=${job.taskId}::uuid
    FOR UPDATE
  `);
  ensureOpen();
  const row = rows.rows[0] as Record<string, unknown> | undefined;
  if (
    rows.rows.length !== 1 ||
    !row ||
    row.task_id !== job.taskId ||
    row.job_id !== job.jobId ||
    row.job_digest !== expectedDigest ||
    row.domain !== job.domain ||
    row.country !== job.country ||
    row.interval_minutes !== job.intervalMinutes ||
    row.batch_index !== job.batchConfig.batchIndex ||
    row.total_batches !== job.batchConfig.totalBatches ||
    (options.active !== false &&
      (row.state !== 'running' ||
        row.business_completed_at !== null ||
        row.completed_at !== null ||
        row.cancel_requested_at !== null)) ||
    (options.active === false &&
      !['business-completed', 'completed'].includes(String(row.state)))
  )
    throw new VariantCheckError('snapshot-changed');
  if (options.active !== false && row.fresh !== true)
    throw new ScheduledMonitorRunError('expired');
  let storedJob: ScheduledMonitorJob;
  let snapshots: ScheduledMonitorGroupSnapshot[];
  try {
    storedJob = parseScheduledMonitorJob(row.job);
    snapshots = parseScheduledMonitorSnapshot(
      storedJob,
      row.groups,
      typeof row.snapshot_digest === 'string' ? row.snapshot_digest : undefined,
      typeof row.total_members === 'number' ? row.total_members : undefined,
    );
  } catch {
    throw new VariantCheckError('snapshot-changed');
  }
  if (
    scheduledMonitorJobDigest(storedJob) !== expectedDigest ||
    canonical(storedJob) !== canonical(job)
  )
    throw new VariantCheckError('snapshot-changed');
  const frozen = snapshots[group.ordinal];
  if (
    !frozen ||
    frozen.snapshotDigest !== group.snapshotDigest ||
    canonical(frozen) !== canonical(group)
  )
    throw new VariantCheckError('snapshot-changed');
  return { job, jobDigest: expectedDigest, group: frozen };
}

/** Compare against native microsecond values in the business database. ORM
 * Date conversion is unsuitable here because it loses fractional precision. */
export async function assertScheduledMonitorSnapshot(
  db: Db,
  check: ScheduledMonitorCheck,
  ensureOpen: () => void,
): Promise<void> {
  const ledger = await assertScheduledMonitorLedger(db, check, ensureOpen);
  const primary = ledger.job.domain === 'primary';
  const groupTable = sql.raw(
    primary ? '"variant_groups"' : '"competitor_variant_groups"',
  );
  const memberTable = sql.raw(primary ? '"asins"' : '"competitor_asins"');
  const groupTimes = primary
    ? [
        'create_time',
        'update_time',
        'last_check_time',
        'manual_broken_updated_at',
      ]
    : ['create_time', 'update_time', 'last_check_time'];
  const memberTimes = primary
    ? [
        'create_time',
        'update_time',
        'last_check_time',
        'manual_broken_updated_at',
        'manual_excluded_updated_at',
      ]
    : ['create_time', 'update_time', 'last_check_time'];
  const groups = await db.execute(sql`
    SELECT to_jsonb(g) || ${sql.raw(fields('g', groupTimes))} AS value
    FROM ${groupTable} g
    WHERE g.id=${check.group.group.id}
    LIMIT 2
  `);
  ensureOpen();
  const members = await db.execute(sql`
    SELECT to_jsonb(a) || ${sql.raw(fields('a', memberTimes))} AS value
    FROM ${memberTable} a
    WHERE a.variant_group_id=${check.group.group.id}
    ORDER BY a.create_time ASC NULLS FIRST,a.id COLLATE "C"
  `);
  ensureOpen();
  try {
    if (groups.rows.length !== 1 || groups.rows[0]?.value === undefined)
      throw new Error('missing group');
    const current = freezeScheduledMonitorGroupSnapshot(
      ledger.job,
      ledger.group.ordinal,
      groups.rows[0].value,
      members.rows.map((row) => row.value),
    );
    if (current.snapshotDigest !== ledger.group.snapshotDigest)
      throw new Error('snapshot changed');
  } catch {
    throw new VariantCheckError('snapshot-changed');
  }
}
