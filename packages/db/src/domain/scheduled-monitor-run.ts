import { buildScheduledMonitorJobId, type ScheduledMonitorJob } from '@asin-monitor/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  orderScheduledMonitorGroups,
  parseScheduledMonitorJob,
  scheduledMonitorGroupBatch,
  scheduledMonitorJobDigest,
  scheduledMonitorTaskId,
} from './scheduled-monitor-policy';

export const SCHEDULED_MONITOR_MAX_GROUPS = 1000;
export const SCHEDULED_MONITOR_MAX_MEMBERS = 20_000;
export const SCHEDULED_MONITOR_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const SCHEDULED_MONITOR_MAX_RESULT_BYTES = 32 * 1024 * 1024;

export class ScheduledMonitorRunError extends Error {
  constructor(
    readonly code:
      | 'input'
      | 'identity'
      | 'snapshot'
      | 'capacity'
      | 'state'
      | 'expired'
      | 'cancelled'
      | 'dependency'
      | 'timeout'
      | 'closed'
      | 'commit-uncertain',
  ) {
    super(`Scheduled monitor run ${code}`);
    this.name = 'ScheduledMonitorRunError';
  }
}

const text = (maximum: number, minimum = 0) =>
  z.string().refine(
    (value) =>
      [...value].length >= minimum &&
      [...value].length <= maximum &&
      !value.includes('\0') &&
      !/[\uD800-\uDFFF]/u.test(value),
  );
const id = text(50, 1);
const flag = z.boolean().nullable();
const nativeTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/)
  .refine((value) => {
    try {
      orderScheduledMonitorGroups([{ id: 'timestamp', createTimeNative: value }]);
      return true;
    } catch {
      return false;
    }
  })
  .nullable();
const instant = z.string().datetime().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  id,
  name: text(255),
  country: text(10, 1),
  brand: text(100),
  is_broken: flag,
  variant_status: text(20).nullable(),
  feishu_notify_enabled: flag,
  create_time: nativeTime,
  update_time: nativeTime,
  last_check_time: nativeTime,
};
const manual = {
  manual_broken: flag,
  manual_broken_reason: text(500).nullable(),
  manual_broken_updated_at: nativeTime,
  manual_broken_updated_by: text(100).nullable(),
};
const primaryGroup = z.object({
  ...common,
  site: text(100),
  ...manual,
  is_competitor: flag,
}).strict();
const competitorGroup = z.object(common).strict();
const memberCommon = {
  ...common,
  name: text(500).nullable(),
  asin: text(20, 1),
  asin_type: text(20).nullable(),
  variant_group_id: id,
};
const primaryMember = z.object({
  ...memberCommon,
  site: text(100),
  ...manual,
  manual_excluded_from_group: flag,
  manual_excluded_reason: text(500).nullable(),
  manual_excluded_updated_at: nativeTime,
  manual_excluded_updated_by: text(100).nullable(),
}).strict();
const competitorMember = z.object(memberCommon).strict();
const envelope = {
  version: z.literal(1),
  ordinal: z.number().int().min(0).max(SCHEDULED_MONITOR_MAX_GROUPS - 1),
  country: z.enum(['US', 'UK', 'DE', 'FR', 'ES', 'IT']),
  snapshotDigest: digest,
};
export const scheduledMonitorGroupSnapshotSchema = z.discriminatedUnion('domain', [
  z.object({
    ...envelope,
    domain: z.literal('primary'),
    group: primaryGroup,
    members: z.array(primaryMember).max(SCHEDULED_MONITOR_MAX_MEMBERS),
  }).strict(),
  z.object({
    ...envelope,
    domain: z.literal('competitor'),
    group: competitorGroup,
    members: z.array(competitorMember).max(SCHEDULED_MONITOR_MAX_MEMBERS),
  }).strict(),
]);
export type ScheduledMonitorGroupSnapshot = z.infer<typeof scheduledMonitorGroupSnapshotSchema>;

/** Canonical JSON covers raw row fields, including microseconds and status.
 * It intentionally does not normalize identifiers, countries or display text. */
function canonical(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([key, child]) => [key, visit(child)]),
      );
    return item;
  };
  return JSON.stringify(visit(value));
}
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** JSONB adds spaces outside strings. Reuse its upper bound rather than relying
 * on compact transport JSON, which can cross the database CHECK boundary. */
export function scheduledMonitorStorageBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (!json) throw new ScheduledMonitorRunError('input');
  let bytes = Buffer.byteLength(json), quoted = false, escaped = false;
  for (const character of json) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ':' || character === ',') bytes++;
    else if (character === 'e' || character === 'E') bytes += 320;
  }
  return bytes;
}
export function scheduledMonitorGroupSnapshotDigest(
  snapshot: Omit<ScheduledMonitorGroupSnapshot, 'snapshotDigest'>,
): string {
  return sha(snapshot);
}
const country = (value: string) => value.replace(/ +$/, '').toUpperCase();
const orderedRows = <T extends { id: string; create_time: string | null }>(rows: T[]) =>
  orderScheduledMonitorGroups(rows.map((row) => ({
    ...row, createTimeNative: row.create_time,
  }))).map(({ createTimeNative: _native, ...row }) => row as T);

