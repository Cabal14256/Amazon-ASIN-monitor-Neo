import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  type Env,
} from '@asin-monitor/config';
import type { TaskState } from '@asin-monitor/db';
import { QueueKeys } from 'bullmq';
import type { Redis } from 'ioredis';

export const CANCELLABLE_TASK_TYPES = [
  'export',
  'import',
  'batch-check',
  'batch-delete',
  'backup',
] as const;
export type CancellationOutcome =
  | 'removed'
  | 'running'
  | 'absent'
  | 'expired'
  | 'identity-changed'
  | 'terminal'
  | 'unsupported'
  | 'foreign';

// BullMQ has no public atomic remove-if-waiting operation. Reuse its complete
// deletion script, with a read-only precondition in the SAME EVAL. Fail closed
// on a dependency upgrade until this adapter and its real-Redis tests are reviewed.
const bullVersion = (require('bullmq/package.json') as { version: string })
  .version;
const { removeJob } = require('bullmq/dist/cjs/scripts/removeJob-2') as {
  removeJob: { name: string; keys: number; content: string };
};
if (
  bullVersion !== '5.81.3' ||
  removeJob.name !== 'removeJob' ||
  removeJob.keys !== 2
)
  throw new Error('TASK_CANCEL_BULLMQ_ADAPTER_VERSION');

const guardedRemoval = `
local function checkType(key, expected)
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= expected then error('TASK_CANCEL_WRONGTYPE') end
  return actual
end
checkType(KEYS[3], 'string')
local raw = redis.call('GET', KEYS[3])
if not raw then return 3 end
if #raw > 262144 then error('TASK_CANCEL_INVALID_META') end
local valid, meta = pcall(cjson.decode, raw)
if not valid or type(meta) ~= 'table' then error('TASK_CANCEL_INVALID_META') end
if meta.taskId ~= ARGV[1] or meta.userId ~= ARGV[4] or
   meta.taskType ~= ARGV[5] or meta.createdAt ~= ARGV[6] then return 4 end
if meta.status == 'completed' or meta.status == 'failed' or meta.status == 'cancelled' then return 5 end
if meta.status ~= 'pending' and meta.status ~= 'processing' and meta.status ~= 'cancelling' then
  error('TASK_CANCEL_INVALID_META')
end
if checkType(KEYS[1], 'hash') == 'none' then return 2 end
if redis.call('HSTRLEN', KEYS[1], 'data') > 262144 then error('TASK_CANCEL_INVALID_JOB') end
local dataOk, data = pcall(cjson.decode, redis.call('HGET', KEYS[1], 'data') or '')
if not dataOk or type(data) ~= 'table' then error('TASK_CANCEL_INVALID_JOB') end
if data.userId ~= ARGV[4] then return 7 end
if data.createdAt ~= ARGV[6] then return 4 end
local prefix = ARGV[3]
for _, suffix in ipairs({'completed', 'failed', 'delayed', 'prioritized', 'waiting-children', 'repeat'}) do
  checkType(prefix .. suffix, 'zset')
end
for _, suffix in ipairs({'wait', 'paused', 'active'}) do checkType(prefix .. suffix, 'list') end
checkType(KEYS[1] .. ':lock', 'string')
if redis.call('ZSCORE', prefix .. 'completed', ARGV[1]) or
   redis.call('ZSCORE', prefix .. 'failed', ARGV[1]) then return 5 end
-- A stalled active job without a lock is still running work from the user's perspective.
if redis.call('EXISTS', KEYS[1] .. ':lock') == 1 or
   redis.call('LPOS', prefix .. 'active', ARGV[1]) then return 0 end
-- These user task queues contain independent jobs, never flows or schedulers.
-- Refuse graph removal rather than modifying another task's parent/children.
if redis.call('HEXISTS', KEYS[1], 'parentKey') == 1 or
   redis.call('HEXISTS', KEYS[1], 'rjk') == 1 or
   redis.call('EXISTS', KEYS[1] .. ':dependencies', KEYS[1] .. ':processed',
     KEYS[1] .. ':failed', KEYS[1] .. ':unsuccessful') > 0 or
   redis.call('ZSCORE', prefix .. 'waiting-children', ARGV[1]) then return -8 end
if not (redis.call('ZSCORE', prefix .. 'delayed', ARGV[1]) or
        redis.call('ZSCORE', prefix .. 'prioritized', ARGV[1]) or
        redis.call('LPOS', prefix .. 'wait', ARGV[1]) or
        redis.call('LPOS', prefix .. 'paused', ARGV[1])) then return 0 end
-- Redis scripts do not roll back runtime errors. Validate the remaining command
-- types/arguments before entering the upstream deletion script.
checkType(prefix .. 'meta', 'hash')
checkType(prefix .. 'events', 'stream')
local maxEvents = redis.call('HGET', prefix .. 'meta', 'opts.maxLenEvents')
if maxEvents then
  local value = tonumber(maxEvents)
  if not value or not (maxEvents == '0' or string.match(maxEvents, '^[1-9]%d*$')) or
     value < 0 or value > 2147483647 or value ~= math.floor(value) then
    error('TASK_CANCEL_INVALID_EVENTS_LIMIT')
  end
end
local deid = redis.call('HGET', KEYS[1], 'deid')
if deid then checkType(prefix .. 'de:' .. deid, 'string') end
${removeJob.content}
`;

export async function cancelQueuedTask(
  redis: Pick<Redis, 'eval'>,
  env: Pick<Env, 'BULL_PREFIX'>,
  task: TaskState,
): Promise<CancellationOutcome> {
  const type = CANCELLABLE_TASK_TYPES.find(
    (candidate) => candidate === task.taskType,
  );
  if (!type) return 'unsupported';
  const keys = new QueueKeys(getNeoQueuePrefix(env)).getKeys(
    getPhysicalQueueName(type),
  );
  const jobKey = `${keys['']}${task.taskId}`;
  if (Object.values(keys).includes(jobKey)) return 'unsupported';
  const outcome = await redis.eval(
    guardedRemoval,
    3,
    jobKey,
    keys.repeat,
    `${env.BULL_PREFIX.trim()}:neo:task:meta:${encodeURIComponent(
      task.taskId,
    )}`,
    task.taskId,
    '0',
    keys[''],
    task.userId,
    task.taskType,
    task.createdAt,
  );
  switch (outcome) {
    case 1:
      return 'removed';
    case 0:
      return 'running';
    case 2:
      return 'absent';
    case 3:
      return 'expired';
    case 4:
      return 'identity-changed';
    case 5:
      return 'terminal';
    case 7:
      return 'foreign';
    case -8:
      return 'unsupported';
    default:
      throw new Error('TASK_CANCEL_UNEXPECTED_RESULT');
  }
}
