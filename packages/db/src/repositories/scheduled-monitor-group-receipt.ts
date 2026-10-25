import type { ScheduledMonitorJob } from '@asin-monitor/contracts';
import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  parseScheduledMonitorJob,
  scheduledMonitorJobDigest,
} from '../domain/scheduled-monitor-policy';
import {
  parseScheduledMonitorSnapshot,
  scheduledMonitorGroupOperation,
  ScheduledMonitorRunError,
  type ScheduledMonitorCheck,
  type ScheduledMonitorGroupOperation,
  type ScheduledMonitorGroupSnapshot,
} from '../domain/scheduled-monitor-run';
import { decodeVariantCheckReceiptResult } from '../domain/variant-check-receipt';
import { assertScheduledMonitorLedger } from './scheduled-monitor-snapshot-check';

type Domain = ScheduledMonitorJob['domain'];

function assertReceiptResult(
  operation: ScheduledMonitorGroupOperation,
  value: unknown,
  frozen?: ScheduledMonitorGroupSnapshot,
): unknown {
  let result: unknown;
  try {
    result = decodeVariantCheckReceiptResult(value, operation.resultKind);
  } catch {
    throw new ScheduledMonitorRunError('identity');
  }
  const row =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {},
    group =
      row.groupSnapshot &&
      typeof row.groupSnapshot === 'object' &&
      !Array.isArray(row.groupSnapshot)
        ? (row.groupSnapshot as Record<string, unknown>)
        : {};
  if (
    group.id !== operation.groupId ||
    typeof group.country !== 'string' ||
    group.country.replace(/ +$/, '').toUpperCase() !== operation.country
  )
    throw new ScheduledMonitorRunError('identity');
  if (frozen) {
    const children = group.children;
    const members = new Map(
      frozen.members.map((member) => [member.id, member.asin]),
    );
    const broken = row.brokenASINs;
    if (
      !Array.isArray(children) ||
      children.length !== members.size ||
      new Set(
        children.map((child) => {
          const item =
            child && typeof child === 'object'
              ? (child as Record<string, unknown>)
              : {};
          return item.id;
        }),
      ).size !== children.length ||
      children.some((child) => {
        const item =
          child && typeof child === 'object'
            ? (child as Record<string, unknown>)
            : {};
        return (
          typeof item.id !== 'string' || members.get(item.id) !== item.asin
        );
      }) ||
      !Array.isArray(broken) ||
      new Set(
        broken.map((item) => {
          const value =
            item && typeof item === 'object'
              ? (item as Record<string, unknown>)
              : {};
          return value.asin;
        }),
      ).size !== broken.length ||
      broken.some((item) => {
        const value =
          item && typeof item === 'object'
            ? (item as Record<string, unknown>)
            : {};
        return (
          typeof value.asin !== 'string' ||
          ![...members.values()].includes(value.asin)
        );
      })
    )
      throw new ScheduledMonitorRunError('identity');
  }
  return result;
}

function assertOperation(
  operation: ScheduledMonitorGroupOperation,
  domain: Domain,
): void {
  if (
    operation.resultKind !==
      (domain === 'primary' ? 'group' : 'competitor-group') ||
    !/^[a-f0-9]{64}$/.test(operation.operationKey) ||
    !/^[a-f0-9]{64}$/.test(operation.requestHash) ||
    !/^[a-f0-9]{64}$/.test(operation.jobDigest) ||
    !/^[a-f0-9]{64}$/.test(operation.snapshotDigest) ||
    !Number.isInteger(operation.ordinal) ||
    operation.ordinal < 0 ||
    operation.ordinal >= 1000
  )
    throw new ScheduledMonitorRunError('identity');
}

async function assertWriteRun(
  db: Db,
  domain: Domain,
  operation: ScheduledMonitorGroupOperation,
  ensureOpen: () => void,
): Promise<ScheduledMonitorGroupSnapshot> {
  const table = sql.raw(`\"${domain}_scheduled_monitor_runs\"`);
  const rows = await db.execute(sql`
    SELECT job,job_digest,state,cancel_requested_at,
      expires_at > clock_timestamp() AS fresh,groups,snapshot_digest,total_members
    FROM ${table}
    WHERE task_id=${operation.taskId}::uuid
    FOR UPDATE
  `);
  ensureOpen();
  const row = rows.rows[0] as Record<string, unknown> | undefined;
  if (
    rows.rows.length !== 1 ||
    !row ||
    row.job_digest !== operation.jobDigest ||
    row.state !== 'running' ||
    row.cancel_requested_at !== null ||
    row.fresh !== true
  )
    throw new ScheduledMonitorRunError('identity');
  try {
    const job = parseScheduledMonitorJob(row.job);
    if (
      scheduledMonitorJobDigest(job) !== operation.jobDigest ||
      job.domain !== domain
    )
      throw new Error('identity');
    const snapshots = parseScheduledMonitorSnapshot(
      job,
      row.groups,
      typeof row.snapshot_digest === 'string' ? row.snapshot_digest : undefined,
      typeof row.total_members === 'number' ? row.total_members : undefined,
    );
    const group = snapshots[operation.ordinal];
    if (
      !group ||
      group.group.id !== operation.groupId ||
      group.country !== operation.country ||
      group.snapshotDigest !== operation.snapshotDigest
    )
      throw new Error('identity');
    return group;
  } catch {
    throw new ScheduledMonitorRunError('identity');
  }
}

