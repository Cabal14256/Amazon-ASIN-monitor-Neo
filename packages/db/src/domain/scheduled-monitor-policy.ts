import {
  buildScheduledMonitorJobId,
  SCHEDULED_MONITOR_MAX_BATCHES,
  scheduledMonitorJobSchema,
  type ScheduledMonitorJob,
  type ScheduledMonitorPlan,
} from '@asin-monitor/contracts';
import { createHash } from 'node:crypto';

export const DEFAULT_SCHEDULED_MONITOR_MAX_AGE_MS = 25 * 60 * 1000;
export type ScheduledMonitorFreshness = {
  stale: boolean;
  reason:
    | 'missing_requested_at'
    | 'scheduled_job_expired'
    | 'invalid_source'
    | null;
  ageMs: number | null;
  maxAgeMs: number;
  timestampSource: 'requestedAt' | 'queue' | null;
};

function validTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}
/** Only a canonical payload timestamp or the actual immutable Bull timestamp
 * can establish freshness. Manual callers remain outside this policy. */
export function evaluateScheduledMonitorFreshness(
  data: { source: unknown; requestedAt?: unknown },
  queueTimestamp: unknown,
  nowMs: number,
  maxAgeMs = DEFAULT_SCHEDULED_MONITOR_MAX_AGE_MS,
): ScheduledMonitorFreshness {
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isFinite(new Date(nowMs).getTime()) ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs <= 0
  )
    throw new RangeError('Invalid scheduled freshness clock or limit');
  const base = { ageMs: null, maxAgeMs, timestampSource: null } as const;
  if (data.source === 'manual')
    return { ...base, stale: false, reason: null, ageMs: 0 };
  if (data.source !== 'scheduled')
    return { ...base, stale: true, reason: 'invalid_source' };
  const parsed =
    typeof data.requestedAt === 'string' ? Date.parse(data.requestedAt) : NaN;
  const canonical =
    validTimestamp(parsed) &&
    new Date(parsed).toISOString() === data.requestedAt;
  const requestedAt = canonical
    ? parsed
    : validTimestamp(queueTimestamp) && queueTimestamp > 0
    ? queueTimestamp
    : null;
  if (requestedAt === null)
    return { ...base, stale: true, reason: 'missing_requested_at' };
  const ageMs = Math.max(nowMs - requestedAt, 0);
  const stale = ageMs > maxAgeMs;
  return {
    stale,
    reason: stale ? 'scheduled_job_expired' : null,
    ageMs,
    maxAgeMs,
    timestampSource: canonical ? 'requestedAt' : 'queue',
  };
}

function batches(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > SCHEDULED_MONITOR_MAX_BATCHES
  )
    throw new RangeError('Invalid scheduled batch count');
}
export function scheduledMonitorBatchIndex(
  epochMs: number,
  intervalMinutes: number,
  totalBatches: number,
): number {
  batches(totalBatches);
  if (
    !Number.isSafeInteger(epochMs) ||
    !Number.isFinite(new Date(epochMs).getTime()) ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 1440
  )
    throw new RangeError('Invalid scheduled batch slot');
  const slot = Math.floor(epochMs / (intervalMinutes * 60000));
  return ((slot % totalBatches) + totalBatches) % totalBatches;
}

/** UUIDv5 in a fixed private namespace; distinct incarnations cannot acquire
 * a different task ID merely because an enqueue acknowledgement was lost. */
export function scheduledMonitorTaskId(plan: ScheduledMonitorPlan): string {
  const namespace = Buffer.from('c986a8e6cf3e5f07b8a7c5c99b866894', 'hex');
  const digest = createHash('sha1')
    .update(namespace)
    .update(buildScheduledMonitorJobId(plan))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Consumer boundary: schema validation alone cannot authorize a replacement
 * task incarnation under the same stable Bull job ID. */
export function parseScheduledMonitorJob(value: unknown): ScheduledMonitorJob {
  const job = scheduledMonitorJobSchema.parse(value);
  if (
    job.taskId !==
    scheduledMonitorTaskId({
      domain: job.domain,
      country: job.country,
      plannedSlot: job.plannedSlot,
      intervalMinutes: job.intervalMinutes,
      batchConfig: job.batchConfig,
    })
  )
    throw new TypeError('Invalid scheduled monitor task identity');
  return job;
}

/** A stable slot UUID alone does not permit a retry to replace the original
 * requestedAt, retention or interval. Persist this complete immutable digest. */
export function scheduledMonitorJobDigest(value: unknown): string {
  const job = parseScheduledMonitorJob(value);
  return createHash('sha256')
    .update(
      JSON.stringify([
        job.version,
        job.source,
        job.taskType,
        job.actor.kind,
        job.actor.purpose,
        job.taskId,
        job.jobId,
        job.domain,
        job.country,
        job.plannedSlot,
        job.intervalMinutes,
        job.batchConfig.batchIndex,
        job.batchConfig.totalBatches,
        job.requestedAt,
        job.createdAt,
        job.expiresAt,
      ]),
    )
    .digest('hex');
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function rawIdBytes(id: string): Buffer {
  if (
    typeof id !== 'string' ||
    id.includes('\0') ||
    /[\uD800-\uDFFF]/u.test(id)
  )
    throw new TypeError('Invalid persisted monitor group ID');
  return Buffer.from(id, 'utf8');
}
/** MySQL CRC32(id): IEEE CRC32 of raw UTF-8 bytes, unsigned. No trimming,
 * case folding, locale collation or Unicode normalization is allowed. */
export function scheduledMonitorIdCrc32(id: string): number {
  let crc = 0xffffffff;
  for (const byte of rawIdBytes(id))
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
export function scheduledMonitorGroupBatch(
  id: string,
  totalBatches: number,
): number {
  batches(totalBatches);
  return scheduledMonitorIdCrc32(id) % totalBatches;
}

function nativeTimeKey(value: string): string {
  const match =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/.exec(
      value,
    );
  if (!match) throw new TypeError('Invalid scheduled monitor native timestamp');
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || day > days[month - 1])
    throw new TypeError('Invalid scheduled monitor native timestamp');
  return `${value.slice(0, 19)}.${(match[7] ?? '').padEnd(6, '0')}`;
}
/** Freeze from create_time::text, never a Date/display conversion. MySQL ASC
 * puts NULL first; SQL reads must use create_time ASC NULLS FIRST,id COLLATE "C".
 * The explicit native field prevents ORM millisecond Dates from being reused. */
export function orderScheduledMonitorGroups<
  T extends { id: string; createTimeNative: string | null },
>(groups: readonly T[]): T[] {
  const seen = new Set<string>();
  const rows = groups.map((group) => {
    const bytes = rawIdBytes(group.id);
    const time =
      group.createTimeNative === null
        ? null
        : nativeTimeKey(group.createTimeNative);
    if (seen.has(group.id))
      throw new TypeError('Invalid scheduled monitor group order');
    seen.add(group.id);
    return { group, bytes, time };
  });
  rows.sort((a, b) => {
    if (a.time === null && b.time !== null) return -1;
    if (a.time !== null && b.time === null) return 1;
    return (
      (a.time === null || b.time === null || a.time === b.time
        ? 0
        : a.time < b.time
        ? -1
        : 1) || Buffer.compare(a.bytes, b.bytes)
    );
  });
  return rows.map(({ group }) => group);
}
