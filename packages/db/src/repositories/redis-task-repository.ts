import type { Env } from '@asin-monitor/config';
import type { Redis } from 'ioredis';
import {
  encodeTaskNotification,
  taskNotificationChannel,
} from './task-notification';
import {
  createTaskInputSchema,
  taskStateSchema,
  transitionTask,
  type CreateTaskInput,
  type TaskMutation,
  type TaskState,
} from './task-state';

export type TaskRedisPort = Pick<Redis, 'get' | 'eval' | 'zrevrange' | 'mget'>;
export type PreparedExportTaskIdentity = Pick<
  TaskState,
  'taskId' | 'userId' | 'createdAt'
> & { taskType: 'export'; taskSubType: 'asin' };
export const TASK_RECORD_MAX_BYTES = 262_144;
// A full 100-job queue can consume 100 hours with two 30-minute attempts
// per job and one consumer. Leave room for retries and operational delay.
export const ASIN_EXPORT_MIN_TASK_TTL_SECONDS = 6 * 24 * 60 * 60;
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
if KEYS[3] then
  local exportType = redis.call('TYPE', KEYS[3]).ok
  if exportType ~= 'none' and exportType ~= 'zset' then
    return redis.error_reply('TASK_EXPORT_INDEX_WRONGTYPE')
  end
end
if KEYS[4] then
  local globalType = redis.call('TYPE', KEYS[4]).ok
  if globalType ~= 'none' and globalType ~= 'zset' then
    return redis.error_reply('TASK_EXPORT_GLOBAL_INDEX_WRONGTYPE')
  end
end
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
local limit = tonumber(ARGV[9] or '0')
if limit > 0 then
  local active = 0
  for _, id in ipairs(redis.call('ZRANGE', KEYS[3], 0, -1)) do
    local raw = redis.call('GET', ARGV[10] .. id)
    local live = false
    if raw then
      local ok, task = pcall(cjson.decode, raw)
      if not ok then return redis.error_reply('TASK_EXPORT_INDEX_INVALID') end
      live = task.userId == ARGV[11] and task.taskType == 'export' and
        task.taskSubType == 'asin' and
        (task.status == 'pending' or task.status == 'processing' or task.status == 'cancelling')
    end
    if live then active = active + 1
    else redis.call('ZREM', KEYS[3], id) end
  end
  if active >= limit then return 3 end
end
local globalLimit = tonumber(ARGV[13] or '0')
if globalLimit > 0 then
  local active = 0
  for _, id in ipairs(redis.call('ZRANGE', KEYS[4], 0, -1)) do
    local raw = redis.call('GET', ARGV[10] .. id)
    local live = false
    if raw then
      local ok, task = pcall(cjson.decode, raw)
      if not ok then return redis.error_reply('TASK_EXPORT_GLOBAL_INDEX_INVALID') end
      live = task.taskId == id and task.taskType == 'export' and
        task.taskSubType == 'asin' and
        (task.status == 'pending' or task.status == 'processing' or task.status == 'cancelling')
    end
    if live then active = active + 1
    else redis.call('ZREM', KEYS[4], id) end
  end
  if active >= globalLimit then return 4 end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if KEYS[3] then
  if limit > 0 then
    redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
  elseif ARGV[12] == 'completed' or ARGV[12] == 'failed' or ARGV[12] == 'cancelled' then
    redis.call('ZREM', KEYS[3], ARGV[5])
  end
  redis.call('EXPIRE', KEYS[3], ARGV[3])
end
if KEYS[4] then
  if globalLimit > 0 then
    redis.call('ZADD', KEYS[4], ARGV[4], ARGV[5])
  elseif ARGV[12] == 'completed' or ARGV[12] == 'failed' or ARGV[12] == 'cancelled' then
    redis.call('ZREM', KEYS[4], ARGV[5])
  end
  redis.call('EXPIRE', KEYS[4], ARGV[3])
end
local count = redis.call('ZCARD', KEYS[2])
if count > tonumber(ARGV[6]) then
  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, count - tonumber(ARGV[6]) - 1)
