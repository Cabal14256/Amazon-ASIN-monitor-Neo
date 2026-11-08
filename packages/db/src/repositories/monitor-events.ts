import type { Env } from '@asin-monitor/config';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { TASK_RECORD_MAX_BYTES } from './redis-task-repository';
import { taskStateSchema, type TaskState } from './task-state';

export const MONITOR_MESSAGE_MAX_BYTES = 1024 * 1024;
export const MONITOR_PROOF_MAX_BYTES = MONITOR_MESSAGE_MAX_BYTES + 2048;
export const MONITOR_NOTICE_MAX_BYTES = 4096;
const country = z.enum(['US', 'UK', 'DE', 'FR', 'IT', 'ES']);
const text = z.string().max(2048);
const count = z.number().int().min(0).max(20_000);
const classifications = z.enum(['SP_API_ERROR', 'NOT_FOUND', 'NO_VARIANTS']);
const manual = {
  statusSource: text,
  manualBroken: z.union([z.literal(0), z.literal(1)]),
  manualBrokenReason: text,
  manualBrokenUpdatedAt: text.nullable(),
  manualBrokenUpdatedBy: text.nullable(),
};
const countryResult = z
  .object({
    country,
    totalGroups: count,
    brokenGroups: count,
    brokenGroupNames: z.array(text).max(1000),
    brokenGroupDetails: z
      .array(
        z
          .object({
            variantGroupId: text,
            groupName: text.nullable(),
            ...Object.fromEntries(
              Object.entries(manual).map(([key, schema]) => [
                key,
                schema.optional(),
              ]),
            ),
          })
          .strict(),
      )
      .max(1000),
    brokenASINs: z
      .array(
        z
          .object({
            asin: text,
            asinId: text.optional(),
            name: text,
            variantGroupId: text,
            groupName: text,
            brand: text,
            errorType: z
              .enum([
                'SP_API_ERROR',
                'NOT_FOUND',
                'NO_VARIANTS',
                'MANUAL_MARKED',
              ])
              .nullable(),
            ...Object.fromEntries(
              Object.entries(manual).map(([key, schema]) => [
                key,
                schema.optional(),
              ]),
            ),
          })
          .strict(),
      )
      .max(20_000),
    brokenByType: z
      .object({ SP_API_ERROR: count, NOT_FOUND: count, NO_VARIANTS: count })
      .strict(),
    asinClassifications: z.record(z.string().max(4096), classifications),
    checkedGroupKeys: z.array(text).max(1000),
    checkTime: z.string().datetime(),
  })
  .strict()
  .refine(
    (r) =>
      r.totalGroups <= 1000 &&
      r.brokenGroups <= r.totalGroups &&
      r.checkedGroupKeys.length === r.totalGroups &&
      r.brokenGroupNames.length === r.brokenGroups &&
      r.brokenGroupDetails.length === r.brokenGroups &&
      Object.keys(r.asinClassifications).length <= 20_000,
  );
export type MonitorCountryResult = z.infer<typeof countryResult>;
const timestamp = z.string().datetime({ offset: true });
const started = z
  .object({
    type: z.literal('monitor_progress'),
    status: z.literal('started'),
    countries: z.array(country).min(1).max(6),
    batchInfo: z.null(),
    timestamp,
    isCompetitor: z.literal(true).optional(),
  })
  .strict();
