import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const analyticsCacheGenerationKey = (prefix: string) =>
  `${prefix.trim()}:neo:ops:analytics-cache:generation`;
export const newAnalyticsCacheGeneration = () =>
  randomBytes(32).toString('hex');
export const isAnalyticsCacheGeneration = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// No unbounded GET of a control value, and no repair of a corrupt existing key.
// Redis scripts are isolated, not rollback transactions after arbitrary errors.
const generationLua = `
local function valid_token(value)
  return type(value) == 'string' and #value == 64 and string.match(value, '^[0-9a-f]+$') ~= nil
end
local function generation(key, candidate)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then
    if not valid_token(candidate) then return nil end
    redis.call('SET', key, candidate, 'NX')
    kind = redis.call('TYPE', key).ok
  end
  if kind ~= 'string' or redis.call('STRLEN', key) ~= 64 or redis.call('PTTL', key) ~= -1 then return nil end
  local value = redis.call('GETRANGE', key, 0, 63)
  if not valid_token(value) then return nil end
  return value
end
local function server_time()
  local parts = redis.call('TIME')
  local value = tonumber(parts[1]) * 1000 + math.floor(tonumber(parts[2]) / 1000)
  if value < 0 or value > 9007199254740991 then return nil end
  return value
end`;

export const CAPTURE_MONITOR_ANALYTICS_GENERATION = `-- neo-analytics-cache-capture:v2\n${generationLua}
local captured = generation(KEYS[1], ARGV[1])
if not captured then return false end
local now = server_time()
if not now then return false end
return {captured, string.format('%.0f', now)}`;

export const LOOKUP_MONITOR_ANALYTICS_CACHE = `-- neo-analytics-cache-lookup:v2\n${generationLua}
local limit = tonumber(ARGV[2])
if not limit or limit < 1 or limit > 2097152 or limit ~= math.floor(limit) then return false end
local captured = generation(KEYS[1], ARGV[1])
if not captured then return false end
if redis.call('TYPE', KEYS[2]).ok ~= 'string' or redis.call('STRLEN', KEYS[2]) > limit then
  return {captured, false}
end
return {captured, redis.call('GET', KEYS[2])}`;

export const WRITE_MONITOR_ANALYTICS_CACHE = `-- neo-analytics-cache-fill:v2\n${generationLua}
local ttl = tonumber(ARGV[3])
if not valid_token(ARGV[1]) or type(ARGV[2]) ~= 'string' or #ARGV[2] > 2097152 or not ttl or ttl <= 0 or ttl > 3600000 or ttl ~= math.floor(ttl) then return 0 end
if generation(KEYS[1], nil) ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[2], ARGV[2], 'PX', ttl)`;

export const ROTATE_MONITOR_ANALYTICS_GENERATION = `-- neo-analytics-cache-rotate:v2\n${generationLua}
local ttl = tonumber(ARGV[4])
local deadline = tonumber(ARGV[5])
if not valid_token(ARGV[1]) or not valid_token(ARGV[2]) or ARGV[1] == ARGV[2] or type(ARGV[3]) ~= 'string' or #ARGV[3] > 64 or not ttl or ttl <= 0 or ttl > 2592000 or ttl ~= math.floor(ttl) or not deadline or deadline < 0 or deadline > 9007199254740991 or deadline ~= math.floor(deadline) then return -2 end
local captured = generation(KEYS[1], nil)
if not captured then return -2 end
if captured ~= ARGV[1] then return 0 end
local now = server_time()
if not now or now >= deadline then return -1 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SETEX', KEYS[2], ttl, ARGV[3])
return 1`;

export function parseAnalyticsCacheCapture(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !isAnalyticsCacheGeneration(value[0]) ||
    typeof value[1] !== 'string' ||
    !/^\d{1,16}$/.test(value[1])
  )
    return null;
  const serverTime = Number(value[1]);
  return Number.isSafeInteger(serverTime) && serverTime >= 0
    ? { generation: value[0], serverTime }
    : null;
}

export class AnalyticsCacheClearDeadlineError extends Error {
  constructor() {
    super('ANALYTICS_CACHE_CLEAR_DEADLINE');
  }
}

/** One local monotonic budget; a caller timeout does not cancel Redis work. */
export class AnalyticsCacheClearBudget {
  private readonly deadline = performance.now() + 5000;
  remaining() {
    const remaining = Math.floor(this.deadline - performance.now());
    if (remaining <= 0) throw new AnalyticsCacheClearDeadlineError();
    return remaining;
  }
  fixedServerDeadline(serverTime: number) {
    const deadline = serverTime + this.remaining();
    if (
      !Number.isSafeInteger(serverTime) ||
      serverTime < 0 ||
      !Number.isSafeInteger(deadline)
    )
      throw new AnalyticsCacheClearDeadlineError();
    return deadline;
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = this.remaining();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve()
      .then(() => {
        this.remaining();
        return operation();
      })
      .then((value) => {
        // Event-loop delay or a late ACK cannot turn expired work into success.
        this.remaining();
        return value;
      });
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AnalyticsCacheClearDeadlineError()),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
