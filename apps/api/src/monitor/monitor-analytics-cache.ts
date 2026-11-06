import type { Env } from '@asin-monitor/config';
import type {
  MonitorAnalyticsOperation,
  MonitorAnalyticsQuery,
} from '@asin-monitor/db';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import {
  MetricsService,
  type AnalyticsCachePrefix,
} from '../metrics/metrics.service';
import { ApplicationRedisClient } from '../redis/redis.service';
import {
  analyticsCacheGenerationKey,
  isAnalyticsCacheGeneration,
  LOOKUP_MONITOR_ANALYTICS_CACHE,
  newAnalyticsCacheGeneration,
  WRITE_MONITOR_ANALYTICS_CACHE,
} from './monitor-analytics-cache-control';
import {
  assertMonitorJsonBounds,
  validateMonitorAnalyticsData,
  type MonitorAnalyticsData,
} from './monitor-analytics-result';

export const MONITOR_ANALYTICS_CACHE_BYTES = 2 * 1024 * 1024;
export const READ_MONITOR_ANALYTICS_CACHE = LOOKUP_MONITOR_ANALYTICS_CACHE;
type CachedResult = MonitorAnalyticsData & { generatedAt: number };
export interface MonitorAnalyticsCacheLookup {
  cached: CachedResult | null;
  lease: string | null;
}
const METRIC_PREFIXES: Partial<
  Record<MonitorAnalyticsOperation, AnalyticsCachePrefix>
> = {
  'by-time': 'statisticsByTime',
  'analytics-monthly-breakdown': 'statisticsByTime',
  'all-countries-summary': 'allCountriesSummary',
  'region-summary': 'regionSummary',
  'period-summary': 'periodSummary',
  'period-summary/details': 'periodSummaryDetails',
  'asin-by-country': 'asinStatisticsByCountry',
  'asin-by-variant-group': 'asinStatisticsByVariantGroup',
};

@Injectable()
export class MonitorAnalyticsCache {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ApplicationRedisClient)
    private readonly redis: ApplicationRedisClient,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
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
    if (this.active >= 4) {
      this.logger.warn('统计缓存暂不可用', 'MonitorAnalyticsCache', {
        reason: 'analytics_cache_unavailable',
      });
      return null;
    }
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
    return (await this.lookup(query)).cached;
  }
  async lookup(
    query: MonitorAnalyticsQuery,
  ): Promise<MonitorAnalyticsCacheLookup> {
    const ttl = this.ttl(query.operation);
    if (!ttl) return { cached: null, lease: null };
    let hit = false;
    try {
      const cached = await this.readValidated(query, ttl);
      hit = cached.cached !== null;
      return cached;
    } finally {
      const prefix = METRIC_PREFIXES[query.operation];
      if (prefix) this.metrics.recordAnalyticsCacheAccess(prefix, hit);
    }
  }
  private async readValidated(
    query: MonitorAnalyticsQuery,
    ttl: number,
  ): Promise<MonitorAnalyticsCacheLookup> {
    const key = this.key(query);
    const raw = await this.attempt(() =>
      this.redis.eval(
        READ_MONITOR_ANALYTICS_CACHE,
        [analyticsCacheGenerationKey(this.env.BULL_PREFIX), key],
        [newAnalyticsCacheGeneration(), MONITOR_ANALYTICS_CACHE_BYTES],
      ),
    );
    if (
      !Array.isArray(raw) ||
      raw.length !== 2 ||
      !isAnalyticsCacheGeneration(raw[0])
    )
      return { cached: null, lease: null };
    const lease = raw[0],
      payload = raw[1];
    if (payload === null) return { cached: null, lease };
    if (
      typeof payload !== 'string' ||
      Buffer.byteLength(payload) > MONITOR_ANALYTICS_CACHE_BYTES
    )
      return { cached: null, lease: null };
    try {
      const cached: unknown = JSON.parse(payload);
      assertMonitorJsonBounds(cached, MONITOR_ANALYTICS_CACHE_BYTES);
      if (!cached || typeof cached !== 'object' || Array.isArray(cached))
        throw new Error('CACHE_INVALID_ENVELOPE');
      const row = cached as Record<string, unknown>;
      const now = Date.now();
      if (
        row.version !== 2 ||
        row.generation !== lease ||
        row.key !== key ||
        typeof row.source !== 'string' ||
        !['raw', 'agg', 'agg:day-fallback'].includes(row.source) ||
        typeof row.generatedAt !== 'number' ||
        !Number.isSafeInteger(row.generatedAt) ||
        row.generatedAt > now ||
        typeof row.expiresAt !== 'number' ||
        !Number.isSafeInteger(row.expiresAt) ||
        row.expiresAt < row.generatedAt ||
        row.expiresAt > row.generatedAt + ttl ||
        !Number.isSafeInteger(row.generatedAt + ttl)
      )
        throw new Error('CACHE_INVALID_METADATA');
      // Ordinary expiration is a cold miss only after envelope validation.
      if (row.expiresAt <= now || row.generatedAt + ttl <= now)
        return { cached: null, lease };
      validateMonitorAnalyticsData(query.operation, row.data);
      return {
        lease,
        cached: {
          data: row.data,
          source: row.source as CachedResult['source'],
          generatedAt: row.generatedAt,
        },
      };
    } catch {
      this.logger.warn('统计缓存内容无效', 'MonitorAnalyticsCache', {
        reason: 'analytics_cache_invalid',
      });
      return { cached: null, lease };
    }
  }
  async set(
    query: MonitorAnalyticsQuery,
    result: MonitorAnalyticsData,
    generatedAt: number,
    capturedLease: string | null,
  ) {
    const ttl = this.ttl(query.operation);
    if (!ttl || !isAnalyticsCacheGeneration(capturedLease)) return;
    const key = this.key(query),
      expiresAt = generatedAt + ttl;
    const payload = {
      version: 2,
      generation: capturedLease,
      key,
      ...result,
      generatedAt,
      expiresAt,
    };
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
      this.redis.eval(
        WRITE_MONITOR_ANALYTICS_CACHE,
        [analyticsCacheGenerationKey(this.env.BULL_PREFIX), key],
        [capturedLease, encoded, remaining],
      ),
    );
  }
}
