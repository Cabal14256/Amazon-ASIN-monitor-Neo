import { ServiceUnavailableException } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnv, type Env } from '@asin-monitor/config';
import { healthSchema, type Health } from '@asin-monitor/contracts';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { HealthController } from '../src/health/health.controller';
import {
  HealthErrorStatsService,
  HealthRuntimeDependencies,
  HealthService,
  memoryHealth,
} from '../src/health/health.service';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { RateLimitService } from '../src/rate-limit/rate-limit.service';
import { ApplicationRedisClient } from '../src/redis/redis.service';

const validEnv = {
  DATABASE_URL: 'postgresql://localhost/amazon_asin_monitor',
  COMPETITOR_DATABASE_URL: 'postgresql://localhost/amazon_competitor_monitor',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-secret',
  AUTH_DATA_AUTHORITY: 'postgresql',
};
const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === 'true';

const poolSnapshot = {
  totalConnections: 2,
  freeConnections: 1,
  activeConnections: 1,
  queueLength: 0,
  config: { connectionLimit: 10, queueLimit: 0 },
};
const saturatedPoolSnapshot = {
  ...poolSnapshot,
  freeConnections: 0,
  activeConnections: 10,
};

function rateLimiterStub(
  forcedStatus?: 'degraded' | 'disabled' | 'ok',
): RateLimitService {
  return {
    recover: vi.fn().mockResolvedValue(undefined),
    startRecovery: vi.fn(),
    snapshot: vi.fn((redisAvailable: boolean) => {
      const status = forcedStatus ?? (redisAvailable ? 'ok' : 'degraded');
      return {
        status,
        stats: {
          enabled: status !== 'disabled',
          backend:
            status === 'disabled'
              ? 'disabled'
              : status === 'degraded'
              ? 'memory'
              : 'redis',
          redisAvailable,
          totalRequests: 0,
          blockedRequests: 0,
          byRole: {
            ADMIN: { requests: 0, blocked: 0 },
            EDITOR: { requests: 0, blocked: 0 },
            READONLY: { requests: 0, blocked: 0 },
            DEFAULT: { requests: 0, blocked: 0 },
          },
          lastReset: 0,
          blockRate: '0.00',
        },
      };
    }),
  } as unknown as RateLimitService;
}

