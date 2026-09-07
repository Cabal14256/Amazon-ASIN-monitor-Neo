import type { Queue } from 'bullmq';
import { resolveQueueSelection } from './queues';

/** Infrastructure queue; the eight Legacy business queue identities stay intact. */
export const AUTH_MAINTENANCE_QUEUE = 'auth-maintenance-queue';
export const AUTH_MAINTENANCE_SCHEDULES = [
  { id: 'auth-session-cleanup', name: 'session-cleanup', pattern: '0 2 * * *' },
  { id: 'auth-audit-archive', name: 'audit-archive', pattern: '0 3 1 * *' },
] as const;
export type AuthMaintenanceJobName =
  (typeof AUTH_MAINTENANCE_SCHEDULES)[number]['name'];
export const AUTH_MAINTENANCE_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 50 },
  removeOnFail: { age: 604800, count: 200 },
};

export function resolveWorkerSelection(raw: string | undefined) {
  const tokens = (raw ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const maintenance = (token: string) =>
    ['maintenance', 'auth-maintenance'].includes(
      token.toLowerCase().replace(/[_\s]+/g, '-'),
    );
  const all =
    tokens.length === 0 ||
    tokens.some((token) => ['all', '*'].includes(token.toLowerCase()));
  const selected = all || tokens.some(maintenance);
  const business = tokens.filter((token) => !maintenance(token));
  return {
    ...resolveQueueSelection(
      all ? 'all' : business.length ? business.join(',') : 'none',
    ),
    maintenance: selected,
  };
}

export async function installAuthMaintenanceSchedules(
  queue: Pick<Queue, 'upsertJobScheduler'>,
) {
  for (const schedule of AUTH_MAINTENANCE_SCHEDULES) {
    await queue.upsertJobScheduler(
      schedule.id,
      { pattern: schedule.pattern, tz: 'Asia/Shanghai' },
      {
        name: schedule.name,
        data: { schemaVersion: 1 },
        opts: AUTH_MAINTENANCE_JOB_OPTIONS,
      },
    );
  }
}

/** Call only in a controlled stop operation after disabling scheduler producers. */
export async function removeAuthMaintenanceSchedules(
  queue: Pick<Queue, 'removeJobScheduler'>,
) {
  for (const schedule of AUTH_MAINTENANCE_SCHEDULES)
    await queue.removeJobScheduler(schedule.id);
}
