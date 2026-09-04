import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Env, loadEnv } from '@asin-monitor/config';
import { AppModule } from '../src/app.module';
import { PermissionCacheService } from '../src/auth/permission-cache.service';
import { ENV } from '../src/config/config.module';
import {
  HealthErrorStatsService,
  HealthService,
} from '../src/health/health.service';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import { MetricsService } from '../src/metrics/metrics.service';
import {
  RateLimitInterceptor,
  RateLimitRequestHook,
  StrictRateLimit,
} from '../src/rate-limit/rate-limit.interceptor';
import {
  buildRateLimitKey,
  RATE_LIMIT_WINDOW_MS,
  RateLimitService,
  ROLE_LIMITS,
  selectRateLimitRole,
  STRICT_RATE_LIMIT,
} from '../src/rate-limit/rate-limit.service';
import { ApplicationRedisClient } from '../src/redis/redis.service';

const validEnv = {
  DATABASE_URL: 'postgresql://localhost/amazon_asin_monitor',
  COMPETITOR_DATABASE_URL: 'postgresql://localhost/amazon_competitor_monitor',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-secret',
  AUTH_DATA_AUTHORITY: 'postgresql',
};
const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const rateLimitPrefix = 'spapi:ratelimiter';

function loggerMock(): AppLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as AppLogger;
}

function redisMock(): ApplicationRedisClient {
  return {
    eval: vi.fn(),
    del: vi.fn().mockResolvedValue(0),
  } as unknown as ApplicationRedisClient;
}

const metricsToClose: MetricsService[] = [];

function createService(
  options: {
    env?: Env;
    logger?: AppLogger;
    metrics?: MetricsService;
    redis?: ApplicationRedisClient;
  } = {},
) {
  const metrics = options.metrics ?? new MetricsService();
  metricsToClose.push(metrics);
  const service = new RateLimitService(
    options.env ?? loadEnv(validEnv),
    options.redis ?? redisMock(),
    options.logger ?? loggerMock(),
    metrics,
  );
  return { metrics, service };
}

