import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { Env } from '@asin-monitor/config';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { MetricsService } from '../metrics/metrics.service';
import { ApplicationRedisClient } from '../redis/redis.service';

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;
export const STRICT_RATE_LIMIT = 20;
export const ROLE_LIMITS = {
  ADMIN: 1_000,
  EDITOR: 500,
  READONLY: 100,
  DEFAULT: 100,
} as const;

export type RateLimitRole = keyof typeof ROLE_LIMITS;
export type RateLimitPolicy = 'role' | 'strict';
export type RateLimitBackend = 'memory' | 'redis';

interface WindowIdentity {
  expiresAt: number;
  generation: string;
}

interface MemoryWindow extends WindowIdentity {
  limit: number;
  ownerCounts: Map<string, number>;
  overflowKey: string;
  requestIds: Set<string>;
  requestOwners: Map<string, string>;
}

interface MemoryWindowSnapshot {
  clientKeys: string[];
  isOverflow: boolean;
  key: string;
  overflowKey: string;
  requestIds: string[];
  requestOwners: string[];
  window: MemoryWindow;
}

interface ReconciliationBarrier {
  promise: Promise<void>;
  resolve: () => void;
}

interface RoleStats {
  requests: number;
  blocked: number;
}

interface WindowResult {
  backend: RateLimitBackend;
  clientKey: string;
  count: number;
  generation: string;
  overflowKey: string;
  requestId: string;
  storageKey: string;
  ttlMs: number;
  uncertainRedisReservation: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  backend: RateLimitBackend;
  clientKey: string;
  count: number;
  generation: string;
  limit: number;
  overflowKey: string;
  policy: RateLimitPolicy;
  remaining: number;
  requestId: string;
  resetAfterMs: number;
  role: RateLimitRole;
  storageKey: string;
  uncertainRedisReservation: boolean;
}

