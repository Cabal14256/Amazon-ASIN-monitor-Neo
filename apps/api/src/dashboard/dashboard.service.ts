import type { Env } from '@asin-monitor/config';
import { dashboardDataSchema } from '@asin-monitor/contracts';
import {
  dashboardDayStart,
  DashboardQueryError,
  MAX_DASHBOARD_RESPONSE_BYTES,
  MonitorAnalyticsQueryError,
  MonitorAnalyticsResultLimitError,
  type DashboardQueryRepositoryPort,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { authorizeCurrentSession } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { MonitorAnalyticsAdmission } from '../monitor/monitor-analytics-admission';
import { assertMonitorJsonBounds } from '../monitor/monitor-analytics-result';

export const DASHBOARD_REPOSITORY = Symbol('DASHBOARD_REPOSITORY');
const fail = (status: number, message: string): never => {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
};
function timeout(error: unknown) {
  for (
    let depth = 0;
    depth < 3 && error && typeof error === 'object';
    depth++
  ) {
    if (error instanceof MonitorAnalyticsQueryError && error.code === 'timeout')
      return true;
    const item = error as { code?: unknown; cause?: unknown };
    if (['57014', '55P03', 'ETIMEDOUT'].includes(String(item.code)))
      return true;
    error = item.cause;
  }
  return false;
}
interface CacheEntry {
  day: string;
  encoded: string;
  generatedAt: number;
  expiresAt: number;
  sequence: number;
}
@Injectable()
export class DashboardService {
  private readonly admission = new MonitorAnalyticsAdmission({
    capacity: '仪表盘查询繁忙，请稍后重试',
    timeout: '查询仪表盘超时，请稍后重试',
  });
  private cache: CacheEntry | undefined;
  private sequence = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DASHBOARD_REPOSITORY)
    private readonly repository: DashboardQueryRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  admit<T>(reply: FastifyReply, action: () => Promise<T>) {
    return this.admission.run(reply, action);
  }
  read(principal: AuthPrincipal, reply: FastifyReply): Promise<string> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有仪表盘入口');
    return this.admission.run(reply, async (assertOpen) => {
      const expires = Date.now() + 10_000;
      const ensureOpen = () => {
        assertOpen();
        if (Date.now() >= expires)
          throw new MonitorAnalyticsQueryError('timeout');
      };
      try {
        let candidate: CacheEntry | undefined;
        const encoded = await this.repository.read(async (unit) => {
          await authorizeCurrentSession(unit, principal);
          ensureOpen();
          const now = new Date(),
            day = dashboardDayStart(now),
            cached = this.cache;
          if (
            cached &&
            cached.day === day &&
            now.getTime() >= cached.generatedAt &&
            now.getTime() < cached.expiresAt
          )
            return cached.encoded;
          const sequence = ++this.sequence;
          const data = await unit.dashboard(now);
          ensureOpen();
          const body = { success: true, data, errorCode: 0 };
          assertMonitorJsonBounds(
            body,
            MAX_DASHBOARD_RESPONSE_BYTES,
            ensureOpen,
          );
          if (!dashboardDataSchema.safeParse(data).success)
            throw new DashboardQueryError('result');
          ensureOpen();
          const value = JSON.stringify(body);
          ensureOpen();
          const generatedAt = Date.now();
          candidate = {
            day,
            encoded: value,
            generatedAt,
            expiresAt: generatedAt + 30_000,
            sequence,
          };
          return value;
        });
        ensureOpen();
        // Publish only after the read transaction commits. A slower older
        // query must not overwrite a newer completed cache generation.
        if (
          candidate &&
          (!this.cache || candidate.sequence > this.cache.sequence)
        )
          this.cache = candidate;
        return encoded;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        if (
          error instanceof MonitorAnalyticsQueryError &&
          error.code === 'capacity'
        )
          fail(429, '仪表盘查询繁忙，请稍后重试');
        if (
          error instanceof MonitorAnalyticsResultLimitError ||
          (error instanceof DashboardQueryError && error.code === 'too-large')
        )
          fail(413, '仪表盘结果过大，请联系管理员');
        if (timeout(error)) {
          this.logger.warn('仪表盘查询超时', 'DashboardService', {
            reason: 'dashboard_query_timeout',
          });
          fail(504, '查询仪表盘超时，请稍后重试');
        }
        this.logger.error('仪表盘查询失败', 'DashboardService', {
          reason: 'dashboard_query_failed',
        });
        return fail(500, '获取仪表盘数据失败');
      }
    });
  }
}