afterEach(() => {
  for (const metrics of metricsToClose.splice(0)) metrics.onModuleDestroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('RateLimitService', () => {
  it('按 ADMIN > EDITOR > READONLY > DEFAULT 选择固定配额', () => {
    expect(selectRateLimitRole(['readonly', 'editor', 'admin'])).toBe('ADMIN');
    expect(selectRateLimitRole(['readonly', 'EDITOR'])).toBe('EDITOR');
    expect(selectRateLimitRole(['READONLY'])).toBe('READONLY');
    expect(selectRateLimitRole(['custom-role'])).toBe('DEFAULT');
    expect(ROLE_LIMITS).toEqual({
      ADMIN: 1_000,
      EDITOR: 500,
      READONLY: 100,
      DEFAULT: 100,
    });
    expect(STRICT_RATE_LIMIT).toBe(20);
  });

  it.each(Object.entries(ROLE_LIMITS))(
    '%s 的第 limit+1 次请求被阻断且计入健康与 Prometheus 统计',
    async (role, limit) => {
      const redis = redisMock();
      vi.mocked(redis.eval)
        .mockResolvedValueOnce([limit, RATE_LIMIT_WINDOW_MS, 'window-a'])
        .mockResolvedValueOnce([
          limit + 1,
          RATE_LIMIT_WINDOW_MS - 1,
          'window-a',
        ]);
      const { service, metrics } = createService({ redis });
      const input = {
        clientIdentifier: '203.0.113.10',
        policy: 'role' as const,
        role: role as keyof typeof ROLE_LIMITS,
      };

      await expect(service.consume(input)).resolves.toMatchObject({
        allowed: true,
        limit,
        remaining: 0,
      });
      await expect(service.consume(input)).resolves.toMatchObject({
        allowed: false,
        count: limit + 1,
        limit,
      });
      expect(service.snapshot(true).stats).toMatchObject({
        totalRequests: 2,
        blockedRequests: 1,
        blockRate: '50.00',
        byRole: { [role]: { requests: 2, blocked: 1 } },
      });
      expect(await metrics.render()).toContain(
        `amazon_asin_monitor_http_rate_limit_decisions_total{role="${role}",policy="role",outcome="blocked",backend="redis"} 1`,
      );
    },
  );

  it('释放预占时携带窗口 generation，旧请求不会递减新窗口', async () => {
    const redis = redisMock();
    vi.mocked(redis.eval)
      .mockResolvedValueOnce([1, RATE_LIMIT_WINDOW_MS, 'reserved-generation'])
      .mockResolvedValueOnce(0);
    const { service } = createService({ redis });
    const decision = await service.consume(
      {
        clientIdentifier: '203.0.113.15',
        policy: 'role',
        role: 'DEFAULT',
      },
      { recordRequest: false },
    );

    await service.release(decision);

    const [consumeScript] = vi.mocked(redis.eval).mock.calls[0]!;
    expect(consumeScript.trimStart()).toMatch(
      /^redis\.replicate_commands\(\)\s+local redisTime/,
    );
    const [releaseScript, releaseKeys, releaseArguments] = vi.mocked(redis.eval)
      .mock.calls[1]!;
    expect(releaseScript.trimStart()).toMatch(
      /^redis\.replicate_commands\(\)\s+local redisTime/,
    );
    expect(releaseScript).toContain(
      "redis.call('HGET', KEYS[index], 'generation')",
    );
    expect(releaseScript).toContain("redis.call('HDEL', KEYS[index]");
    expect(releaseKeys).toEqual([
      decision.clientKey,
      decision.overflowKey,
      `${decision.overflowKey}:clients`,
    ]);
    expect(releaseArguments).toEqual([
      'reserved-generation',
      decision.requestId,
      RATE_LIMIT_WINDOW_MS,
    ]);
  });

  it('认证角色计数与 DEFAULT 预占释放在同一个 Redis 脚本内完成', async () => {
    const redis = redisMock();
    vi.mocked(redis.eval)
      .mockResolvedValueOnce([1, RATE_LIMIT_WINDOW_MS, 'source-generation'])
      .mockResolvedValueOnce([
        1,
        RATE_LIMIT_WINDOW_MS,
        'target-generation',
        buildRateLimitKey(rateLimitPrefix, 'role', 'ADMIN', '203.0.113.16'),
        1,
      ]);
    const { service } = createService({ redis });
    const source = await service.consume(
      {
        clientIdentifier: '203.0.113.16',
        policy: 'role',
        role: 'DEFAULT',
      },
      { recordRequest: false },
    );

    const transferred = await service.transfer(source, {
      clientIdentifier: '203.0.113.16',
      policy: 'role',
      role: 'ADMIN',
    });

    expect(transferred).toMatchObject({
      backend: 'redis',
      count: 1,
      generation: 'target-generation',
      role: 'ADMIN',
    });
    expect(redis.eval).toHaveBeenCalledTimes(2);
    const [transferScript, transferKeys, transferArguments] = vi.mocked(
      redis.eval,
    ).mock.calls[1]!;
    expect(transferScript.trimStart()).toMatch(
      /^redis\.replicate_commands\(\)\s+local redisTime/,
    );
    expect(transferScript).toContain("redis.call('HSET', selected");
    expect(transferScript).toContain("redis.call('HGET', KEYS[index]");
    expect(transferScript).toContain("redis.call('HDEL', KEYS[index]");
    expect(transferKeys).toEqual([
      source.clientKey,
      source.overflowKey,
      buildRateLimitKey(rateLimitPrefix, 'role', 'ADMIN', '203.0.113.16'),
      `${rateLimitPrefix}:http:neo:overflow:admin`,
      `${rateLimitPrefix}:http:neo:overflow:admin:clients`,
      `${source.overflowKey}:clients`,
    ]);
    expect(transferArguments[3]).toBe(source.requestId);
    expect(transferArguments[4]).toBe('source-generation');
    expect(transferArguments[5]).toBe(1);
    expect(transferArguments[6]).toBe(RATE_LIMIT_WINDOW_MS);
  });

  it('原子转移调用失败时保留较严格的 DEFAULT 决策并进入降级', async () => {
    const redis = redisMock();
    vi.mocked(redis.eval)
      .mockResolvedValueOnce([1, RATE_LIMIT_WINDOW_MS, 'source-generation'])
      .mockRejectedValueOnce(new Error('transfer unavailable'));
    const { service } = createService({ redis });
    const source = await service.consume(
      {
        clientIdentifier: '203.0.113.17',
        policy: 'role',
        role: 'DEFAULT',
      },
      { recordRequest: false },
    );

    await expect(
      service.transfer(source, {
        clientIdentifier: '203.0.113.17',
        policy: 'role',
        role: 'ADMIN',
      }),
    ).resolves.toBe(source);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(service.snapshot(true).status).toBe('degraded');
  });

  it('strict 原子转移失联时先用目标内存桶，恢复后重试来源释放', async () => {
    const redis = redisMock();
    vi.mocked(redis.eval)
      .mockResolvedValueOnce([1, RATE_LIMIT_WINDOW_MS, 'source-generation'])
      .mockRejectedValueOnce(new Error('strict transfer unavailable'));
    const { service } = createService({ redis });
    const source = await service.consume(
      {
        clientIdentifier: '203.0.113.171',
        policy: 'role',
        role: 'DEFAULT',
      },
      { recordRequest: false },
    );

    const fallback = await service.transfer(
      source,
      {
        clientIdentifier: '203.0.113.171',
        policy: 'strict',
        role: 'ADMIN',
      },
      { fallbackToTargetMemory: true },
    );
    expect(fallback).toMatchObject({
      allowed: true,
      backend: 'memory',
      count: 1,
      policy: 'strict',
      uncertainRedisReservation: true,
    });
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(service.snapshot(true).status).toBe('degraded');

    (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;
    vi.mocked(redis.eval)
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        1,
        RATE_LIMIT_WINDOW_MS,
        arguments_[0],
        keys[0],
      ])
      .mockRejectedValueOnce(new Error('source release unavailable'));
    await service.recover(true);
    expect(service.snapshot(true).status).toBe('degraded');

    (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;
    vi.mocked(redis.eval)
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        1,
        RATE_LIMIT_WINDOW_MS,
        arguments_[0],
        keys[0],
      ])
      .mockResolvedValueOnce(1);
    await service.recover(true);
    expect(service.snapshot(true).status).toBe('ok');
    const [, releaseKeys, releaseArguments] = vi.mocked(redis.eval).mock
      .calls[7]!;
    expect(releaseKeys).toEqual([
      source.clientKey,
      source.overflowKey,
      `${source.overflowKey}:clients`,
    ]);
    expect(releaseArguments).toEqual([
      source.generation,
      source.requestId,
      RATE_LIMIT_WINDOW_MS,
    ]);
  });

  it('Redis 响应不确定时保留 DEFAULT 内存预占，角色转移与释放均不误删', async () => {
    const redis = redisMock();
    vi.mocked(redis.eval).mockRejectedValueOnce(
      new Error('consume response timeout'),
    );
    const { service } = createService({ redis });
    const input = {
      clientIdentifier: '203.0.113.18',
      policy: 'role' as const,
      role: 'DEFAULT' as const,
    };
    const source = await service.consume(input, { recordRequest: false });

    expect(source).toMatchObject({
      backend: 'memory',
      count: 1,
      uncertainRedisReservation: true,
    });
    await expect(
      service.transfer(source, { ...input, role: 'ADMIN' }),
    ).resolves.toBe(source);
    await service.release(source);
    await expect(service.consume(input)).resolves.toMatchObject({
      backend: 'memory',
      count: 2,
    });
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it('不确定 DEFAULT 来源可转入 strict 内存桶并在完整对账后释放', async () => {
    const redis = redisMock();
    vi.mocked(redis.eval).mockRejectedValueOnce(
      new Error('consume response timeout'),
    );
    const { service } = createService({ redis });
    const source = await service.consume(
      {
        clientIdentifier: '203.0.113.181',
        policy: 'role',
        role: 'DEFAULT',
      },
      { recordRequest: false },
    );

    const strict = await service.transfer(
      source,
      {
        clientIdentifier: '203.0.113.181',
        policy: 'strict',
        role: 'ADMIN',
      },
      { fallbackToTargetMemory: true },
    );
    expect(strict).toMatchObject({
      allowed: true,
      backend: 'memory',
      count: 1,
      policy: 'strict',
      uncertainRedisReservation: false,
    });

    const generation = String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS));
    (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;
    vi.mocked(redis.eval)
      .mockResolvedValueOnce(generation)
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        Number(arguments_[3]),
        RATE_LIMIT_WINDOW_MS,
        generation,
        keys[0],
      ])
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        Number(arguments_[3]),
        RATE_LIMIT_WINDOW_MS,
        generation,
        keys[0],
      ])
      .mockResolvedValueOnce(1);

    await service.recover(true);

    expect(service.snapshot(true).status).toBe('ok');
    const [, releaseKeys, releaseArguments] = vi.mocked(redis.eval).mock
      .calls[4]!;
    expect(releaseKeys).toEqual([
      source.clientKey,
      source.overflowKey,
      `${source.overflowKey}:clients`,
    ]);
    expect(releaseArguments).toEqual([
      source.generation,
      source.requestId,
      RATE_LIMIT_WINDOW_MS,
    ]);
  });

  it('已对账的内存来源转移响应超时时仍保留 Redis 来源释放意图', async () => {
    const redis = redisMock();
    const { service } = createService({ redis });
    const internal = service as unknown as {
      backend: 'memory';
      redisRetryAfter: number;
    };
    internal.backend = 'memory';
    internal.redisRetryAfter = Number.MAX_SAFE_INTEGER;
    const source = await service.consume(
      {
        clientIdentifier: '203.0.113.182',
        policy: 'role',
        role: 'DEFAULT',
      },
      { recordRequest: false },
    );
    const generation = String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS));
    vi.mocked(redis.eval)
      .mockResolvedValueOnce(generation)
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        Number(arguments_[3]),
        RATE_LIMIT_WINDOW_MS,
        generation,
        keys[0],
      ]);
    internal.redisRetryAfter = 0;
    await service.recover(true);
    expect(service.snapshot(true).status).toBe('ok');

    vi.mocked(redis.eval).mockRejectedValueOnce(
      new Error('transfer response timeout'),
    );
    const fallback = await service.transfer(
      source,
      {
        clientIdentifier: '203.0.113.182',
        policy: 'strict',
        role: 'ADMIN',
      },
      { fallbackToTargetMemory: true },
    );
    expect(fallback).toMatchObject({
      allowed: true,
      backend: 'memory',
      uncertainRedisReservation: true,
    });

    internal.redisRetryAfter = 0;
    vi.mocked(redis.eval)
      .mockResolvedValueOnce(generation)
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        Number(arguments_[3]),
        RATE_LIMIT_WINDOW_MS,
        generation,
        keys[0],
      ])
      .mockResolvedValueOnce(1);
    await service.recover(true);

    expect(service.snapshot(true).status).toBe('ok');
    const [, releaseKeys, releaseArguments] = vi.mocked(redis.eval).mock
      .calls[5]!;
    expect(releaseKeys).toEqual([
      source.clientKey,
      source.overflowKey,
      `${source.overflowKey}:clients`,
    ]);
    expect(releaseArguments).toEqual([
      source.generation,
      source.requestId,
      RATE_LIMIT_WINDOW_MS,
    ]);
  });

  it('已观测 Redis 时钟偏移时本地跨窗仍保持同一降级窗口', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:14:59.900Z'));
    const redis = redisMock();
    const { service } = createService({ redis });
    const redisNowMs = new Date('2026-09-01T00:16:59.900Z').getTime();
    const generation = String(Math.floor(redisNowMs / RATE_LIMIT_WINDOW_MS));
    vi.mocked(redis.eval).mockResolvedValueOnce([generation, redisNowMs]);
    await service.recover(true);
    const internal = service as unknown as {
      backend: 'memory';
      redisRetryAfter: number;
    };
    internal.backend = 'memory';
    internal.redisRetryAfter = Number.MAX_SAFE_INTEGER;
    const input = {
      clientIdentifier: '198.51.100.201',
      policy: 'role' as const,
      role: 'DEFAULT' as const,
    };

    const beforeRollover = await service.consume(input, {
      recordRequest: false,
    });
    vi.advanceTimersByTime(200);
    const afterRollover = await service.consume(input, {
      recordRequest: false,
    });

    expect(afterRollover).toMatchObject({ backend: 'memory', count: 2 });
    expect(afterRollover.generation).toBe(beforeRollover.generation);
    vi.mocked(redis.eval)
      .mockResolvedValueOnce([generation, redisNowMs + 200])
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        Number(arguments_[3]),
        RATE_LIMIT_WINDOW_MS,
        generation,
        keys[0],
      ]);
    internal.redisRetryAfter = 0;

    await service.recover(true);

    const [, , reconcileArguments] = vi.mocked(redis.eval).mock.calls[2]!;
    expect(reconcileArguments[3]).toBe(2);
    expect(reconcileArguments.slice(4, 6)).toEqual(
      expect.arrayContaining([
        beforeRollover.requestId,
        afterRollover.requestId,
      ]),
    );
    expect(service.snapshot(true).status).toBe('ok');
  });

  it('无 Redis 时钟偏移时降级配额在固定窗口边界正常重置', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:14:59.900Z'));
    const { service } = createService();
    const internal = service as unknown as {
      backend: 'memory';
      redisRetryAfter: number;
    };
    internal.backend = 'memory';
    internal.redisRetryAfter = Number.MAX_SAFE_INTEGER;
    const input = {
      clientIdentifier: '198.51.100.202',
      policy: 'role' as const,
      role: 'DEFAULT' as const,
    };

    let beforeRollover!: Awaited<ReturnType<typeof service.consume>>;
    for (let index = 0; index < ROLE_LIMITS.DEFAULT; index += 1) {
      beforeRollover = await service.consume(input, { recordRequest: false });
    }
    expect(beforeRollover).toMatchObject({
      allowed: true,
      count: ROLE_LIMITS.DEFAULT,
    });

    vi.advanceTimersByTime(200);
    const afterRollover = await service.consume(input, {
      recordRequest: false,
    });

    expect(afterRollover).toMatchObject({
      allowed: true,
      backend: 'memory',
      count: 1,
    });
    expect(afterRollover.generation).not.toBe(beforeRollover.generation);
  });

  it('Redis 故障时保持对齐内存窗口，后台自动恢复不阻塞触发请求', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const redis = redisMock();
    vi.mocked(redis.eval)
      .mockRejectedValueOnce(new Error('redis://user:secret@cache/0'))
      .mockRejectedValueOnce(new Error('still unavailable'))
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        Number(arguments_[3]),
        RATE_LIMIT_WINDOW_MS - 10_003,
        arguments_[0],
        keys[0],
      ])
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        6,
        RATE_LIMIT_WINDOW_MS - 10_003,
        arguments_[0],
        keys[0],
      ]);
    const logger = loggerMock();
    const { service } = createService({ logger, redis });
    const input = {
      clientIdentifier: '198.51.100.20',
      policy: 'strict' as const,
      role: 'DEFAULT' as const,
    };

    const first = await service.consume(input);
    vi.advanceTimersByTime(1_000);
    const second = await service.consume(input);
    expect(first).toMatchObject({ backend: 'memory', count: 1 });
    expect(second).toMatchObject({
      backend: 'memory',
      count: 2,
      resetAfterMs: RATE_LIMIT_WINDOW_MS - 1_000,
    });
    expect(redis.eval).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(4_001);
    await expect(service.consume(input)).resolves.toMatchObject({
      backend: 'memory',
      count: 3,
    });
    await expect(service.consume(input)).resolves.toMatchObject({
      backend: 'memory',
      count: 4,
    });
    expect(redis.eval).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_001);
    await expect(service.consume(input)).resolves.toMatchObject({
      backend: 'memory',
      count: 5,
    });
    await service.recover(true);
    expect(service.snapshot(true).status).toBe('ok');
    const [mergeScript, mergeKeys, mergeArguments] = vi.mocked(redis.eval).mock
      .calls[3]!;
    expect(mergeScript).toContain('local requestCount = tonumber(ARGV[4])');
    expect(mergeScript.trimStart()).toMatch(
      /^redis\.replicate_commands\(\)\s+local redisTime/,
    );
    expect(mergeKeys).toHaveLength(2);
    expect(mergeArguments[3]).toBe(5);
    expect(mergeArguments.slice(4, 9)).toHaveLength(5);
    expect(mergeArguments.slice(9, -3)).toEqual(Array(5).fill(''));
    expect(mergeArguments.at(-1)).toBe(RATE_LIMIT_WINDOW_MS);
    await expect(service.consume(input)).resolves.toMatchObject({
      backend: 'redis',
      count: 6,
    });
    const [, consumeKeys, consumeArguments] = vi.mocked(redis.eval).mock
      .calls[4]!;
    expect(consumeKeys).toHaveLength(3);
    expect(consumeArguments).toHaveLength(5);
    expect(consumeArguments.at(-1)).toBe(RATE_LIMIT_WINDOW_MS);
    expect(mergeArguments.slice(4, 9)).not.toContain(consumeArguments[3]);
    expect(logger.warn).toHaveBeenCalledWith(
      'HTTP 限流 Redis 不可用，切换内存降级',
      'RateLimitService',
      { backend: 'memory', reason: 'redis_unavailable' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP 限流 Redis 已恢复',
      'RateLimitService',
      { backend: 'redis', previousBackend: 'memory' },
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      'secret',
    );
  });

  it('半开窗口只允许一个 Redis 恢复探测，并发请求继续使用内存', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const redis = redisMock();
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error('unavailable'));
    const { service } = createService({ redis });
    const input = {
      clientIdentifier: '198.51.100.30',
      policy: 'role' as const,
      role: 'DEFAULT' as const,
    };
    await expect(service.consume(input)).resolves.toMatchObject({
      backend: 'memory',
    });
    vi.advanceTimersByTime(5_001);

    let finishProbe!: (value: unknown) => void;
    vi.mocked(redis.eval).mockImplementationOnce(
      () => new Promise((resolve) => (finishProbe = resolve)),
    );
    vi.mocked(redis.eval).mockImplementation(async (script, keys, arguments_) =>
      script.includes('local requestCount = tonumber(ARGV[4])')
        ? [Number(arguments_[3]), RATE_LIMIT_WINDOW_MS, arguments_[0], keys[0]]
        : [1, RATE_LIMIT_WINDOW_MS, arguments_[0], keys[0]],
    );
    const leader = service.consume({ ...input, clientIdentifier: 'leader' });
    await expect(leader).resolves.toMatchObject({
      backend: 'memory',
      count: 1,
    });
    const followers = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.consume({
          ...input,
          clientIdentifier: `follower-${index}`,
        }),
      ),
    );

    expect(followers.every(({ backend }) => backend === 'memory')).toBe(true);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    finishProbe(1);
    await service.recover(true);
    expect(service.snapshot(true).status).toBe('ok');
    expect(redis.eval).toHaveBeenCalledTimes(12);
  });

  it('readiness 可在冷却后主动验证 Lua 并恢复 Redis 后端', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const redis = redisMock();
    vi.mocked(redis.eval)
      .mockRejectedValueOnce(new Error('eval unavailable'))
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        Number(arguments_[3]),
        RATE_LIMIT_WINDOW_MS,
        arguments_[0],
        keys[0],
      ]);
    const { service } = createService({ redis });

    await service.consume({
      clientIdentifier: '198.51.100.40',
      policy: 'role',
      role: 'DEFAULT',
    });
    expect(service.snapshot(true).status).toBe('degraded');
    vi.advanceTimersByTime(5_001);

    await service.recover(true);

    expect(service.snapshot(true).status).toBe('ok');
    expect(redis.eval).toHaveBeenCalledTimes(3);
    const [script, keys, arguments_] = vi.mocked(redis.eval).mock.calls[1]!;
    for (const command of [
      'HSET',
      'HSETNX',
      'HINCRBY',
      'HGET',
      'HEXISTS',
      'HLEN',
      'HDEL',
      'PEXPIREAT',
      'PTTL',
      'TIME',
      'DEL',
    ]) {
      expect(script).toContain(`redis.call('${command}'`);
    }
    expect(script.trimStart()).toMatch(
      /^redis\.replicate_commands\(\)\s+local redisTime/,
    );
    expect(script).toContain('return { currentGeneration, tostring(nowMs) }');
    expect(keys[0]).toMatch(
      /^spapi:ratelimiter:http:neo:capability:[0-9a-f-]+$/,
    );
    expect(arguments_[0]).toEqual(expect.any(String));
    expect(arguments_[1]).toEqual(expect.any(Number));
    expect(arguments_[2]).toEqual(expect.any(String));
    expect(arguments_[3]).toBe(RATE_LIMIT_WINDOW_MS);
  });

  it('对账期间新流量直用 Redis，但角色转移等待整轮恢复完成', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const redis = redisMock();
    let finishReconciliation!: (value: unknown) => void;
    vi.mocked(redis.eval)
      .mockRejectedValueOnce(new Error('initial outage'))
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishReconciliation = resolve;
          }),
      )
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        1,
        RATE_LIMIT_WINDOW_MS,
        arguments_[0],
        keys[0],
      ])
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        1,
        RATE_LIMIT_WINDOW_MS,
        arguments_[0],
        keys[2],
        1,
      ])
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        1,
        RATE_LIMIT_WINDOW_MS,
        arguments_[0],
        keys[2],
        1,
      ]);
    const { service } = createService({ redis });
    const source = await service.consume(
      {
        clientIdentifier: '198.51.100.45',
        policy: 'role',
        role: 'DEFAULT',
      },
      { recordRequest: false },
    );
    expect(source.backend).toBe('memory');
    (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;

    expect(service.startRecovery(true)).toBeUndefined();
    expect(service.startRecovery(true)).toBeUndefined();
    await vi.waitFor(() => expect(redis.eval).toHaveBeenCalledTimes(3));
    expect(service.snapshot(true).status).toBe('degraded');
    const duringRecovery = await service.consume({
      clientIdentifier: '198.51.100.45-during-recovery',
      policy: 'role',
      role: 'DEFAULT',
    });
    expect(duringRecovery).toMatchObject({ backend: 'redis', count: 1 });
    const memoryTransfer = service.transfer(source, {
      clientIdentifier: '198.51.100.45',
      policy: 'role',
      role: 'ADMIN',
    });
    const redisTransfer = service.transfer(duringRecovery, {
      clientIdentifier: '198.51.100.45-during-recovery',
      policy: 'role',
      role: 'ADMIN',
    });
    expect(redis.eval).toHaveBeenCalledTimes(4);

    const [, reconcileKeys, reconcileArguments] = vi.mocked(redis.eval).mock
      .calls[2]!;
    expect(reconcileKeys).toEqual([source.clientKey, source.overflowKey]);
    expect(reconcileArguments.slice(4, -3)).toContain(source.requestId);
    expect(reconcileArguments.at(-1)).toBe(RATE_LIMIT_WINDOW_MS);
    finishReconciliation([
      1,
      RATE_LIMIT_WINDOW_MS,
      source.generation,
      source.clientKey,
    ]);
    await expect(memoryTransfer).resolves.toMatchObject({
      backend: 'redis',
      count: 1,
      role: 'ADMIN',
    });
    await expect(redisTransfer).resolves.toMatchObject({
      backend: 'redis',
      count: 1,
      role: 'ADMIN',
    });
    expect(service.snapshot(true).status).toBe('ok');
    expect(redis.eval).toHaveBeenCalledTimes(6);
  });

  it('第二批冻结窗口在自身对账完成前不会提前访问 Redis', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const redis = redisMock();
    const { service } = createService({ redis });
    const internal = service as unknown as {
      backend: 'memory';
      redisRetryAfter: number;
    };
    internal.backend = 'memory';
    internal.redisRetryAfter = Number.MAX_SAFE_INTEGER;
    const inputs = Array.from({ length: 101 }, (_, index) => ({
      clientIdentifier: `198.51.100.46-${index}`,
      policy: 'role' as const,
      role: 'DEFAULT' as const,
    }));
    for (const input of inputs) {
      await service.consume(input, { recordRequest: false });
    }
    const target = inputs.at(-1)!;
    const targetKey = buildRateLimitKey(
      rateLimitPrefix,
      target.policy,
      target.role,
      target.clientIdentifier,
    );
    let finishTargetReconciliation!: (value: unknown) => void;
    vi.mocked(redis.eval).mockImplementation(
      async (script, keys, arguments_) => {
        if (keys[0]?.includes(':capability:')) return 1;
        if (script.includes('local requestCount')) {
          if (keys[0] === targetKey) {
            return new Promise((resolve) => {
              finishTargetReconciliation = resolve;
            });
          }
          return [
            Number(arguments_[3]),
            RATE_LIMIT_WINDOW_MS,
            arguments_[0],
            keys[0],
          ];
        }
        return [2, RATE_LIMIT_WINDOW_MS, arguments_[0], keys[0]];
      },
    );
    internal.redisRetryAfter = 0;

    service.startRecovery(true);
    await vi.waitFor(() =>
      expect(finishTargetReconciliation).toEqual(expect.any(Function)),
    );
    const callsBeforeConsume = vi.mocked(redis.eval).mock.calls.length;
    const pending = service.consume(target, { recordRequest: false });
    await Promise.resolve();
    expect(redis.eval).toHaveBeenCalledTimes(callsBeforeConsume);

    finishTargetReconciliation([
      1,
      RATE_LIMIT_WINDOW_MS,
      String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS)),
      targetKey,
    ]);
    await expect(pending).resolves.toMatchObject({
      backend: 'redis',
      count: 2,
      storageKey: targetKey,
    });
    await service.recover(true);
    expect(service.snapshot(true).status).toBe('ok');
  });

  it('对账失败后丢弃竞态中的 Redis 成功结果并返回不确定内存阻断', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const redis = redisMock();
    let failReconciliation!: (reason: Error) => void;
    let finishConcurrentConsume!: (value: unknown) => void;
    vi.mocked(redis.eval)
      .mockRejectedValueOnce(new Error('initial outage'))
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failReconciliation = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishConcurrentConsume = resolve;
          }),
      );
    const { service } = createService({ redis });
    await service.consume({
      clientIdentifier: '198.51.100.451',
      policy: 'role',
      role: 'DEFAULT',
    });
    (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;
    service.startRecovery(true);
    await vi.waitFor(() => expect(redis.eval).toHaveBeenCalledTimes(3));

    const concurrent = service.consume({
      clientIdentifier: '198.51.100.452',
      policy: 'role',
      role: 'DEFAULT',
    });
    await vi.waitFor(() => expect(redis.eval).toHaveBeenCalledTimes(4));
    failReconciliation(new Error('reconciliation timeout'));
    await service.recover(true);
    const generation = String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS));
    finishConcurrentConsume([
      1,
      RATE_LIMIT_WINDOW_MS,
      generation,
      buildRateLimitKey(rateLimitPrefix, 'role', 'DEFAULT', '198.51.100.452'),
    ]);

    await expect(concurrent).resolves.toMatchObject({
      allowed: false,
      backend: 'memory',
      count: ROLE_LIMITS.DEFAULT + 1,
      uncertainRedisReservation: true,
    });
    expect(service.snapshot(true).status).toBe('degraded');
  });

  it('恢复期冻结的 overflow 成员等待对应成员表对账后才访问 Redis', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const redis = redisMock();
    const { service } = createService({ redis });
    const input = {
      clientIdentifier: '198.51.100.47',
      policy: 'role' as const,
      role: 'DEFAULT' as const,
    };
    const clientKey = buildRateLimitKey(
      rateLimitPrefix,
      input.policy,
      input.role,
      input.clientIdentifier,
    );
    const overflowKey = `${rateLimitPrefix}:http:neo:overflow:default`;
    const generation = String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS));
    let resolveBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });
    const internal = service as unknown as {
      backend: 'memory';
      memoryOverflowWindows: Map<
        string,
        {
          expiresAt: number;
          generation: string;
          limit: number;
          requestIds: Set<string>;
          requestOwners: Map<string, string>;
        }
      >;
      reconciliationBarriers: Map<
        string,
        { promise: Promise<void>; resolve: () => void }
      >;
      recoveryUsesRedis: boolean;
    };
    internal.backend = 'memory';
    internal.recoveryUsesRedis = true;
    internal.memoryOverflowWindows.set(overflowKey, {
      expiresAt: Date.now() + RATE_LIMIT_WINDOW_MS,
      generation,
      limit: ROLE_LIMITS.DEFAULT,
      requestIds: new Set(['existing']),
      requestOwners: new Map([['existing', clientKey]]),
    });
    internal.reconciliationBarriers.set(overflowKey, {
      promise: barrier,
      resolve: resolveBarrier,
    });
    vi.mocked(redis.eval).mockResolvedValueOnce([
      2,
      RATE_LIMIT_WINDOW_MS,
      generation,
      overflowKey,
    ]);

    const pending = service.consume(input);
    await Promise.resolve();
    expect(redis.eval).not.toHaveBeenCalled();
    resolveBarrier();
    await expect(pending).resolves.toMatchObject({
      backend: 'redis',
      count: 2,
      storageKey: overflowKey,
    });
    const [, keys, arguments_] = vi.mocked(redis.eval).mock.calls[0]!;
    expect(keys).toEqual([clientKey, overflowKey, `${overflowKey}:clients`]);
    expect(arguments_.at(-1)).toBe(RATE_LIMIT_WINDOW_MS);
  });

  it('对账中断后内存请求 fail-closed，成功重试后才恢复放行', async () => {
    const redis = redisMock();
    vi.mocked(redis.eval)
      .mockRejectedValueOnce(new Error('initial outage'))
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('partial reconciliation'));
    const { service } = createService({ redis });
    const input = {
      clientIdentifier: '198.51.100.48',
      policy: 'role' as const,
      role: 'DEFAULT' as const,
    };
    await service.consume(input);
    (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;

    await service.recover(true);

    await expect(service.consume(input)).resolves.toMatchObject({
      allowed: false,
      backend: 'memory',
      count: ROLE_LIMITS.DEFAULT + 1,
    });
    expect(service.snapshot(true).status).toBe('degraded');

    (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;
    vi.mocked(redis.eval)
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(async (_script, keys, arguments_) => [
        Number(arguments_[3]),
        RATE_LIMIT_WINDOW_MS,
        arguments_[0],
        keys[0],
      ]);
    await service.recover(true);
    expect(service.snapshot(true).status).toBe('ok');
  });

  it('内存降级与 Redis 使用相同对齐窗口，不会从故障时刻续期 15 分钟', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:10:00.000Z'));
    const redis = redisMock();
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error('late outage'));
    const { service } = createService({ redis });

    const decision = await service.consume({
      clientIdentifier: '198.51.100.46',
      policy: 'role',
      role: 'DEFAULT',
    });

    expect(decision).toMatchObject({
      backend: 'memory',
      resetAfterMs: 5 * 60 * 1_000,
    });
    const [, , arguments_] = vi.mocked(redis.eval).mock.calls[0]!;
    expect(arguments_[1]).toBe(new Date('2026-09-01T00:15:00.000Z').getTime());
  });

  it('实例启动时 readiness 即验证完整限流命令，ACL 不足保持 degraded', async () => {
    const redis = redisMock();
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error('INCR denied'));
    const { service } = createService({ redis });

    await service.recover(true);

    expect(redis.eval).toHaveBeenCalledOnce();
    expect(service.snapshot(true).status).toBe('degraded');
  });

  it('Redis key 只包含客户端摘要，白名单兼容 IPv4-mapped 地址', () => {
    const env = loadEnv({
      ...validEnv,
      RATE_LIMIT_WHITELIST_IPS: '127.0.0.1,::1',
    });
    const { service } = createService({ env });
    const key = buildRateLimitKey(
      env.RATE_LIMITER_KEY_PREFIX,
      'role',
      'DEFAULT',
      '127.0.0.1',
    );

    expect(key).toMatch(/^spapi:ratelimiter:http:neo:default:[a-f0-9]{64}$/);
    expect(key).not.toContain('127.0.0.1');
    expect(
      buildRateLimitKey('production:limiter', 'role', 'DEFAULT', '127.0.0.1'),
    ).not.toBe(key);
    expect(service.isWhitelisted('127.0.0.1')).toBe(true);
    expect(service.isWhitelisted('::ffff:127.0.0.1')).toBe(true);
    expect(service.isWhitelisted('192.0.2.1')).toBe(false);
  });

  it('内存窗口满载后按分钟摊销清理，并用有界 overflow 保留活跃计数', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const { service } = createService();
    const internal = service as unknown as {
      backend: 'memory';
      cleanMemory(now: number): void;
      memoryOverflowWindows: Map<
        string,
        {
          expiresAt: number;
          generation: string;
          limit: number;
          requestIds: Set<string>;
          requestOwners: Map<string, string>;
        }
      >;
      memoryWindows: Map<
        string,
        {
          expiresAt: number;
          generation: string;
          limit: number;
          requestIds: Set<string>;
          requestOwners: Map<string, string>;
        }
      >;
      redisRetryAfter: number;
    };
    const expiresAt = Date.now() + RATE_LIMIT_WINDOW_MS;
    const generation = String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS));
    for (let index = 0; index < 10_000; index += 1) {
      internal.memoryWindows.set(`existing-${index}`, {
        expiresAt,
        generation,
        limit: ROLE_LIMITS.DEFAULT,
        requestIds: new Set([`existing-request-${index}`]),
        requestOwners: new Map(),
      });
    }
    internal.backend = 'memory';
    internal.redisRetryAfter = expiresAt;
    const clean = vi.spyOn(internal, 'cleanMemory');

    const decisions = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        service.consume({
          clientIdentifier: `new-client-${index}`,
          policy: 'role',
          role: 'DEFAULT',
        }),
      ),
    );
    const revisited = await service.consume({
      clientIdentifier: 'new-client-0',
      policy: 'role',
      role: 'DEFAULT',
    });

    expect(clean).toHaveBeenCalledOnce();
    expect(internal.memoryWindows).toHaveLength(10_000);
    expect(internal.memoryWindows.has('existing-0')).toBe(true);
    expect(internal.memoryOverflowWindows).toHaveLength(1);
    expect(decisions.map(({ count }) => count)).toEqual([1, 2, 3]);
    expect(revisited.count).toBe(4);
    await service.release(decisions[1]!);
    const overflowWindow = [...internal.memoryOverflowWindows.values()][0]!;
    expect([...overflowWindow.requestOwners.values()]).not.toContain(
      decisions[1]!.clientKey,
    );
    expect([...overflowWindow.requestOwners.values()]).toEqual(
      expect.arrayContaining([
        decisions[0]!.clientKey,
        decisions[2]!.clientKey,
      ]),
    );

    internal.memoryWindows.delete('existing-0');
    const returnedToIndependent = await service.consume({
      clientIdentifier: 'new-client-3',
      policy: 'role',
      role: 'DEFAULT',
    });
    expect(returnedToIndependent).toMatchObject({
      count: 1,
      storageKey: returnedToIndependent.clientKey,
    });
    expect(returnedToIndependent.storageKey).not.toBe(decisions[0]!.storageKey);

    internal.memoryWindows.delete('existing-1');
    const existingOverflowClient = await service.consume({
      clientIdentifier: 'new-client-0',
      policy: 'role',
      role: 'DEFAULT',
    });
    expect(existingOverflowClient.storageKey).toBe(decisions[0]!.storageKey);
  });

  it('关闭开关时健康快照明确标记 disabled', () => {
    const env = loadEnv({ ...validEnv, API_RATE_LIMIT_ENABLED: 'false' });
    const logger = loggerMock();
    const { service } = createService({ env, logger });

    expect(service.enabled).toBe(false);
    expect(service.snapshot(true)).toMatchObject({
      status: 'disabled',
      stats: { enabled: false, backend: 'disabled' },
    });
    expect(logger.info).toHaveBeenCalledWith(
      'HTTP API 限流已禁用',
      'RateLimitService',
      { reason: 'configuration' },
    );
  });
});