function buildService(
  options: {
    env?: Env;
    logger?: AppLogger;
    queryPrimary?: () => Promise<void>;
    queryCompetitor?: () => Promise<void>;
    pingRedis?: () => Promise<void>;
    primaryPoolSnapshot?: () => typeof poolSnapshot;
    rateLimiter?: RateLimitService;
  } = {},
) {
  const env = options.env ?? loadEnv(validEnv);
  const dependencies = {
    queryPrimary: options.queryPrimary ?? vi.fn().mockResolvedValue(undefined),
    queryCompetitor:
      options.queryCompetitor ?? vi.fn().mockResolvedValue(undefined),
    pingRedis: options.pingRedis ?? vi.fn().mockResolvedValue(undefined),
    primaryPoolSnapshot:
      options.primaryPoolSnapshot ?? vi.fn(() => poolSnapshot),
    competitorPoolSnapshot: vi.fn(() => poolSnapshot),
  } as unknown as HealthRuntimeDependencies;
  const metrics = new MetricsService();
  const errorStats = new HealthErrorStatsService();
  const service = new HealthService(
    env,
    dependencies,
    options.logger ?? new AppLogger(),
    metrics,
    errorStats,
    options.rateLimiter ?? rateLimiterStub(),
  );
  return { service, metrics, errorStats };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('HealthService', () => {
  it('真实汇总双 PostgreSQL、Redis、内存与错误统计并记录低基数指标', async () => {
    const { service, metrics, errorStats } = buildService();
    errorStats.recordStatus(429);
    const health = await service.getHealth();

    expect(healthSchema.parse(health).status).toBe('ok');
    expect(health.database).toMatchObject({
      status: 'ok',
      connected: true,
      usagePercent: '10.00',
    });
    expect(health.competitorDatabase?.connected).toBe(true);
    expect(health.cache).toMatchObject({
      status: 'ok',
      connected: true,
      backend: 'redis',
    });
    expect(health.rateLimiter).toMatchObject({
      status: 'ok',
      stats: {
        backend: 'redis',
        redisAvailable: true,
        totalRequests: 0,
        blockedRequests: 0,
      },
    });
    expect(health.errorStats).toMatchObject({
      recent: { count: 1, byType: { RATE_LIMIT: 1 } },
    });

    const rendered = await metrics.render();
    expect(rendered).toContain(
      'amazon_asin_monitor_health_dependency_up{dependency="database"} 1',
    );
    expect(rendered).toContain(
      'amazon_asin_monitor_health_dependency_up{dependency="competitor_database"} 1',
    );
    expect(rendered).toContain(
      'amazon_asin_monitor_health_dependency_up{dependency="redis"} 1',
    );
    metrics.onModuleDestroy();
  });

  it('共享应用数据库池仅对探针应用超时并安全消费空闲连接错误', async () => {
    const warn = vi.fn();
    const logger = { warn: warn } as unknown as AppLogger;
    const pools = new ApplicationDatabasePools(loadEnv(validEnv), logger);
    const query = vi
      .spyOn(pools.primaryPool, 'query')
      .mockResolvedValue({} as never);
    const dependencies = new HealthRuntimeDependencies(
      loadEnv(validEnv),
      pools,
      { ping: vi.fn() } as unknown as ApplicationRedisClient,
    );

    await dependencies.queryPrimary();

    expect(pools.primaryPool.options.connectionTimeoutMillis).toBe(2_000);
    expect(
      pools.primaryPool.options.types
        ?.getTypeParser(
          1114,
          'text',
        )('2026-09-01 16:00:00')
        .toISOString(),
    ).toBe('2026-09-01T08:00:00.000Z');
    expect(pools.primaryPool.options).not.toHaveProperty('query_timeout');
    expect(pools.primaryPool.options).not.toHaveProperty('statement_timeout');
    expect(query).toHaveBeenCalledWith({
      text: 'SELECT 1',
      query_timeout: 2_000,
    });
    query.mockRejectedValueOnce(
      new Error('timeout exceeded when trying to connect'),
    );
    await expect(dependencies.queryPrimary()).rejects.toMatchObject({
      name: 'HealthProbeTimeoutError',
    });

    (
      pools.primaryPool as unknown as {
        emit(event: string, error: Error): boolean;
      }
    ).emit(
      'error',
      new Error('postgresql://operator:raw-secret@db.internal/primary'),
    );
    (
      pools.competitorPool as unknown as {
        emit(event: string, error: Error): boolean;
      }
    ).emit(
      'error',
      new Error('postgresql://operator:raw-secret@db.internal/competitor'),
    );

    expect(warn).toHaveBeenNthCalledWith(
      1,
      'PostgreSQL 空闲连接异常',
      'ApplicationDatabasePools',
      { dependency: 'database', reason: 'idle_client_error' },
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      'PostgreSQL 空闲连接异常',
      'ApplicationDatabasePools',
      { dependency: 'competitor_database', reason: 'idle_client_error' },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('raw-secret');
    await pools.onApplicationShutdown();
  });

  it('健康运行依赖委托给共享应用数据库池而不创建独立 PG 池', async () => {
    const primaryPool = {
      query: vi.fn().mockResolvedValue(undefined),
      options: { max: 10 },
      totalCount: 2,
      idleCount: 1,
      waitingCount: 0,
    };
    const competitorPool = {
      ...primaryPool,
      query: vi.fn().mockResolvedValue(undefined),
    };
    const databasePools = {
      primaryPool,
      competitorPool,
    } as unknown as ApplicationDatabasePools;
    const redis = {
      ping: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApplicationRedisClient;
    const dependencies = new HealthRuntimeDependencies(
      loadEnv(validEnv),
      databasePools,
      redis,
    );

    await dependencies.queryPrimary();
    await dependencies.queryCompetitor();
    await dependencies.pingRedis();

    expect(primaryPool.query).toHaveBeenCalledWith({
      text: 'SELECT 1',
      query_timeout: 2_000,
    });
    expect(competitorPool.query).toHaveBeenCalledWith({
      text: 'SELECT 1',
      query_timeout: 2_000,
    });
    expect(redis.ping).toHaveBeenCalledOnce();
    expect(dependencies.primaryPoolSnapshot()).toEqual(poolSnapshot);
    expect(dependencies.competitorPoolSnapshot()).toEqual(poolSnapshot);
  });

  it('共享 Redis 客户端复用单次连接并安全消费底层错误事件', async () => {
    const debug = vi.fn();
    const client = new ApplicationRedisClient(loadEnv(validEnv), {
      debug,
    } as unknown as AppLogger);
    const connect = vi
      .spyOn(client.client, 'connect')
      .mockResolvedValue(undefined);
    const ping = vi.spyOn(client.client, 'ping').mockResolvedValue('PONG');

    await Promise.all([client.ping(), client.ping()]);
    client.client.emit(
      'error',
      new Error('redis://operator:raw-secret@cache.internal/15'),
    );

    expect(connect).toHaveBeenCalledOnce();
    expect(ping).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledWith(
      'Redis 底层连接事件',
      'ApplicationRedisClient',
      { dependency: 'redis', reason: 'connection_error' },
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain('raw-secret');
    client.onModuleDestroy();
  });

  it('依赖失败返回通用错误与 degraded，日志不包含连接串或凭据', async () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn() } as unknown as AppLogger;
    const { service, metrics } = buildService({
      logger,
      queryCompetitor: vi
        .fn()
        .mockRejectedValue(
          new Error('postgresql://operator:raw-secret@db.internal/competitor'),
        ),
    });

    const health = await service.getHealth();
    expect(health.status).toBe('degraded');
    expect(health.competitorDatabase).toMatchObject({
      status: 'error',
      connected: false,
      error: 'probe_failed',
    });
    expect(JSON.stringify(health)).not.toContain('raw-secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('raw-secret');
    expect(warn).toHaveBeenCalledWith('健康依赖不可用', 'HealthService', {
      dependency: 'competitor_database',
      reason: 'probe_failed',
    });
    metrics.onModuleDestroy();
  });

  it('Redis PING 正常但 EVAL 降级时后台触发恢复并立即返回 degraded', async () => {
    const rateLimiter = rateLimiterStub('degraded');
    vi.mocked(rateLimiter.recover).mockImplementation(
      () => new Promise(() => undefined),
    );
    const { service, metrics } = buildService({
      rateLimiter,
    });

    const health = await service.getHealth();

    expect(health.cache).toMatchObject({ status: 'ok', connected: true });
    expect(health.rateLimiter).toMatchObject({
      status: 'degraded',
      stats: { backend: 'memory', redisAvailable: true },
    });
    expect(health.status).toBe('degraded');
    expect(rateLimiter.startRecovery).toHaveBeenCalledWith(true);
    expect(rateLimiter.recover).not.toHaveBeenCalled();
    metrics.onModuleDestroy();
  });

  it('超时探针有界失败并报告 probe_timeout', async () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn() } as unknown as AppLogger;
    const env = loadEnv({
      ...validEnv,
      HEALTH_PROBE_TIMEOUT_MS: '50',
      DATABASE_POOL_CONNECTION_TIMEOUT_MS: '50',
    });
    const { service, metrics } = buildService({
      env,
      logger,
      queryPrimary: () => new Promise(() => undefined),
      primaryPoolSnapshot: () => saturatedPoolSnapshot,
    });

    const health = await service.getHealth();
    expect(health.status).toBe('degraded');
    expect(health.database).toMatchObject({
      connected: false,
      error: 'probe_timeout',
      usagePercent: '100.00',
      pool: saturatedPoolSnapshot,
    });
    expect(warn).toHaveBeenCalledOnce();
    metrics.onModuleDestroy();
  });

  it.each([
    new Error('Command timed out'),
    Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  ])('ioredis 原生超时统一报告 probe_timeout', async (failure) => {
    const { service, metrics } = buildService({
      pingRedis: vi.fn().mockRejectedValue(failure),
    });

    const health = await service.getHealth();
    expect(health.status).toBe('degraded');
    expect(health.cache).toMatchObject({
      status: 'error',
      connected: false,
      error: 'probe_timeout',
    });
    metrics.onModuleDestroy();
  });

  it('内存阈值按 heap limit 和可选 RSS 绝对值判定', () => {
    const env = loadEnv({
      ...validEnv,
      HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD: '50',
      HEALTH_MEMORY_RSS_DEGRADED_MB: '100',
    });
    const memory = memoryHealth(
      env,
      {
        rss: 101 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        heapUsed: 60 * 1024 * 1024,
        external: 1 * 1024 * 1024,
        arrayBuffers: 0,
      },
      100 * 1024 * 1024,
    );
    expect(memory.status).toBe('degraded');
    expect(memory.heapLimitUsagePercent).toBe('60.00');
    expect(memory.thresholdPercent).toBe('50.00');
  });

  it('全局异常过滤器把低基数错误分类写入健康统计', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const stats = new HealthErrorStatsService();
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => reply }),
    };
    const filter = new ApiExceptionFilter(new AppLogger(), stats);

    filter.catch(
      new ServiceUnavailableException('postgresql://user:secret@db/primary'),
      host as never,
    );

    expect(stats.snapshot()).toMatchObject({
      recent: { count: 1, byType: { SERVER_ERROR: 1 } },
      byType: { SERVER_ERROR: 1 },
    });
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      errorMessage: '服务器内部错误',
      errorCode: 503,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret@db');
  });
});

