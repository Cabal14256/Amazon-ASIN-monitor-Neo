import { createHash } from 'node:crypto';

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
}

interface RoleStats {
  requests: number;
  blocked: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  backend: RateLimitBackend;
  count: number;
  limit: number;
  policy: RateLimitPolicy;
  remaining: number;
  resetAfterMs: number;
  role: RateLimitRole;
}

const REDIS_RETRY_DELAY_MS = 5_000;
const MAX_MEMORY_WINDOWS = 10_000;
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
elseif ttl <= 0 then
  redis.call('SET', KEYS[1], 1, 'PX', ARGV[1])
  current = 1
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

function freshRoleStats(): Record<RateLimitRole, RoleStats> {
  return {
    ADMIN: { requests: 0, blocked: 0 },
    EDITOR: { requests: 0, blocked: 0 },
    READONLY: { requests: 0, blocked: 0 },
    DEFAULT: { requests: 0, blocked: 0 },
  };
}

function parseRedisWindow(value: unknown): { count: number; ttlMs: number } {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('invalid Redis rate-limit response');
  }
  const count = Number(value[0]);
  const ttlMs = Number(value[1]);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0
  ) {
    throw new Error('invalid Redis rate-limit counter');
  }
  return { count, ttlMs };
}

export function selectRateLimitRole(codes: readonly string[]): RateLimitRole {
  const normalized = new Set(codes.map((code) => code.trim().toUpperCase()));
  if (normalized.has('ADMIN')) return 'ADMIN';
  if (normalized.has('EDITOR')) return 'EDITOR';
  if (normalized.has('READONLY')) return 'READONLY';
  return 'DEFAULT';
}

export function buildRateLimitKey(
  policy: RateLimitPolicy,
  role: RateLimitRole,
  clientIdentifier: string,
): string {
  const digest = createHash('sha256').update(clientIdentifier).digest('hex');
  const bucket = policy === 'strict' ? 'strict' : role.toLowerCase();
  return `rate_limit:neo:${bucket}:${digest}`;
}

@Injectable()
export class RateLimitService {
  private readonly memoryWindows = new Map<string, MemoryWindow>();
  private byRole = freshRoleStats();
  private totalRequests = 0;
  private blockedRequests = 0;
  private lastReset = Date.now();
  private backend: RateLimitBackend = 'redis';
  private redisRetryAfter = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ApplicationRedisClient)
    private readonly redis: ApplicationRedisClient,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
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
  }

  private consumeMemory(
    key: string,
    now: number,
  ): { count: number; ttlMs: number } {
    let window = this.memoryWindows.get(key);
    if (!window || window.expiresAt <= now) {
      if (!window && this.memoryWindows.size >= MAX_MEMORY_WINDOWS) {
        this.cleanMemory(now);
        if (this.memoryWindows.size >= MAX_MEMORY_WINDOWS) {
          const oldest = this.memoryWindows.keys().next().value as
            | string
            | undefined;
          if (oldest) this.memoryWindows.delete(oldest);
        }
      }
      window = { count: 0, expiresAt: now + RATE_LIMIT_WINDOW_MS };
      this.memoryWindows.set(key, window);
    }
    window.count += 1;
    return { count: window.count, ttlMs: Math.max(1, window.expiresAt - now) };
  }

  private async consumeWindow(
    key: string,
    now: number,
  ): Promise<{ backend: RateLimitBackend; count: number; ttlMs: number }> {
    if (this.backend === 'memory' && now < this.redisRetryAfter) {
      return { backend: 'memory', ...this.consumeMemory(key, now) };
    }
    try {
      const window = parseRedisWindow(
        await this.redis.eval(
          FIXED_WINDOW_SCRIPT,
          [key],
          [RATE_LIMIT_WINDOW_MS],
        ),
      );
      this.setBackend('redis', now);
      return { backend: 'redis', ...window };
    } catch {
      this.setBackend('memory', now);
      return { backend: 'memory', ...this.consumeMemory(key, now) };
    }
  }

  async consume(input: {
    clientIdentifier: string;
    policy: RateLimitPolicy;
    role: RateLimitRole;
  }): Promise<RateLimitDecision> {
    const now = Date.now();
    const limit =
      input.policy === 'strict' ? STRICT_RATE_LIMIT : ROLE_LIMITS[input.role];
    const key = buildRateLimitKey(
      input.policy,
      input.role,
      input.clientIdentifier,
    );
    const window = await this.consumeWindow(key, now);
    const allowed = window.count <= limit;
    this.totalRequests += 1;
    this.byRole[input.role].requests += 1;
    if (!allowed) {
      this.blockedRequests += 1;
      this.byRole[input.role].blocked += 1;
    }
    this.metrics.recordRateLimitDecision({
      role: input.role,
      policy: input.policy,
      outcome: allowed ? 'allowed' : 'blocked',
      backend: window.backend,
    });
    return {
      allowed,
      backend: window.backend,
      count: window.count,
      limit,
      policy: input.policy,
      remaining: Math.max(0, limit - window.count),
      resetAfterMs: window.ttlMs,
      role: input.role,
    };
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
