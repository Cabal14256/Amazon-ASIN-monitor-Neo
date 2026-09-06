import type { Env } from '@asin-monitor/config';
import type { Redis } from 'ioredis';
import {
  createTaskInputSchema,
  taskStateSchema,
  transitionTask,
  type CreateTaskInput,
  type TaskMutation,
  type TaskState,
} from './task-state';

export type TaskRedisPort = Pick<Redis, 'get' | 'eval' | 'zrevrange' | 'mget'>;
export const TASK_RECORD_MAX_BYTES = 262_144;
const MAX_WRITE_ATTEMPTS = 8;
// All keys are explicit. A single Redis instance is the deployment contract.
// Validate types before mutation; Lua prevents interleaving, not general rollback.
const COMPARE_AND_SET = `
local metaType = redis.call('TYPE', KEYS[1]).ok
local indexType = redis.call('TYPE', KEYS[2]).ok
if (metaType ~= 'none' and metaType ~= 'string') or
   (indexType ~= 'none' and indexType ~= 'zset') then
  return redis.error_reply('TASK_REGISTRY_WRONGTYPE')
end
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local count = redis.call('ZCARD', KEYS[2])
if count > tonumber(ARGV[6]) then
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, count - tonumber(ARGV[6]) - 1)
end
return 1
`;

export class TaskRegistryError extends Error {
  constructor(
    public readonly code:
      | 'TASK_EXISTS'
      | 'TASK_CONTENTION'
      | 'TASK_RECORD_INVALID'
      | 'TASK_RECORD_TOO_LARGE',
  ) {
    super(code);
    this.name = 'TaskRegistryError';
  }
}

export type TaskRegistryConfig = Pick<
  Env,
  'BULL_PREFIX' | 'TASK_META_TTL_SECONDS' | 'TASK_USER_MAX_ITEMS'
>;

/** Shared persistence only; callers authenticate/authorize and own the bounded Redis connection. */
export class RedisTaskRepository {
  private readonly prefix: string;
  constructor(
    private readonly redis: TaskRedisPort,
    private readonly config: TaskRegistryConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !config.BULL_PREFIX.trim() ||
      !Number.isInteger(config.TASK_META_TTL_SECONDS) ||
      config.TASK_META_TTL_SECONDS < 1 ||
      config.TASK_META_TTL_SECONDS > 31_536_000 ||
      !Number.isInteger(config.TASK_USER_MAX_ITEMS) ||
      config.TASK_USER_MAX_ITEMS < 1 ||
      config.TASK_USER_MAX_ITEMS > 1000
    ) {
      throw new Error('TASK_REGISTRY_CONFIG_INVALID');
    }
    this.prefix = `${config.BULL_PREFIX.trim()}:neo:task`;
    this.config = { ...config };
  }

  private key(kind: 'meta' | 'user', id: string): string {
    if (!id || id.length > 200) throw new Error('TASK_IDENTIFIER_INVALID');
    return `${this.prefix}:${kind}:${encodeURIComponent(id)}`;
  }

  private parse(raw: string, taskId: string): TaskState {
    try {
      if (Buffer.byteLength(raw) > TASK_RECORD_MAX_BYTES) throw new Error();
      const task = taskStateSchema.parse(JSON.parse(raw));
      if (task.taskId !== taskId) throw new Error();
      return task;
    } catch {
      throw new TaskRegistryError('TASK_RECORD_INVALID');
    }
  }

  private async save(
    expected: string | null,
    task: TaskState,
  ): Promise<boolean> {
    let raw: string;
    try {
      raw = JSON.stringify(task, (_key, value: unknown) => {
        if (
          ['undefined', 'function', 'symbol', 'bigint'].includes(
            typeof value,
          ) ||
          (typeof value === 'number' && !Number.isFinite(value))
        ) {
          throw new Error('Non-JSON task data');
        }
        return value;
      });
    } catch {
      throw new TaskRegistryError('TASK_RECORD_INVALID');
    }
    if (Buffer.byteLength(raw) > TASK_RECORD_MAX_BYTES)
      throw new TaskRegistryError('TASK_RECORD_TOO_LARGE');
    // Round-trip validation catches unsupported JSON values before issuing Redis writes.
    this.parse(raw, task.taskId);
    return (
      (await this.redis.eval(
        COMPARE_AND_SET,
        2,
        this.key('meta', task.taskId),
        this.key('user', task.userId),
        expected ?? '',
        raw,
        this.config.TASK_META_TTL_SECONDS,
        Date.parse(task.updatedAt),
        task.taskId,
        this.config.TASK_USER_MAX_ITEMS,
      )) === 1
    );
  }

  async create(input: CreateTaskInput): Promise<TaskState> {
    const data = createTaskInputSchema.parse(input);
    const timestamp = this.now().toISOString();
    const task: TaskState = {
      ...data,
      title: data.title ?? data.taskType,
      taskSubType: data.taskSubType ?? null,
      status: 'pending',
      progress: 0,
      message: '任务已创建，等待处理',
      error: null,
      result: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
      cancelRequestedAt: null,
      cancelledAt: null,
      revision: 0,
    };
    if (!(await this.save(null, task)))
      throw new TaskRegistryError('TASK_EXISTS');
    return task;
  }

  async read(taskId: string): Promise<TaskState | null> {
    const raw = await this.redis.get(this.key('meta', taskId));
    return raw === null ? null : this.parse(raw, taskId);
  }

  async mutate(
    taskId: string,
    change: TaskMutation,
  ): Promise<TaskState | null> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const raw = await this.redis.get(this.key('meta', taskId));
      if (raw === null) return null; // Never resurrect expired or create ownerless tasks.
      const task = this.parse(raw, taskId);
      const next = transitionTask(task, change, this.now());
      if (next === task) return task;
      if (await this.save(raw, next)) return next;
    }
    throw new TaskRegistryError('TASK_CONTENTION');
  }

  async listUser(
    userId: string,
    options: { limit?: number; status?: string } = {},
  ): Promise<TaskState[]> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('TASK_LIMIT_INVALID');
    // Inspect the entire bounded index before filtering; limit*3 loses older active tasks.
    const ids = await this.redis.zrevrange(
      this.key('user', userId),
      0,
      this.config.TASK_USER_MAX_ITEMS - 1,
    );
    if (ids.length === 0) return [];
    const rows = await this.redis.mget(
      ...ids.map((id) => this.key('meta', id)),
    );
    const tasks = rows.flatMap((raw, i) =>
      raw === null ? [] : [this.parse(raw, ids[i])],
    );
    const status = options.status ?? 'all';
    return tasks
      .filter(
        (task) =>
          task.userId === userId &&
          (status === 'all' ||
            (status === 'active'
              ? ['pending', 'processing', 'cancelling'].includes(task.status)
              : task.status === status)),
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
  }
}
