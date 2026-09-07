import type { Env } from '@asin-monitor/config';
import {
  AsinQueryRepositoryError,
  type AsinQueryRepositoryPort,
  type AsinQueryUnit,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { mapAsinQueryGroups } from './asin-query-mapper';
import {
  AsinQueryInputError,
  parseAsinGroupId,
  parseAsinGroupQuery,
} from './asin-query-values';

export const ASIN_QUERY_REPOSITORY = Symbol('ASIN_QUERY_REPOSITORY');
function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
@Injectable()
export class AsinQueryService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ASIN_QUERY_REPOSITORY)
    private readonly repository: AsinQueryRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async read<T>(
    principal: AuthPrincipal,
    operation: 'list' | 'detail',
    action: (unit: AsinQueryUnit) => Promise<T>,
  ) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有 ASIN 入口');
    if (this.active >= 8) fail(429, 'ASIN 查询繁忙，请稍后再试');
    this.active++;
    try {
      return await this.repository.read(async (unit) => {
        await authorizeAdministration(unit, principal, 'asin:read');
        return action(unit);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error instanceof AsinQueryInputError ||
        (error instanceof AsinQueryRepositoryError && error.code === 'input')
      )
        fail(400, 'ASIN 查询参数无效');
      if (
        error instanceof AsinQueryRepositoryError &&
        error.code === 'too-many-children'
      )
        fail(413, '查询包含过多 ASIN，请缩小筛选范围或使用导出');
      this.logger.error('ASIN 查询失败', 'AsinQueryService', {
        operation,
        reason: 'asin_query_failed',
      });
      return fail(500, 'ASIN 查询失败');
    } finally {
      this.active--;
    }
  }
  list(principal: AuthPrincipal, query: unknown) {
    return this.read(principal, 'list', async (unit) => {
      const parsed = parseAsinGroupQuery(query);
      const result = await unit.list(parsed);
      return {
        list: mapAsinQueryGroups(result),
        total: result.total,
        totalASINs: result.totalASINs,
        current: parsed.current,
        pageSize: parsed.pageSize,
      };
    });
  }
  detail(principal: AuthPrincipal, groupId: unknown) {
    return this.read(principal, 'detail', async (unit) => {
      const result = await unit.detail(parseAsinGroupId(groupId));
      if (!result.groups.length) fail(404, '变体组不存在');
      return mapAsinQueryGroups(result)[0];
    });
  }
}
