import type { Env } from '@asin-monitor/config';
import type {
  MonitorAnalyticsOperation,
  MonitorAnalyticsQuery,
} from '@asin-monitor/db';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { ApplicationRedisClient } from '../redis/redis.service';
import {
  assertMonitorJsonBounds,
  validateMonitorAnalyticsData,
  type MonitorAnalyticsData,
} from './monitor-analytics-result';

export const MONITOR_ANALYTICS_CACHE_BYTES = 2 * 1024 * 1024;
// STRLEN and GET share a Redis command; oversized values never cross the wire.
export const READ_MONITOR_ANALYTICS_CACHE = `
if redis.call('STRLEN', KEYS[1]) > tonumber(ARGV[1]) then return false end
return redis.call('GET', KEYS[1])`;
const WRITE_CACHE = `return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])`;
type CachedResult = MonitorAnalyticsData & { generatedAt: number };

@Injectable()
export class MonitorAnalyticsCache {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ApplicationRedisClient)
    private readonly redis: ApplicationRedisClient,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  ttl(operation: MonitorAnalyticsOperation) {
    switch (operation) {
      case 'by-time':
      case 'analytics-monthly-breakdown':
        return this.env.ANALYTICS_STATISTICS_BY_TIME_TTL_MS;
      case 'all-countries-summary':
        return this.env.ANALYTICS_ALL_COUNTRIES_SUMMARY_TTL_MS;
      case 'region-summary':
        return this.env.ANALYTICS_REGION_SUMMARY_TTL_MS;
      case 'period-summary':
      case 'period-summary/details':
        return this.env.ANALYTICS_PERIOD_SUMMARY_TTL_MS;
      case 'asin-by-country':
        return this.env.ANALYTICS_ASIN_COUNTRY_TTL_MS;
      case 'asin-by-variant-group':
        return this.env.ANALYTICS_ASIN_VARIANT_GROUP_TTL_MS;
      default:
        return 0;
    }
  }
  key(query: MonitorAnalyticsQuery) {
    // Query is normalized before hashing. Flags isolate rollback configurations.
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          query,
          aggregate: this.env.ANALYTICS_AGG_ENABLED,
          intervals: this.env.ANALYTICS_STATUS_INTERVAL_ENABLED,
        }),
      )
      .digest('hex');
    return `${this.env.BULL_PREFIX.trim()}:neo:analytics:v1:${hash}`;
  }
  private async attempt<T>(action: () => Promise<T>): Promise<T | null> {
    if (this.active >= 4) return null;
    this.active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Retain admission until the underlying command actually settles, including
    // a connection whose configured probe timeout exceeds this cache budget.
    const work = Promise.resolve()
      .then(action)
      .finally(() => this.active--);
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('CACHE_TIMEOUT')), 500);
        }),
      ]);
    } catch {
      this.logger.warn('统计缓存暂不可用', 'MonitorAnalyticsCache', {
        reason: 'analytics_cache_unavailable',
      });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async get(query: MonitorAnalyticsQuery): Promise<CachedResult | null> {
    const ttl = this.ttl(query.operation);
    if (!ttl) return null;
    const key = this.key(query);
    const raw = await this.attempt(() =>
      this.redis.eval(
        READ_MONITOR_ANALYTICS_CACHE,
        [key],
        [MONITOR_ANALYTICS_CACHE_BYTES],
      ),
    );
    if (
      typeof raw !== 'string' ||
      Buffer.byteLength(raw) > MONITOR_ANALYTICS_CACHE_BYTES
    )
      return null;
    try {
      const cached: unknown = JSON.parse(raw);
      assertMonitorJsonBounds(cached, MONITOR_ANALYTICS_CACHE_BYTES);
      if (!cached || typeof cached !== 'object' || Array.isArray(cached))
        return null;
      const row = cached as Record<string, unknown>;
      const now = Date.now();
      if (
        row.version !== 1 ||
        row.key !== key ||
        !['raw', 'agg', 'agg:day-fallback'].includes(String(row.source)) ||
        typeof row.generatedAt !== 'number' ||
        !Number.isSafeInteger(row.generatedAt) ||
        row.generatedAt > now ||
        typeof row.expiresAt !== 'number' ||
        !Number.isSafeInteger(row.expiresAt) ||
        row.expiresAt <= now ||
        row.expiresAt > row.generatedAt + ttl ||
        row.generatedAt + ttl <= now
      )
        return null;
      validateMonitorAnalyticsData(query.operation, row.data);
      return {
        data: row.data,
        source: row.source as CachedResult['source'],
        generatedAt: row.generatedAt,
      };
    } catch {
      this.logger.warn('统计缓存内容无效', 'MonitorAnalyticsCache', {
        reason: 'analytics_cache_invalid',
      });
      return null;
    }
  }
  async set(
    query: MonitorAnalyticsQuery,
    result: MonitorAnalyticsData,
    generatedAt: number,
  ) {
    const ttl = this.ttl(query.operation);
    if (!ttl) return;
    const key = this.key(query),
      expiresAt = generatedAt + ttl;
    const payload = { version: 1, key, ...result, generatedAt, expiresAt };
    // Large valid responses are delivered whole without occupying Redis cache.
    try {
      assertMonitorJsonBounds(payload, MONITOR_ANALYTICS_CACHE_BYTES);
    } catch {
      return;
    }
    const encoded = JSON.stringify(payload);
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return;
    await this.attempt(() =>
      this.redis.eval(WRITE_CACHE, [key], [encoded, remaining]),
    );
  }
}