describe('RateLimitModule wiring', () => {
  it('完整 AppModule 可解析全局 Interceptor 与 HealthService 依赖图', async () => {
    for (const [key, value] of Object.entries({
      ...validEnv,
      LOG_LEVEL: 'ERROR',
      NODE_ENV: 'test',
    })) {
      vi.stubEnv(key, value);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef.get(RateLimitService)).toBeInstanceOf(RateLimitService);
    expect(moduleRef.get(RateLimitRequestHook)).toBeInstanceOf(
      RateLimitRequestHook,
    );
    expect(moduleRef.get(HealthService)).toBeInstanceOf(HealthService);
    await moduleRef.close();
  });
});

@Injectable()
class PrincipalGuard implements CanActivate {
  calls = 0;

  canActivate(context: ExecutionContext): boolean {
    this.calls += 1;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    request.auth = { userId: 'test-user' } as never;
    return true;
  }
}

@Injectable()
class RejectingGuard implements CanActivate {
  calls = 0;

  canActivate(): never {
    this.calls += 1;
    throw new UnauthorizedException({
      success: false,
      errorMessage: '会话不存在或已过期',
      errorCode: 401,
    });
  }
}

@Controller('rate-test')
class RateTestController {
  @Get('anonymous')
  anonymous() {
    return { success: true };
  }

