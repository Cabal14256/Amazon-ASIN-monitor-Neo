/**
 * 队列注册表（类型化，替代旧 workerProcessorRegistry 的字符串约定）。
 * 队列名与旧 Bull v4 的 8 个队列一一对应；P2-T2 平移各 Processor 实现。
 */
export const QUEUE_NAMES = [
  'monitor',
  'competitor-monitor',
  'export',
  'import',
  'batch-check',
  'batch-delete',
  'backup',
  'variant-check',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * 解析 WORKER_ENABLED_QUEUES（逗号分隔），未设置时启用全部队列。
 * 语义对齐旧系统：同名选择、空串视为全量。
 */
export function resolveEnabledQueues(raw: string | undefined): QueueName[] {
  if (!raw || raw.trim() === '') {
    return [...QUEUE_NAMES];
  }
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = requested.filter((q): q is QueueName =>
    (QUEUE_NAMES as readonly string[]).includes(q),
  );
  const invalid = requested.filter(
    (q) => !(QUEUE_NAMES as readonly string[]).includes(q),
  );
  if (invalid.length > 0) {
    throw new Error(`WORKER_ENABLED_QUEUES 含未知队列: ${invalid.join(', ')}`);
  }
  return valid;
}
