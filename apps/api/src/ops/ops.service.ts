import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  resolveQueueSelection,
  type Env,
} from '@asin-monitor/config';
import type { PermissionCode } from '@asin-monitor/contracts';
import {
  refreshAnalyticsRequestSchema,
  timescaleAggregateEvidenceManifest,
} from '@asin-monitor/contracts';
import {
  formatShanghaiTimestamp,
  type RoleRepositoryPort,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
import type { FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { authorizeAdministrationAny } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { AppLogger } from '../logger/app-logger.service';
import { ApplicationRedisClient } from '../redis/redis.service';

const ANALYTICS_PREFIX = 'analytics:v1:';
const LAST_CLEARED_AT_TTL_SECONDS = 30 * 86400;
const QUEUE_NAMES = ['monitor', 'competitor-monitor'] as const;
const MAX_REFRESH_RANGE_MS = 31 * 86400000;
const MAX_REFRESH_MS = 120_000;
const CACHE_SCAN_COUNT = 200;
const MAX_CACHE_SCAN_PAGES = 100;
const MAX_CACHE_KEYS = 10_000;
const MAX_CACHE_OPERATION_MS = 5_000;
const REFRESH_LOCK_SQL = `hashtextextended('amazon-asin-monitor:neo-ops-aggregate-refresh', 0)`;
export const OPS_ROLE_REPOSITORY = Symbol('OPS_ROLE_REPOSITORY');
export const OPS_QUEUE_FACTORY = Symbol('OPS_QUEUE_FACTORY');
type OpsQueue = Pick<
  Queue,
  'waitUntilReady' | 'getJobCounts' | 'isPaused' | 'close'
>;
export type OpsQueueFactory = (
  name: string,
  options: { connection: ConnectionOptions; prefix: string },
) => OpsQueue;
const fail = (status: number, errorMessage: string): never => {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage },
    status,
  );
};
export class OpsRedisDeadlineError extends Error {}

/** Bound the caller even when Redis's configured command timeout is longer. */
export function withOpsRedisDeadline<T>(
  deadline: number,
  operation: () => Promise<T>,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new OpsRedisDeadlineError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new OpsRedisDeadlineError()),
      remaining,
    );
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function escapeRedisGlob(value: string) {
  return value.replace(/[\\*?\[\]]/g, '\\$&');
}

function parseRefreshTimestamp(value: string): number | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/.exec(
      value,
    );
  if (!match) return undefined;
  const [
    ,
    year,
    month,
    day,
    hour = '0',
    minute = '0',
    second = '0',
    fraction = '',
  ] = match;
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, '0').slice(0, 3)),
  );
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  )
    return undefined;
  return timestamp + Number(fraction.padEnd(6, '0').slice(3) || 0) / 1000;
}

