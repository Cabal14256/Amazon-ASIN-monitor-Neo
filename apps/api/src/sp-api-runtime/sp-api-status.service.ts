import type { Env } from '@asin-monitor/config';
import type { SpApiConfigurationRepositoryPort } from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { SP_API_CONFIG_REPOSITORY } from '../sp-api-config/sp-api-config.service';
import { ApplicationSpApiRuntime } from './sp-api-runtime';
import {
  parseErrorStatsHours,
  parseQuotaStatusQuery,
  SpApiStatusInputError,
} from './sp-api-status-values';

function fail(status: number, errorMessage: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage },
    status,
  );
}
@Injectable()
export class SpApiStatusService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SP_API_CONFIG_REPOSITORY)
    private readonly repository: SpApiConfigurationRepositoryPort,
    @Inject(ApplicationSpApiRuntime)
    private readonly runtime: ApplicationSpApiRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async run<T>(
    principal: AuthPrincipal,
    action: () => Promise<T> | T,
  ): Promise<T> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有状态入口');
    if (this.active >= 8) fail(429, '状态查询繁忙，请稍后再试');
    this.active++;
    try {
      return await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'settings:read');
        return action();
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof SpApiStatusInputError) fail(400, '状态查询参数无效');
      this.logger.error('SP-API 状态查询失败', 'SpApiStatusService', {
        reason: 'status_query_failed',
      });
      return fail(500, '状态查询失败');
    } finally {
      this.active--;
    }
  }
  quota(principal: AuthPrincipal, query: unknown) {
    return this.run(principal, async () => {
      const { regions, operation } = parseQuotaStatusQuery(query);
      return Object.fromEntries(
        await Promise.all(
          regions.map(async (region) => [
            region,
            await this.runtime.getQuotaStatus(region, operation),
          ]),
        ),
      );
    });
  }
  errors(principal: AuthPrincipal, query: unknown) {
    return this.run(principal, () =>
      this.runtime.errors.getErrorStats({ hours: parseErrorStatsHours(query) }),
    );
  }
}