  @Get('authenticated')
  @UseGuards(PrincipalGuard)
  authenticated() {
    return { success: true };
  }

  @Get('strict')
  @StrictRateLimit()
  strict() {
    return { success: true };
  }

  @Get('authenticated-strict')
  @UseGuards(PrincipalGuard)
  @StrictRateLimit()
  authenticatedStrict() {
    return { success: true };
  }

  @Get('rejected')
  @UseGuards(RejectingGuard)
  rejected() {
    return { success: true };
  }
}

@Controller()
class ExcludedRateTestController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('metrics')
  metrics() {
    return 'metrics';
  }
}

describe('RateLimitRequestHook HTTP 边界', () => {
  let app: NestFastifyApplication;
  let errorStats: HealthErrorStatsService;
  let logger: AppLogger;
  let metrics: MetricsService;
  let permissionCache: { getRoles: ReturnType<typeof vi.fn> };
  let redis: ApplicationRedisClient;
  let counters: Map<string, number>;
  let generations: Map<string, string>;
  let memberships: Map<string, Set<string>>;
  let operations: Map<string, Set<string>>;

  async function createApp(env = loadEnv(validEnv)) {
    counters = new Map();
    generations = new Map();
    memberships = new Map();
    operations = new Map();
    logger = loggerMock();
    metrics = new MetricsService();
    metricsToClose.push(metrics);
    permissionCache = { getRoles: vi.fn().mockResolvedValue(['ADMIN']) };
    redis = redisMock();
    const ensureWindow = (key: string, generation: string) => {
      const currentGeneration = generations.get(key);
      if (currentGeneration === generation) return;
      if (currentGeneration !== undefined || !counters.has(key)) {
        counters.delete(key);
      }
      generations.set(key, generation);
      operations.set(key, new Set());
    };
    const addOperation = (
      key: string,
      generation: string,
      requestId: string,
      limit: number,
    ) => {
      ensureWindow(key, generation);
      const applied = operations.get(key)!;
      let count = counters.get(key) ?? 0;
      if (!applied.has(requestId) && count <= limit) {
        applied.add(requestId);
        count += 1;
        counters.set(key, count);
      }
      return count;
    };
    const removeOperation = (
      key: string,
      generation: string,
      requestId: string,
    ) => {
      if (
        generations.get(key) !== generation ||
        !operations.get(key)?.delete(requestId)
      ) {
        return 0;
      }
      const count = Math.max(0, (counters.get(key) ?? 0) - 1);
      if (count === 0) {
        counters.delete(key);
        generations.delete(key);
        operations.delete(key);
      } else {
        counters.set(key, count);
      }
      return 1;
    };
    vi.mocked(redis.eval).mockImplementation(
      async (script, keys: readonly string[], arguments_) => {
        if (keys[0]?.includes(':capability:')) return 1;
        if (script.includes('local requestCount = tonumber(ARGV[4])')) {
          const key = keys[0]!;
          const generation = String(
            Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS),
          );
          const limit = Number(arguments_[2]);
          const requestCount = Number(arguments_[3]);
          let count = counters.get(key) ?? 0;
          for (const requestId of arguments_.slice(4, 4 + requestCount)) {
            count = addOperation(key, generation, String(requestId), limit);
          }
          const memberKeys = arguments_
            .slice(4 + requestCount, 4 + requestCount * 2)
            .map(String)
            .filter(Boolean);
          if (memberKeys.length > 0) {
            const membershipKey = keys[1]!;
            if (generations.get(membershipKey) !== generation) {
              generations.set(membershipKey, generation);
              memberships.set(membershipKey, new Set());
            }
            const members = memberships.get(membershipKey)!;
            for (const memberKey of memberKeys) members.add(memberKey);
          }
          return [count, RATE_LIMIT_WINDOW_MS, generation, key];
        }
        if (script.includes('return released')) {
          const releasedByKey = keys
            .slice(0, 2)
            .map((key) =>
              removeOperation(
                key,
                String(arguments_[0]),
                String(arguments_[1]),
              ),
            );
          if (releasedByKey[1] === 1 && !counters.has(keys[1]!)) {
            generations.delete(keys[2]!);
            memberships.delete(keys[2]!);
          }
          return releasedByKey.reduce((total, released) => total + released, 0);
        }
        if (keys.length === 6) {
          const targetGeneration = String(
            Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS),
          );
          const targetClientKey = keys[2]!;
          const targetOverflowKey = keys[3]!;
          const targetMembershipKey = keys[4]!;
          const targetKey =
            generations.get(targetMembershipKey) === targetGeneration &&
            memberships.get(targetMembershipKey)?.has(targetClientKey)
              ? targetOverflowKey
              : targetClientKey;
          const requestId = String(arguments_[3]);
          const count = addOperation(
            targetKey,
            targetGeneration,
            requestId,
            Number(arguments_[2]),
          );
          let released = 0;
          if (count <= Number(arguments_[2]) && Number(arguments_[5]) !== 0) {
            for (const sourceKey of keys.slice(0, 2)) {
              const removed = removeOperation(
                sourceKey,
                String(arguments_[4]),
                requestId,
              );
              released += removed;
              if (
                sourceKey === keys[1] &&
                removed === 1 &&
                !counters.has(sourceKey)
              ) {
                generations.delete(keys[5]!);
                memberships.delete(keys[5]!);
              }
            }
          }
          return [
            count,
            RATE_LIMIT_WINDOW_MS,
            targetGeneration,
            targetKey,
            released,
          ];
        }
        const key = keys[0]!;
        const overflowKey = keys[1]!;
        const membershipKey = keys[2]!;
        const generation = String(
          Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS),
        );
        if (Number(arguments_[4]) === 1) {
          if (generations.get(membershipKey) !== generation) {
            generations.set(membershipKey, generation);
            memberships.set(membershipKey, new Set());
          }
          memberships.get(membershipKey)!.add(key);
        }
        const selectedKey =
          Number(arguments_[4]) === 1 ||
          (generations.get(membershipKey) === generation &&
            memberships.get(membershipKey)?.has(key))
            ? overflowKey
            : key;
        const count = addOperation(
          selectedKey,
          generation,
          String(arguments_[3]),
          Number(arguments_[2]),
        );
        return [count, RATE_LIMIT_WINDOW_MS, generation, selectedKey];
      },
    );
    errorStats = new HealthErrorStatsService();
    const moduleRef = await Test.createTestingModule({
      controllers: [RateTestController, ExcludedRateTestController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: ApplicationRedisClient, useValue: redis },
        { provide: AppLogger, useValue: logger },
        { provide: MetricsService, useValue: metrics },
        { provide: PermissionCacheService, useValue: permissionCache },
        Reflector,
        PrincipalGuard,
        RejectingGuard,
        RateLimitService,
        RateLimitRequestHook,
        {
          provide: APP_INTERCEPTOR,
          useClass: RateLimitInterceptor,
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    configureHttpApp(app, {
      logger,
      errorStats,
      metrics,
      rateLimit: moduleRef.get(RateLimitRequestHook),
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  beforeEach(async () => {
    await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('overflow 总数只作用于已登记成员，独立客户端仍使用自己的窗口', async () => {
    const service = app.get(RateLimitService);
    const input = {
      clientIdentifier: '127.0.0.1',
      policy: 'role' as const,
      role: 'DEFAULT' as const,
    };
    const clientKey = buildRateLimitKey(
      rateLimitPrefix,
      input.policy,
      input.role,
      input.clientIdentifier,
    );
    const overflowKey = `${rateLimitPrefix}:http:neo:overflow:default`;
    const membershipKey = `${overflowKey}:clients`;
    const generation = String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS));
    counters.set(overflowKey, ROLE_LIMITS.DEFAULT + 1);
    generations.set(overflowKey, generation);
    operations.set(overflowKey, new Set());

    const independent = await service.consume(input);
    expect(independent).toMatchObject({
      allowed: true,
      count: 1,
      storageKey: clientKey,
    });
    await service.release(independent);

    generations.set(membershipKey, generation);
    memberships.set(membershipKey, new Set([clientKey]));
    await expect(service.consume(input)).resolves.toMatchObject({
      allowed: false,
      count: ROLE_LIMITS.DEFAULT + 1,
      storageKey: overflowKey,
    });
  });

  it('Guard 成功后释放 DEFAULT 预占并改计认证角色，strict 再附加独立策略', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    const authenticated = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated',
      headers: { authorization: 'Bearer signed-test-token' },
    });
    const strict = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/strict',
    });

    expect(authenticated.headers['ratelimit-limit']).toBe('1000');
    expect(permissionCache.getRoles).toHaveBeenCalledWith('test-user');
    expect(strict.headers['ratelimit-limit']).toBe('20');
    expect(strict.headers['ratelimit-policy']).toBe('20;w=900');
    expect(app.get(RateLimitService).snapshot(true).stats).toMatchObject({
      totalRequests: 2,
      byRole: {
        ADMIN: { requests: 1 },
        DEFAULT: { requests: 1 },
      },
    });
    expect(await metrics.render()).toContain(
      'amazon_asin_monitor_http_rate_limit_decisions_total{role="DEFAULT",policy="strict",outcome="allowed",backend="redis"} 1',
    );
  });

  it('角色查询失败安全回退 DEFAULT 且日志不包含身份信息', async () => {
    permissionCache.getRoles.mockRejectedValueOnce(new Error('private user'));
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/rate-test/authenticated',
        headers: { authorization: 'Bearer signed-test-token' },
      });

    expect(response.statusCode).toBe(200);
    expect(response.headers['ratelimit-limit']).toBe('100');
    expect(logger.warn).toHaveBeenCalledWith(
      'HTTP 限流角色读取失败，使用默认配额',
      'RateLimitInterceptor',
      { reason: 'role_lookup_failed' },
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      'private user',
    );
  });

  it('角色查询未完成前持续持有 DEFAULT 预占，阻止并发绕过权限存储保护', async () => {
    const key = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'DEFAULT',
      '127.0.0.1',
    );
    counters.set(key, ROLE_LIMITS.DEFAULT - 1);
    let finishRoleLookup!: (roles: string[]) => void;
    permissionCache.getRoles.mockImplementationOnce(
      () => new Promise((resolve) => (finishRoleLookup = resolve)),
    );
    const fastify = app.getHttpAdapter().getInstance();

    const first = fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated',
    });
    await vi.waitFor(() => expect(permissionCache.getRoles).toHaveBeenCalled());
    const concurrent = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated',
    });

    expect(concurrent.statusCode).toBe(429);
    finishRoleLookup(['ADMIN']);
    const completed = await first;
    expect(completed.statusCode).toBe(200);
    expect(completed.headers['ratelimit-limit']).toBe('1000');
    expect(counters.get(key)).toBe(ROLE_LIMITS.DEFAULT);
  });

  it('认证角色桶拒绝时保留 DEFAULT 预占，使后续请求在 Guard 前阻断', async () => {
    const defaultKey = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'DEFAULT',
      '127.0.0.1',
    );
    const adminKey = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'ADMIN',
      '127.0.0.1',
    );
    counters.set(defaultKey, ROLE_LIMITS.DEFAULT - 1);
    counters.set(adminKey, ROLE_LIMITS.ADMIN);
    const fastify = app.getHttpAdapter().getInstance();
    const principalGuard = app.get(PrincipalGuard);

    const roleBlocked = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated',
    });
    const blockedBeforeGuard = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated',
    });

    expect(roleBlocked.statusCode).toBe(429);
    expect(roleBlocked.headers['ratelimit-limit']).toBe('1000');
    expect(blockedBeforeGuard.statusCode).toBe(429);
    expect(blockedBeforeGuard.headers['ratelimit-limit']).toBe('100');
    expect(principalGuard.calls).toBe(1);
    expect(permissionCache.getRoles).toHaveBeenCalledOnce();
    expect(counters.get(defaultKey)).toBe(ROLE_LIMITS.DEFAULT + 1);
    expect(app.get(RateLimitService).snapshot(true).stats).toMatchObject({
      totalRequests: 2,
      blockedRequests: 2,
      byRole: {
        ADMIN: { requests: 1, blocked: 1 },
        DEFAULT: { requests: 1, blocked: 1 },
      },
    });
  });

  it('strict 附加桶阻断时健康统计只记录一次请求，桶指标分别保留', async () => {
    const strictKey = buildRateLimitKey(
      rateLimitPrefix,
      'strict',
      'DEFAULT',
      '127.0.0.1',
    );
    counters.set(strictKey, STRICT_RATE_LIMIT);

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/rate-test/strict',
    });

    expect(response.statusCode).toBe(429);
    expect(app.get(RateLimitService).snapshot(true).stats).toMatchObject({
      totalRequests: 1,
      blockedRequests: 1,
      byRole: { DEFAULT: { requests: 1, blocked: 1 } },
    });
    const rendered = await metrics.render();
    expect(rendered).toContain(
      'amazon_asin_monitor_http_rate_limit_decisions_total{role="DEFAULT",policy="role",outcome="allowed",backend="redis"} 1',
    );
    expect(rendered).toContain(
      'amazon_asin_monitor_http_rate_limit_decisions_total{role="DEFAULT",policy="strict",outcome="blocked",backend="redis"} 1',
    );
  });

  it('认证 strict 请求通过附加桶后才释放 DEFAULT 预占', async () => {
    const defaultKey = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'DEFAULT',
      '127.0.0.1',
    );
    const adminKey = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'ADMIN',
      '127.0.0.1',
    );
    const strictKey = buildRateLimitKey(
      rateLimitPrefix,
      'strict',
      'ADMIN',
      '127.0.0.1',
    );
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated-strict',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['ratelimit-limit']).toBe('20');
    expect(counters.has(defaultKey)).toBe(false);
    expect(app.get(PrincipalGuard).calls).toBe(1);
    const transferCalls = vi
      .mocked(redis.eval)
      .mock.calls.filter(([, keys]) => keys.length === 6);
    expect(transferCalls).toHaveLength(2);
    expect(transferCalls[0]![1][2]).toBe(adminKey);
    expect(transferCalls[0]![2][5]).toBe(0);
    expect(transferCalls[1]![1][2]).toBe(strictKey);
    expect(transferCalls[1]![2][5]).toBe(1);
    expect(
      vi
        .mocked(redis.eval)
        .mock.calls.some(([script]) => script.includes('return released')),
    ).toBe(false);
  });

  it('认证 strict 的角色转移先失败时仍在恢复后释放 DEFAULT 预占', async () => {
    const defaultKey = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'DEFAULT',
      '127.0.0.1',
    );
    const strictKey = buildRateLimitKey(
      rateLimitPrefix,
      'strict',
      'ADMIN',
      '127.0.0.1',
    );
    const evalMock = vi.mocked(redis.eval);
    const defaultImplementation = evalMock.getMockImplementation()!;
    evalMock
      .mockImplementationOnce(defaultImplementation)
      .mockRejectedValueOnce(new Error('role transfer unavailable'));

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated-strict',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['ratelimit-limit']).toBe('20');
    expect(counters.get(defaultKey)).toBe(1);
    expect(counters.has(strictKey)).toBe(false);
    const service = app.get(RateLimitService);
    expect(service.snapshot(true).status).toBe('degraded');

    (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;
    await service.recover(true);

    expect(service.snapshot(true).status).toBe('ok');
    expect(counters.has(defaultKey)).toBe(false);
    expect(counters.get(strictKey)).toBe(1);
  });

  it('认证 strict 的 DEFAULT 写入响应不确定时恢复后不会泄漏预占', async () => {
    const defaultKey = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'DEFAULT',
      '127.0.0.1',
    );
    const strictKey = buildRateLimitKey(
      rateLimitPrefix,
      'strict',
      'ADMIN',
      '127.0.0.1',
    );
    const evalMock = vi.mocked(redis.eval);
    const defaultImplementation = evalMock.getMockImplementation()!;
    evalMock.mockImplementationOnce(async (...arguments_) => {
      await defaultImplementation(...arguments_);
      throw new Error('DEFAULT consume response timeout');
    });

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated-strict',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['ratelimit-limit']).toBe('20');
    expect(counters.get(defaultKey)).toBe(1);
    expect(counters.has(strictKey)).toBe(false);
    const service = app.get(RateLimitService);
    expect(service.snapshot(true).status).toBe('degraded');

    (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;
    await service.recover(true);

    expect(service.snapshot(true).status).toBe('ok');
    expect(counters.has(defaultKey)).toBe(false);
    expect(counters.get(strictKey)).toBe(1);
  });

  it('认证 strict 拒绝时保留 DEFAULT 预占，使后续请求在 Guard 前阻断', async () => {
    const defaultKey = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'DEFAULT',
      '127.0.0.1',
    );
    const strictKey = buildRateLimitKey(
      rateLimitPrefix,
      'strict',
      'ADMIN',
      '127.0.0.1',
    );
    counters.set(defaultKey, ROLE_LIMITS.DEFAULT - 1);
    counters.set(strictKey, STRICT_RATE_LIMIT);
    const fastify = app.getHttpAdapter().getInstance();
    const principalGuard = app.get(PrincipalGuard);

    const strictBlocked = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated-strict',
    });
    const blockedBeforeGuard = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/authenticated-strict',
    });

    expect(strictBlocked.statusCode).toBe(429);
    expect(strictBlocked.headers['ratelimit-limit']).toBe('20');
    expect(blockedBeforeGuard.statusCode).toBe(429);
    expect(blockedBeforeGuard.headers['ratelimit-limit']).toBe('100');
    expect(principalGuard.calls).toBe(1);
    expect(permissionCache.getRoles).toHaveBeenCalledOnce();
    expect(counters.get(defaultKey)).toBe(ROLE_LIMITS.DEFAULT + 1);
  });

  it('撤销会话的 Guard 拒绝与未匹配 API 均保留 DEFAULT 预占，并在下一请求提前 429', async () => {
    const clientIdentifier = '127.0.0.1';
    const key = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'DEFAULT',
      clientIdentifier,
    );
    counters.set(key, ROLE_LIMITS.DEFAULT - 1);
    const fastify = app.getHttpAdapter().getInstance();
    const rejectingGuard = app.get(RejectingGuard);

    const rejected = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/rejected',
      headers: { authorization: 'Bearer correctly-signed-revoked-token' },
    });
    const blockedBeforeGuard = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rate-test/rejected',
      headers: { authorization: 'Bearer correctly-signed-revoked-token' },
    });

    expect(rejected.statusCode).toBe(401);
    expect(blockedBeforeGuard.statusCode).toBe(429);
    expect(rejectingGuard.calls).toBe(1);
    expect(permissionCache.getRoles).not.toHaveBeenCalled();

    counters.set(key, ROLE_LIMITS.DEFAULT - 1);
    const missing = await fastify.inject({
      method: 'GET',
      url: '/api/v1/missing-route',
    });
    const blockedBeforeRouting = await fastify.inject({
      method: 'GET',
      url: '/api/v1/missing-route',
    });
    expect(missing.statusCode).toBe(404);
    expect(blockedBeforeRouting.statusCode).toBe(429);
  });

  it('第 101 个匿名请求返回 legacy 429 信封、标准 headers 与错误统计', async () => {
    const key = buildRateLimitKey(
      rateLimitPrefix,
      'role',
      'DEFAULT',
      '127.0.0.1',
    );
    counters.set(key, ROLE_LIMITS.DEFAULT);
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/rate-test/anonymous',
        headers: { origin: 'http://localhost:8000' },
      });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      success: false,
      errorMessage: '请求过于频繁，请稍后再试',
      errorCode: 429,
    });
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': 'http://localhost:8000',
      'ratelimit-limit': '100',
      'ratelimit-remaining': '0',
      'ratelimit-reset': '900',
      'retry-after': '900',
    });
    expect(errorStats.snapshot()).toMatchObject({
      recent: { count: 1, byType: { RATE_LIMIT: 1 } },
    });
    expect(await metrics.render()).toContain(
      'amazon_asin_monitor_http_requests_total{method="GET",route="/api/v1/rate-test/anonymous",status="429"} 1',
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      '127.0.0.1',
    );
  });

  it('GET/HEAD health、metrics、OPTIONS、关闭开关与白名单绕过计数', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    await fastify.inject({ method: 'GET', url: '/health' });
    await fastify.inject({ method: 'GET', url: '/metrics' });
    await fastify.inject({ method: 'HEAD', url: '/api/v1/health' });
    await fastify.inject({
      method: 'OPTIONS',
      url: '/api/v1/rate-test/anonymous',
    });
    expect(redis.eval).not.toHaveBeenCalled();

    const unsupportedHealthMethod = await fastify.inject({
      method: 'POST',
      url: '/api/v1/health',
    });
    expect(unsupportedHealthMethod.statusCode).toBe(404);
    expect(unsupportedHealthMethod.headers['ratelimit-limit']).toBe('100');
    expect(redis.eval).toHaveBeenCalledOnce();

    await app.close();
    await createApp(
      loadEnv({
        ...validEnv,
        RATE_LIMIT_WHITELIST_IPS: '127.0.0.1',
      }),
    );
    const whitelisted = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/rate-test/anonymous',
    });
    expect(whitelisted.headers['ratelimit-limit']).toBeUndefined();
    expect(redis.eval).not.toHaveBeenCalled();

    await app.close();
    await createApp(loadEnv({ ...validEnv, API_RATE_LIMIT_ENABLED: 'false' }));
    await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/rate-test/anonymous',
    });
    expect(redis.eval).not.toHaveBeenCalled();
  });
});

