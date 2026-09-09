import {
  getNeoQueuePrefix,
  getQueuePolicy,
  type Env,
} from '@asin-monitor/config';
import type { ConnectionOptions, QueueOptions, WorkerOptions } from 'bullmq';
import type { QueueName } from './queues';

export { getNeoQueuePrefix, getQueuePolicy } from '@asin-monitor/config';
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