const REDIS_RETRY_DELAY_MS = 5_000;
const MAX_MEMORY_WINDOWS = 10_000;
export const MAX_MEMORY_RESERVATIONS = 100_000;
const RECONCILIATION_BATCH_SIZE = 100;
const CONSUME_WINDOW_SCRIPT = `
redis.replicate_commands()
local redisTime = redis.call('TIME')
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local windowMs = tonumber(ARGV[5])
local currentGeneration = tostring(math.floor(nowMs / windowMs))
local expiresAt = (tonumber(currentGeneration) + 1) * windowMs
local selected = KEYS[1]
if redis.call('HGET', KEYS[3], 'generation') == currentGeneration
  and redis.call('HEXISTS', KEYS[3], KEYS[1]) == 1 then
  selected = KEYS[2]
end
local generation = redis.call('HGET', selected, 'generation')
if generation ~= currentGeneration then
  redis.call('DEL', selected)
  redis.call('HSET', selected, 'generation', currentGeneration)
end
local field = 'request:' .. ARGV[4]
local current = redis.call('HLEN', selected) - 1
local effective = current
if selected == KEYS[2] then
  local ownerCount = tonumber(redis.call('HGET', KEYS[3], KEYS[1])) or 0
  local individualCount = 0
  if redis.call('HGET', KEYS[1], 'generation') == currentGeneration then
    individualCount = redis.call('HLEN', KEYS[1]) - 1
  end
  effective = math.max(current, individualCount + ownerCount)
  if redis.call('HEXISTS', selected, field) == 0 and effective <= tonumber(ARGV[3]) then
    redis.call('HSET', selected, field, KEYS[1])
    redis.call('HINCRBY', KEYS[3], KEYS[1], 1)
    current = current + 1
    ownerCount = ownerCount + 1
    effective = math.max(current, individualCount + ownerCount)
  end
  if ownerCount <= 0 then redis.call('HDEL', KEYS[3], KEYS[1]) end
  if redis.call('HLEN', KEYS[3]) <= 1 then
    redis.call('DEL', KEYS[3])
  else
    redis.call('PEXPIREAT', KEYS[3], expiresAt)
  end
elseif redis.call('HEXISTS', selected, field) == 0 and current <= tonumber(ARGV[3]) then
  redis.call('HSET', selected, field, 1)
  current = current + 1
  effective = current
end
redis.call('PEXPIREAT', selected, expiresAt)
return { effective, redis.call('PTTL', selected), currentGeneration, selected }
`;
const RELEASE_WINDOW_SCRIPT = `
redis.replicate_commands()
local redisTime = redis.call('TIME')
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local currentGeneration = tostring(math.floor(nowMs / tonumber(ARGV[3])))
local released = 0
for index = 1, 2 do
  local sourceGeneration = redis.call('HGET', KEYS[index], 'generation')
  if sourceGeneration == ARGV[1] or sourceGeneration == currentGeneration then
    local field = 'request:' .. ARGV[2]
    local owner = nil
    if index == 2 then
      owner = redis.call('HGET', KEYS[index], field)
    end
    local removed = redis.call('HDEL', KEYS[index], field)
    released = released + removed
    if removed == 1 and index == 2
      and redis.call('HGET', KEYS[3], 'generation') == sourceGeneration then
      if not owner or owner == '1' then owner = KEYS[1] end
      local ownerCount = redis.call('HINCRBY', KEYS[3], owner, -1)
      if ownerCount <= 0 then redis.call('HDEL', KEYS[3], owner) end
    end
    if removed == 1 and redis.call('HLEN', KEYS[index]) <= 1 then
      redis.call('DEL', KEYS[index])
      if index == 2 then
        redis.call('DEL', KEYS[3])
      end
    end
  end
end
return released
`;
const TRANSFER_WINDOW_SCRIPT = `
redis.replicate_commands()
local redisTime = redis.call('TIME')
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local windowMs = tonumber(ARGV[7])
local currentGeneration = tostring(math.floor(nowMs / windowMs))
local expiresAt = (tonumber(currentGeneration) + 1) * windowMs
local selected = KEYS[3]
if redis.call('HGET', KEYS[5], 'generation') == currentGeneration
  and redis.call('HEXISTS', KEYS[5], KEYS[3]) == 1 then
  selected = KEYS[4]
end
local generation = redis.call('HGET', selected, 'generation')
if generation ~= currentGeneration then
  redis.call('DEL', selected)
  redis.call('HSET', selected, 'generation', currentGeneration)
end
local field = 'request:' .. ARGV[4]
local current = redis.call('HLEN', selected) - 1
local effective = current
if selected == KEYS[4] then
  local ownerCount = tonumber(redis.call('HGET', KEYS[5], KEYS[3])) or 0
  local individualCount = 0
  if redis.call('HGET', KEYS[3], 'generation') == currentGeneration then
    individualCount = redis.call('HLEN', KEYS[3]) - 1
  end
  effective = math.max(current, individualCount + ownerCount)
  if redis.call('HEXISTS', selected, field) == 0 and effective <= tonumber(ARGV[3]) then
    redis.call('HSET', selected, field, KEYS[3])
    redis.call('HINCRBY', KEYS[5], KEYS[3], 1)
    current = current + 1
    ownerCount = ownerCount + 1
    effective = math.max(current, individualCount + ownerCount)
  end
  redis.call('PEXPIREAT', KEYS[5], expiresAt)
elseif redis.call('HEXISTS', selected, field) == 0 and current <= tonumber(ARGV[3]) then
  redis.call('HSET', selected, field, 1)
  current = current + 1
  effective = current
end
redis.call('PEXPIREAT', selected, expiresAt)
local released = 0
if effective <= tonumber(ARGV[3]) and ARGV[6] ~= '0' then
  for index = 1, 2 do
    local sourceGeneration = redis.call('HGET', KEYS[index], 'generation')
    if sourceGeneration == ARGV[5] or sourceGeneration == currentGeneration then
      local owner = nil
      if index == 2 then owner = redis.call('HGET', KEYS[index], field) end
      local removed = redis.call('HDEL', KEYS[index], field)
      released = released + removed
      if removed == 1 and index == 2
        and redis.call('HGET', KEYS[6], 'generation') == sourceGeneration then
        if not owner or owner == '1' then owner = KEYS[1] end
        local ownerCount = redis.call('HINCRBY', KEYS[6], owner, -1)
        if ownerCount <= 0 then redis.call('HDEL', KEYS[6], owner) end
      end
      if redis.call('HLEN', KEYS[index]) <= 1 then
        redis.call('DEL', KEYS[index])
        if index == 2 then
          redis.call('DEL', KEYS[6])
        end
      end
    end
  end
end
return { effective, redis.call('PTTL', selected), currentGeneration, selected, released }
`;
const RECONCILE_WINDOW_SCRIPT = `
redis.replicate_commands()
local redisTime = redis.call('TIME')
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local windowMs = tonumber(ARGV[#ARGV])
local currentGeneration = tostring(math.floor(nowMs / windowMs))
local expiresAt = (tonumber(currentGeneration) + 1) * windowMs
local recoveryGeneration = ARGV[#ARGV - 1]
if currentGeneration ~= recoveryGeneration then
  local current = 0
  if redis.call('HGET', KEYS[1], 'generation') == currentGeneration then
    current = redis.call('HLEN', KEYS[1]) - 1
  end
  return { current, expiresAt - nowMs, currentGeneration, KEYS[1] }
end
local generation = redis.call('HGET', KEYS[1], 'generation')
if generation ~= currentGeneration then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'generation', currentGeneration)
end
local current = redis.call('HLEN', KEYS[1]) - 1
local requestCount = tonumber(ARGV[4])
local isOverflow = ARGV[#ARGV - 2] == '1'
if isOverflow then
  local memberGeneration = redis.call('HGET', KEYS[2], 'generation')
  if memberGeneration ~= currentGeneration then
    redis.call('DEL', KEYS[2])
    redis.call('HSET', KEYS[2], 'generation', currentGeneration)
  end
end
for index = 1, requestCount do
  local field = 'request:' .. ARGV[4 + index]
  local owner = ARGV[4 + requestCount + index]
  local alreadyCounted = redis.call('HEXISTS', KEYS[1], field) == 1
  if not alreadyCounted and owner ~= ''
    and redis.call('HGET', owner, 'generation') == currentGeneration
    and redis.call('HEXISTS', owner, field) == 1 then
    alreadyCounted = true
  end
  if not alreadyCounted and not isOverflow
    and redis.call('HGET', KEYS[2], 'generation') == currentGeneration
    and redis.call('HGET', KEYS[2], field) == KEYS[1] then
    alreadyCounted = true
  end
  if not alreadyCounted then
    local value = owner ~= '' and owner or '1'
    redis.call('HSET', KEYS[1], field, value)
    current = current + 1
    if isOverflow and owner ~= '' then
      redis.call('HINCRBY', KEYS[2], owner, 1)
    end
  end
end
redis.call('PEXPIREAT', KEYS[1], expiresAt)
if isOverflow then
  for keyIndex = 3, #KEYS do
    local ownerCount = tonumber(redis.call('HGET', KEYS[2], KEYS[keyIndex])) or 0
    if ownerCount <= 0 then redis.call('HDEL', KEYS[2], KEYS[keyIndex]) end
  end
  if redis.call('HLEN', KEYS[2]) <= 1 then
    redis.call('DEL', KEYS[2])
  else
    redis.call('PEXPIREAT', KEYS[2], expiresAt)
  end
end
return { current, redis.call('PTTL', KEYS[1]), currentGeneration, KEYS[1] }
`;
const CAPABILITY_PROBE_SCRIPT = `
redis.replicate_commands()
local redisTime = redis.call('TIME')
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local currentGeneration = tostring(math.floor(nowMs / tonumber(ARGV[4])))
redis.call('HSET', KEYS[1], 'generation', currentGeneration)
redis.call('HSET', KEYS[1], 'request:' .. ARGV[3], 1)
redis.call('HSETNX', KEYS[1], 'owner:' .. ARGV[3], 0)
redis.call('HINCRBY', KEYS[1], 'owner:' .. ARGV[3], 1)
redis.call('HGET', KEYS[1], 'generation')
redis.call('HEXISTS', KEYS[1], 'request:' .. ARGV[3])
redis.call('HLEN', KEYS[1])
redis.call('HDEL', KEYS[1], 'request:' .. ARGV[3])
redis.call('HDEL', KEYS[1], 'owner:' .. ARGV[3])
redis.call('PEXPIREAT', KEYS[1], nowMs + 1000)
redis.call('PTTL', KEYS[1])
redis.call('DEL', KEYS[1])
return { currentGeneration, tostring(nowMs) }
`;

