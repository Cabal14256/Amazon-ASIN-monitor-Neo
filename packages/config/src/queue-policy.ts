import type { Env } from './index';
import { getPhysicalQueueName, type QueueName } from './queues';
interface QueuePolicy {
  attempts: number;
  completeAge: number;
  failureAge: number;
  duration: number;
  concurrencyKey?: keyof Pick<
    Env,
    | 'MONITOR_QUEUE_WORKER_CONCURRENCY'
    | 'COMPETITOR_QUEUE_WORKER_CONCURRENCY'
    | 'EXPORT_QUEUE_WORKER_CONCURRENCY'
    | 'BATCH_CHECK_QUEUE_WORKER_CONCURRENCY'
    | 'BATCH_DELETE_QUEUE_WORKER_CONCURRENCY'
    | 'BACKUP_QUEUE_WORKER_CONCURRENCY'
    | 'VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY'
  >;
}
const standard = { attempts: 2, completeAge: 3600, failureAge: 86400 };
const POLICIES: Record<QueueName, QueuePolicy> = {
  monitor: {
    ...standard,
    attempts: 3,
    duration: 200,
    concurrencyKey: 'MONITOR_QUEUE_WORKER_CONCURRENCY',
  },
  'competitor-monitor': {
    ...standard,
    attempts: 3,
    duration: 200,
    concurrencyKey: 'COMPETITOR_QUEUE_WORKER_CONCURRENCY',
  },
  export: {
    attempts: 2,
    completeAge: 86400,
    failureAge: 604800,
    duration: 500,
    concurrencyKey: 'EXPORT_QUEUE_WORKER_CONCURRENCY',
  },
  import: { ...standard, duration: 1000 },
  'batch-check': {
    ...standard,
    duration: 1000,
    concurrencyKey: 'BATCH_CHECK_QUEUE_WORKER_CONCURRENCY',
  },
  'batch-delete': {
    ...standard,
    attempts: 1,
    duration: 1000,
    concurrencyKey: 'BATCH_DELETE_QUEUE_WORKER_CONCURRENCY',
  },
  backup: {
    ...standard,
    // Restore is destructive; automatic redelivery cannot prove the prior
    // attempt left no changes. Operators inspect the task before resubmitting.
    attempts: 1,
    duration: 2000,
    concurrencyKey: 'BACKUP_QUEUE_WORKER_CONCURRENCY',
  },
  'variant-check': {
    ...standard,
    duration: 500,
    concurrencyKey: 'VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY',
  },
};

export function getQueuePolicy(name: QueueName, env: Env) {
  const policy = POLICIES[name];
  // A committed restore may have only a BullMQ receipt while the separate
  // task registry is unavailable. Keep it throughout the metadata lifetime;
  // no count cap may evict it early when newer jobs complete.
  const backupRetention =
    name === 'backup'
      ? Math.max(7 * 24 * 60 * 60, env.TASK_META_TTL_SECONDS)
      : undefined;
  const defaultJobOptions = {
    attempts: policy.attempts,
    ...(policy.attempts > 1
      ? { backoff: { type: 'exponential' as const, delay: 5000 } }
      : {}),
    removeOnComplete: { age: backupRetention ?? policy.completeAge },
    removeOnFail: { age: backupRetention ?? policy.failureAge },
  };
  const limiter =
    name === 'monitor'
      ? {
          max: env.MONITOR_QUEUE_LIMITER_MAX,
          duration: env.MONITOR_QUEUE_LIMITER_DURATION_MS,
        }
      : name === 'competitor-monitor'
      ? {
          max: env.COMPETITOR_QUEUE_LIMITER_MAX,
          duration: env.COMPETITOR_QUEUE_LIMITER_DURATION_MS,
        }
      : { max: 1, duration: policy.duration };
  return {
    physicalName: getPhysicalQueueName(name),
    defaultJobOptions,
    concurrency: policy.concurrencyKey ? env[policy.concurrencyKey] : 1,
    limiter,
  };
}