end
-- Notification is advisory: publication failure must not fail a committed task.
local published = redis.pcall('PUBLISH', ARGV[7], ARGV[8])
if type(published) == 'table' and published.err then return 2 end
return 1
`;

export class TaskRegistryError extends Error {
  constructor(
    public readonly code:
      | 'TASK_EXISTS'
      | 'TASK_CONTENTION'
      | 'TASK_IDENTITY_CHANGED'
      | 'TASK_RECORD_INVALID'
      | 'TASK_RECORD_TOO_LARGE'
      | 'TASK_EXPORT_LIMIT'
      | 'TASK_EXPORT_GLOBAL_LIMIT',
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
    private readonly onNotificationFailure?: () => void,
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

  private key(
    kind: 'meta' | 'user' | 'export' | 'export-global',
    id: string,
  ): string {
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
    maxActiveExports?: number,
    maxGlobalExports?: number,
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
    const limited = expected === null && maxActiveExports !== undefined;
    const trackExport =
      limited ||
      (expected !== null &&
        task.taskType === 'export' &&
        task.taskSubType === 'asin');
    const saved = await this.redis.eval(
      COMPARE_AND_SET,
      trackExport ? 4 : 2,
      this.key('meta', task.taskId),
      this.key('user', task.userId),
      ...(trackExport
        ? [this.key('export', task.userId), this.key('export-global', 'asin')]
        : []),
      expected ?? '',
      raw,
      this.config.TASK_META_TTL_SECONDS,
      Date.parse(task.updatedAt),
      task.taskId,
      this.config.TASK_USER_MAX_ITEMS,
      taskNotificationChannel(this.config.BULL_PREFIX),
      encodeTaskNotification(task),
      ...(trackExport
        ? [
            maxActiveExports ?? 0,
            `${this.prefix}:meta:`,
            task.userId,
            task.status,
            maxGlobalExports ?? 0,
          ]
        : []),
    );
    if (saved === 3) throw new TaskRegistryError('TASK_EXPORT_LIMIT');
    if (saved === 4) throw new TaskRegistryError('TASK_EXPORT_GLOBAL_LIMIT');
    if (saved === 2) {
      try {
        this.onNotificationFailure?.();
      } catch {
        // Diagnostics cannot change the outcome of an already committed mutation.
      }
    }
    return saved === 1 || saved === 2;
  }

  private async createInternal(
    input: CreateTaskInput,
    maxActiveExports?: number,
    maxGlobalExports?: number,
    onPrepared?: (identity: PreparedExportTaskIdentity) => void,
  ): Promise<TaskState> {
    const data = createTaskInputSchema.parse(input);
    const timestamp = this.now().toISOString();
    const task: TaskState = {
      ...data,
      title: data.title ?? data.taskType,
      taskSubType: data.taskSubType ?? null,
      status: 'pending',
      progress: 0,
      message: data.message ?? '任务已创建，等待处理',
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
    onPrepared?.({
      taskId: task.taskId,
      userId: task.userId,
      taskType: 'export',
      taskSubType: 'asin',
      createdAt: task.createdAt,
    });
    if (!(await this.save(null, task, maxActiveExports, maxGlobalExports)))
      throw new TaskRegistryError('TASK_EXISTS');
    return task;
  }

  create(input: CreateTaskInput): Promise<TaskState> {
    return this.createInternal(input);
  }

  /** The admission slot and task metadata are committed by one Redis script. */
  createLimitedExport(
    input: CreateTaskInput,
    maxActiveExports: number,
    maxGlobalExports = 100,
    onPrepared?: (identity: PreparedExportTaskIdentity) => void,
  ): Promise<TaskState> {
    if (
      input.taskType !== 'export' ||
      input.taskSubType !== 'asin' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        input.taskId,
      ) ||
      !Number.isInteger(maxActiveExports) ||
      maxActiveExports < 1 ||
      maxActiveExports > 10 ||
      !Number.isInteger(maxGlobalExports) ||
      maxGlobalExports < 1 ||
      maxGlobalExports > 100
    )
      throw new TaskRegistryError('TASK_RECORD_INVALID');
    return this.createInternal(
      input,
      maxActiveExports,
      maxGlobalExports,
      onPrepared,
    );
  }

  async read(taskId: string): Promise<TaskState | null> {
    const raw = await this.redis.get(this.key('meta', taskId));
    return raw === null ? null : this.parse(raw, taskId);
  }

  async mutate(
    taskId: string,
    change: TaskMutation,
    expectedIdentity?: Pick<TaskState, 'userId' | 'taskType' | 'createdAt'> &
      Partial<Pick<TaskState, 'taskSubType'>>,
  ): Promise<TaskState | null> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const raw = await this.redis.get(this.key('meta', taskId));
      if (raw === null) return null; // Never resurrect expired or create ownerless tasks.
      const task = this.parse(raw, taskId);
      // Recheck on every CAS attempt: an expired ID must not authorize a replacement task.
      if (
        expectedIdentity &&
        (task.userId !== expectedIdentity.userId ||
          task.taskType !== expectedIdentity.taskType ||
          task.createdAt !== expectedIdentity.createdAt ||
          (expectedIdentity.taskSubType !== undefined &&
            task.taskSubType !== expectedIdentity.taskSubType))
      ) {
        throw new TaskRegistryError('TASK_IDENTITY_CHANGED');
      }
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