function freshRoleStats(): Record<RateLimitRole, RoleStats> {
  return {
    ADMIN: { requests: 0, blocked: 0 },
    EDITOR: { requests: 0, blocked: 0 },
    READONLY: { requests: 0, blocked: 0 },
    DEFAULT: { requests: 0, blocked: 0 },
  };
}

function identityAt(now: number): WindowIdentity {
  const windowNumber = Math.floor(now / RATE_LIMIT_WINDOW_MS);
  return {
    generation: String(windowNumber),
    expiresAt: (windowNumber + 1) * RATE_LIMIT_WINDOW_MS,
  };
}

function parseRedisWindow(
  value: unknown,
  storageKey: string,
  minimumCount = 1,
): { count: number; generation: string; storageKey: string; ttlMs: number } {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error('invalid Redis rate-limit response');
  }
  const count = Number(value[0]);
  const ttlMs = Number(value[1]);
  const generation = String(value[2] ?? '');
  const returnedKey = String(value[3] ?? storageKey);
  if (
    !Number.isInteger(count) ||
    count < minimumCount ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    generation.length === 0 ||
    returnedKey.length === 0
  ) {
    throw new Error('invalid Redis rate-limit counter');
  }
  return { count, generation, storageKey: returnedKey, ttlMs };
}

function parseRecoveryClock(value: unknown): {
  generation: string;
  redisNowMs?: number;
} {
  const generation = String(Array.isArray(value) ? value[0] : value ?? '');
  if (!/^\d+$/.test(generation)) {
    throw new Error('invalid Redis rate-limit recovery generation');
  }
  if (!Array.isArray(value)) return { generation };
  const redisNowMs = Number(value[1]);
  if (!Number.isSafeInteger(redisNowMs) || redisNowMs <= 0) {
    throw new Error('invalid Redis rate-limit recovery clock');
  }
  return { generation, redisNowMs };
}

export function selectRateLimitRole(codes: readonly string[]): RateLimitRole {
  const normalized = new Set(codes.map((code) => code.trim().toUpperCase()));
  if (normalized.has('ADMIN')) return 'ADMIN';
  if (normalized.has('EDITOR')) return 'EDITOR';
  if (normalized.has('READONLY')) return 'READONLY';
  return 'DEFAULT';
}

export function buildRateLimitKey(
  prefix: string,
  policy: RateLimitPolicy,
  role: RateLimitRole,
  clientIdentifier: string,
): string {
  const digest = createHash('sha256').update(clientIdentifier).digest('hex');
  const bucket = policy === 'strict' ? 'strict' : role.toLowerCase();
  return `${prefix}:http:neo:${bucket}:${digest}`;
}

