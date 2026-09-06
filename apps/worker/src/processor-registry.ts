import type { Env } from '@asin-monitor/config';
import type { ConnectionOptions, Processor } from 'bullmq';
import { getWorkerOptions } from './queue-policy';
import { getPhysicalQueueName, type QueueName } from './queues';

/** Payload remains unknown until the owning domain validates its contract. */
export type QueueProcessors = Partial<
  Record<QueueName, Processor<unknown, unknown, string>>
>;

/** Pure preflight: validate all selections before allocating any Worker. */
export function buildWorkerPlans(
  enabled: readonly QueueName[],
  processors: QueueProcessors,
  env: Env,
  connection: ConnectionOptions,
) {
  const selected = [...new Set(enabled)];
  const missing = selected.filter(
    (name) => typeof processors[name] !== 'function',
  );
  if (missing.length)
    throw new Error(`尚未注册队列处理器: ${missing.join(', ')}`);
  return selected.map((name) => ({
    name,
    physicalName: getPhysicalQueueName(name),
    processor: processors[name]!,
    options: getWorkerOptions(name, env, connection),
  }));
}
