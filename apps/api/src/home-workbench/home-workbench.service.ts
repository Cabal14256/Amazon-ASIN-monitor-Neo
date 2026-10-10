import type { Env } from '@asin-monitor/config';
import { homeWorkbenchDataSchema } from '@asin-monitor/contracts';
import {
  HomeWorkbenchQueryError,
  MAX_HOME_WORKBENCH_BYTES,
  MonitorAnalyticsQueryError,
  MonitorAnalyticsResultLimitError,
  parseHomeWorkbenchQuery,
  type HomeWorkbenchQueryRepositoryPort,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { MonitorAnalyticsAdmission } from '../monitor/monitor-analytics-admission';
import { assertMonitorJsonBounds } from '../monitor/monitor-analytics-result';

export const HOME_WORKBENCH_REPOSITORY = Symbol('HOME_WORKBENCH_REPOSITORY');
function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
function isTimeout(error: unknown) {
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
@Injectable()
export class HomeWorkbenchService {
  private readonly admission = new MonitorAnalyticsAdmission({
    capacity: '首页工作台查询繁忙，请稍后重试',
    timeout: '首页工作台查询超时，请缩小筛选范围后重试',
  });
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(HOME_WORKBENCH_REPOSITORY)
    private readonly repository: HomeWorkbenchQueryRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  admit<T>(reply: FastifyReply, action: () => Promise<T>) {
    return this.admission.run(reply, action);
  }
  read(
    principal: AuthPrincipal,
    reply: FastifyReply,
    input: unknown,
  ): Promise<string> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有首页');
    return this.admission.run(reply, async (ensureOpen) => {
      try {
        const query = parseHomeWorkbenchQuery(input);
        const encoded = await this.repository.read(async (unit) => {
          await authorizeAdministration(unit, principal, 'asin:read');
          ensureOpen();
          const codes = await unit.operatorPermissionCodes(principal.userId);
          ensureOpen();
          const trendsAuthorized =
            codes.includes('monitor:read') || codes.includes('analytics:read');
          const data = await unit.workbench(
            query,
            new Date(),
            trendsAuthorized,
          );
          ensureOpen();
          const body = { success: true, errorCode: 0, data };
          assertMonitorJsonBounds(body, MAX_HOME_WORKBENCH_BYTES, ensureOpen);
          if (
            !homeWorkbenchDataSchema.safeParse(data).success ||
            data.trendsAuthorized !== trendsAuthorized
          )
            throw new HomeWorkbenchQueryError('result');
          const value = JSON.stringify(body);
          ensureOpen();
          return value;
        });
        ensureOpen();
        return encoded;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        if (error instanceof HomeWorkbenchQueryError && error.code === 'input')
          fail(400, '首页筛选参数无效，请减少页数或缩小筛选范围');
        if (
          error instanceof MonitorAnalyticsQueryError &&
          error.code === 'capacity'
        )
          fail(429, '首页工作台查询繁忙，请稍后重试');
        if (
          error instanceof MonitorAnalyticsResultLimitError ||
          (error instanceof HomeWorkbenchQueryError &&
            error.code === 'too-large')
        )
          fail(413, '首页工作台结果过大，请缩小筛选范围');
        if (isTimeout(error)) {
          this.logger.warn('首页工作台查询超时', 'HomeWorkbenchService', {
            reason: 'home_workbench_timeout',
          });
          fail(504, '首页工作台查询超时，请缩小筛选范围后重试');
        }
        this.logger.error('首页工作台查询失败', 'HomeWorkbenchService', {
          reason: 'home_workbench_failed',
        });
        return fail(500, '无法读取首页工作台，请稍后重试');
      }
    });
  }
}
