import type { Env } from '@asin-monitor/config';
import type { PermissionCode } from '@asin-monitor/contracts';
import {
  MonitorAnalyticsQueryError,
  MonitorAnalyticsResultLimitError,
  parseMonitorAnalyticsQuery,
  type MonitorAnalyticsOperation,
  type MonitorAnalyticsQuery,
  type MonitorAnalyticsQueryRepositoryPort,
  type MonitorAnalyticsQueryUnit,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { authorizeAdministrationAny } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { MonitorAnalyticsAdmission } from './monitor-analytics-admission';
import { MonitorAnalyticsCache } from './monitor-analytics-cache';
import {
  encodeMonitorAnalyticsResult,
  validateMonitorAnalyticsData,
  type MonitorAnalyticsData,
} from './monitor-analytics-result';
import {
  buildMonitorMonthlyBreakdown,
  buildMonitorPeakMarkAreas,
  resolveMonitorMonthlyRange,
  type MonitorMonthlySourceRow,
} from './monitor-analytics-view';

export const MONITOR_ANALYTICS_REPOSITORY = Symbol(
  'MONITOR_ANALYTICS_REPOSITORY',
);
export function monitorAnalyticsPermissions(
  operation: MonitorAnalyticsOperation,
): readonly PermissionCode[] {
  if (
    operation === 'statistics' ||
    operation === 'peak-hours' ||
    operation === 'abnormal-duration-statistics'
  )
    return ['monitor:read', 'analytics:read'];
  return ['analytics:read'];
}
const fail = (status: number, message: string): never => {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
};
function timedOut(error: unknown): boolean {
  for (
    let depth = 0;
    error && typeof error === 'object' && depth < 4;
    depth++
  ) {
    const row = error as { code?: unknown; cause?: unknown };
    if (['57014', '55P03', 'timeout'].includes(String(row.code))) return true;
    error = row.cause;
  }
  return false;
}

@Injectable()
export class MonitorAnalyticsService {
  private readonly admission = new MonitorAnalyticsAdmission();
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(MONITOR_ANALYTICS_REPOSITORY)
    private readonly repository: MonitorAnalyticsQueryRepositoryPort,
    @Inject(MonitorAnalyticsCache)
    private readonly cache: MonitorAnalyticsCache,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private bypass(operation: MonitorAnalyticsOperation, header: unknown) {
    if (
      !['all-countries-summary', 'region-summary', 'period-summary'].includes(
        operation,
      )
    )
      return false;
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== 'string' || value.trim() !== '1') return false;
    if (this.env.ANALYTICS_BENCHMARK_CACHE_BYPASS_ENABLED) return true;
    this.logger.warn('统计缓存绕过请求未启用', 'MonitorAnalyticsService', {
      reason: 'analytics_cache_bypass_disabled',
    });
    return false;
  }
  private async execute(
    unit: MonitorAnalyticsQueryUnit,
    query: MonitorAnalyticsQuery,
  ): Promise<MonitorAnalyticsData> {
    switch (query.operation) {
      case 'by-country':
      case 'by-variant-group':
        return { data: await unit.counts(query), source: 'raw' };
      case 'peak-hours':
        return { data: await unit.peak(query), source: 'raw' };
      case 'period-summary':
      case 'period-summary/details':
        return unit.period(query);
      case 'abnormal-duration-statistics':
        return unit.abnormal(query);
      case 'peak-mark-areas':
        return {
          data: buildMonitorPeakMarkAreas({
            ...query,
            startTime: query.startTime!,
            endTime: query.endTime!,
          }),
          source: 'raw',
        };
      case 'analytics-monthly-breakdown': {
        const result = await unit.duration(query);
        validateMonitorAnalyticsData('by-time', result.data);
        return {
          data: buildMonitorMonthlyBreakdown(
            result.data as MonitorMonthlySourceRow[],
            query.month,
          ),
          source: result.source,
        };
      }
      default:
        return unit.duration(query);
    }
  }
  admit<T>(reply: FastifyReply, action: () => Promise<T>) {
    return this.admission.run(reply, action);
  }
  async read(
    principal: AuthPrincipal,
    reply: FastifyReply,
    operation: MonitorAnalyticsOperation,
    raw: unknown,
    bypassHeader?: unknown,
  ): Promise<string> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有统计入口');
    return this.admission.run(reply, async (assertOpen) => {
      const expires = Date.now() + 10000;
      const ensureOpen = () => {
        assertOpen();
        if (Date.now() >= expires)
          throw new MonitorAnalyticsQueryError('timeout');
      };
      try {
        const response = await this.repository.read(async (unit) => {
          await authorizeAdministrationAny(
            unit,
            principal,
            monitorAnalyticsPermissions(operation),
          );
          ensureOpen();
          let query = parseMonitorAnalyticsQuery(operation, raw);
          if (operation === 'analytics-monthly-breakdown') {
            const range = resolveMonitorMonthlyRange(query);
            query = {
              ...query,
              month: range.month,
              startTime: range.startTime,
              endTime: range.endTime,
            };
            // Resolve Legacy fallback month before cache key construction; never
            // cache an implicit "current month" under an unchanging key.
          }
          const bypass = this.bypass(operation, bypassHeader);
          const cached = bypass ? null : await this.cache.get(query);
          ensureOpen();
          if (cached)
            return encodeMonitorAnalyticsResult(
              operation,
              cached,
              cached.generatedAt,
              true,
              ensureOpen,
            );
          const result = await this.execute(unit, query);
          ensureOpen();
          const generatedAt = Date.now();
          const encoded = encodeMonitorAnalyticsResult(
            operation,
            result,
            generatedAt,
            false,
            ensureOpen,
          );
          if (!bypass) await this.cache.set(query, result, generatedAt);
          ensureOpen();
          return encoded;
        });
        ensureOpen();
        return response;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        if (error instanceof MonitorAnalyticsQueryError) {
          if (error.code === 'input') {
            const query =
              raw && typeof raw === 'object'
                ? (raw as Record<string, unknown>)
                : {};
            if (operation === 'peak-hours' && !query.country)
              fail(400, '高峰期统计需要指定国家');
            if (
              operation === 'peak-mark-areas' &&
              (!query.startTime || !query.endTime)
            )
              fail(400, '请提供开始时间和结束时间');
            fail(400, '统计查询参数无效');
          }
          if (error.code === 'capacity') fail(429, '统计查询繁忙，请稍后再试');
        }
        if (
          error instanceof MonitorAnalyticsResultLimitError ||
          (operation === 'peak-mark-areas' && error instanceof RangeError)
        )
          fail(413, '统计结果过大，请缩小查询范围');
        if (timedOut(error)) {
          this.logger.warn('统计查询超时', 'MonitorAnalyticsService', {
            operation,
            reason: 'analytics_query_timeout',
          });
          fail(504, '查询超时，请尝试缩小时间范围或稍后重试');
        }
        this.logger.error('统计查询失败', 'MonitorAnalyticsService', {
          operation,
          reason: 'analytics_query_failed',
        });
        return fail(500, '查询统计失败');
      }
    });
  }
}
