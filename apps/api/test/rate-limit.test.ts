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
        .mockResolvedValueOnce([limit, RATE_LIMIT_WINDOW_MS])
        .mockResolvedValueOnce([limit + 1, RATE_LIMIT_WINDOW_MS - 1]);
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

  it('Redis 故障时使用不延长窗口的内存降级，并在冷却后自动恢复', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const redis = redisMock();
    vi.mocked(redis.eval)
      .mockRejectedValueOnce(new Error('redis://user:secret@cache/0'))
      .mockRejectedValueOnce(new Error('still unavailable'))
      .mockResolvedValueOnce([1, RATE_LIMIT_WINDOW_MS]);
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
      backend: 'redis',
      count: 1,
    });
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
    const leader = service.consume({ ...input, clientIdentifier: 'leader' });
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
    finishProbe([1, RATE_LIMIT_WINDOW_MS]);
    await expect(leader).resolves.toMatchObject({ backend: 'redis', count: 1 });
  });

  it('readiness 可在冷却后主动验证 Lua 并恢复 Redis 后端', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const redis = redisMock();
    vi.mocked(redis.eval)
      .mockRejectedValueOnce(new Error('eval unavailable'))
      .mockResolvedValueOnce(1);
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
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(vi.mocked(redis.eval).mock.calls[1]).toEqual(['return 1', [], []]);
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

  it('内存窗口达到上限后按分钟摊销清理，后续新客户端只做 O(1) 淘汰', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const { service } = createService();
    const internal = service as unknown as {
      backend: 'memory';
      cleanMemory(now: number): void;
      memoryWindows: Map<string, { count: number; expiresAt: number }>;
      redisRetryAfter: number;
    };
    const expiresAt = Date.now() + RATE_LIMIT_WINDOW_MS;
    for (let index = 0; index < 10_000; index += 1) {
      internal.memoryWindows.set(`existing-${index}`, { count: 1, expiresAt });
    }
    internal.backend = 'memory';
    internal.redisRetryAfter = expiresAt;
    const clean = vi.spyOn(internal, 'cleanMemory');

    for (let index = 0; index < 3; index += 1) {
      await service.consume({
        clientIdentifier: `new-client-${index}`,
        policy: 'role',
        role: 'DEFAULT',
      });
    }

    expect(clean).toHaveBeenCalledOnce();
    expect(internal.memoryWindows).toHaveLength(10_000);
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
  canActivate(context: ExecutionContext): boolean {
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

  async function createApp(env = loadEnv(validEnv)) {
    counters = new Map();
    logger = loggerMock();
    metrics = new MetricsService();
    metricsToClose.push(metrics);
    permissionCache = { getRoles: vi.fn().mockResolvedValue(['ADMIN']) };
    redis = redisMock();
    vi.mocked(redis.eval).mockImplementation(
      async (script, keys: readonly string[]) => {
        if (keys.length === 0) return 1;
        const key = keys[0]!;
        if (script.includes("redis.call('DECR'")) {
          const current = counters.get(key) ?? 0;
          if (current <= 1) {
            counters.delete(key);
            return 0;
          }
          counters.set(key, current - 1);
          return current - 1;
        }
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return [count, RATE_LIMIT_WINDOW_MS];
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
      totalRequests: 3,
      byRole: {
        ADMIN: { requests: 1 },
        DEFAULT: { requests: 2 },
      },
    });
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

  it('/health、/metrics、OPTIONS、关闭开关与白名单请求绕过计数', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    await fastify.inject({ method: 'GET', url: '/health' });
    await fastify.inject({ method: 'GET', url: '/metrics' });
    await fastify.inject({
      method: 'OPTIONS',
      url: '/api/v1/rate-test/anonymous',
    });
    expect(redis.eval).not.toHaveBeenCalled();

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
    it('两个服务实例共享原子计数、TTL 不续期且可原子释放预占', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const redis = new ApplicationRedisClient(env, logger);
      const metricsA = new MetricsService();
      const metricsB = new MetricsService();
      const serviceA = new RateLimitService(env, redis, logger, metricsA);
      const serviceB = new RateLimitService(env, redis, logger, metricsB);
      const clientIdentifier = `integration-${process.pid}-${Date.now()}`;
      const key = buildRateLimitKey(
        env.RATE_LIMITER_KEY_PREFIX,
        'strict',
        'DEFAULT',
        clientIdentifier,
      );
      try {
        await redis.del(key);
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
        expect(firstTtl).toBeGreaterThan(RATE_LIMIT_WINDOW_MS - 2_000);
        expect(secondTtl).toBeGreaterThan(0);
        expect(secondTtl).toBeLessThanOrEqual(firstTtl);

        await serviceA.release(
          {
            clientIdentifier,
            policy: 'strict',
            role: 'DEFAULT',
          },
          'redis',
        );
        expect(await redis.client.get(key)).toBe('1');
        await serviceB.release(
          {
            clientIdentifier,
            policy: 'strict',
            role: 'DEFAULT',
          },
          'redis',
        );
        expect(await redis.client.get(key)).toBeNull();
      } finally {
        if (redis.client.status !== 'end') await redis.del(key);
        if (redis.client.status !== 'end') redis.onModuleDestroy();
        metricsA.onModuleDestroy();
        metricsB.onModuleDestroy();
      }
    }, 30_000);
  },
);
