import {
  buildScheduledMonitorJobId,
  type ScheduledMonitorJob,
  type ScheduledMonitorPlan,
} from '@asin-monitor/contracts';
import {
  scheduledMonitorBatchIndex,
  scheduledMonitorTaskId,
} from '@asin-monitor/db';

export const SCHEDULED_MONITOR_SCHEDULER_ID =
  'neo-scheduled-monitor-dispatch-v1';
export const SCHEDULED_MONITOR_SELECTOR = 'scheduled-monitor';
export const SCHEDULED_MONITOR_BUSINESS_QUEUE = 'scheduled-monitor-task-queue';
export const SCHEDULED_MONITOR_TICK_QUEUE =
  'scheduled-monitor-scheduler-task-queue';
export const SCHEDULED_MONITOR_TICK_JOB = 'scheduled-monitor-scheduler-tick';
export const SCHEDULED_MONITOR_TICK_EVERY_MS = 60_000;
export const SCHEDULED_MONITOR_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { age: 604800, count: 500 },
  removeOnFail: { age: 604800, count: 500 },
};

export const SCHEDULED_MONITOR_INTERVALS = [15, 30, 60] as const;
export type ScheduledMonitorInterval =
  (typeof SCHEDULED_MONITOR_INTERVALS)[number];
export const SCHEDULED_MONITOR_US_COUNTRIES = ['US'] as const;
export const SCHEDULED_MONITOR_EU_COUNTRIES = [
  'UK',
  'DE',
  'FR',
  'ES',
  'IT',
] as const;
export type ScheduledMonitorCountry =
  | (typeof SCHEDULED_MONITOR_US_COUNTRIES)[number]
  | (typeof SCHEDULED_MONITOR_EU_COUNTRIES)[number];

export function isScheduledMonitorSelected(raw: string | undefined): boolean {
  return (raw ?? '')
    .split(',')
    .map((token) =>
      token
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, '-'),
    )
    .includes(SCHEDULED_MONITOR_SELECTOR);
}

export interface ScheduledMonitorConfig {
  enabled: boolean;
  competitorEnabled: boolean;
  usIntervalMinutes: ScheduledMonitorInterval;
  euIntervalMinutes: ScheduledMonitorInterval;
  totalBatches: number;
}

const value = (
  rows: readonly { configKey: string; configValue: string | null }[],
  key: string,
) => {
  const matches = rows.filter((row) => row.configKey.toUpperCase() === key);
  if (matches.length > 1) throw new Error('SCHEDULED_MONITOR_CONFIG_DUPLICATE');
  return matches[0]?.configValue ?? undefined;
};

function interval(
  raw: unknown,
  fallback: ScheduledMonitorInterval,
): ScheduledMonitorInterval {
  const parsed = Number(raw);
  return SCHEDULED_MONITOR_INTERVALS.includes(
    parsed as ScheduledMonitorInterval,
  )
    ? (parsed as ScheduledMonitorInterval)
    : fallback;
}

function positiveInteger(
  raw: unknown,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(maximum, parsed)
    : fallback;
}

export function parseScheduledMonitorConfig(
  rows: readonly { configKey: string; configValue: string | null }[],
  env: {
    enabled: boolean;
    competitorEnabled: boolean;
    usIntervalMinutes: ScheduledMonitorInterval;
    euIntervalMinutes: ScheduledMonitorInterval;
    totalBatches: number;
  },
): ScheduledMonitorConfig {
  return {
    enabled: env.enabled,
    competitorEnabled:
      value(rows, 'COMPETITOR_MONITOR_ENABLED') === undefined
        ? env.competitorEnabled
        : ['1', 'true', 'yes', 'on'].includes(
            String(value(rows, 'COMPETITOR_MONITOR_ENABLED'))
              .trim()
              .toLowerCase(),
          ),
    usIntervalMinutes: interval(
      value(rows, 'MONITOR_US_SCHEDULE_MINUTES'),
      env.usIntervalMinutes ?? 30,
    ),
    euIntervalMinutes: interval(
      value(rows, 'MONITOR_EU_SCHEDULE_MINUTES'),
      env.euIntervalMinutes ?? 60,
    ),
    totalBatches: positiveInteger(
      value(rows, 'MONITOR_BATCH_COUNT'),
      env.totalBatches,
      1000,
    ),
  };
}

