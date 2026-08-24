/**
 * 选择器名称与 Redis 中的物理队列名称分开保存。
 * 物理名称必须与旧 Bull v4 producer 一致，选择器则兼容旧
 * WORKER_ENABLED_QUEUES 的别名。
 */
export const QUEUE_DEFINITIONS = [
  {
    name: 'monitor',
    physicalName: 'monitor-task-queue',
    aliases: ['monitor'],
  },
  {
    name: 'competitor-monitor',
    physicalName: 'competitor-monitor-task-queue',
    aliases: ['competitor', 'competitor-monitor'],
  },
  {
    name: 'export',
    physicalName: 'export-task-queue',
    aliases: ['export'],
  },
  {
    name: 'import',
    physicalName: 'import-task-queue',
    aliases: ['import'],
  },
  {
    name: 'batch-check',
    physicalName: 'batch-check-task-queue',
    aliases: ['batchcheck', 'batch-check'],
  },
  {
    name: 'batch-delete',
    physicalName: 'batch-delete-task-queue',
    aliases: ['batchdelete', 'batch-delete'],
  },
  {
    name: 'backup',
    physicalName: 'backup-task-queue',
    aliases: ['backup'],
  },
  {
    name: 'variant-check',
    physicalName: 'variant-check-task-queue',
    aliases: ['variantcheck', 'variant-check'],
  },
] as const;

export const QUEUE_NAMES = QUEUE_DEFINITIONS.map(({ name }) => name);

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueueSelection {
  enabledQueues: QueueName[];
  unknownQueues: string[];
}

/** none/off 模式不应创建 Redis、BullMQ 或看门狗资源。 */
export function shouldInitializeQueueRuntime(
  enabled: readonly QueueName[],
): boolean {
  return enabled.length > 0;
}

function normalizeQueueToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function resolveQueueSelector(token: string): QueueName | null {
  const normalized = normalizeQueueToken(token);
  const definition = QUEUE_DEFINITIONS.find(({ name, aliases }) =>
    [name, ...aliases].map(normalizeQueueToken).includes(normalized),
  );
  return definition?.name ?? null;
}

export function getPhysicalQueueName(name: QueueName): string {
  const definition = QUEUE_DEFINITIONS.find((item) => item.name === name);
  if (!definition) {
    throw new Error(`未知队列选择器: ${name}`);
  }
  return definition.physicalName;
}

/**
 * 解析 WORKER_ENABLED_QUEUES（逗号分隔），未设置时启用全部队列。
 * 语义对齐旧系统：同名选择、空串视为全量。
 */
export function resolveQueueSelection(raw: string | undefined): QueueSelection {
  if (!raw || raw.trim() === '') {
    return { enabledQueues: [...QUEUE_NAMES], unknownQueues: [] };
  }
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (
    requested.some((token) => ['all', '*'].includes(normalizeQueueToken(token)))
  ) {
    return { enabledQueues: [...QUEUE_NAMES], unknownQueues: [] };
  }

  const resolved = requested
    .filter((token) => !['none', 'off'].includes(normalizeQueueToken(token)))
    .map((token) => ({ token, name: resolveQueueSelector(token) }));
  const unknownQueues = resolved
    .filter(({ name }) => !name)
    .map(({ token }) => token);
  const enabledQueues = [
    ...new Set(
      resolved.filter(({ name }) => name).map(({ name }) => name as QueueName),
    ),
  ];
  return { enabledQueues, unknownQueues };
}

export function resolveEnabledQueues(raw: string | undefined): QueueName[] {
  return resolveQueueSelection(raw).enabledQueues;
}