/** Called from the business check transaction so history, status and the
 * private replay receipt either commit together or are all rolled back. */
export async function writeScheduledMonitorGroupReceipt(
  db: Db,
  domain: Domain,
  operation: ScheduledMonitorGroupOperation,
  value: unknown,
  ensureOpen: () => void,
): Promise<void> {
  assertOperation(operation, domain);
  const frozen = await assertWriteRun(db, domain, operation, ensureOpen);
  const result = assertReceiptResult(operation, value, frozen);
  const table = `${domain}_scheduled_monitor_group_receipts`;
  const qualifiedTable = sql.raw(`"${table}"`);
  const inserted = await db.execute(sql`
    INSERT INTO ${qualifiedTable}
      (operation_key,request_hash,task_id,job_digest,country,group_id,ordinal,snapshot_digest,result_kind,result)
    VALUES
      (${operation.operationKey},${operation.requestHash},${
    operation.taskId
  }::uuid,${operation.jobDigest},${operation.country},${operation.groupId},${
    operation.ordinal
  },${operation.snapshotDigest},${operation.resultKind},${JSON.stringify(
    result,
  )}::jsonb)
    ON CONFLICT (operation_key) DO NOTHING
    RETURNING operation_key
  `);
  ensureOpen();
  if (inserted.rowCount === 1) return;
  const existing = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${qualifiedTable}
      WHERE operation_key=${operation.operationKey}
        AND request_hash=${operation.requestHash}
        AND task_id=${operation.taskId}::uuid
        AND job_digest=${operation.jobDigest}
        AND country=${operation.country}
        AND group_id=${operation.groupId}
        AND ordinal=${operation.ordinal}
        AND snapshot_digest=${operation.snapshotDigest}
        AND result_kind=${operation.resultKind}
        AND result=${JSON.stringify(result)}::jsonb
    ) AS matches
  `);
  ensureOpen();
  if (existing.rows[0]?.matches !== true)
    throw new ScheduledMonitorRunError('identity');
}

/** Replay a receipt from the same business transaction. Freshness is ignored
 * after the receipt has committed; the immutable job and frozen group identity
 * are still locked and verified. */
export async function readScheduledMonitorGroupReceipt(
  db: Db,
  check: ScheduledMonitorCheck,
  ensureOpen: () => void,
): Promise<unknown | undefined> {
  const identity = await assertScheduledMonitorLedger(db, check, ensureOpen, {
    active: false,
  });
  const operation = scheduledMonitorGroupOperation(
    identity.job,
    identity.group,
  );
  assertOperation(operation, identity.job.domain);
  const table = sql.raw(
    `\"${identity.job.domain}_scheduled_monitor_group_receipts\"`,
  );
  const rows = await db.execute(sql`
    SELECT operation_key,request_hash,task_id,job_digest,country,group_id,
      ordinal,snapshot_digest,result_kind,result
    FROM ${table}
    WHERE operation_key=${operation.operationKey}
    FOR UPDATE
  `);
  ensureOpen();
  if (!rows.rows.length) return undefined;
  if (rows.rows.length !== 1) throw new ScheduledMonitorRunError('identity');
  const row = rows.rows[0] as Record<string, unknown>;
  if (
    row.operation_key !== operation.operationKey ||
    row.request_hash !== operation.requestHash ||
    row.task_id !== operation.taskId ||
    row.job_digest !== operation.jobDigest ||
    row.country !== operation.country ||
    row.group_id !== operation.groupId ||
    row.ordinal !== operation.ordinal ||
    row.snapshot_digest !== operation.snapshotDigest ||
    row.result_kind !== operation.resultKind
  )
    throw new ScheduledMonitorRunError('identity');
  return assertReceiptResult(operation, row.result);
}