function slot(
  nowMs: number,
  intervalMinutes: ScheduledMonitorInterval,
): string {
  const size = intervalMinutes * 60_000;
  return new Date(Math.floor(nowMs / size) * size).toISOString();
}

function job(
  domain: ScheduledMonitorPlan['domain'],
  country: ScheduledMonitorCountry,
  plannedSlot: string,
  intervalMinutes: ScheduledMonitorInterval,
  totalBatches: number,
  requestedAt: string,
): ScheduledMonitorJob {
  const batchIndex = scheduledMonitorBatchIndex(
    Date.parse(plannedSlot),
    intervalMinutes,
    totalBatches,
  );
  const plan = {
    domain,
    country,
    plannedSlot,
    intervalMinutes,
    batchConfig: { batchIndex, totalBatches },
  } satisfies ScheduledMonitorPlan;
  const createdAt = requestedAt;
  const expiresAt = new Date(Date.parse(createdAt) + 30 * 60_000).toISOString();
  return {
    ...plan,
    version: 1,
    source: 'scheduled',
    taskType: 'scheduled-monitor',
    actor: { kind: 'system', purpose: 'scheduled-monitor' },
    taskId: scheduledMonitorTaskId(plan),
    jobId: buildScheduledMonitorJobId(plan),
    requestedAt,
    createdAt,
    expiresAt,
  };
}

export interface ScheduledMonitorDispatch {
  job: ScheduledMonitorJob;
  delayMs: number;
}

export function buildScheduledMonitorDispatches(
  nowMs: number,
  config: ScheduledMonitorConfig,
): ScheduledMonitorDispatch[] {
  if (!config.enabled) return [];
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
    throw new RangeError('Invalid scheduled monitor clock');
  const now = new Date(nowMs);
  if (now.getUTCSeconds() !== 0 || now.getUTCMilliseconds() !== 0) return [];
  const requestedAt = now.toISOString();
  const due: { us: boolean; eu: boolean } = {
    us: new Date(nowMs).getUTCMinutes() % config.usIntervalMinutes === 0,
    eu: new Date(nowMs).getUTCMinutes() % config.euIntervalMinutes === 0,
  };
  const usSlot = slot(nowMs, config.usIntervalMinutes);
  const euSlot = slot(nowMs, config.euIntervalMinutes);
  const dispatches: ScheduledMonitorDispatch[] = [];
  if (due.us)
    dispatches.push({
      job: job(
        'primary',
        'US',
        usSlot,
        config.usIntervalMinutes,
        config.totalBatches,
        requestedAt,
      ),
      delayMs: 0,
    });
  if (!due.eu) return dispatches;
  SCHEDULED_MONITOR_EU_COUNTRIES.forEach((country, index) => {
    const delayMs = index * 1000;
    dispatches.push({
      job: job(
        'primary',
        country,
        euSlot,
        config.euIntervalMinutes,
        config.totalBatches,
        requestedAt,
      ),
      delayMs,
    });
    if (config.competitorEnabled)
      dispatches.push({
        job: job(
          'competitor',
          country,
          euSlot,
          config.euIntervalMinutes,
          config.totalBatches,
          requestedAt,
        ),
        delayMs,
      });
  });
  return dispatches;
}

export function shouldDispatchAt(
  nowMs: number,
  plannedSlot: string,
  intervalMinutes: ScheduledMonitorInterval,
): boolean {
  const parsed = Date.parse(plannedSlot);
  const interval = intervalMinutes * 60_000;
  const now = new Date(nowMs);
  return (
    Number.isFinite(parsed) &&
    now.getUTCSeconds() === 0 &&
    now.getUTCMilliseconds() === 0 &&
    now.getUTCMinutes() % intervalMinutes === 0 &&
    Math.floor(nowMs / interval) === Math.floor(parsed / interval)
  );
}