@Injectable()
export class RateLimitService {
  private readonly memoryWindows = new Map<string, MemoryWindow>();
  private readonly memoryOverflowWindows = new Map<string, MemoryWindow>();
  private readonly capabilityProbeKey: string;
  private byRole = freshRoleStats();
  private totalRequests = 0;
  private blockedRequests = 0;
  private lastReset = Date.now();
  private backend: RateLimitBackend = 'redis';
  private redisRetryAfter = 0;
  private nextMemoryCleanupAt = 0;
  private lastMemoryCleanupGeneration: string | undefined;
  private memoryReservationCount = 0;
  private recoveryProbeInFlight = false;
  private recoveryPromise: Promise<void> | undefined;
  private readonly reconciliationBarriers = new Map<
    string,
    ReconciliationBarrier
  >();
  private recoveryUsesRedis = false;
  private reconciliationUncertain = false;
  private capabilityVerified = false;
  private redisClockOffsetMs: number | undefined;
  private readonly pendingSourceReleases = new Map<
    string,
    Map<string, RateLimitDecision>
  >();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ApplicationRedisClient)
    private readonly redis: ApplicationRedisClient,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    // Lua errors do not roll back preceding writes. Reuse one isolated key
    // across retries/instances so partial ACL failures cannot leak probe keys.
    this.capabilityProbeKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:capability:probe`;
    this.metrics.setRateLimitBackend(this.enabled ? 'redis' : 'disabled');
    if (!env.API_RATE_LIMIT_ENABLED) {
      logger.info('HTTP API 限流已禁用', 'RateLimitService', {
        reason: 'configuration',
      });
    }
  }

  get enabled(): boolean {
    return this.env.API_RATE_LIMIT_ENABLED;
  }

  isWhitelisted(clientIdentifier: string): boolean {
    const candidates = new Set([clientIdentifier]);
    if (clientIdentifier.startsWith('::ffff:')) {
      candidates.add(clientIdentifier.slice('::ffff:'.length));
    } else if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(clientIdentifier)) {
      candidates.add(`::ffff:${clientIdentifier}`);
    }
    return this.env.RATE_LIMIT_WHITELIST_IPS.some((entry) =>
      candidates.has(entry),
    );
  }

  private redisAlignedNow(localNow: number): number {
    return localNow + (this.redisClockOffsetMs ?? 0);
  }

  private observeRedisClock(
    redisNowMs: number,
    localStartedAt: number,
    localCompletedAt = Date.now(),
  ): void {
    const localMidpoint = (localStartedAt + localCompletedAt) / 2;
    this.redisClockOffsetMs = Math.round(redisNowMs - localMidpoint);
  }

  private observeRedisWindow(
    window: Pick<WindowResult, 'generation' | 'ttlMs'>,
    localStartedAt: number,
  ): void {
    const redisWindowEnd =
      (Number(window.generation) + 1) * RATE_LIMIT_WINDOW_MS;
    this.observeRedisClock(
      redisWindowEnd - window.ttlMs,
      localStartedAt,
      Date.now(),
    );
  }

  private setBackend(next: RateLimitBackend, now: number): void {
    // Operations started before recovery may fail after its snapshot freezes.
    // Invalidate the snapshot before a fallback adds another reservation.
    if (next === 'memory') this.recoveryUsesRedis = false;
    if (this.backend === next) {
      if (next === 'memory') this.redisRetryAfter = now + REDIS_RETRY_DELAY_MS;
      return;
    }
    const previous = this.backend;
    this.backend = next;
    this.metrics.setRateLimitBackend(next);
    if (next === 'memory') {
      this.capabilityVerified = false;
      this.redisRetryAfter = now + REDIS_RETRY_DELAY_MS;
      this.logger.warn(
        'HTTP 限流 Redis 不可用，切换内存降级',
        'RateLimitService',
        { backend: 'memory', reason: 'redis_unavailable' },
      );
      return;
    }
    this.redisRetryAfter = 0;
    this.logger.info('HTTP 限流 Redis 已恢复', 'RateLimitService', {
      backend: 'redis',
      previousBackend: previous,
    });
  }

  private cleanMemory(now: number): void {
    for (const [key, window] of this.memoryWindows) {
      if (window.expiresAt <= now) {
        this.removeMemoryWindow(this.memoryWindows, key);
        this.pendingSourceReleases.delete(key);
      }
    }
    for (const [key, window] of this.memoryOverflowWindows) {
      if (window.expiresAt <= now) {
        this.removeMemoryWindow(this.memoryOverflowWindows, key);
        this.pendingSourceReleases.delete(key);
      }
    }
  }

  private removeMemoryWindow(
    map: Map<string, MemoryWindow>,
    key: string,
  ): void {
    const window = map.get(key);
    if (!window) return;
    this.memoryReservationCount = Math.max(
      0,
      this.memoryReservationCount - window.requestIds.size,
    );
    map.delete(key);
  }

  private cleanMemoryForCapacity(identity: WindowIdentity): void {
    const now = this.redisAlignedNow(Date.now());
    if (
      this.lastMemoryCleanupGeneration === identity.generation &&
      now < this.nextMemoryCleanupAt
    ) {
      return;
    }
    this.cleanMemory(now);
    this.nextMemoryCleanupAt = now + 60_000;
    this.lastMemoryCleanupGeneration = identity.generation;
  }

  private newMemoryWindow(
    identity: WindowIdentity,
    limit: number,
    overflowKey: string,
  ): MemoryWindow {
    return {
      ...identity,
      limit,
      overflowKey,
      ownerCounts: new Map<string, number>(),
      requestIds: new Set<string>(),
      requestOwners: new Map<string, string>(),
    };
  }

  private memoryRequestCount(window: MemoryWindow): number {
    return window.requestIds.size;
  }

  private addMemoryRequest(window: MemoryWindow, requestId: string): boolean {
    if (window.requestIds.has(requestId)) return true;
    if (
      this.memoryRequestCount(window) > window.limit ||
      this.memoryReservationCount >= MAX_MEMORY_RESERVATIONS
    )
      return false;
    window.requestIds.add(requestId);
    this.memoryReservationCount += 1;
    return true;
  }

  private activeMemoryWindow(
    map: Map<string, MemoryWindow>,
    key: string,
    identity: WindowIdentity,
  ): MemoryWindow | undefined {
    const window = map.get(key);
    if (!window) return undefined;
    if (window.generation === identity.generation) return window;
    this.removeMemoryWindow(map, key);
    this.pendingSourceReleases.delete(key);
    return undefined;
  }

  private consumeMemory(
    clientKey: string,
    overflowKey: string,
    identity: WindowIdentity,
    limit: number,
    requestId: string,
    uncertainRedisReservation = false,
    reusableSource?: RateLimitDecision,
  ): WindowResult {
    // A synchronous transfer may use the slot occupied solely by its source.
    // Keep that reservation until target admission succeeds; no await occurs
    // between allocation and release, and a failed new allocation removes itself.
    const sourceWindow = reusableSource
      ? this.memoryWindows.get(reusableSource.clientKey)
      : undefined;
    const canReuseSourceSlot = Boolean(
      reusableSource &&
        reusableSource.clientKey !== clientKey &&
        sourceWindow?.generation === identity.generation &&
        sourceWindow.requestIds.size === 1 &&
        sourceWindow.requestIds.has(requestId),
    );
    const atCapacity = () =>
      this.memoryWindows.size >= MAX_MEMORY_WINDOWS && !canReuseSourceSlot;
    let window = this.activeMemoryWindow(
      this.memoryWindows,
      clientKey,
      identity,
    );
    let storageKey = clientKey;
    if (!window) {
      if (atCapacity()) {
        this.cleanMemoryForCapacity(identity);
      }
      const overflow = this.activeMemoryWindow(
        this.memoryOverflowWindows,
        overflowKey,
        identity,
      );
      if (overflow && (atCapacity() || overflow.ownerCounts.has(clientKey))) {
        window = overflow;
        storageKey = overflowKey;
      }
    }
    if (!window) {
      if (atCapacity()) {
        this.cleanMemoryForCapacity(identity);
      }
      if (atCapacity()) {
        window = this.newMemoryWindow(identity, limit, overflowKey);
        this.memoryOverflowWindows.set(overflowKey, window);
        storageKey = overflowKey;
      } else {
        window = this.newMemoryWindow(identity, limit, overflowKey);
        this.memoryWindows.set(clientKey, window);
      }
    }
    const stored = this.addMemoryRequest(window, requestId);
    if (!stored && this.memoryRequestCount(window) === 0) {
      this.removeMemoryWindow(
        storageKey === overflowKey
          ? this.memoryOverflowWindows
          : this.memoryWindows,
        storageKey,
      );
    }
    if (
      stored &&
      storageKey === overflowKey &&
      !window.requestOwners.has(requestId)
    ) {
      window.requestOwners.set(requestId, clientKey);
      window.ownerCounts.set(
        clientKey,
        (window.ownerCounts.get(clientKey) ?? 0) + 1,
      );
    }
    const count = stored
      ? this.memoryRequestCount(window)
      : Math.max(this.memoryRequestCount(window), limit + 1);
    return {
      backend: 'memory',
      clientKey,
      count: this.reconciliationUncertain ? Math.max(count, limit + 1) : count,
      generation: window.generation,
      overflowKey,
      requestId,
      storageKey,
      ttlMs: Math.max(1, window.expiresAt - this.redisAlignedNow(Date.now())),
      uncertainRedisReservation,
    };
  }

  private releaseMemory(decision: RateLimitDecision, now: number): void {
    for (const [map, key] of [
      [this.memoryWindows, decision.clientKey],
      [this.memoryOverflowWindows, decision.overflowKey],
    ] as const) {
      const window = map.get(key);
      if (
        !window ||
        window.expiresAt <= this.redisAlignedNow(now) ||
        window.generation !== decision.generation ||
        !window.requestIds.delete(decision.requestId)
      ) {
        continue;
      }
      const owner = window.requestOwners.get(decision.requestId);
      window.requestOwners.delete(decision.requestId);
      if (owner) {
        const remaining = (window.ownerCounts.get(owner) ?? 1) - 1;
        if (remaining > 0) window.ownerCounts.set(owner, remaining);
        else window.ownerCounts.delete(owner);
      }
      this.memoryReservationCount = Math.max(
        0,
        this.memoryReservationCount - 1,
      );
      if (this.memoryRequestCount(window) === 0) map.delete(key);
    }
  }

  private beginRecoveryProbe(now: number): boolean {
    if (
      this.backend !== 'memory' ||
      now < this.redisRetryAfter ||
      this.recoveryProbeInFlight
    ) {
      return false;
    }
    this.recoveryProbeInFlight = true;
    return true;
  }

  private memorySnapshots(
    now: number,
    priorityKey?: string,
  ): MemoryWindowSnapshot[] {
    this.cleanMemory(this.redisAlignedNow(now));
    const snapshots = [
      ...Array.from(this.memoryWindows, ([key, window]) =>
        this.memorySnapshot(key, window, false),
      ),
      ...Array.from(this.memoryOverflowWindows, ([key, window]) =>
        this.memorySnapshot(key, window, true),
      ),
    ];
    const priorityIndex = priorityKey
      ? snapshots.findIndex(({ key }) => key === priorityKey)
      : -1;
    if (priorityIndex > 0) {
      const [priority] = snapshots.splice(priorityIndex, 1);
      if (priority) snapshots.unshift(priority);
    }
    return snapshots;
  }

  private memorySnapshot(
    key: string,
    window: MemoryWindow,
    isOverflow: boolean,
  ): MemoryWindowSnapshot {
    const requestIds = [...window.requestIds];
    const requestOwners = requestIds.map(
      (requestId) => window.requestOwners.get(requestId) ?? '',
    );
    return {
      clientKeys: [...new Set(requestOwners.filter(Boolean))],
      isOverflow,
      key,
      overflowKey: isOverflow ? key : window.overflowKey,
      requestIds,
      requestOwners,
      window,
    };
  }

  private prepareReconciliationBarriers(
    snapshots: readonly MemoryWindowSnapshot[],
  ): void {
    this.finishReconciliationBarriers();
    for (const { key } of snapshots) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.reconciliationBarriers.set(key, { promise, resolve });
    }
  }

  private resolveReconciliationBarrier(key: string): void {
    const barrier = this.reconciliationBarriers.get(key);
    if (!barrier) return;
    this.reconciliationBarriers.delete(key);
    barrier.resolve();
  }

  private finishReconciliationBarriers(): void {
    for (const { resolve } of this.reconciliationBarriers.values()) resolve();
    this.reconciliationBarriers.clear();
  }

  private async waitForReconciliation(keys: readonly string[]): Promise<void> {
    const barriers = [
      ...new Set(
        keys
          .map((key) => this.reconciliationBarriers.get(key)?.promise)
          .filter((promise): promise is Promise<void> => Boolean(promise)),
      ),
    ];
    if (barriers.length > 0) await Promise.all(barriers);
  }

  private queueSourceRelease(
    targetStorageKey: string,
    source: RateLimitDecision,
  ): void {
    const pending =
      this.pendingSourceReleases.get(targetStorageKey) ??
      new Map<string, RateLimitDecision>();
    pending.set(source.requestId, source);
    this.pendingSourceReleases.set(targetStorageKey, pending);
  }

  private async releaseRedis(decision: RateLimitDecision): Promise<void> {
    await this.redis.eval(
      RELEASE_WINDOW_SCRIPT,
      [
        decision.clientKey,
        decision.overflowKey,
        this.overflowMembershipKey(decision.overflowKey),
      ],
      [decision.generation, decision.requestId, RATE_LIMIT_WINDOW_MS],
    );
  }

  private async releasePendingSources(targetStorageKey: string): Promise<void> {
    const pending = this.pendingSourceReleases.get(targetStorageKey);
    if (!pending) return;
    for (const source of pending.values()) {
      await this.releaseRedis(source);
    }
  }

  private async releaseAllPendingSources(): Promise<void> {
    // An uncertain source may itself be a memory snapshot. Release it only
    // after every snapshot is reconciled so a later batch cannot re-add it.
    // Retain every intent until recovery can commit: if a later release or a
    // concurrent Redis operation fails, the next recovery replays the entire
    // idempotent set after re-reconciliation.
    for (const targetStorageKey of this.pendingSourceReleases.keys()) {
      await this.releasePendingSources(targetStorageKey);
    }
  }

  private async reconcileMemory(
    recoveryClock: ReturnType<typeof parseRecoveryClock>,
    localStartedAt: number,
    localProbeCompletedAt: number,
    priorityKey?: string,
  ): Promise<void> {
    this.reconciliationUncertain = true;
    this.recoveryUsesRedis = true;
    const snapshots = this.memorySnapshots(Date.now(), priorityKey);
    this.prepareReconciliationBarriers(snapshots);
    for (
      let offset = 0;
      offset < snapshots.length;
      offset += RECONCILIATION_BATCH_SIZE
    ) {
      await Promise.all(
        snapshots
          .slice(offset, offset + RECONCILIATION_BATCH_SIZE)
          .map(
            async ({
              clientKeys,
              isOverflow,
              key,
              overflowKey,
              requestIds,
              requestOwners,
              window,
            }) => {
              parseRedisWindow(
                await this.redis.eval(
                  RECONCILE_WINDOW_SCRIPT,
                  isOverflow
                    ? [key, this.overflowMembershipKey(key), ...clientKeys]
                    : [key, overflowKey],
                  [
                    window.generation,
                    window.expiresAt,
                    window.limit,
                    requestIds.length,
                    ...requestIds,
                    ...requestOwners,
                    isOverflow ? 1 : 0,
                    recoveryClock.generation,
                    RATE_LIMIT_WINDOW_MS,
                  ],
                ),
                key,
                0,
              );
              this.resolveReconciliationBarrier(key);
            },
          ),
      );
    }
    await this.releaseAllPendingSources();
    if (!this.recoveryUsesRedis) {
      throw new Error('Redis rate-limit recovery interrupted');
    }
    this.pendingSourceReleases.clear();
    this.memoryWindows.clear();
    this.memoryOverflowWindows.clear();
    this.memoryReservationCount = 0;
    this.reconciliationUncertain = false;
    this.capabilityVerified = true;
    if (recoveryClock.redisNowMs !== undefined) {
      this.observeRedisClock(
        recoveryClock.redisNowMs,
        localStartedAt,
        localProbeCompletedAt,
      );
    }
    this.setBackend('redis', Date.now());
    this.recoveryUsesRedis = false;
  }

  private async runRecovery(now: number, priorityKey?: string): Promise<void> {
    const recovery = (async () => {
      try {
        const identity = identityAt(this.redisAlignedNow(now));
        const recoveryResponse = await this.redis.eval(
          CAPABILITY_PROBE_SCRIPT,
          [this.capabilityProbeKey],
          [identity.generation, now + 1_000, 'probe', RATE_LIMIT_WINDOW_MS],
        );
        const localProbeCompletedAt = Date.now();
        const recoveryClock = parseRecoveryClock(recoveryResponse);
        await this.reconcileMemory(
          recoveryClock,
          now,
          localProbeCompletedAt,
          priorityKey,
        );
      } catch {
        this.recoveryUsesRedis = false;
        this.setBackend('memory', Date.now());
      } finally {
        this.finishReconciliationBarriers();
        this.recoveryProbeInFlight = false;
      }
    })();
    this.recoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (this.recoveryPromise === recovery) this.recoveryPromise = undefined;
    }
  }

  private async consumeRedis(
    clientKey: string,
    overflowKey: string,
    identity: WindowIdentity,
    limit: number,
    requestId: string,
    localStartedAt: number,
  ): Promise<WindowResult> {
    const window = parseRedisWindow(
      await this.redis.eval(
        CONSUME_WINDOW_SCRIPT,
        [clientKey, overflowKey, this.overflowMembershipKey(overflowKey)],
        [
          identity.generation,
          identity.expiresAt,
          limit,
          requestId,
          RATE_LIMIT_WINDOW_MS,
        ],
      ),
      clientKey,
    );
    if (this.backend === 'redis') {
      this.observeRedisWindow(window, localStartedAt);
    }
    return {
      backend: 'redis',
      clientKey,
      overflowKey,
      requestId,
      uncertainRedisReservation: false,
      ...window,
    };
  }

  private frozenStorageKey(
    clientKey: string,
    overflowKey: string,
  ): string | undefined {
    const clientWindow = this.memoryWindows.get(clientKey);
    if (clientWindow && this.memoryRequestCount(clientWindow) > 0) {
      return clientKey;
    }
    const overflowWindow = this.memoryOverflowWindows.get(overflowKey);
    if (overflowWindow && overflowWindow.ownerCounts.has(clientKey)) {
      return overflowKey;
    }
    return undefined;
  }

  private async consumeWindow(
    clientKey: string,
    overflowKey: string,
    limit: number,
    requestId: string,
    now: number,
  ): Promise<WindowResult> {
    const identity = identityAt(this.redisAlignedNow(now));
    if (this.backend === 'memory') {
      if (this.recoveryUsesRedis) {
        try {
          const frozenKey = this.frozenStorageKey(clientKey, overflowKey);
          if (frozenKey) await this.waitForReconciliation([frozenKey]);
          if (this.backend === 'memory' && !this.recoveryUsesRedis) {
            return this.consumeMemory(
              clientKey,
              overflowKey,
              identity,
              limit,
              requestId,
              true,
            );
          }
          const redisWindow = await this.consumeRedis(
            clientKey,
            overflowKey,
            identity,
            limit,
            requestId,
            now,
          );
          if (redisWindow.count > limit) return redisWindow;
          if (this.backend === 'memory' && !this.recoveryUsesRedis) {
            return this.consumeMemory(
              clientKey,
              overflowKey,
              identity,
              limit,
              requestId,
              true,
            );
          }
          return redisWindow;
        } catch {
          this.recoveryUsesRedis = false;
          this.setBackend('memory', Date.now());
          return this.consumeMemory(
            clientKey,
            overflowKey,
            identity,
            limit,
            requestId,
            true,
          );
        }
      }
      const memory = this.consumeMemory(
        clientKey,
        overflowKey,
        identity,
        limit,
        requestId,
      );
      if (!this.beginRecoveryProbe(now)) return memory;
      void this.runRecovery(now, memory.storageKey);
      return memory;
    }
    try {
      const redisWindow = await this.consumeRedis(
        clientKey,
        overflowKey,
        identity,
        limit,
        requestId,
        now,
      );
      if (this.backend === 'redis' || redisWindow.count > limit) {
        return redisWindow;
      }
      // A sibling request may have entered fallback while this Redis call was
      // pending. Keep the same reservation locally, invalidating any newer
      // recovery snapshot before adding it. A Redis denial stays a denial.
      this.setBackend('memory', Date.now());
      return this.consumeMemory(
        clientKey,
        overflowKey,
        identityAt(this.redisAlignedNow(Date.now())),
        limit,
        requestId,
        true,
      );
    } catch {
      this.setBackend('memory', Date.now());
      return this.consumeMemory(
        clientKey,
        overflowKey,
        identity,
        limit,
        requestId,
        true,
      );
    }
  }

  private key(input: {
    clientIdentifier: string;
    policy: RateLimitPolicy;
    role: RateLimitRole;
  }): string {
    return buildRateLimitKey(
      this.env.RATE_LIMITER_KEY_PREFIX,
      input.policy,
      input.role,
      input.clientIdentifier,
    );
  }

  private overflowKey(input: {
    policy: RateLimitPolicy;
    role: RateLimitRole;
  }): string {
    const bucket =
      input.policy === 'strict' ? 'strict' : input.role.toLowerCase();
    return `${this.env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:${bucket}`;
  }

  private overflowMembershipKey(overflowKey: string): string {
    return `${overflowKey}:clients`;
  }

  private recordBucketDecision(decision: RateLimitDecision): void {
    this.metrics.recordRateLimitDecision({
      role: decision.role,
      policy: decision.policy,
      outcome: decision.allowed ? 'allowed' : 'blocked',
      backend: decision.backend,
    });
  }

  recordRequest(role: RateLimitRole, blocked: boolean): void {
    this.totalRequests += 1;
    this.byRole[role].requests += 1;
    if (blocked) {
      this.blockedRequests += 1;
      this.byRole[role].blocked += 1;
    }
  }

  private decision(
    input: { policy: RateLimitPolicy; role: RateLimitRole },
    limit: number,
    window: WindowResult,
  ): RateLimitDecision {
    return {
      allowed: window.count <= limit,
      backend: window.backend,
      clientKey: window.clientKey,
      count: window.count,
      generation: window.generation,
      limit,
      overflowKey: window.overflowKey,
      policy: input.policy,
      remaining: Math.max(0, limit - window.count),
      requestId: window.requestId,
      resetAfterMs: window.ttlMs,
      role: input.role,
      storageKey: window.storageKey,
      uncertainRedisReservation: window.uncertainRedisReservation,
    };
  }

  async consume(
    input: {
      clientIdentifier: string;
      policy: RateLimitPolicy;
      role: RateLimitRole;
    },
    options: { recordRequest?: boolean } = {},
  ): Promise<RateLimitDecision> {
    const now = Date.now();
    const limit =
      input.policy === 'strict' ? STRICT_RATE_LIMIT : ROLE_LIMITS[input.role];
    const clientKey = this.key(input);
    const window = await this.consumeWindow(
      clientKey,
      this.overflowKey(input),
      limit,
      randomUUID(),
      now,
    );
    const decision = this.decision(input, limit, window);
    this.recordBucketDecision(decision);
    if (options.recordRequest !== false) {
      this.recordRequest(input.role, !decision.allowed);
    }
    return decision;
  }

  async transfer(
    source: RateLimitDecision,
    input: {
      clientIdentifier: string;
      policy: RateLimitPolicy;
      role: RateLimitRole;
    },
    options: {
      /** Compatibility flag: uncertain transitions always charge the target. */
      fallbackToTargetMemory?: boolean;
      releaseSource?: boolean;
    } = {},
  ): Promise<RateLimitDecision> {
    if (this.recoveryPromise) {
      await this.recoveryPromise;
    }
    const now = Date.now();
    const identity = identityAt(this.redisAlignedNow(now));
    const limit =
      input.policy === 'strict' ? STRICT_RATE_LIMIT : ROLE_LIMITS[input.role];
    const clientKey = this.key(input);
    const overflowKey = this.overflowKey(input);
    let sourceMayExistInRedis =
      source.backend === 'redis' || source.uncertainRedisReservation;
    let targetRedisReservationUncertain = false;
    if (this.backend === 'redis') {
      // A memory decision may already have been reconciled while transfer()
      // waited for recovery, so failures from here require Redis cleanup too.
      sourceMayExistInRedis = true;
      try {
        const window = parseRedisWindow(
          await this.redis.eval(
            TRANSFER_WINDOW_SCRIPT,
            [
              source.clientKey,
              source.overflowKey,
              clientKey,
              overflowKey,
              this.overflowMembershipKey(overflowKey),
              this.overflowMembershipKey(source.overflowKey),
            ],
            [
              identity.generation,
              identity.expiresAt,
              limit,
              source.requestId,
              source.generation,
              options.releaseSource === false ? 0 : 1,
              RATE_LIMIT_WINDOW_MS,
            ],
          ),
          clientKey,
        );
        if (this.backend === 'redis' || window.count > limit) {
          if (this.backend === 'redis') this.observeRedisWindow(window, now);
          const decision = this.decision(input, limit, {
            backend: 'redis',
            clientKey,
            overflowKey,
            requestId: source.requestId,
            uncertainRedisReservation: false,
            ...window,
          });
          this.recordBucketDecision(decision);
          return decision;
        }
        // Another in-flight operation entered fallback before this success.
        // Mirror it locally and invalidate any newly frozen recovery snapshot.
        targetRedisReservationUncertain = true;
        this.setBackend('memory', Date.now());
      } catch {
        targetRedisReservationUncertain = true;
        this.setBackend('memory', now);
      }
    }
    // Uncertain reconciliation must use the blocked target-policy memory
    // decision below, never a previously allowed DEFAULT source.
    const decision = this.decision(
      input,
      limit,
      this.consumeMemory(
        clientKey,
        overflowKey,
        identity,
        limit,
        source.requestId,
        targetRedisReservationUncertain,
        !sourceMayExistInRedis &&
          !this.reconciliationUncertain &&
          options.releaseSource !== false
          ? source
          : undefined,
      ),
    );
    if (decision.allowed && options.releaseSource !== false) {
      if (sourceMayExistInRedis) {
        this.queueSourceRelease(decision.storageKey, source);
      } else if (source.backend === 'memory') {
        this.releaseMemory(source, now);
      }
    }
    this.recordBucketDecision(decision);
    return decision;
  }

  async release(decision: RateLimitDecision): Promise<void> {
    if (this.recoveryPromise) {
      await this.recoveryPromise;
    }
    const now = Date.now();
    if (this.backend === 'redis') {
      try {
        await this.releaseRedis(decision);
        return;
      } catch {
        this.setBackend('memory', now);
      }
    }
    if (
      decision.backend === 'memory' &&
      !decision.uncertainRedisReservation &&
      !this.reconciliationUncertain
    ) {
      this.releaseMemory(decision, now);
    }
  }

  startRecovery(redisAvailable: boolean): void {
    if (!this.enabled) return;
    if (!redisAvailable) {
      this.capabilityVerified = false;
      this.setBackend('memory', Date.now());
      return;
    }
    if (
      this.recoveryPromise ||
      (this.backend === 'redis' && this.capabilityVerified)
    ) {
      return;
    }
    void this.recover(true);
  }

  async recover(redisAvailable: boolean): Promise<void> {
    if (!this.enabled) return;
    if (!redisAvailable) {
      this.capabilityVerified = false;
      this.setBackend('memory', Date.now());
      return;
    }
    if (this.recoveryPromise) {
      await this.recoveryPromise;
      return;
    }
    if (this.backend === 'redis' && this.capabilityVerified) return;
    const now = Date.now();
    if (this.backend === 'memory') {
      if (!this.beginRecoveryProbe(now)) return;
    } else {
      if (this.recoveryProbeInFlight) return;
      this.recoveryProbeInFlight = true;
    }
    await this.runRecovery(now);
  }

  resetStats(now = Date.now()): void {
    this.totalRequests = 0;
    this.blockedRequests = 0;
    this.byRole = freshRoleStats();
    this.lastReset = now;
  }

  snapshot(redisAvailable: boolean) {
    const activeBackend: RateLimitBackend | 'disabled' = !this.enabled
      ? 'disabled'
      : redisAvailable && this.backend === 'redis'
      ? 'redis'
      : 'memory';
    return {
      status: !this.enabled
        ? 'disabled'
        : redisAvailable && activeBackend === 'redis' && this.capabilityVerified
        ? 'ok'
        : 'degraded',
      stats: {
        enabled: this.enabled,
        backend: activeBackend,
        redisAvailable,
        totalRequests: this.totalRequests,
        blockedRequests: this.blockedRequests,
        byRole: structuredClone(this.byRole),
        lastReset: this.lastReset,
        blockRate:
          this.totalRequests > 0
            ? ((this.blockedRequests / this.totalRequests) * 100).toFixed(2)
            : '0.00',
      },
    };
  }
}
