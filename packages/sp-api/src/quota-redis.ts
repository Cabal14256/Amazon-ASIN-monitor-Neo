import { SpApiError } from './errors';
import type { QuotaDecision } from './quota-memory';
import {
  buildQuotaWindows,
  isQuotaOperation,
  OPERATION_QUOTAS,
  parseQuotaMetadata,
  quotaMetadataKey,
  resolveQuotaSettings,
  type QuotaMetadata,
  type QuotaSettings,
  type QuotaWindow,
} from './quota-policy';
import type { Region } from './types';

export interface QuotaRedisPort {
  readonly status: string;
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    keyCount: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}
type UnavailableReason =
  | 'not_ready'
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'closed'
  | 'dependency';
export type RedisQuotaResult<T> =
  | { available: true; value: T }
  | { available: false; reason: UnavailableReason };
export interface RedisQuotaDecision extends QuotaDecision {
  windows: QuotaWindow[];
  metadata?: QuotaMetadata;
  /** False when the local guard denied admission before running Lua. */
  checkedRedis?: boolean;
}
export interface RedisQuotaSnapshot {
  windows: (QuotaWindow & { used: number; remaining: number })[];
  metadata?: QuotaMetadata;
}

export const QUOTA_SNAPSHOT_SCRIPT = `
local counts = {}
local now = tonumber(ARGV[1])
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - tonumber(ARGV[i + 1]))
  counts[i] = redis.call('ZCARD', KEYS[i])
end
return counts
`;
export const QUOTA_PUBLISH_SCRIPT = `
local function validTime(value)
  if type(value) ~= 'string' then return false end
  local y,m,d,h,n,s = string.match(value, '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.%d%d%dZ$')
  if not y then return false end
  y,m,d,h,n,s = tonumber(y),tonumber(m),tonumber(d),tonumber(h),tonumber(n),tonumber(s)
  if m < 1 or m > 12 or h > 23 or n > 59 or s > 59 then return false end
  local days = {31,28,31,30,31,30,31,31,30,31,30,31}
  if y % 4 == 0 and (y % 100 ~= 0 or y % 400 == 0) then days[2] = 29 end
  return d >= 1 and d <= days[m]
end
local incoming = cjson.decode(ARGV[1])
local raw = redis.call('GET', KEYS[1])
if raw and string.len(raw) <= 4096 then
  local ok, current = pcall(cjson.decode, raw)
  if ok and type(current) == 'table' and (type(current.rate) == 'number' or type(current.rate) == 'string') then
    local rate = tonumber(current.rate)
    if rate and rate > 0 and rate <= 1000000 and validTime(current.updatedAt)
      and current.updatedAt > incoming.updatedAt then return 0 end
  end
end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`;

// Keep Legacy's keys, ZSET member format and argument framing. All windows are
// checked before deductions. NX also makes a repeated request acknowledgement
// idempotent without extending the timestamp of an already charged member.
export const QUOTA_ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local memberPrefix = ARGV[2]
local keyCount = tonumber(ARGV[3])
local tokenCount = tonumber(ARGV[4])
local retryMs = 0
for i = 1, keyCount do
  local base = 4 + ((i - 1) * 3)
  local limitValue = tonumber(ARGV[base + 1])
  local windowMs = tonumber(ARGV[base + 2])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - windowMs)
  local count = redis.call('ZCARD', KEYS[i])
  local needed = 0
  for tokenIndex = 1, tokenCount do
    if not redis.call('ZSCORE', KEYS[i], memberPrefix .. ':' .. tokenIndex) then needed = needed + 1 end
  end
  if needed > 0 and count + needed > limitValue then
    local index = count + needed - limitValue - 1
    local oldest = redis.call('ZRANGE', KEYS[i], index, index, 'WITHSCORES')
    local oldestScore = tonumber(oldest[2]) or now
    retryMs = math.max(retryMs, windowMs - (now - oldestScore) + 1)
  end
