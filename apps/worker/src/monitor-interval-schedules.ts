import type { Queue } from 'bullmq';

export const MONITOR_INTERVAL_QUEUE = 'monitor-interval-maintenance-queue';
export const MONITOR_INTERVAL_JOB = 'reconcile-status-intervals';
export const MONITOR_INTERVAL_SCHEDULER = 'monitor-status-intervals';
export const MONITOR_INTERVAL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 50 },
  removeOnFail: { age: 604800, count: 200 },
};
export async function installMonitorIntervalSchedule(
  queue: Pick<Queue, 'upsertJobScheduler'>,
) {
  await queue.upsertJobScheduler(
    MONITOR_INTERVAL_SCHEDULER,
    { every: 30_000 },
    {
      name: MONITOR_INTERVAL_JOB,
      data: { schemaVersion: 1 },
      opts: MONITOR_INTERVAL_JOB_OPTIONS,
    },
  );
}