export function parseScheduledMonitorSnapshot(
  inputJob: unknown,
  value: unknown,
  expectedDigest?: string,
  expectedMembers?: number,
): ScheduledMonitorGroupSnapshot[] {
  const job = parseScheduledMonitorJob(inputJob);
  if (!Array.isArray(value) || value.length > SCHEDULED_MONITOR_MAX_GROUPS)
    throw new ScheduledMonitorRunError('capacity');
  if (scheduledMonitorStorageBytes(value) > SCHEDULED_MONITOR_MAX_SNAPSHOT_BYTES)
    throw new ScheduledMonitorRunError('capacity');
  const parsed = z.array(scheduledMonitorGroupSnapshotSchema).safeParse(value);
  if (!parsed.success) throw new ScheduledMonitorRunError('snapshot');
  const snapshots = parsed.data;
  const groups = new Set<string>(), members = new Set<string>();
  let count = 0;
  for (const [ordinal, snapshot] of snapshots.entries()) {
    const { snapshotDigest, ...content } = snapshot;
    if (
      snapshot.ordinal !== ordinal || snapshot.domain !== job.domain ||
      snapshot.country !== job.country || country(snapshot.group.country) !== job.country ||
      ('is_competitor' in snapshot.group && snapshot.group.is_competitor === true) ||
      groups.has(snapshot.group.id) ||
      scheduledMonitorGroupBatch(snapshot.group.id, job.batchConfig.totalBatches) !== job.batchConfig.batchIndex ||
      snapshotDigest !== scheduledMonitorGroupSnapshotDigest(content)
    ) throw new ScheduledMonitorRunError('snapshot');
    groups.add(snapshot.group.id);
    const ordered = orderedRows(snapshot.members);
    if (ordered.some((member, index) => member.id !== snapshot.members[index].id))
      throw new ScheduledMonitorRunError('snapshot');
    for (const member of snapshot.members) {
      if (members.has(member.id) || member.variant_group_id !== snapshot.group.id || country(member.country) !== job.country)
        throw new ScheduledMonitorRunError('snapshot');
      members.add(member.id);
      if (++count > SCHEDULED_MONITOR_MAX_MEMBERS)
        throw new ScheduledMonitorRunError('capacity');
    }
  }
  const ordered = orderedRows(snapshots.map((snapshot) => snapshot.group));
  if (ordered.some((group, index) => group.id !== snapshots[index].group.id))
    throw new ScheduledMonitorRunError('snapshot');
  if ((expectedMembers !== undefined && expectedMembers !== count) ||
      (expectedDigest !== undefined && expectedDigest !== scheduledMonitorSnapshotDigest(job, snapshots)))
    throw new ScheduledMonitorRunError('snapshot');
  return snapshots;
}
export function scheduledMonitorSnapshotDigest(
  job: ScheduledMonitorJob,
  snapshots: readonly ScheduledMonitorGroupSnapshot[],
): string {
  return sha([scheduledMonitorJobDigest(job), snapshots]);
}
export function freezeScheduledMonitorSnapshot(
  inputJob: unknown,
  groupRows: unknown[],
  memberRows: unknown[],
): ScheduledMonitorGroupSnapshot[] {
  const job = parseScheduledMonitorJob(inputJob);
  if (groupRows.length > SCHEDULED_MONITOR_MAX_GROUPS || memberRows.length > SCHEDULED_MONITOR_MAX_MEMBERS)
    throw new ScheduledMonitorRunError('capacity');
  const groupSchema = job.domain === 'primary' ? primaryGroup : competitorGroup;
  const memberSchema = job.domain === 'primary' ? primaryMember : competitorMember;
  const groups = orderedRows(groupRows.map((row) => groupSchema.parse(row)));
  const members = orderedRows(memberRows.map((row) => memberSchema.parse(row)));
  const byGroup = new Map<string, unknown[]>();
  for (const member of members) {
    const rows = byGroup.get(member.variant_group_id) ?? [];
    rows.push(member);
    byGroup.set(member.variant_group_id, rows);
  }
  const snapshots = groups.map((group, ordinal) => {
    const content = {
      version: 1 as const, ordinal, domain: job.domain, country: job.country,
      group, members: byGroup.get(group.id) ?? [],
    };
    return { ...content, snapshotDigest: sha(content) };
  });
  if (snapshots.reduce((sum, snapshot) => sum + snapshot.members.length, 0) !== members.length)
    throw new ScheduledMonitorRunError('snapshot');
  return parseScheduledMonitorSnapshot(job, snapshots);
}