describe.skipIf(!integrationEnabled)(
  'HealthRuntimeDependencies integration',
  () => {
    it('对 CI 的双 PostgreSQL 与 Redis 执行真实有界探针', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const databasePools = new ApplicationDatabasePools(env, logger);
      const redis = new ApplicationRedisClient(env, logger);
      const dependencies = new HealthRuntimeDependencies(
        env,
        databasePools,
        redis,
      );
      const metrics = new MetricsService();
      const service = new HealthService(
        env,
        dependencies,
        logger,
        metrics,
        new HealthErrorStatsService(),
        rateLimiterStub(),
      );
      try {
        const health = await service.getHealth();
        expect(healthSchema.parse(health).status).toBe('ok');
        expect(health.database?.connected).toBe(true);
        expect(health.competitorDatabase?.connected).toBe(true);
        expect(health.cache).toMatchObject({ connected: true });
      } finally {
        redis.onModuleDestroy();
        await databasePools.onApplicationShutdown();
        metrics.onModuleDestroy();
      }
    }, 30_000);
  },
);

describe('HealthController compatibility routes', () => {
  async function createApp(health: Health) {
    const healthService = { getHealth: vi.fn().mockResolvedValue(health) };
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: healthService }],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    configureHttpApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  it('两条兼容路由共享响应且不生成重复 /api 前缀', async () => {
    const health: Health = {
      status: 'ok',
      timestamp: '2026-08-31T21:00:00.000+08:00',
      uptime: 10,
    };
    const app = await createApp(health);
    const fastify = app.getHttpAdapter().getInstance();
    const root = await fastify.inject({ method: 'GET', url: '/health' });
    const versioned = await fastify.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    const duplicated = await fastify.inject({
      method: 'GET',
      url: '/api/v1/api/v1/health',
    });

    expect(root.statusCode).toBe(200);
    expect(versioned.statusCode).toBe(200);
    expect(root.json()).toEqual(versioned.json());
    expect(duplicated.statusCode).toBe(404);
    await app.close();
  });

  it('任一关键依赖降级时返回 HTTP 503 而不是成功码', async () => {
    const app = await createApp({
      status: 'degraded',
      timestamp: '2026-08-31T21:00:00.000+08:00',
      database: { status: 'error', connected: false, error: 'probe_failed' },
    });
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'degraded' });
    await app.close();
  });
});