const progress = z
  .object({
    type: z.literal('monitor_progress'),
    status: z.literal('progress'),
    country,
    current: count,
    total: count,
    progress: z.number().int().min(0).max(100),
    timestamp,
    isCompetitor: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (m) =>
      m.total > 0 &&
      m.current > 0 &&
      m.current <= m.total &&
      m.progress === Math.round((m.current / m.total) * 100),
  );
const complete = z
  .object({
    type: z.literal('monitor_complete'),
    success: z.literal(true),
    totalChecked: count,
    totalBroken: count,
    totalNormal: count,
    duration: z
      .string()
      .regex(/^\d+\.\d{2}$/)
      .max(30),
    countryResults: z.record(country, countryResult),
    timestamp,
    isCompetitor: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (m) =>
      m.totalChecked === m.totalNormal + m.totalBroken &&
      m.totalChecked ===
        Object.values(m.countryResults).reduce(
          (n, r) => n + r.totalGroups,
          0,
        ) &&
      m.totalBroken ===
        Object.values(m.countryResults).reduce(
          (n, r) => n + r.brokenGroups,
          0,
        ) &&
      Object.entries(m.countryResults).every(
        ([key, r]) => key === r.country && r.brokenGroups <= r.totalGroups,
      ),
  );
export const monitorMessageSchema = z.union([started, progress, complete]);
export type MonitorMessage = z.infer<typeof monitorMessageSchema>;
export const monitorNoticeSchema = taskStateSchema
  .pick({ taskId: true, userId: true, createdAt: true, revision: true })
  .extend({
    version: z.literal(1),
    type: z.literal('monitor_changed'),
    taskType: z.enum(['monitor', 'competitor-monitor']),
    taskSubType: z.enum(['primary', 'competitor']),
    slot: z.enum(['started', 'US', 'UK', 'DE', 'FR', 'IT', 'ES', 'complete']),
    sequence: z.number().int().min(0).max(7000),
  })
  .strict()
  .refine((n) => (n.taskType === 'monitor') === (n.taskSubType === 'primary'));
export type MonitorNotice = z.infer<typeof monitorNoticeSchema>;
const proofSchema = z
  .object({ notice: monitorNoticeSchema, message: monitorMessageSchema })
  .strict();
export type MonitorProof = z.infer<typeof proofSchema>;
export function monitorEventChannel(prefix: string): string {
  if (!prefix.trim()) throw new Error('MONITOR_EVENT_CONFIG_INVALID');
  return `${prefix.trim()}:neo:monitor:events`;
}
export function parseMonitorNotice(raw: string): MonitorNotice | null {
  if (Buffer.byteLength(raw) > MONITOR_NOTICE_MAX_BYTES) return null;
  try {
    const value = monitorNoticeSchema.safeParse(JSON.parse(raw));
    return value.success ? value.data : null;
  } catch {
    return null;
  }
}
export function monitorIdentity(
  task: Pick<
    TaskState,
    'taskId' | 'userId' | 'taskType' | 'taskSubType' | 'createdAt'
  >,
): string {
  return JSON.stringify([
    task.taskId,
    task.userId,
    task.taskType,
    task.taskSubType,
    task.createdAt,
  ]);
}
export function validMonitorProof(
  task: TaskState,
  proof: MonitorProof,
): boolean {
  const { notice: n, message: m } = proof;
  if (
    monitorIdentity(task) !== monitorIdentity(n) ||
    task.revision < n.revision ||
    task.cancelRequestedAt ||
    !!m.isCompetitor !== (n.taskType === 'competitor-monitor')
  )
    return false;
  if (m.type === 'monitor_complete') {
    const result = task.result as Record<string, unknown> | null;
    const countries = result?.countryResults;
    if (!countries || typeof countries !== 'object' || Array.isArray(countries))
      return false;
    const rows = countries as Record<
      string,
      { totalGroups?: unknown; brokenGroups?: unknown }
    >;
    return (
      n.slot === 'complete' &&
      n.sequence === 7000 &&
      task.status === 'completed' &&
      !!result &&
      result.success === true &&
      result.totalChecked === m.totalChecked &&
      result.totalBroken === m.totalBroken &&
      result.totalNormal === m.totalNormal &&
      Object.keys(rows).length === Object.keys(m.countryResults).length &&
      Object.entries(m.countryResults).every(
        ([key, row]) =>
          !!rows[key] &&
          rows[key].totalGroups === row.totalGroups &&
          rows[key].brokenGroups === row.brokenGroups,
      )
    );
  }
  if (task.status !== 'processing') return false;
  return m.status === 'started'
    ? n.slot === 'started' && n.sequence === 0
    : n.slot === m.country &&
        n.sequence > 0 &&
        n.sequence < 7000 &&
        (n.sequence - m.current) % 1001 === 0;
}

/** Count escaped JSON bytes as serialization visits each value, before Zod's
 * deep traversal. Abort before creating an oversized encoded payload. */
function budgetedJson(value: unknown, maxBytes: number): string {
  let bytes = 0;
  return JSON.stringify(value, function (key, item: unknown) {
    if (item && typeof item === 'object') {
      const keys = Object.keys(item);
      if (keys.length > 20_000) throw new Error('MONITOR_EVENT_TOO_LARGE');
      bytes += 2 + Math.max(keys.length - 1, 0);
      if (!Array.isArray(item))
        for (const property of keys)
          bytes += Buffer.byteLength(JSON.stringify(property)) + 1;
    } else {
      if (
        ['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))
      )
        throw new Error('MONITOR_EVENT_NON_JSON');
      bytes += Buffer.byteLength(JSON.stringify(item));
    }
    if (bytes > maxBytes) throw new Error('MONITOR_EVENT_TOO_LARGE');
    return item;
  });
}

// Eight fixed slots: started, six country progress snapshots and completion.
// Each progress slot is <=4KiB, so it cannot consume completion's 1MiB budget.
// The per-slot high water survives Worker retries; no cross-country ordering.
const SAVE = `
if redis.call('STRLEN', KEYS[1]) > 262144 then return 0 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, task = pcall(cjson.decode, raw)
if not ok or task.taskId ~= ARGV[1] or task.userId ~= ARGV[2] or task.taskType ~= ARGV[3] or task.taskSubType ~= ARGV[4] or task.createdAt ~= ARGV[5] or task.revision ~= tonumber(ARGV[6]) or task.status ~= ARGV[7] or task.cancelRequestedAt ~= cjson.null then return 0 end
local previous = tonumber(redis.call('HGET', KEYS[2], 'seq:' .. ARGV[8]) or '-1')
if previous >= tonumber(ARGV[9]) then return 0 end
redis.call('HSET', KEYS[2], 'seq:' .. ARGV[8], ARGV[9], ARGV[8], ARGV[10])
redis.call('EXPIRE', KEYS[2], ARGV[11])
local sent = redis.pcall('PUBLISH', ARGV[12], ARGV[13])
if type(sent) == 'table' and sent.err then return 2 end
return 1
`;
const READ = `
if redis.call('STRLEN', KEYS[1]) > tonumber(ARGV[2]) or redis.call('HSTRLEN', KEYS[2], ARGV[1]) > tonumber(ARGV[3]) then return {} end
local task = redis.call('GET', KEYS[1])
local event = redis.call('HGET', KEYS[2], ARGV[1])
if not task or not event then return {} end
return {task, event}
`;
export class RedisMonitorEventRepository {
  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    private readonly config: Pick<Env, 'BULL_PREFIX' | 'TASK_META_TTL_SECONDS'>,
  ) {
    if (
      !config.BULL_PREFIX.trim() ||
      !Number.isInteger(config.TASK_META_TTL_SECONDS) ||
      config.TASK_META_TTL_SECONDS < 1 ||
      config.TASK_META_TTL_SECONDS > 31_536_000
    )
      throw new Error('MONITOR_EVENT_CONFIG_INVALID');
  }
  private keys(
    task: Pick<TaskState, 'taskId' | 'createdAt'>,
  ): [string, string] {
    const prefix = this.config.BULL_PREFIX.trim();
    return [
      `${prefix}:neo:task:meta:${encodeURIComponent(task.taskId)}`,
      `${prefix}:neo:monitor:proof:${encodeURIComponent(
        task.taskId,
      )}:${encodeURIComponent(task.createdAt)}`,
    ];
  }
  async publish(
    task: TaskState,
    sequence: number,
    input: MonitorMessage,
  ): Promise<void> {
    const payload = budgetedJson(
      input,
      input.type === 'monitor_complete'
        ? MONITOR_MESSAGE_MAX_BYTES
        : MONITOR_NOTICE_MAX_BYTES,
    );
    const message = monitorMessageSchema.parse(JSON.parse(payload));
    const slot =
      message.type === 'monitor_complete'
        ? 'complete'
        : message.status === 'started'
        ? 'started'
        : message.country;
    const notice = monitorNoticeSchema.parse({
      version: 1,
      type: 'monitor_changed',
      taskId: task.taskId,
      userId: task.userId,
      taskType: task.taskType,
      taskSubType: task.taskSubType,
      createdAt: task.createdAt,
      revision: task.revision,
      slot,
      sequence,
    });
    const proof = proofSchema.parse({ notice, message });
    if (!validMonitorProof(task, proof))
      throw new Error('MONITOR_EVENT_STATE_INVALID');
    const raw = JSON.stringify(proof),
      hint = JSON.stringify(notice);
    if (
      Buffer.byteLength(payload) >
        (slot === 'complete'
          ? MONITOR_MESSAGE_MAX_BYTES
          : MONITOR_NOTICE_MAX_BYTES) ||
      Buffer.byteLength(raw) > MONITOR_PROOF_MAX_BYTES ||
      Buffer.byteLength(hint) > MONITOR_NOTICE_MAX_BYTES
    )
      throw new Error('MONITOR_EVENT_TOO_LARGE');
    const outcome = await this.redis.eval(
      SAVE,
      2,
      ...this.keys(task),
      task.taskId,
      task.userId,
      task.taskType,
      task.taskSubType!,
      task.createdAt,
      task.revision,
      task.status,
      slot,
      sequence,
      raw,
      this.config.TASK_META_TTL_SECONDS,
      monitorEventChannel(this.config.BULL_PREFIX),
      hint,
    );
    if (outcome === 2) throw new Error('MONITOR_EVENT_PUBLICATION_UNCONFIRMED');
  }
  async read(
    input: MonitorNotice,
  ): Promise<{ task: TaskState; proof: MonitorProof } | null> {
    const notice = monitorNoticeSchema.parse(input);
    const values = await this.redis.eval(
      READ,
      2,
      ...this.keys(notice),
      notice.slot,
      TASK_RECORD_MAX_BYTES,
      MONITOR_PROOF_MAX_BYTES,
    );
    if (
      !Array.isArray(values) ||
      values.length !== 2 ||
      !values.every((v) => typeof v === 'string')
    )
      return null;
    const task = taskStateSchema.parse(JSON.parse(values[0]));
    const proof = proofSchema.parse(JSON.parse(values[1]));
    budgetedJson(
      proof.message,
      proof.message.type === 'monitor_complete'
        ? MONITOR_MESSAGE_MAX_BYTES
        : MONITOR_NOTICE_MAX_BYTES,
    );
    if (
      JSON.stringify(proof.notice) !== JSON.stringify(notice) ||
      !validMonitorProof(task, proof)
    )
      return null;
    return { task, proof };
  }
}
