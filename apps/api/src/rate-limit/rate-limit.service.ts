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
  requestIds: Set<string>;
  requestOwners: Map<string, string>;
}

interface MemoryWindowSnapshot {
  clientKeys: string[];
  key: string;
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
const RECONCILIATION_BATCH_SIZE = 100;
const CONSUME_WINDOW_SCRIPT = `
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
local redisTime = redis.call('TIME')
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local windowMs = tonumber(ARGV[#ARGV])
local currentGeneration = tostring(math.floor(nowMs / windowMs))
local expiresAt = (tonumber(currentGeneration) + 1) * windowMs
local generation = redis.call('HGET', KEYS[1], 'generation')
if generation ~= currentGeneration then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'generation', currentGeneration)
end
local current = redis.call('HLEN', KEYS[1]) - 1
local requestCount = tonumber(ARGV[4])
local isOverflow = #KEYS > 2
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
redis.call('TIME')
redis.call('HSET', KEYS[1], 'generation', ARGV[1])
redis.call('HSET', KEYS[1], 'request:' .. ARGV[3], 1)
redis.call('HSETNX', KEYS[1], 'owner:' .. ARGV[3], 0)
redis.call('HINCRBY', KEYS[1], 'owner:' .. ARGV[3], 1)
redis.call('HGET', KEYS[1], 'generation')
redis.call('HEXISTS', KEYS[1], 'request:' .. ARGV[3])
redis.call('HLEN', KEYS[1])
redis.call('HDEL', KEYS[1], 'request:' .. ARGV[3])
redis.call('HDEL', KEYS[1], 'owner:' .. ARGV[3])
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
redis.call('PTTL', KEYS[1])
redis.call('DEL', KEYS[1])
return 1
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
  private recoveryProbeInFlight = false;
  private recoveryPromise: Promise<void> | undefined;
  private readonly reconciliationBarriers = new Map<
    string,
    ReconciliationBarrier
  >();
  private recoveryUsesRedis = false;
  private reconciliationUncertain = false;
  private capabilityVerified = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ApplicationRedisClient)
    private readonly redis: ApplicationRedisClient,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.capabilityProbeKey = `${
      env.RATE_LIMITER_KEY_PREFIX
    }:http:neo:capability:${randomUUID()}`;
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

  private setBackend(next: RateLimitBackend, now: number): void {
    if (this.backend === next) {
      if (next === 'memory') this.redisRetryAfter = now + REDIS_RETRY_DELAY_MS;
      return;
    }
    const previous = this.backend;
    this.backend = next;
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
      if (window.expiresAt <= now) this.memoryWindows.delete(key);
    }
    for (const [key, window] of this.memoryOverflowWindows) {
      if (window.expiresAt <= now) this.memoryOverflowWindows.delete(key);
    }
  }

  private newMemoryWindow(
    identity: WindowIdentity,
    limit: number,
  ): MemoryWindow {
    return {
      ...identity,
      limit,
      requestIds: new Set<string>(),
      requestOwners: new Map<string, string>(),
    };
  }

  private addMemoryRequest(window: MemoryWindow, requestId: string): boolean {
    if (
      window.requestIds.has(requestId) ||
      window.requestIds.size > window.limit
    ) {
      return window.requestIds.has(requestId);
    }
    window.requestIds.add(requestId);
    return true;
  }

  private activeMemoryWindow(
    map: Map<string, MemoryWindow>,
    key: string,
    identity: WindowIdentity,
  ): MemoryWindow | undefined {
    const window = map.get(key);
    if (!window) return undefined;
    if (
      window.expiresAt <= Date.now() ||
      window.generation !== identity.generation
    ) {
      map.delete(key);
      return undefined;
    }
    return window;
  }

  private consumeMemory(
    clientKey: string,
    overflowKey: string,
    identity: WindowIdentity,
    limit: number,
    requestId: string,
    uncertainRedisReservation = false,
  ): WindowResult {
    let window = this.activeMemoryWindow(
      this.memoryWindows,
      clientKey,
      identity,
    );
    let storageKey = clientKey;
    if (!window) {
      const overflow = this.activeMemoryWindow(
        this.memoryOverflowWindows,
        overflowKey,
        identity,
      );
      if (overflow) {
        window = overflow;
        storageKey = overflowKey;
      }
    }
    if (!window) {
      if (this.memoryWindows.size >= MAX_MEMORY_WINDOWS) {
        const now = Date.now();
        if (now >= this.nextMemoryCleanupAt) {
          this.cleanMemory(now);
          this.nextMemoryCleanupAt = now + 60_000;
        }
      }
      if (this.memoryWindows.size >= MAX_MEMORY_WINDOWS) {
        window = this.newMemoryWindow(identity, limit);
        this.memoryOverflowWindows.set(overflowKey, window);
        storageKey = overflowKey;
      } else {
        window = this.newMemoryWindow(identity, limit);
        this.memoryWindows.set(clientKey, window);
      }
    }
    const stored = this.addMemoryRequest(window, requestId);
    if (stored && storageKey === overflowKey) {
      window.requestOwners.set(requestId, clientKey);
    }
    return {
      backend: 'memory',
      clientKey,
      count: this.reconciliationUncertain
        ? Math.max(window.requestIds.size, limit + 1)
        : window.requestIds.size,
      generation: window.generation,
      overflowKey,
      requestId,
      storageKey,
      ttlMs: Math.max(1, window.expiresAt - Date.now()),
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
        window.expiresAt <= now ||
        window.generation !== decision.generation ||
        !window.requestIds.delete(decision.requestId)
      ) {
        continue;
      }
      window.requestOwners.delete(decision.requestId);
      if (window.requestIds.size === 0) map.delete(key);
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
    this.cleanMemory(now);
    const snapshots = [
      ...Array.from(this.memoryWindows, ([key, window]) =>
        this.memorySnapshot(key, window),
      ),
      ...Array.from(this.memoryOverflowWindows, ([key, window]) =>
        this.memorySnapshot(key, window),
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
  ): MemoryWindowSnapshot {
    const requestIds = [...window.requestIds];
    const requestOwners = requestIds.map(
      (requestId) => window.requestOwners.get(requestId) ?? '',
    );
    return {
      clientKeys: [...new Set(requestOwners.filter(Boolean))],
      key,
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

  private async reconcileMemory(priorityKey?: string): Promise<void> {
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
            async ({ clientKeys, key, requestIds, requestOwners, window }) => {
              parseRedisWindow(
                await this.redis.eval(
                  RECONCILE_WINDOW_SCRIPT,
                  [key, this.overflowMembershipKey(key), ...clientKeys],
                  [
                    window.generation,
                    window.expiresAt,
                    window.limit,
                    requestIds.length,
                    ...requestIds,
                    ...requestOwners,
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
    if (!this.recoveryUsesRedis) {
      throw new Error('Redis rate-limit recovery interrupted');
    }
    this.memoryWindows.clear();
    this.memoryOverflowWindows.clear();
    this.reconciliationUncertain = false;
    this.capabilityVerified = true;
    this.setBackend('redis', Date.now());
    this.recoveryUsesRedis = false;
  }

  private async runRecovery(now: number, priorityKey?: string): Promise<void> {
    const recovery = (async () => {
      try {
        const identity = identityAt(now);
        await this.redis.eval(
          CAPABILITY_PROBE_SCRIPT,
          [this.capabilityProbeKey],
          [identity.generation, now + 1_000, randomUUID()],
        );
        await this.reconcileMemory(priorityKey);
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
    identity: WindowIdentity,
  ): string | undefined {
    const clientWindow = this.memoryWindows.get(clientKey);
    if (
      clientWindow?.generation === identity.generation &&
      clientWindow.expiresAt > Date.now()
    ) {
      return clientKey;
    }
    const overflowWindow = this.memoryOverflowWindows.get(overflowKey);
    if (
      overflowWindow?.generation === identity.generation &&
      overflowWindow.expiresAt > Date.now() &&
      [...overflowWindow.requestOwners.values()].includes(clientKey)
    ) {
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
    const identity = identityAt(now);
    if (this.backend === 'memory') {
      if (this.recoveryUsesRedis) {
        try {
          const frozenKey = this.frozenStorageKey(
            clientKey,
            overflowKey,
            identity,
          );
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
          );
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
      return await this.consumeRedis(
        clientKey,
        overflowKey,
        identity,
        limit,
        requestId,
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
      fallbackToTargetMemory?: boolean;
      releaseSource?: boolean;
    } = {},
  ): Promise<RateLimitDecision> {
    if (this.recoveryPromise) {
      await this.recoveryPromise;
    }
    const now = Date.now();
    const identity = identityAt(now);
    const limit =
      input.policy === 'strict' ? STRICT_RATE_LIMIT : ROLE_LIMITS[input.role];
    const clientKey = this.key(input);
    const overflowKey = this.overflowKey(input);
    if (this.backend === 'redis') {
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
      } catch {
        this.setBackend('memory', now);
        if (!options.fallbackToTargetMemory) return source;
      }
    }
    if (source.backend === 'redis' && !options.fallbackToTargetMemory) {
      return source;
    }
    if (source.uncertainRedisReservation || this.reconciliationUncertain) {
      return source;
    }
    const decision = this.decision(
      input,
      limit,
      this.consumeMemory(
        clientKey,
        overflowKey,
        identity,
        limit,
        source.requestId,
        source.backend === 'redis',
      ),
    );
    if (
      decision.allowed &&
      options.releaseSource !== false &&
      source.backend === 'memory'
    ) {
      this.releaseMemory(source, now);
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
        await this.redis.eval(
          RELEASE_WINDOW_SCRIPT,
          [
            decision.clientKey,
            decision.overflowKey,
            this.overflowMembershipKey(decision.overflowKey),
          ],
          [decision.generation, decision.requestId, RATE_LIMIT_WINDOW_MS],
        );
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
