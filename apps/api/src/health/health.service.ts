import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import type { Env } from '@asin-monitor/config';
import type { Health } from '@asin-monitor/contracts';
import { ENV } from '../config/config.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { AppLogger, utc8Iso } from '../logger/app-logger.service';
import { MetricsService } from '../metrics/metrics.service';
import { ApplicationRedisClient } from '../redis/redis.service';

type DependencyName = 'competitor_database' | 'database' | 'redis';
type ComponentStatus = 'degraded' | 'error' | 'ok';
type ErrorCategory =
  | 'AUTH_ERROR'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'RATE_LIMIT'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

interface PoolSnapshot {
  totalConnections: number;
  freeConnections: number;
  activeConnections: number;
  queueLength: number;
  config: {
    connectionLimit: number;
    queueLimit: number;
  };
}

interface DependencyProbe {
  status: ComponentStatus;
  connected: boolean;
  latencyMs: number;
  error?: 'probe_failed' | 'probe_timeout';
}

interface DatabaseProbe extends DependencyProbe {
  [key: string]: unknown;
  pool: PoolSnapshot;
  usagePercent: string;
}

interface ErrorRecord {
  occurredAt: number;
  type: ErrorCategory;
}

class HealthProbeTimeoutError extends Error {
  constructor() {
    super('health probe timed out');
    this.name = 'HealthProbeTimeoutError';
  }
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

function probeFailureReason(error: unknown): DependencyProbe['error'] {
  if (error instanceof HealthProbeTimeoutError) return 'probe_timeout';
  if (!(error instanceof Error)) return 'probe_failed';

  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ETIMEDOUT' ||
    /^(?:Command timed out|connect ETIMEDOUT)$/i.test(error.message)
    ? 'probe_timeout'
    : 'probe_failed';
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new HealthProbeTimeoutError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function poolSnapshot(pool: Pool): PoolSnapshot {
  const connectionLimit = pool.options.max ?? 10;
  return {
    totalConnections: pool.totalCount,
    freeConnections: pool.idleCount,
    activeConnections: Math.max(0, pool.totalCount - pool.idleCount),
    queueLength: pool.waitingCount,
    config: {
      connectionLimit,
      queueLimit: 0,
    },
  };
}

function poolUsage(snapshot: PoolSnapshot): number {
  return snapshot.config.connectionLimit > 0
    ? snapshot.activeConnections / snapshot.config.connectionLimit
    : 0;
}

async function runPostgresProbe(pool: Pool, timeoutMs: number): Promise<void> {
  const query = { text: 'SELECT 1', query_timeout: timeoutMs };
  try {
    await pool.query(query);
  } catch (error) {
    if (
      error instanceof Error &&
      /query read timeout|timeout exceeded when trying to connect|connection terminated due to connection timeout/i.test(
        error.message,
      )
    ) {
      throw new HealthProbeTimeoutError();
    }
    throw error;
  }
}

export function memoryHealth(
  env: Pick<
    Env,
    | 'HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD'
    | 'HEALTH_MEMORY_RSS_DEGRADED_MB'
  >,
  usage = process.memoryUsage(),
  heapLimitBytes = getHeapStatistics().heap_size_limit || 0,
) {
  const heapUsedToTotalPercent =
    usage.heapTotal > 0 ? (usage.heapUsed / usage.heapTotal) * 100 : 0;
  const heapUsedToLimitPercent =
    heapLimitBytes > 0 ? (usage.heapUsed / heapLimitBytes) * 100 : 0;
  const rss = Math.round(usage.rss / 1024 / 1024);
  const degraded =
    heapUsedToLimitPercent >
      env.HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD * 100 ||
    (env.HEALTH_MEMORY_RSS_DEGRADED_MB > 0 &&
      rss > env.HEALTH_MEMORY_RSS_DEGRADED_MB);
  return {
    status: degraded ? ('degraded' as const) : ('ok' as const),
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
    heapLimit: Math.round(heapLimitBytes / 1024 / 1024),
    external: Math.round(usage.external / 1024 / 1024),
    rss,
    usagePercent: heapUsedToTotalPercent.toFixed(2),
    heapLimitUsagePercent: heapUsedToLimitPercent.toFixed(2),
    thresholdPercent: (
      env.HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD * 100
    ).toFixed(2),
  };
}

@Injectable()
export class HealthErrorStatsService {
  private readonly records: ErrorRecord[] = [];
  private readonly totals = new Map<ErrorCategory, number>();

  recordStatus(status: number, occurredAt = Date.now()): void {
    const type: ErrorCategory =
      status === 429
        ? 'RATE_LIMIT'
        : status === 401
        ? 'AUTH_ERROR'
        : status === 403
        ? 'FORBIDDEN'
        : status === 404
        ? 'NOT_FOUND'
        : status === 400
        ? 'INVALID_INPUT'
        : status >= 500
        ? 'SERVER_ERROR'
        : 'UNKNOWN';
    this.records.push({ occurredAt, type });
    if (this.records.length > 1_000) this.records.shift();
    this.totals.set(type, (this.totals.get(type) ?? 0) + 1);
  }

  snapshot(now = Date.now()) {
    const cutoff = now - 60 * 60_000;
    const recent = this.records.filter(({ occurredAt }) => occurredAt > cutoff);
    const recentByType: Record<string, number> = {};
    for (const { type } of recent) {
      recentByType[type] = (recentByType[type] ?? 0) + 1;
    }
    return {
      recent: {
        count: recent.length,
        hours: 1,
        byType: recentByType,
        byRegion: {},
      },
      byType: Object.fromEntries(this.totals),
    };
  }
}

@Injectable()
export class HealthRuntimeDependencies {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ApplicationDatabasePools)
    private readonly databasePools: ApplicationDatabasePools,
    @Inject(ApplicationRedisClient)
    private readonly redis: ApplicationRedisClient,
  ) {}