end
if retryMs > 0 then return {0, retryMs} end
for i = 1, keyCount do
  local base = 4 + ((i - 1) * 3)
  for tokenIndex = 1, tokenCount do
    redis.call('ZADD', KEYS[i], 'NX', now, memberPrefix .. ':' .. tokenIndex)
  end
  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[base + 3]))
end
return {1, 0}
`;

/** The caller owns the Redis connection and must disable offline command queues
 * and use finite command retries/timeouts. A timed-out operation retains its
 * admission slot until underlying work settles, preventing a command backlog.
 */
export class RedisQuotaStore {
  readonly settings: QuotaSettings;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly stops = new Set<(reason: UnavailableReason) => void>();
  private closed = false;
  private timestamp(value = this.now()): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999)
      throw new SpApiError('INVALID_INPUT');
    return value;
  }
  constructor(
    private readonly redis: QuotaRedisPort,
    settings: QuotaSettings,
    options: { timeoutMs?: number; now?: () => number } = {},
  ) {
    this.settings = resolveQuotaSettings({
      RATE_LIMITER_KEY_PREFIX: settings.prefix,
      SP_API_RATE_LIMIT_PER_MINUTE: settings.regionPerMinute,
      SP_API_RATE_LIMIT_PER_HOUR: settings.regionPerHour,
      SP_API_RATE_LIMIT_SAFETY_FACTOR: settings.safetyFactor,
      SP_API_RATE_LIMIT_BURST_CAP: settings.burstCap,
    });
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 10 ||
      this.timeoutMs > 10_000 ||
      typeof this.now !== 'function'
    )
      throw new SpApiError('INVALID_CONFIG');
  }
  private async run<T>(
    slot: string,
    work: (assertActive: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<RedisQuotaResult<T>> {
    if (this.closed) return { available: false, reason: 'closed' };
    if (signal?.aborted) return { available: false, reason: 'cancelled' };
    if (this.pending.has(slot)) return { available: false, reason: 'busy' };
    if (this.redis.status !== 'ready')
      return { available: false, reason: 'not_ready' };
    let active = true;
    let reason: UnavailableReason = 'dependency';
    let resolveStop!: (result: RedisQuotaResult<T>) => void;
    const stopped = new Promise<RedisQuotaResult<T>>((resolve) => {
      resolveStop = resolve;
    });
    const stop = (next: UnavailableReason) => {
      if (!active) return;
      active = false;
      reason = next;
      resolveStop({ available: false, reason });
    };
    const assertActive = () => {
      if (!active || this.closed || signal?.aborted)
        throw new SpApiError('CANCELLED');
    };
    const promise = Promise.resolve().then(() => {
      assertActive();
      return work(assertActive);
    });
    this.pending.set(slot, promise);
    const cleanup = () => {
      if (this.pending.get(slot) === promise) this.pending.delete(slot);
    };
    void promise.then(cleanup, cleanup);
    const outcome = promise.then<RedisQuotaResult<T>, RedisQuotaResult<T>>(
      (value) =>
        active ? { available: true, value } : { available: false, reason },
      () => ({ available: false, reason }),
    );
    this.stops.add(stop);
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), this.timeoutMs);
    try {
      return await Promise.race([outcome, stopped]);
    } finally {
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.stops.delete(stop);
    }
  }
  async acquire(
    region: Region,
    operation: string,
    requestId: string,
    signal?: AbortSignal,
    guard?: (metadata: QuotaMetadata | undefined) => QuotaDecision,
  ): Promise<RedisQuotaResult<RedisQuotaDecision>> {
    if (
      !['US', 'EU'].includes(region) ||
      !isQuotaOperation(operation) ||
      typeof requestId !== 'string' ||
      !/^[a-zA-Z0-9:_-]{1,200}$/.test(requestId)
    )
      throw new SpApiError('INVALID_INPUT');
    return this.run(
      'acquire',
      async (assertActive) => {
        const metadata = parseQuotaMetadata(
          await this.redis.get(
            quotaMetadataKey(this.settings, region, operation),
          ),
        );
        assertActive();
        const windows = buildQuotaWindows(
          this.settings,
          region,
          operation,
          metadata,
        );
        const local = guard?.(metadata);
        if (local && !local.allowed)
          return { ...local, windows, metadata, checkedRedis: false };
        assertActive();
        const now = this.timestamp();
        const raw = await this.redis.eval(
          QUOTA_ACQUIRE_SCRIPT,
          windows.length,
          ...windows.map((window) => window.key),
          now,
          requestId,
          windows.length,
          1,
          ...windows.flatMap((window) => [
            window.limit,
            window.windowMs,
            window.ttlMs,
          ]),
        );
        assertActive();
        if (
          !Array.isArray(raw) ||
          raw.length !== 2 ||
          ![0, 1].includes(raw[0]) ||
          !Number.isSafeInteger(raw[1]) ||
          raw[1] < 0 ||
          (raw[0] === 1 && raw[1] !== 0) ||
          (raw[0] === 0 && raw[1] === 0)
        )
          throw new SpApiError('DEPENDENCY_ERROR');
        return {
          allowed: raw[0] === 1,
          retryMs: raw[1] as number,
          windows,
          metadata,
          checkedRedis: true,
        };
      },
      signal,
    );
  }

  async snapshot(
    region: Region,
    operation?: string,
    signal?: AbortSignal,
  ): Promise<RedisQuotaResult<RedisQuotaSnapshot>> {
    if (
      !['US', 'EU'].includes(region) ||
      (operation !== undefined && !isQuotaOperation(operation))
    )
      throw new SpApiError('INVALID_INPUT');
    return this.run(
      `snapshot:${region}:${operation ?? 'region'}`,
      async (assertActive) => {
        const metadata =
          operation !== undefined && isQuotaOperation(operation)
            ? parseQuotaMetadata(
                await this.redis.get(
                  quotaMetadataKey(this.settings, region, operation),
                ),
              )
            : undefined;
        assertActive();
        const all = buildQuotaWindows(
          this.settings,
          region,
          operation ?? 'default',
          metadata,
        );
        const windows =
          operation === undefined ? all.slice(0, 2) : all.slice(2);
        const counts = await this.redis.eval(
          QUOTA_SNAPSHOT_SCRIPT,
          windows.length,
          ...windows.map((window) => window.key),
          this.timestamp(),
          ...windows.map((window) => window.windowMs),
        );
        assertActive();
        if (
          !Array.isArray(counts) ||
          counts.length !== windows.length ||
          counts.some((count) => !Number.isSafeInteger(count) || count < 0)
        )
          throw new SpApiError('DEPENDENCY_ERROR');
        return {
          metadata,
          windows: windows.map((window, index) => ({
            ...window,
            used: counts[index] as number,
            remaining: Math.max(window.limit - counts[index], 0),
          })),
        };
      },
      signal,
    );
  }

  async publish(
    region: Region,
    operation: string,
    rate: number,
    signal?: AbortSignal,
    observedAt?: number,
  ): Promise<RedisQuotaResult<boolean>> {
    if (
      !['US', 'EU'].includes(region) ||
      !isQuotaOperation(operation) ||
      !Number.isFinite(rate) ||
      rate <= 0 ||
      rate > 1_000_000
    )
      throw new SpApiError('INVALID_INPUT');
    const updatedAt = new Date(this.timestamp(observedAt)).toISOString();
    const metadata = JSON.stringify({
      rate,
      burst: OPERATION_QUOTAS[operation].burst,
      source: 'response_header',
      updatedAt,
    });
    return this.run(
      `publish:${region}:${operation}`,
      async (assertActive) => {
        const result = await this.redis.eval(
          QUOTA_PUBLISH_SCRIPT,
          1,
          quotaMetadataKey(this.settings, region, operation),
          metadata,
        );
        assertActive();
        if (result !== 0 && result !== 1)
          throw new SpApiError('DEPENDENCY_ERROR');
        return result === 1;
      },
      signal,
    );
  }
  close() {
    this.closed = true;
    for (const stop of this.stops) stop('closed');
  }
}
