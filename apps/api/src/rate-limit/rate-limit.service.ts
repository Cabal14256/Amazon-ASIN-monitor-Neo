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
  version: number;
}

interface MemoryWindowSnapshot {
  key: string;
  map: Map<string, MemoryWindow>;
  requestIds: string[];
  version: number;
  window: MemoryWindow;
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
}

const REDIS_RETRY_DELAY_MS = 5_000;
const MAX_MEMORY_WINDOWS = 10_000;
const RECONCILIATION_BATCH_SIZE = 100;
const CONSUME_WINDOW_SCRIPT = `
local generation = redis.call('HGET', KEYS[1], 'generation')
if generation ~= ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'generation', ARGV[1])
end
local field = 'request:' .. ARGV[4]
local current = redis.call('HLEN', KEYS[1]) - 1
if redis.call('HEXISTS', KEYS[1], field) == 0 and current <= tonumber(ARGV[3]) then
  redis.call('HSET', KEYS[1], field, 1)
  current = current + 1
end
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
local effective = current
if redis.call('HGET', KEYS[2], 'generation') == ARGV[1] then
  local overflow = redis.call('HLEN', KEYS[2]) - 1
  if overflow > effective then
    effective = overflow
  end
end
return { effective, redis.call('PTTL', KEYS[1]), ARGV[1], KEYS[1] }
`;
const RELEASE_WINDOW_SCRIPT = `
local released = 0
for index = 1, #KEYS do
  if redis.call('HGET', KEYS[index], 'generation') == ARGV[1] then
    released = released + redis.call('HDEL', KEYS[index], 'request:' .. ARGV[2])
    if redis.call('HLEN', KEYS[index]) <= 1 then
      redis.call('DEL', KEYS[index])
    end
  end
end
return released
`;
const TRANSFER_WINDOW_SCRIPT = `
local generation = redis.call('HGET', KEYS[3], 'generation')
if generation ~= ARGV[1] then
  redis.call('DEL', KEYS[3])
  redis.call('HSET', KEYS[3], 'generation', ARGV[1])
end
local field = 'request:' .. ARGV[4]
local current = redis.call('HLEN', KEYS[3]) - 1
if redis.call('HEXISTS', KEYS[3], field) == 0 and current <= tonumber(ARGV[3]) then
  redis.call('HSET', KEYS[3], field, 1)
  current = current + 1
end
redis.call('PEXPIREAT', KEYS[3], ARGV[2])
local effective = current
if redis.call('HGET', KEYS[4], 'generation') == ARGV[1] then
  local overflow = redis.call('HLEN', KEYS[4]) - 1
  if overflow > effective then
    effective = overflow
  end
end
local released = 0
if effective <= tonumber(ARGV[3]) then
  for index = 1, 2 do
    if redis.call('HGET', KEYS[index], 'generation') == ARGV[5] then
      released = released + redis.call('HDEL', KEYS[index], field)
      if redis.call('HLEN', KEYS[index]) <= 1 then
        redis.call('DEL', KEYS[index])
      end
    end
  end
end
return { effective, redis.call('PTTL', KEYS[3]), ARGV[1], KEYS[3], released }
`;
const RECONCILE_WINDOW_SCRIPT = `
local generation = redis.call('HGET', KEYS[1], 'generation')
if generation and generation ~= ARGV[1] then
  return { -1, redis.call('PTTL', KEYS[1]), generation, KEYS[1] }
end
if not generation then
  redis.call('HSET', KEYS[1], 'generation', ARGV[1])
end
local current = redis.call('HLEN', KEYS[1]) - 1
for index = 4, #ARGV do
  local field = 'request:' .. ARGV[index]
  if redis.call('HEXISTS', KEYS[1], field) == 0 and current <= tonumber(ARGV[3]) then
    redis.call('HSET', KEYS[1], field, 1)
    current = current + 1
  end
end
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return { current, redis.call('PTTL', KEYS[1]), ARGV[1], KEYS[1] }
`;
const CAPABILITY_PROBE_SCRIPT = `
redis.call('HSET', KEYS[1], 'generation', ARGV[1])
redis.call('HSET', KEYS[1], 'request:' .. ARGV[3], 1)
redis.call('HGET', KEYS[1], 'generation')
redis.call('HEXISTS', KEYS[1], 'request:' .. ARGV[3])
redis.call('HLEN', KEYS[1])
redis.call('HDEL', KEYS[1], 'request:' .. ARGV[3])
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
    count < 1 ||
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
      version: 0,
    };
  }

  private addMemoryRequest(window: MemoryWindow, requestId: string): void {
    if (
      window.requestIds.has(requestId) ||
      window.requestIds.size > window.limit
    ) {
      return;
    }
    window.requestIds.add(requestId);
    window.version += 1;
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
    this.addMemoryRequest(window, requestId);
    return {
      backend: 'memory',
      clientKey,
      count: window.requestIds.size,
      generation: window.generation,
      overflowKey,
      requestId,
      storageKey,
      ttlMs: Math.max(1, window.expiresAt - Date.now()),
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
      window.version += 1;
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

  private isRedisBackend(): boolean {
    return this.backend === 'redis';
  }

  private memorySnapshots(now: number): MemoryWindowSnapshot[] {
    this.cleanMemory(now);
    return [
      ...Array.from(this.memoryWindows, ([key, window]) => ({
        key,
        map: this.memoryWindows,
        requestIds: [...window.requestIds],
        version: window.version,
        window,
      })),
      ...Array.from(this.memoryOverflowWindows, ([key, window]) => ({
        key,
        map: this.memoryOverflowWindows,
        requestIds: [...window.requestIds],
        version: window.version,
        window,
      })),
    ];
  }

  private snapshotsAreStable(snapshots: MemoryWindowSnapshot[]): boolean {
    if (
      snapshots.length !==
      this.memoryWindows.size + this.memoryOverflowWindows.size
    ) {
      return false;
    }
    return snapshots.every(
      ({ key, map, version, window }) =>
        map.get(key) === window && window.version === version,
    );
  }

  private async reconcileMemory(): Promise<void> {
    for (;;) {
      const snapshots = this.memorySnapshots(Date.now());
      if (snapshots.length === 0) {
        this.setBackend('redis', Date.now());
        return;
      }
      for (
        let offset = 0;
        offset < snapshots.length;
        offset += RECONCILIATION_BATCH_SIZE
      ) {
        await Promise.all(
          snapshots
            .slice(offset, offset + RECONCILIATION_BATCH_SIZE)
            .map(async ({ key, requestIds, window }) => {
              const result = parseRedisWindow(
                await this.redis.eval(
                  RECONCILE_WINDOW_SCRIPT,
                  [key],
                  [
                    window.generation,
                    window.expiresAt,
                    window.limit,
                    ...requestIds,
                  ],
                ),
                key,
              );
              if (result.generation !== window.generation) {
                throw new Error('Redis rate-limit generation conflict');
              }
            }),
        );
      }
      this.cleanMemory(Date.now());
      if (!this.snapshotsAreStable(snapshots)) continue;
      this.memoryWindows.clear();
      this.memoryOverflowWindows.clear();
      this.setBackend('redis', Date.now());
      return;
    }
  }

  private async runRecovery(now: number): Promise<void> {
    const recovery = (async () => {
      try {
        const identity = identityAt(now);
        await this.redis.eval(
          CAPABILITY_PROBE_SCRIPT,
          [this.capabilityProbeKey],
          [identity.generation, now + 1_000, randomUUID()],
        );
        await this.reconcileMemory();
      } catch {
        this.setBackend('memory', Date.now());
      } finally {
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
        [clientKey, overflowKey],
        [identity.generation, identity.expiresAt, limit, requestId],
      ),
      clientKey,
    );
    return {
      backend: 'redis',
      clientKey,
      overflowKey,
      requestId,
      ...window,
    };
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
      const memory = this.consumeMemory(
        clientKey,
        overflowKey,
        identity,
        limit,
        requestId,
      );
      if (!this.beginRecoveryProbe(now)) return memory;
      await this.runRecovery(now);
      if (!this.isRedisBackend()) return memory;
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
        );
      }
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
  ): Promise<RateLimitDecision> {
    if (source.backend === 'memory' && this.recoveryPromise) {
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
            [source.clientKey, source.overflowKey, clientKey, overflowKey],
            [
              identity.generation,
              identity.expiresAt,
              limit,
              source.requestId,
              source.generation,
            ],
          ),
          clientKey,
        );
        const decision = this.decision(input, limit, {
          backend: 'redis',
          clientKey,
          overflowKey,
          requestId: source.requestId,
          ...window,
        });
        this.recordBucketDecision(decision);
        return decision;
      } catch {
        this.setBackend('memory', now);
        return source;
      }
    }
    if (source.backend === 'redis') return source;
    const decision = this.decision(
      input,
      limit,
      this.consumeMemory(
        clientKey,
        overflowKey,
        identity,
        limit,
        source.requestId,
      ),
    );
    if (decision.allowed) this.releaseMemory(source, now);
    this.recordBucketDecision(decision);
    return decision;
  }

  async release(decision: RateLimitDecision): Promise<void> {
    if (decision.backend === 'memory' && this.recoveryPromise) {
      await this.recoveryPromise;
    }
    const now = Date.now();
    if (this.backend === 'redis') {
      try {
        await this.redis.eval(
          RELEASE_WINDOW_SCRIPT,
          [decision.clientKey, decision.overflowKey],
          [decision.generation, decision.requestId],
        );
        return;
      } catch {
        this.setBackend('memory', now);
      }
    }
    if (decision.backend === 'memory') this.releaseMemory(decision, now);
  }

  async recover(redisAvailable: boolean): Promise<void> {
    if (!this.enabled || !redisAvailable) return;
    if (this.recoveryPromise) {
      await this.recoveryPromise;
      return;
    }
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
