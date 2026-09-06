import type { Env } from '@asin-monitor/config';
import type {
  ConnectionOptions,
  JobsOptions,
  QueueOptions,
  WorkerOptions,
} from 'bullmq';
import { getPhysicalQueueName, type QueueName } from './queues';

/** Bull and BullMQ do not share persisted job formats during migration. */
export function getNeoQueuePrefix(env: Pick<Env, 'BULL_PREFIX'>): string {
  return `${env.BULL_PREFIX}:neo`;
}

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
  const defaultJobOptions: JobsOptions = {
    attempts: policy.attempts,
    ...(policy.attempts > 1
      ? { backoff: { type: 'exponential', delay: 5000 } }
      : {}),
    removeOnComplete: { age: policy.completeAge },
    removeOnFail: { age: policy.failureAge },
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

export function getQueueOptions(
  name: QueueName,
  env: Env,
  connection: ConnectionOptions,
): QueueOptions {
  return {
    connection,
    prefix: getNeoQueuePrefix(env),
    defaultJobOptions: getQueuePolicy(name, env).defaultJobOptions,
  };
}

export function getWorkerOptions(
  name: QueueName,
  env: Env,
  connection: ConnectionOptions,
): WorkerOptions {
  const { concurrency, limiter } = getQueuePolicy(name, env);
  // BullMQ applies limiter to Worker, not Queue (unlike legacy Bull v4).
  return { connection, prefix: getNeoQueuePrefix(env), concurrency, limiter };
}