export const scheduledMonitorRunStateSchema = z.enum([
  'pending', 'running', 'business-completed', 'completed', 'skipped-expired', 'cancelled', 'failed',
]);
export type ScheduledMonitorRunState = z.infer<typeof scheduledMonitorRunStateSchema>;
export const scheduledMonitorBusinessResultSchema = z.object({
  version: z.literal(1),
  totalGroups: z.number().int().min(0).max(SCHEDULED_MONITOR_MAX_GROUPS),
  totalMembers: z.number().int().min(0).max(SCHEDULED_MONITOR_MAX_MEMBERS),
  brokenGroups: z.number().int().min(0).max(SCHEDULED_MONITOR_MAX_GROUPS),
  brokenMembers: z.number().int().min(0).max(SCHEDULED_MONITOR_MAX_MEMBERS),
}).strict().refine((value) => value.brokenGroups <= value.totalGroups && value.brokenMembers <= value.totalMembers);
export type ScheduledMonitorBusinessResult = z.infer<typeof scheduledMonitorBusinessResultSchema>;
export interface ScheduledMonitorRun {
  job: ScheduledMonitorJob;
  jobDigest: string;
  groups: ScheduledMonitorGroupSnapshot[];
  snapshotDigest: string;
  totalMembers: number;
  state: ScheduledMonitorRunState;
  businessCompletedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  result: ScheduledMonitorBusinessResult | null;
  followUpJob: ScheduledMonitorJob | null;
  followUpDigest: string | null;
}

export function assertScheduledMonitorFollowUp(
  parent: ScheduledMonitorJob,
  businessCompletedAt: string,
  rawChild: unknown,
  expectedDigest?: string,
): ScheduledMonitorJob {
  const child = parseScheduledMonitorJob(rawChild);
  if (!instant.safeParse(businessCompletedAt).success ||
      parent.domain !== 'primary' || parent.country !== 'US' || child.domain !== 'competitor' || child.country !== 'US' ||
      child.plannedSlot !== parent.plannedSlot || child.intervalMinutes !== parent.intervalMinutes ||
      child.batchConfig.batchIndex !== parent.batchConfig.batchIndex || child.batchConfig.totalBatches !== parent.batchConfig.totalBatches ||
      child.requestedAt < businessCompletedAt ||
      (expectedDigest !== undefined && scheduledMonitorJobDigest(child) !== expectedDigest))
    throw new ScheduledMonitorRunError('identity');
  return child;
}

/** Build once with the actual business-commit boundary, then persist the entire
 * payload. Replay must return it rather than generating a newer requestedAt. */
export function createScheduledMonitorFollowUp(parent: ScheduledMonitorJob, businessCompletedAt: string): ScheduledMonitorJob {
  const job = parseScheduledMonitorJob(parent);
  const plan = {
    domain: 'competitor' as const,
    country: 'US' as const,
    plannedSlot: job.plannedSlot,
    intervalMinutes: job.intervalMinutes,
    batchConfig: { ...job.batchConfig },
  };
  return assertScheduledMonitorFollowUp(job,businessCompletedAt,{
    ...plan,
    version: 1,
    source: 'scheduled',
    taskType: 'scheduled-monitor',
    actor: { kind: 'system', purpose: 'scheduled-monitor' },
    taskId: scheduledMonitorTaskId(plan),
    jobId: buildScheduledMonitorJobId(plan),
    requestedAt: businessCompletedAt,
    createdAt: businessCompletedAt,
    expiresAt: job.expiresAt,
  });
}

/** Stable operation keys exclude the mutable request digest, so replacement
 * snapshots cannot create a second successful write under the same ordinal. */
export function scheduledMonitorGroupOperation(job: ScheduledMonitorJob, group: ScheduledMonitorGroupSnapshot) {
  job = parseScheduledMonitorJob(job);
  const parsed = scheduledMonitorGroupSnapshotSchema.safeParse(group);
  if (!parsed.success || scheduledMonitorStorageBytes(group) > SCHEDULED_MONITOR_MAX_SNAPSHOT_BYTES)
    throw new ScheduledMonitorRunError('snapshot');
  group = parsed.data;
  const { snapshotDigest, ...content } = group;
  if (group.domain !== job.domain || group.country !== job.country || country(group.group.country) !== job.country ||
      ('is_competitor' in group.group && group.group.is_competitor === true) ||
      scheduledMonitorGroupBatch(group.group.id,job.batchConfig.totalBatches) !== job.batchConfig.batchIndex ||
      snapshotDigest !== scheduledMonitorGroupSnapshotDigest(content) ||
      new Set(group.members.map((member) => member.id)).size !== group.members.length ||
      group.members.some((member) => member.variant_group_id !== group.group.id || country(member.country) !== job.country) ||
      orderedRows(group.members).some((member,index) => member.id !== group.members[index].id))
    throw new ScheduledMonitorRunError('snapshot');
  const jobDigest = scheduledMonitorJobDigest(job);
  return {
    operationKey: sha(['scheduled-monitor-group', job.taskId, group.ordinal]),
    requestHash: sha([jobDigest, group.country, group.group.id, group.snapshotDigest]),
    taskId: job.taskId, jobDigest, country: job.country,
    groupId: group.group.id, ordinal: group.ordinal, snapshotDigest: group.snapshotDigest,
    resultKind: job.domain === 'primary' ? 'group' as const : 'competitor-group' as const,
  };
}