describe.skipIf(!integrationEnabled)(
  'RateLimitService Redis integration',
  () => {
    it('两个实例共享计数，generation 保护释放并支持原子角色转移', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metricsA = new MetricsService();
      const metricsB = new MetricsService();
      const serviceA = new RateLimitService(env, redis, logger, metricsA);
      const serviceB = new RateLimitService(env, redis, logger, metricsB);
      const remainingInWindow =
        RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
      if (remainingInWindow < 2_000) {
        await new Promise((resolve) =>
          setTimeout(resolve, remainingInWindow + 100),
        );
      }
      const clientIdentifier = `integration-${process.pid}-${Date.now()}`;
      const key = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'strict',
        'DEFAULT',
        clientIdentifier,
      );
      const defaultKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        clientIdentifier,
      );
      const adminKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'ADMIN',
        clientIdentifier,
      );
      const overflowKeys = ['strict', 'default', 'admin'].map(
        (bucket) =>
          `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:${bucket}`,
      );
      const overflowMembershipKeys = overflowKeys.map(
        (key) => `${key}:clients`,
      );
      try {
        await serviceA.recover(true);
        expect(serviceA.snapshot(true).status).toBe('ok');
        await redis.del(
          key,
          defaultKey,
          adminKey,
          ...overflowKeys,
          ...overflowMembershipKeys,
        );
        const first = await serviceA.consume({
          clientIdentifier,
          policy: 'strict',
          role: 'DEFAULT',
        });
        const firstTtl = await redis.client.pttl(key);
        const second = await serviceB.consume({
          clientIdentifier,
          policy: 'strict',
          role: 'DEFAULT',
        });
        const secondTtl = await redis.client.pttl(key);

        expect(first).toMatchObject({ backend: 'redis', count: 1 });
        expect(second).toMatchObject({ backend: 'redis', count: 2 });
        expect(firstTtl).toBeGreaterThan(0);
        expect(firstTtl).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS);
        expect(secondTtl).toBeGreaterThan(0);
        expect(secondTtl).toBeLessThanOrEqual(firstTtl);

        await serviceA.release(first);
        expect((await redis.client.hlen(key)) - 1).toBe(1);
        await serviceB.release(second);
        expect(await redis.client.exists(key)).toBe(0);

        const stale = await serviceA.consume({
          clientIdentifier,
          policy: 'strict',
          role: 'DEFAULT',
        });
        await redis.del(key);
        await redis.client.hset(
          key,
          'generation',
          'replacement-window',
          'request:replacement',
          1,
        );
        await redis.client.pexpire(key, RATE_LIMIT_WINDOW_MS);
        await serviceA.release(stale);
        expect((await redis.client.hlen(key)) - 1).toBe(1);

        const provisional = await serviceA.consume(
          {
            clientIdentifier,
            policy: 'role',
            role: 'DEFAULT',
          },
          { recordRequest: false },
        );
        const transferred = await serviceA.transfer(provisional, {
          clientIdentifier,
          policy: 'role',
          role: 'ADMIN',
        });
        expect(transferred).toMatchObject({
          backend: 'redis',
          count: 1,
          role: 'ADMIN',
        });
        expect(await redis.client.exists(defaultKey)).toBe(0);
        expect((await redis.client.hlen(adminKey)) - 1).toBe(1);
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(
            key,
            defaultKey,
            adminKey,
            ...overflowKeys,
            ...overflowMembershipKeys,
          );
        }
        if (redis.client.status !== 'end') redis.onModuleDestroy();
        metricsA.onModuleDestroy();
        metricsB.onModuleDestroy();
      }
    }, 30_000);

    it('实例时钟跨窗偏差仍复用 Redis TIME 对齐的同一代计数', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metricsA = new MetricsService();
      const metricsB = new MetricsService();
      const serviceA = new RateLimitService(env, redis, logger, metricsA);
      const serviceB = new RateLimitService(env, redis, logger, metricsB);
      const remainingInWindow =
        RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
      if (remainingInWindow < 2_000) {
        await new Promise((resolve) =>
          setTimeout(resolve, remainingInWindow + 100),
        );
      }
      const redisAlignedNow = Date.now();
      const clientIdentifier = `clock-skew-${process.pid}-${redisAlignedNow}`;
      const key = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        clientIdentifier,
      );
      const overflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const membershipKey = `${overflowKey}:clients`;
      const now = vi.spyOn(Date, 'now');
      try {
        await redis.del(key, overflowKey, membershipKey);
        now.mockReturnValue(redisAlignedNow - RATE_LIMIT_WINDOW_MS);
        const behind = await serviceA.consume({
          clientIdentifier,
          policy: 'role',
          role: 'DEFAULT',
        });
        now.mockReturnValue(redisAlignedNow + RATE_LIMIT_WINDOW_MS);
        const ahead = await serviceB.consume({
          clientIdentifier,
          policy: 'role',
          role: 'DEFAULT',
        });

        expect(behind).toMatchObject({ backend: 'redis', count: 1 });
        expect(ahead).toMatchObject({ backend: 'redis', count: 2 });
        expect(ahead.generation).toBe(behind.generation);
        expect(await redis.client.hget(key, 'generation')).toBe(
          behind.generation,
        );
        expect(await redis.client.pttl(key)).toBeGreaterThan(0);
      } finally {
        now.mockRestore();
        if (redis.client.status !== 'end') {
          await redis.del(key, overflowKey, membershipKey);
          redis.onModuleDestroy();
        }
        metricsA.onModuleDestroy();
        metricsB.onModuleDestroy();
      }
    }, 30_000);

    it('落后主机观测 Redis 偏移后跨本地边界仍保持服务端活动窗口', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metricsA = new MetricsService();
      const metricsB = new MetricsService();
      const serviceA = new RateLimitService(env, redis, logger, metricsA);
      const serviceB = new RateLimitService(env, redis, logger, metricsB);
      const remainingInWindow =
        RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
      if (remainingInWindow < 2_000) {
        await new Promise((resolve) =>
          setTimeout(resolve, remainingInWindow + 100),
        );
      }
      const redisAlignedNow = Date.now();
      const redisWindowStart =
        Math.floor(redisAlignedNow / RATE_LIMIT_WINDOW_MS) *
        RATE_LIMIT_WINDOW_MS;
      const clientIdentifier = `clock-skew-fallback-${process.pid}-${redisAlignedNow}`;
      const key = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        clientIdentifier,
      );
      const overflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const membershipKey = `${overflowKey}:clients`;
      const now = vi.spyOn(Date, 'now');
      try {
        await redis.del(key, overflowKey, membershipKey);
        now.mockReturnValue(redisWindowStart - 1);
        await serviceA.recover(true);
        expect(serviceA.snapshot(true).status).toBe('ok');
        const originalEval = redis.eval.bind(redis);
        vi.spyOn(redis, 'eval').mockImplementationOnce(
          async (...arguments_) => {
            await originalEval(...arguments_);
            throw new Error('simulated response timeout before local rollover');
          },
        );
        const beforeRollover = await serviceA.consume({
          clientIdentifier,
          policy: 'role',
          role: 'DEFAULT',
        });
        expect(beforeRollover).toMatchObject({
          backend: 'memory',
          count: 1,
          uncertainRedisReservation: true,
        });
        expect((await redis.client.hlen(key)) - 1).toBe(1);

        now.mockReturnValue(redisWindowStart + 1);
        const afterRollover = await serviceA.consume({
          clientIdentifier,
          policy: 'role',
          role: 'DEFAULT',
        });
        expect(afterRollover).toMatchObject({ backend: 'memory', count: 2 });
        expect(afterRollover.generation).toBe(beforeRollover.generation);

        (
          serviceA as unknown as { redisRetryAfter: number }
        ).redisRetryAfter = 0;
        await serviceA.recover(true);

        expect(serviceA.snapshot(true).status).toBe('ok');
        expect((await redis.client.hlen(key)) - 1).toBe(2);
        await expect(
          serviceB.consume({
            clientIdentifier,
            policy: 'role',
            role: 'DEFAULT',
          }),
        ).resolves.toMatchObject({ backend: 'redis', count: 3 });
      } finally {
        now.mockRestore();
        if (redis.client.status !== 'end') {
          await redis.del(key, overflowKey, membershipKey);
          redis.onModuleDestroy();
        }
        metricsA.onModuleDestroy();
        metricsB.onModuleDestroy();
      }
    }, 30_000);

    it('落后窗口的降级预占仍合并到 Redis 当前代并可释放或转移', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metrics = new MetricsService();
      const service = new RateLimitService(env, redis, logger, metrics);
      const remainingInWindow =
        RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
      if (remainingInWindow < 2_000) {
        await new Promise((resolve) =>
          setTimeout(resolve, remainingInWindow + 100),
        );
      }
      const redisAlignedNow = Date.now();
      const releaseIdentifier = `lagging-release-${process.pid}-${redisAlignedNow}`;
      const transferIdentifier = `lagging-transfer-${process.pid}-${redisAlignedNow}`;
      const releaseKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        releaseIdentifier,
      );
      const transferKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        transferIdentifier,
      );
      const adminKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'ADMIN',
        transferIdentifier,
      );
      const defaultOverflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const adminOverflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:admin`;
      const cleanupKeys = [
        releaseKey,
        transferKey,
        adminKey,
        defaultOverflowKey,
        `${defaultOverflowKey}:clients`,
        adminOverflowKey,
        `${adminOverflowKey}:clients`,
      ];
      const internal = service as unknown as {
        backend: 'memory';
        redisRetryAfter: number;
      };
      const now = vi
        .spyOn(Date, 'now')
        .mockReturnValue(redisAlignedNow - RATE_LIMIT_WINDOW_MS);
      try {
        await redis.del(...cleanupKeys);
        internal.backend = 'memory';
        internal.redisRetryAfter = Number.MAX_SAFE_INTEGER;
        const releasable = await service.consume({
          clientIdentifier: releaseIdentifier,
          policy: 'role',
          role: 'DEFAULT',
        });
        const transferable = await service.consume({
          clientIdentifier: transferIdentifier,
          policy: 'role',
          role: 'DEFAULT',
        });
        expect(releasable).toMatchObject({ backend: 'memory', count: 1 });
        expect(transferable.generation).toBe(releasable.generation);

        internal.redisRetryAfter = 0;
        await service.recover(true);

        expect(service.snapshot(true).status).toBe('ok');
        expect(await redis.client.hget(releaseKey, 'generation')).not.toBe(
          releasable.generation,
        );
        expect((await redis.client.hlen(releaseKey)) - 1).toBe(1);
        expect((await redis.client.hlen(transferKey)) - 1).toBe(1);

        await service.release(releasable);
        expect(await redis.client.exists(releaseKey)).toBe(0);
        await expect(
          service.transfer(transferable, {
            clientIdentifier: transferIdentifier,
            policy: 'role',
            role: 'ADMIN',
          }),
        ).resolves.toMatchObject({ allowed: true, role: 'ADMIN' });
        expect(await redis.client.exists(transferKey)).toBe(0);
        expect((await redis.client.hlen(adminKey)) - 1).toBe(1);
      } finally {
        now.mockRestore();
        if (redis.client.status !== 'end') {
          await redis.del(...cleanupKeys);
          redis.onModuleDestroy();
        }
        metrics.onModuleDestroy();
      }
    }, 30_000);

    it('恢复代际锚点阻止冻结快照跨边界进入下一个 Redis 窗口', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metrics = new MetricsService();
      const service = new RateLimitService(env, redis, logger, metrics);
      const clientIdentifier = `recovery-anchor-${process.pid}-${Date.now()}`;
      const input = {
        clientIdentifier,
        policy: 'role' as const,
        role: 'DEFAULT' as const,
      };
      const key = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        input.policy,
        input.role,
        clientIdentifier,
      );
      const overflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const cleanupKeys = [key, overflowKey, `${overflowKey}:clients`];
      const internal = service as unknown as {
        backend: 'memory';
        redisRetryAfter: number;
      };
      try {
        await redis.del(...cleanupKeys);
        internal.backend = 'memory';
        internal.redisRetryAfter = Number.MAX_SAFE_INTEGER;
        await expect(service.consume(input)).resolves.toMatchObject({
          backend: 'memory',
          count: 1,
        });

        const originalEval = redis.eval.bind(redis);
        const evalSpy = vi
          .spyOn(redis, 'eval')
          .mockImplementationOnce(async (...arguments_) => {
            const observed = (await originalEval(...arguments_)) as [
              unknown,
              unknown,
            ];
            return [String(Number(observed[0]) - 1), observed[1]];
          });
        internal.redisRetryAfter = 0;
        await service.recover(true);

        expect(service.snapshot(true).status).toBe('ok');
        expect(await redis.client.exists(key)).toBe(0);
        const [reconcileScript, , reconcileArguments] = evalSpy.mock.calls[1]!;
        expect(reconcileScript).toContain(
          'currentGeneration ~= recoveryGeneration',
        );
        expect(reconcileArguments.at(-2)).toMatch(/^\d+$/);
        await expect(service.consume(input)).resolves.toMatchObject({
          backend: 'redis',
          count: 1,
        });
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(...cleanupKeys);
          redis.onModuleDestroy();
        }
        metrics.onModuleDestroy();
      }
    }, 30_000);

    it('strict Redis 转移未执行时在恢复对账后重试 DEFAULT 来源释放', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metrics = new MetricsService();
      const service = new RateLimitService(env, redis, logger, metrics);
      const clientIdentifier = `strict-release-${process.pid}-${Date.now()}`;
      const defaultKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        clientIdentifier,
      );
      const strictKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'strict',
        'ADMIN',
        clientIdentifier,
      );
      const defaultOverflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const strictOverflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:strict`;
      const cleanupKeys = [
        defaultKey,
        strictKey,
        defaultOverflowKey,
        `${defaultOverflowKey}:clients`,
        strictOverflowKey,
        `${strictOverflowKey}:clients`,
      ];
      try {
        await redis.del(...cleanupKeys);
        const source = await service.consume(
          {
            clientIdentifier,
            policy: 'role',
            role: 'DEFAULT',
          },
          { recordRequest: false },
        );
        vi.spyOn(redis, 'eval').mockRejectedValueOnce(
          new Error('simulated transfer connection failure'),
        );
        const fallback = await service.transfer(
          source,
          {
            clientIdentifier,
            policy: 'strict',
            role: 'ADMIN',
          },
          { fallbackToTargetMemory: true },
        );
        expect(fallback).toMatchObject({
          allowed: true,
          backend: 'memory',
          policy: 'strict',
        });
        expect((await redis.client.hlen(defaultKey)) - 1).toBe(1);
        expect(await redis.client.exists(strictKey)).toBe(0);

        (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;
        await service.recover(true);

        expect(service.snapshot(true).status).toBe('ok');
        expect(await redis.client.exists(defaultKey)).toBe(0);
        expect((await redis.client.hlen(strictKey)) - 1).toBe(1);
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(...cleanupKeys);
          redis.onModuleDestroy();
        }
        metrics.onModuleDestroy();
      }
    }, 30_000);

    it('不确定 DEFAULT Redis 写入转入 strict 后在恢复时释放来源', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metrics = new MetricsService();
      const service = new RateLimitService(env, redis, logger, metrics);
      const clientIdentifier = `strict-ambiguous-${process.pid}-${Date.now()}`;
      const defaultKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        clientIdentifier,
      );
      const strictKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'strict',
        'ADMIN',
        clientIdentifier,
      );
      const defaultOverflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const strictOverflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:strict`;
      const cleanupKeys = [
        defaultKey,
        strictKey,
        defaultOverflowKey,
        `${defaultOverflowKey}:clients`,
        strictOverflowKey,
        `${strictOverflowKey}:clients`,
      ];
      try {
        await redis.del(...cleanupKeys);
        const originalEval = redis.eval.bind(redis);
        vi.spyOn(redis, 'eval').mockImplementationOnce(
          async (...arguments_) => {
            await originalEval(...arguments_);
            throw new Error('simulated DEFAULT response timeout');
          },
        );
        const source = await service.consume(
          {
            clientIdentifier,
            policy: 'role',
            role: 'DEFAULT',
          },
          { recordRequest: false },
        );
        const fallback = await service.transfer(
          source,
          {
            clientIdentifier,
            policy: 'strict',
            role: 'ADMIN',
          },
          { fallbackToTargetMemory: true },
        );

        expect(source).toMatchObject({
          backend: 'memory',
          uncertainRedisReservation: true,
        });
        expect(fallback).toMatchObject({
          allowed: true,
          backend: 'memory',
          policy: 'strict',
        });
        expect((await redis.client.hlen(defaultKey)) - 1).toBe(1);
        expect(await redis.client.exists(strictKey)).toBe(0);

        (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;
        await service.recover(true);

        expect(service.snapshot(true).status).toBe('ok');
        expect(await redis.client.exists(defaultKey)).toBe(0);
        expect((await redis.client.hlen(strictKey)) - 1).toBe(1);
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(...cleanupKeys);
          redis.onModuleDestroy();
        }
        metrics.onModuleDestroy();
      }
    }, 30_000);

    it('不确定的 overflow Redis 写入恢复时不会再计入独立窗口', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metricsA = new MetricsService();
      const metricsB = new MetricsService();
      const serviceA = new RateLimitService(env, redis, logger, metricsA);
      const serviceB = new RateLimitService(env, redis, logger, metricsB);
      const remainingInWindow =
        RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
      if (remainingInWindow < 2_000) {
        await new Promise((resolve) =>
          setTimeout(resolve, remainingInWindow + 100),
        );
      }
      const generation = String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS));
      const expiresAt = (Number(generation) + 1) * RATE_LIMIT_WINDOW_MS;
      const clientIdentifier = `ambiguous-overflow-${
        process.pid
      }-${Date.now()}`;
      const clientKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        clientIdentifier,
      );
      const overflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const membershipKey = `${overflowKey}:clients`;
      try {
        await redis.del(clientKey, overflowKey, membershipKey);
        await redis.client.hset(
          overflowKey,
          'generation',
          generation,
          'request:existing-overflow',
          clientKey,
        );
        await redis.client.hset(
          membershipKey,
          'generation',
          generation,
          clientKey,
          1,
        );
        await redis.client.pexpireat(overflowKey, expiresAt);
        await redis.client.pexpireat(membershipKey, expiresAt);
        const originalEval = redis.eval.bind(redis);
        vi.spyOn(redis, 'eval').mockImplementationOnce(
          async (...arguments_) => {
            await originalEval(...arguments_);
            throw new Error('simulated overflow response timeout');
          },
        );
        const input = {
          clientIdentifier,
          policy: 'role' as const,
          role: 'DEFAULT' as const,
        };
        const ambiguous = await serviceA.consume(input);
        expect(ambiguous).toMatchObject({
          backend: 'memory',
          count: 1,
          storageKey: clientKey,
          uncertainRedisReservation: true,
        });
        expect(
          await redis.client.hget(
            overflowKey,
            `request:${ambiguous.requestId}`,
          ),
        ).toBe(clientKey);

        (
          serviceA as unknown as { redisRetryAfter: number }
        ).redisRetryAfter = 0;
        await serviceA.recover(true);

        expect((await redis.client.hlen(clientKey)) - 1).toBe(0);
        expect((await redis.client.hlen(overflowKey)) - 1).toBe(2);
        expect(await redis.client.hget(membershipKey, clientKey)).toBe('2');
        await expect(serviceB.consume(input)).resolves.toMatchObject({
          backend: 'redis',
          count: 3,
          storageKey: overflowKey,
        });
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(clientKey, overflowKey, membershipKey);
          redis.onModuleDestroy();
        }
        metricsA.onModuleDestroy();
        metricsB.onModuleDestroy();
      }
    }, 30_000);

    it('恢复后的 overflow 成员继续叠加故障前独立 Redis 计数', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metricsA = new MetricsService();
      const metricsB = new MetricsService();
      const serviceA = new RateLimitService(env, redis, logger, metricsA);
      const serviceB = new RateLimitService(env, redis, logger, metricsB);
      const generation = String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS));
      const expiresAt = (Number(generation) + 1) * RATE_LIMIT_WINDOW_MS;
      const clientIdentifier = `overflow-existing-${process.pid}-${Date.now()}`;
      const clientKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        clientIdentifier,
      );
      const overflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const membershipKey = `${overflowKey}:clients`;
      const duplicatedRequestId = 'pre-outage-0';
      const fallbackRequestId = `fallback-overflow-${process.pid}`;
      const internal = serviceA as unknown as {
        backend: 'memory';
        memoryOverflowWindows: Map<
          string,
          {
            expiresAt: number;
            generation: string;
            limit: number;
            requestIds: Set<string>;
            requestOwners: Map<string, string>;
          }
        >;
        redisRetryAfter: number;
      };
      try {
        await redis.del(clientKey, overflowKey, membershipKey);
        const existingFields = Array.from(
          { length: ROLE_LIMITS.DEFAULT - 1 },
          (_, index) => [`request:pre-outage-${index}`, 1] as const,
        ).flat();
        await redis.client.hset(
          clientKey,
          'generation',
          generation,
          ...existingFields,
        );
        await redis.client.pexpireat(clientKey, expiresAt);
        internal.backend = 'memory';
        internal.redisRetryAfter = 0;
        internal.memoryOverflowWindows.set(overflowKey, {
          expiresAt,
          generation,
          limit: ROLE_LIMITS.DEFAULT,
          requestIds: new Set([duplicatedRequestId, fallbackRequestId]),
          requestOwners: new Map([
            [duplicatedRequestId, clientKey],
            [fallbackRequestId, clientKey],
          ]),
        });

        await serviceA.recover(true);

        expect((await redis.client.hlen(clientKey)) - 1).toBe(
          ROLE_LIMITS.DEFAULT - 1,
        );
        expect((await redis.client.hlen(overflowKey)) - 1).toBe(1);
        expect(await redis.client.hget(membershipKey, clientKey)).toBe('1');
        await expect(
          serviceB.consume({
            clientIdentifier,
            policy: 'role',
            role: 'DEFAULT',
          }),
        ).resolves.toMatchObject({
          allowed: false,
          count: ROLE_LIMITS.DEFAULT + 1,
          storageKey: overflowKey,
        });
        expect(await redis.client.hget(membershipKey, clientKey)).toBe('2');
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(clientKey, overflowKey, membershipKey);
          redis.onModuleDestroy();
        }
        metricsA.onModuleDestroy();
        metricsB.onModuleDestroy();
      }
    }, 30_000);

    it('真实 Redis 仅让已迁移成员继承 overflow 计数', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metricsA = new MetricsService();
      const metricsB = new MetricsService();
      const serviceA = new RateLimitService(env, redis, logger, metricsA);
      const serviceB = new RateLimitService(env, redis, logger, metricsB);
      const generation = String(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS));
      const expiresAt = (Number(generation) + 1) * RATE_LIMIT_WINDOW_MS;
      const memberIdentifier = `overflow-member-${process.pid}-${Date.now()}`;
      const independentIdentifier = `overflow-independent-${
        process.pid
      }-${Date.now()}`;
      const memberKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        memberIdentifier,
      );
      const independentKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        independentIdentifier,
      );
      const overflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const membershipKey = `${overflowKey}:clients`;
      const adminKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'ADMIN',
        memberIdentifier,
      );
      const internal = serviceA as unknown as {
        backend: 'memory';
        memoryOverflowWindows: Map<
          string,
          {
            expiresAt: number;
            generation: string;
            limit: number;
            requestIds: Set<string>;
            requestOwners: Map<string, string>;
          }
        >;
        redisRetryAfter: number;
      };
      try {
        await redis.del(
          memberKey,
          independentKey,
          adminKey,
          overflowKey,
          membershipKey,
        );
        const overflowRequestIds = Array.from(
          { length: ROLE_LIMITS.DEFAULT + 1 },
          (_, index) => `overflow-request-${index}`,
        );
        internal.backend = 'memory';
        internal.redisRetryAfter = 0;
        internal.memoryOverflowWindows.set(overflowKey, {
          expiresAt,
          generation,
          limit: ROLE_LIMITS.DEFAULT,
          requestIds: new Set(overflowRequestIds),
          requestOwners: new Map(
            overflowRequestIds.map((requestId) => [requestId, memberKey]),
          ),
        });

        await serviceA.recover(true);

        expect(await redis.client.hexists(membershipKey, memberKey)).toBe(1);
        await expect(
          serviceB.consume({
            clientIdentifier: memberIdentifier,
            policy: 'role',
            role: 'DEFAULT',
          }),
        ).resolves.toMatchObject({
          allowed: false,
          count: ROLE_LIMITS.DEFAULT + 1,
          storageKey: overflowKey,
        });
        await expect(
          serviceB.consume({
            clientIdentifier: independentIdentifier,
            policy: 'role',
            role: 'DEFAULT',
          }),
        ).resolves.toMatchObject({
          allowed: true,
          count: 1,
          storageKey: independentKey,
        });

        await redis.del(
          memberKey,
          independentKey,
          adminKey,
          overflowKey,
          membershipKey,
        );
        await redis.client.hset(
          overflowKey,
          'generation',
          generation,
          'request:other-member',
          independentKey,
        );
        await redis.client.hset(
          membershipKey,
          'generation',
          generation,
          memberKey,
          0,
          independentKey,
          1,
        );
        await redis.client.pexpireat(overflowKey, expiresAt);
        await redis.client.pexpireat(membershipKey, expiresAt);
        const releasable = await serviceB.consume({
          clientIdentifier: memberIdentifier,
          policy: 'role',
          role: 'DEFAULT',
        });
        expect(releasable).toMatchObject({ count: 2, storageKey: overflowKey });
        await expect(
          serviceB.transfer(releasable, {
            clientIdentifier: memberIdentifier,
            policy: 'role',
            role: 'ADMIN',
          }),
        ).resolves.toMatchObject({ allowed: true, role: 'ADMIN' });
        expect(await redis.client.hexists(membershipKey, memberKey)).toBe(0);
        expect(await redis.client.hget(membershipKey, independentKey)).toBe(
          '1',
        );
        expect((await redis.client.hlen(overflowKey)) - 1).toBe(1);
        await expect(
          serviceB.consume({
            clientIdentifier: memberIdentifier,
            policy: 'role',
            role: 'DEFAULT',
          }),
        ).resolves.toMatchObject({ count: 1, storageKey: memberKey });
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(
            memberKey,
            independentKey,
            adminKey,
            overflowKey,
            membershipKey,
          );
          redis.onModuleDestroy();
        }
        metricsA.onModuleDestroy();
        metricsB.onModuleDestroy();
      }
    }, 30_000);

    it('Redis 后台恢复时把活动内存窗口增量合并到共享计数', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metrics = new MetricsService();
      const metricsB = new MetricsService();
      const service = new RateLimitService(env, redis, logger, metrics);
      const serviceB = new RateLimitService(env, redis, logger, metricsB);
      const remainingInWindow =
        RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
      if (remainingInWindow < 2_000) {
        await new Promise((resolve) =>
          setTimeout(resolve, remainingInWindow + 100),
        );
      }
      const clientIdentifier = `fallback-${process.pid}-${Date.now()}`;
      const key = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'DEFAULT',
        clientIdentifier,
      );
      const adminKey = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'role',
        'ADMIN',
        clientIdentifier,
      );
      const overflowKey = `${env.RATE_LIMITER_KEY_PREFIX}:http:neo:overflow:default`;
      const overflowMembershipKey = `${overflowKey}:clients`;
      try {
        await redis.del(key, adminKey, overflowKey, overflowMembershipKey);
        const originalEval = redis.eval.bind(redis);
        const evalSpy = vi
          .spyOn(redis, 'eval')
          .mockImplementationOnce(async (...arguments_) => {
            await originalEval(...arguments_);
            throw new Error('simulated response timeout');
          });
        const input = {
          clientIdentifier,
          policy: 'role' as const,
          role: 'DEFAULT' as const,
        };
        const source = await service.consume(input);
        expect(source).toMatchObject({
          backend: 'memory',
          count: 1,
          uncertainRedisReservation: true,
        });
        await expect(
          service.transfer(source, { ...input, role: 'ADMIN' }),
        ).resolves.toBe(source);
        expect((await redis.client.hlen(key)) - 1).toBe(1);
        expect(await redis.client.exists(adminKey)).toBe(0);
        expect(evalSpy).toHaveBeenCalledOnce();
        const preRecoveryTtl = await redis.client.pttl(key);
        await service.consume(input);
        await service.consume(input);
        (service as unknown as { redisRetryAfter: number }).redisRetryAfter = 0;

        await expect(service.consume(input)).resolves.toMatchObject({
          backend: 'memory',
          count: 4,
        });
        await service.recover(true);
        expect(service.snapshot(true).status).toBe('ok');
        const [reconcileScript, reconcileKeys, reconcileArguments] =
          evalSpy.mock.calls[2]!;
        expect(reconcileScript).toContain(
          'local requestCount = tonumber(ARGV[4])',
        );
        expect(reconcileKeys).toEqual([key, overflowKey]);
        expect(reconcileArguments[3]).toBe(4);
        expect(reconcileArguments.slice(4, -3)).toHaveLength(8);
        expect(reconcileArguments.slice(8, -3)).toEqual(Array(4).fill(''));
        expect(reconcileArguments.at(-1)).toBe(RATE_LIMIT_WINDOW_MS);
        expect((await redis.client.hlen(key)) - 1).toBe(4);
        expect(await redis.client.pttl(key)).toBeLessThanOrEqual(
          preRecoveryTtl,
        );

        await expect(serviceB.consume(input)).resolves.toMatchObject({
          backend: 'redis',
          count: 5,
        });
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(key, adminKey, overflowKey, overflowMembershipKey);
        }
        if (redis.client.status !== 'end') redis.onModuleDestroy();
        metrics.onModuleDestroy();
        metricsB.onModuleDestroy();
      }
    }, 30_000);
  },
);