@Injectable()
export class OpsService {
  private refreshing = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ApplicationDatabasePools)
    private readonly pools: ApplicationDatabasePools,
    @Inject(ApplicationRedisClient)
    private readonly redis: ApplicationRedisClient,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(OPS_ROLE_REPOSITORY)
    private readonly roles: RoleRepositoryPort,
    @Inject(OPS_QUEUE_FACTORY)
    private readonly queueFactory: OpsQueueFactory,
  ) {}

  private async authorize(
    principal: AuthPrincipal,
    permissions: readonly PermissionCode[],
  ) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有运维入口');
    return this.roles.transaction((unit) =>
      authorizeAdministrationAny(unit, principal, permissions),
    );
  }

  private async queueStats(name: (typeof QUEUE_NAMES)[number]) {
    const queue = this.queueFactory(getPhysicalQueueName(name), {
      connection: this.redis.client as unknown as ConnectionOptions,
      prefix: getNeoQueuePrefix(this.env),
    });
    try {
      await queue.waitUntilReady();
      return {
        counts: await queue.getJobCounts(),
        isPaused: await queue.isPaused(),
        limiter:
          name === 'monitor'
            ? {
                max: this.env.MONITOR_QUEUE_LIMITER_MAX,
                duration: this.env.MONITOR_QUEUE_LIMITER_DURATION_MS,
              }
            : {
                max: this.env.COMPETITOR_QUEUE_LIMITER_MAX,
                duration: this.env.COMPETITOR_QUEUE_LIMITER_DURATION_MS,
              },
      };
    } finally {
      await queue.close().catch(() => undefined);
    }
  }

  private get analyticsPrefix() {
    return `${this.env.BULL_PREFIX.trim()}:neo:${ANALYTICS_PREFIX}`;
  }

  private get lastClearedAtKey() {
    return `${this.env.BULL_PREFIX.trim()}:neo:ops:analytics-cache:last-cleared-at`;
  }

  // SCAN runs as separate bounded Redis commands. Never traverse the whole keyspace
  // in one Lua script, which would block all other Redis clients.
  private async scanAnalyticsKeys(deadline: number) {
    const keys = new Set<string>();
    const prefix = this.analyticsPrefix;
    const pattern = `${escapeRedisGlob(prefix)}*`;
    let cursor = '0';
    for (let page = 0; page < MAX_CACHE_SCAN_PAGES; page++) {
      if (Date.now() >= deadline) return { keys: [...keys], complete: false };
      let nextCursor: string;
      let pageKeys: string[];
      try {
        [nextCursor, pageKeys] = await withOpsRedisDeadline(deadline, () =>
          this.redis.scan(cursor, pattern, CACHE_SCAN_COUNT),
        );
      } catch (error) {
        if (error instanceof OpsRedisDeadlineError)
          return { keys: [...keys], complete: false };
        throw error;
      }
      // BULL_PREFIX is configuration, not a Redis glob. Filter literal prefixes
      // before deletion even if the configured prefix contains glob characters.
      for (const key of pageKeys) {
        if (!key.startsWith(prefix)) continue;
        if (keys.size === MAX_CACHE_KEYS && !keys.has(key))
          return { keys: [...keys], complete: false };
        keys.add(key);
      }
      if (nextCursor === '0') return { keys: [...keys], complete: true };
      cursor = nextCursor;
    }
    return { keys: [...keys], complete: false };
  }

  private async cacheStats() {
    const scan = await this.scanAnalyticsKeys(
      Date.now() + MAX_CACHE_OPERATION_MS,
    );
    const count = scan.complete ? scan.keys.length : null;
    return {
      activeEntries: count,
      totalEntries: count,
      estimatedCacheMemoryMB: null,
      truncated: !scan.complete,
    };
  }

  private async analyticsCacheStatus() {
    let lastClearedAt: string | null = null;
    try {
      lastClearedAt = await this.redis.get(this.lastClearedAtKey);
    } catch {
      this.logger.warn('分析缓存清理时间读取失败', 'OpsService', {
        reason: 'analytics_cache_status_unavailable',
      });
    }
    return { prefixes: [this.analyticsPrefix], lastClearedAt };
  }

  async overview(principal: AuthPrincipal, reply: FastifyReply) {
    await this.authorize(principal, ['settings:read']);
    reply.header('Cache-Control', 'no-store');
    try {
      const [monitor, competitor, cache, analyticsCache] = await Promise.all([
        this.queueStats('monitor'),
        this.queueStats('competitor-monitor'),
        this.cacheStats(),
        this.analyticsCacheStatus(),
      ]);
      const selection = resolveQueueSelection(this.env.WORKER_ENABLED_QUEUES);
      return {
        success: true,
        errorCode: 0,
        data: {
          processRole: this.env.PROCESS_ROLE,
          schedulerEnabled: this.env.SCHEDULER_ENABLED,
          workerRegisteredQueues: selection.enabledQueues,
          workerProcessorDetails: { source: 'worker-configuration' },
          cache,
          analyticsCache,
          riskControl: {},
          scheduler: { enabled: this.env.SCHEDULER_ENABLED },
          analyticsAgg: {
            enabled: this.env.ANALYTICS_AGG_ENABLED,
            isRefreshing: this.refreshing,
            backfillHours: null,
            backfillDays: null,
          },
          queues: { monitor, competitor },
        },
      };
    } catch (error) {
      this.logger.error('运维概览读取失败', 'OpsService', {
        reason: 'ops_overview_failed',
      });
      return fail(503, '暂时无法读取运维概览');
    }
  }

  async clearCache(principal: AuthPrincipal) {
    await this.authorize(principal, ['settings:write']);
    try {
      const deadline = Date.now() + MAX_CACHE_OPERATION_MS;
      const scan = await this.scanAnalyticsKeys(deadline);
      if (!scan.complete) {
        this.logger.warn('分析缓存清理范围超限', 'OpsService', {
          reason: 'analytics_cache_scan_limit',
        });
        fail(409, '分析缓存条目过多或扫描超时，请稍后重试');
      }
      let removed = 0;
      for (
        let offset = 0;
        offset < scan.keys.length;
        offset += CACHE_SCAN_COUNT
      ) {
        if (Date.now() >= deadline) fail(503, '分析缓存清理超时，请重试');
        removed += await withOpsRedisDeadline(deadline, () =>
          this.redis.unlink(
            ...scan.keys.slice(offset, offset + CACHE_SCAN_COUNT),
          ),
        );
      }
      const clearedAt = new Date().toISOString();
      await withOpsRedisDeadline(deadline, () =>
        this.redis.setex(
          this.lastClearedAtKey,
          LAST_CLEARED_AT_TTL_SECONDS,
          clearedAt,
        ),
      );
      this.logger.info('分析缓存已清理', 'OpsService', {
        removed,
      });
      return {
        success: true,
        errorCode: 0,
        data: { prefixes: [this.analyticsPrefix], clearedAt },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('分析缓存清理失败', 'OpsService', {
        reason: 'analytics_cache_clear_failed',
      });
      return fail(503, '清理分析缓存失败');
    }
  }

  async refresh(principal: AuthPrincipal, body: unknown) {
    await this.authorize(principal, ['settings:write']);
    if (!this.env.ANALYTICS_AGG_ENABLED) fail(400, '聚合刷新未启用');
    const parsed = refreshAnalyticsRequestSchema.safeParse(
      body === undefined ? {} : body,
    );
    const input = parsed.success ? parsed.data : fail(400, '聚合刷新参数无效');
    const granularity = input.granularity;
    if (this.refreshing) fail(409, '聚合刷新正在执行');
    const start =
      input.startTime ??
      formatShanghaiTimestamp(new Date(Date.now() - 2 * 86400000));
    const end = input.endTime ?? formatShanghaiTimestamp(new Date());
    const startMs = parseRefreshTimestamp(start);
    const endMs = parseRefreshTimestamp(end);
    if (
      startMs === undefined ||
      endMs === undefined ||
      endMs <= startMs ||
      endMs - startMs > MAX_REFRESH_RANGE_MS
    )
      fail(400, '刷新时间范围无效，必须为正数且不超过 31 天');
    const targets = timescaleAggregateEvidenceManifest
      .filter((item) => !granularity || item.granularity === granularity)
      .map((item) => item.caggRelation);
    this.refreshing = true;
    let client: PoolClient | undefined;
    let lockHeld = false;
    let timeoutChanged = false;
    const deadline = Date.now() + MAX_REFRESH_MS;
    try {
      client = await this.pools.primaryPool.connect();
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(${REFRESH_LOCK_SQL}) AS acquired`,
      );
      lockHeld = lock.rows[0]?.acquired === true;
      if (!lockHeld) fail(409, '聚合刷新正在执行');
      for (const relation of targets) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) fail(503, '聚合刷新超时');
        timeoutChanged = true;
        await client.query(`SET statement_timeout = ${remaining}`);
        await client.query(
          'CALL public.refresh_continuous_aggregate($1::regclass,$2::timestamp,$3::timestamp,force=>true)',
          [`public.${relation}`, start, end],
        );
      }
      this.logger.info('分析聚合刷新完成', 'OpsService', {
        count: targets.length,
      });
      return {
        success: true,
        errorCode: 0,
        data: { refreshed: targets, startTime: start, endTime: end },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('分析聚合刷新失败', 'OpsService', {
        reason: 'analytics_refresh_failed',
      });
      return fail(503, '刷新聚合失败');
    } finally {
      if (client) {
        let discard = false;
        if (timeoutChanged)
          await client.query('RESET statement_timeout').catch(() => {
            discard = true;
          });
        if (lockHeld)
          await client
            .query(`SELECT pg_advisory_unlock(${REFRESH_LOCK_SQL})`)
            .catch(() => {
              discard = true;
            });
        client.release(discard);
      }
      this.refreshing = false;
    }
  }
}