  async queryPrimary(): Promise<void> {
    await runPostgresProbe(
      this.databasePools.primaryPool,
      this.env.HEALTH_PROBE_TIMEOUT_MS,
    );
  }

  async queryCompetitor(): Promise<void> {
    await runPostgresProbe(
      this.databasePools.competitorPool,
      this.env.HEALTH_PROBE_TIMEOUT_MS,
    );
  }

  async pingRedis(): Promise<void> {
    await this.redis.ping();
  }

  primaryPoolSnapshot(): PoolSnapshot {
    return poolSnapshot(this.databasePools.primaryPool);
  }

  competitorPoolSnapshot(): PoolSnapshot {
    return poolSnapshot(this.databasePools.competitorPool);
  }
}

@Injectable()
export class HealthService {
  private readonly lastDependencyState = new Map<DependencyName, boolean>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(HealthRuntimeDependencies)
    private readonly dependencies: HealthRuntimeDependencies,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(HealthErrorStatsService)
    private readonly errorStats: HealthErrorStatsService,
  ) {}

  private recordProbeState(
    dependency: DependencyName,
    connected: boolean,
    latencyMs: number,
    reason?: DependencyProbe['error'],
  ): void {
    const previous = this.lastDependencyState.get(dependency);
    this.lastDependencyState.set(dependency, connected);
    this.metrics.recordHealthProbe({
      dependency,
      up: connected,
      durationSeconds: latencyMs / 1_000,
    });
    if (!connected && previous !== false) {
      this.logger.warn('健康依赖不可用', 'HealthService', {
        dependency,
        reason: reason ?? 'probe_failed',
      });
    } else if (connected && previous === false) {
      this.logger.info('健康依赖已恢复', 'HealthService', { dependency });
    }
  }

  private async probeDatabase(
    dependency: Exclude<DependencyName, 'redis'>,
    query: () => Promise<void>,
    snapshot: () => PoolSnapshot,
  ): Promise<DatabaseProbe> {
    const startedAt = performance.now();
    try {
      await withTimeout(query(), this.env.HEALTH_PROBE_TIMEOUT_MS);
      const pool = snapshot();
      const usage = poolUsage(pool);
      const status =
        usage >= this.env.HEALTH_DB_POOL_DEGRADED_THRESHOLD ? 'degraded' : 'ok';
      const latencyMs = roundMilliseconds(performance.now() - startedAt);
      this.recordProbeState(dependency, true, latencyMs);
      return {
        status,
        connected: true,
        pool,
        usagePercent: (usage * 100).toFixed(2),
        latencyMs,
      };
    } catch (error) {
      const latencyMs = roundMilliseconds(performance.now() - startedAt);
      const reason = probeFailureReason(error);
      const pool = snapshot();
      this.recordProbeState(dependency, false, latencyMs, reason);
      return {
        status: 'error',
        connected: false,
        pool,
        usagePercent: (poolUsage(pool) * 100).toFixed(2),
        latencyMs,
        error: reason,
      };
    }
  }

  private async probeRedis(): Promise<DependencyProbe> {
    const startedAt = performance.now();
    try {
      await withTimeout(
        this.dependencies.pingRedis(),
        this.env.HEALTH_PROBE_TIMEOUT_MS,
      );
      const latencyMs = roundMilliseconds(performance.now() - startedAt);
      this.recordProbeState('redis', true, latencyMs);
      return { status: 'ok', connected: true, latencyMs };
    } catch (error) {
      const latencyMs = roundMilliseconds(performance.now() - startedAt);
      const reason = probeFailureReason(error);
      this.recordProbeState('redis', false, latencyMs, reason);
      return {
        status: 'error',
        connected: false,
        latencyMs,
        error: reason,
      };
    }
  }

  async getHealth(): Promise<Health> {
    const [database, competitorDatabase, redis] = await Promise.all([
      this.probeDatabase(
        'database',
        () => this.dependencies.queryPrimary(),
        () => this.dependencies.primaryPoolSnapshot(),
      ),
      this.probeDatabase(
        'competitor_database',
        () => this.dependencies.queryCompetitor(),
        () => this.dependencies.competitorPoolSnapshot(),
      ),
      this.probeRedis(),
    ]);
    const memory = memoryHealth(this.env);
    const status =
      database.status === 'ok' &&
      competitorDatabase.status === 'ok' &&
      redis.status === 'ok' &&
      memory.status === 'ok'
        ? 'ok'
        : 'degraded';
    return {
      status,
      timestamp: utc8Iso(),
      uptime: process.uptime(),
      database,
      competitorDatabase,
      memory,
      rateLimiter: {
        status: redis.status,
        stats: {
          mode: 'redis-backend-ready',
          redisAvailable: redis.connected,
        },
      },
      cache: {
        status: redis.status,
        connected: redis.connected,
        backend: 'redis',
        latencyMs: redis.latencyMs,
        ...(redis.error ? { error: redis.error } : {}),
      },
      errorStats: this.errorStats.snapshot(),
    };
  }
}
