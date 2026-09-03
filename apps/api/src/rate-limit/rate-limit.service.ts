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

interface MemoryWindow {
  count: number;
  expiresAt: number;
  generation: string;
}

interface ActiveMemoryWindow {
  overflow: boolean;
  storageKey: string;
  window: MemoryWindow;
}

interface RoleStats {
  requests: number;
  blocked: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  backend: RateLimitBackend;
  count: number;
  generation: string;
  limit: number;
  policy: RateLimitPolicy;
  remaining: number;
  resetAfterMs: number;
  role: RateLimitRole;
  storageKey: string;
}

const REDIS_RETRY_DELAY_MS = 5_000;
const MAX_MEMORY_WINDOWS = 10_000;
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('HINCRBY', KEYS[1], 'count', 1)
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 then
  redis.call('HSET', KEYS[1], 'generation', ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
elseif ttl <= 0 then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'count', 1, 'generation', ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  current = 1
  ttl = tonumber(ARGV[1])
end
local generation = redis.call('HGET', KEYS[1], 'generation')
return { current, ttl, generation }
`;
const RELEASE_WINDOW_SCRIPT = `
local generation = redis.call('HGET', KEYS[1], 'generation')
if generation ~= ARGV[1] then
  return 0
end
local current = tonumber(redis.call('HGET', KEYS[1], 'count') or '0')
if current <= 1 then
  redis.call('DEL', KEYS[1])
else
  redis.call('HINCRBY', KEYS[1], 'count', -1)
end
return 1
`;
const TRANSFER_WINDOW_SCRIPT = `
local current = redis.call('HINCRBY', KEYS[2], 'count', 1)
local ttl = redis.call('PTTL', KEYS[2])
if current == 1 then
  redis.call('HSET', KEYS[2], 'generation', ARGV[2])
  redis.call('PEXPIRE', KEYS[2], ARGV[1])
  ttl = tonumber(ARGV[1])
elseif ttl <= 0 then
  redis.call('DEL', KEYS[2])
  redis.call('HSET', KEYS[2], 'count', 1, 'generation', ARGV[2])
  redis.call('PEXPIRE', KEYS[2], ARGV[1])
  current = 1
  ttl = tonumber(ARGV[1])
end
local generation = redis.call('HGET', KEYS[2], 'generation')
local fallbackCount = tonumber(ARGV[5])
if fallbackCount > 0 then
  local markerGeneration = redis.call('HGET', KEYS[3], 'generation')
  local migrated = 0
  if markerGeneration == generation then
    migrated = tonumber(redis.call('HGET', KEYS[3], 'count') or '0')
  end
  if fallbackCount > migrated then
    current = redis.call('HINCRBY', KEYS[2], 'count', fallbackCount - migrated)
  end
  local fallbackTtl = tonumber(ARGV[6])
  if fallbackTtl > ttl then
    redis.call('PEXPIRE', KEYS[2], fallbackTtl)
    ttl = fallbackTtl
  end
  redis.call('HSET', KEYS[3], 'generation', generation, 'count', fallbackCount)
  redis.call('PEXPIRE', KEYS[3], ttl)
end
local released = 0
if current <= tonumber(ARGV[3]) then
  local sourceGeneration = redis.call('HGET', KEYS[1], 'generation')
  if sourceGeneration == ARGV[4] then
    local sourceCount = tonumber(redis.call('HGET', KEYS[1], 'count') or '0')
    if sourceCount <= 1 then
      redis.call('DEL', KEYS[1])
    else
      redis.call('HINCRBY', KEYS[1], 'count', -1)
    end
    released = 1
  end
end
return { current, ttl, generation, released }
`;
const MERGE_WINDOW_SCRIPT = `
local current = redis.call('HINCRBY', KEYS[1], 'count', 1)
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 then
  redis.call('HSET', KEYS[1], 'generation', ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
elseif ttl <= 0 then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'count', 1, 'generation', ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  current = 1
  ttl = tonumber(ARGV[1])
end
local fallbackCount = tonumber(ARGV[3])
local generation = redis.call('HGET', KEYS[1], 'generation')
local markerGeneration = redis.call('HGET', KEYS[2], 'generation')
local migrated = 0
if markerGeneration == generation then
  migrated = tonumber(redis.call('HGET', KEYS[2], 'count') or '0')
end
if fallbackCount > migrated then
  current = redis.call('HINCRBY', KEYS[1], 'count', fallbackCount - migrated)
  local fallbackTtl = tonumber(ARGV[4])
  if fallbackTtl > ttl then
    redis.call('PEXPIRE', KEYS[1], fallbackTtl)
    ttl = fallbackTtl
  end
end
redis.call('HSET', KEYS[2], 'generation', generation, 'count', fallbackCount)
redis.call('PEXPIRE', KEYS[2], ttl)
return { current, ttl, generation }
`;
const CAPABILITY_PROBE_SCRIPT = `
redis.call('HSET', KEYS[1], 'count', 1, 'generation', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('PTTL', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
redis.call('HGET', KEYS[1], 'generation')
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

function parseRedisWindow(value: unknown): {
  count: number;
  generation: string;
  ttlMs: number;
} {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error('invalid Redis rate-limit response');
  }
  const count = Number(value[0]);
  const ttlMs = Number(value[1]);
  const generation = String(value[2] ?? '');
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    generation.length === 0
  ) {
    throw new Error('invalid Redis rate-limit counter');
  }
  return { count, generation, ttlMs };
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
  private capabilityProbe: Promise<void> | undefined;

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
      if (next === 'memory') {
        this.redisRetryAfter = now + REDIS_RETRY_DELAY_MS;
      }
      return;
    }
    const previous = this.backend;
    this.backend = next;
    if (next === 'memory') {
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

  private consumeMemory(
    key: string,
    overflowKey: string,
    now: number,
  ): {
    count: number;
    generation: string;
    storageKey: string;
    ttlMs: number;
  } {
    let window = this.memoryWindows.get(key);
    if (!window || window.expiresAt <= now) {
      if (!window && this.memoryWindows.size >= MAX_MEMORY_WINDOWS) {
        if (now >= this.nextMemoryCleanupAt) {
          this.cleanMemory(now);
          this.nextMemoryCleanupAt = now + 60_000;
        }
        if (this.memoryWindows.size >= MAX_MEMORY_WINDOWS) {
          let overflow = this.memoryOverflowWindows.get(overflowKey);
          if (!overflow || overflow.expiresAt <= now) {
            overflow = {
              count: 0,
              expiresAt: now + RATE_LIMIT_WINDOW_MS,
              generation: randomUUID(),
            };
            this.memoryOverflowWindows.set(overflowKey, overflow);
          }
          overflow.count += 1;
          return {
            count: overflow.count,
            generation: overflow.generation,
            storageKey: overflowKey,
            ttlMs: Math.max(1, overflow.expiresAt - now),
          };
        }
      }
      window = {
        count: 0,
        expiresAt: now + RATE_LIMIT_WINDOW_MS,
        generation: randomUUID(),
      };
      this.memoryWindows.set(key, window);
    }
    window.count += 1;
    return {
      count: window.count,
      generation: window.generation,
      storageKey: key,
      ttlMs: Math.max(1, window.expiresAt - now),
    };
  }

  private releaseMemory(
    storageKey: string,
    generation: string,
    now: number,
  ): void {
    const windows = this.memoryWindows.has(storageKey)
      ? this.memoryWindows
      : this.memoryOverflowWindows;
    const window = windows.get(storageKey);
    if (!window || window.generation !== generation) return;
    if (window.expiresAt <= now || window.count <= 1) {
      windows.delete(storageKey);
      return;
    }
    window.count -= 1;
  }

  private activeMemoryWindow(
    key: string,
    overflowKey: string,
    now: number,
  ): ActiveMemoryWindow | undefined {
    const direct = this.memoryWindows.get(key);
    if (direct) {
      if (direct.expiresAt > now) {
        return { overflow: false, storageKey: key, window: direct };
      }
      this.memoryWindows.delete(key);
    }
    const overflow = this.memoryOverflowWindows.get(overflowKey);
    if (!overflow) return undefined;
    if (overflow.expiresAt > now) {
      return { overflow: true, storageKey: overflowKey, window: overflow };
    }
    this.memoryOverflowWindows.delete(overflowKey);
    return undefined;
  }

  private clearMigratedMemory(
    active: ActiveMemoryWindow | undefined,
    migratedCount: number,
  ): void {
    if (!active || active.overflow) return;
    const current = this.memoryWindows.get(active.storageKey);
    if (
      current === active.window &&
      current.generation === active.window.generation &&
      current.count <= migratedCount
    ) {
      this.memoryWindows.delete(active.storageKey);
    }
  }

  private migrationMarkerKey(
    redisKey: string,
    active: ActiveMemoryWindow | undefined,
  ): string {
    return `${redisKey}:fallback:${active?.window.generation ?? 'none'}`;
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

  private async consumeWindow(
    key: string,
    overflowKey: string,
    now: number,
  ): Promise<{
    backend: RateLimitBackend;
    count: number;
    generation: string;
    storageKey: string;
    ttlMs: number;
  }> {
    const recovering = this.backend === 'memory';
    if (recovering && !this.beginRecoveryProbe(now)) {
      return {
        backend: 'memory',
        ...this.consumeMemory(key, overflowKey, now),
      };
    }
    const active = this.activeMemoryWindow(key, overflowKey, now);
    const fallbackCount = active?.window.count ?? 0;
    const fallbackTtl = active ? Math.max(1, active.window.expiresAt - now) : 0;
    try {
      const window = parseRedisWindow(
        active
          ? await this.redis.eval(
              MERGE_WINDOW_SCRIPT,
              [key, this.migrationMarkerKey(key, active)],
              [RATE_LIMIT_WINDOW_MS, randomUUID(), fallbackCount, fallbackTtl],
            )
          : await this.redis.eval(
              FIXED_WINDOW_SCRIPT,
              [key],
              [RATE_LIMIT_WINDOW_MS, randomUUID()],
            ),
      );
      this.setBackend('redis', now);
      this.clearMigratedMemory(active, fallbackCount);
      return { backend: 'redis', storageKey: key, ...window };
    } catch {
      this.setBackend('memory', now);
      return {
        backend: 'memory',
        ...this.consumeMemory(key, overflowKey, now),
      };
    } finally {
      if (recovering) this.recoveryProbeInFlight = false;
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
    input: {
      policy: RateLimitPolicy;
      role: RateLimitRole;
    },
    window: {
      backend: RateLimitBackend;
      count: number;
      generation: string;
      storageKey: string;
      ttlMs: number;
    },
  ): RateLimitDecision {
    const limit =
      input.policy === 'strict' ? STRICT_RATE_LIMIT : ROLE_LIMITS[input.role];
    return {
      allowed: window.count <= limit,
      backend: window.backend,
      count: window.count,
      generation: window.generation,
      limit,
      policy: input.policy,
      remaining: Math.max(0, limit - window.count),
      resetAfterMs: window.ttlMs,
      role: input.role,
      storageKey: window.storageKey,
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
    const key = this.key(input);
    const window = await this.consumeWindow(key, this.overflowKey(input), now);
    const decision = this.decision(input, window);
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
  ): Promise<RateLimitDecision> {
    const now = Date.now();
    const key = this.key(input);
    const overflowKey = this.overflowKey(input);
    if (source.backend === 'memory') {
      const decision = this.decision(input, {
        backend: 'memory',
        ...this.consumeMemory(key, overflowKey, now),
      });
      if (decision.allowed) {
        this.releaseMemory(source.storageKey, source.generation, now);
      }
      this.recordBucketDecision(decision);
      return decision;
    }
    if (this.backend !== 'redis') return source;

    const active = this.activeMemoryWindow(key, overflowKey, now);
    const fallbackCount = active?.window.count ?? 0;
    const fallbackTtl = active ? Math.max(1, active.window.expiresAt - now) : 0;
    const limit =
      input.policy === 'strict' ? STRICT_RATE_LIMIT : ROLE_LIMITS[input.role];
    try {
      const window = parseRedisWindow(
        await this.redis.eval(
          TRANSFER_WINDOW_SCRIPT,
          [source.storageKey, key, this.migrationMarkerKey(key, active)],
          [
            RATE_LIMIT_WINDOW_MS,
            randomUUID(),
            limit,
            source.generation,
            fallbackCount,
            fallbackTtl,
          ],
        ),
      );
      this.setBackend('redis', now);
      this.clearMigratedMemory(active, fallbackCount);
      const decision = this.decision(input, {
        backend: 'redis',
        storageKey: key,
        ...window,
      });
      this.recordBucketDecision(decision);
      return decision;
    } catch {
      this.setBackend('memory', now);
      return source;
    }
  }

  async release(decision: RateLimitDecision): Promise<void> {
    const now = Date.now();
    if (decision.backend === 'memory') {
      this.releaseMemory(decision.storageKey, decision.generation, now);
      return;
    }
    try {
      await this.redis.eval(
        RELEASE_WINDOW_SCRIPT,
        [decision.storageKey],
        [decision.generation],
      );
    } catch {
      this.setBackend('memory', now);
    }
  }

  async recover(redisAvailable: boolean): Promise<void> {
    if (!this.enabled || !redisAvailable) return;
    if (this.capabilityProbe) {
      await this.capabilityProbe;
      return;
    }
    const now = Date.now();
    if (this.backend === 'memory') {
      if (!this.beginRecoveryProbe(now)) return;
    } else {
      if (this.recoveryProbeInFlight) return;
      this.recoveryProbeInFlight = true;
    }
    const probe = (async () => {
      try {
        await this.redis.eval(
          CAPABILITY_PROBE_SCRIPT,
          [this.capabilityProbeKey],
          [1_000, randomUUID()],
        );
        this.setBackend('redis', now);
      } catch {
        this.setBackend('memory', now);
      } finally {
        this.recoveryProbeInFlight = false;
      }
    })();
    this.capabilityProbe = probe;
    try {
      await probe;
    } finally {
      if (this.capabilityProbe === probe) this.capabilityProbe = undefined;
    }
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
        : redisAvailable && activeBackend === 'redis'
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
