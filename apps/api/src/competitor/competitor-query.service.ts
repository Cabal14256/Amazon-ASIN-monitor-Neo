import type { Env } from '@asin-monitor/config';
import {
  CompetitorQueryError,
  type CompetitorQueryRepositoryPort,
  type CompetitorQueryUnit,
} from '@asin-monitor/db';
import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AsinQueryInputError } from '../asin/asin-query-values';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { mapCompetitorQueryGroups } from './competitor-query-mapper';
import {
  parseCompetitorGroupId,
  parseCompetitorGroupQuery,
} from './competitor-query-values';

export const COMPETITOR_QUERY_REPOSITORY = Symbol(
  'COMPETITOR_QUERY_REPOSITORY',
);
const fail = (status: number, message: string): never => {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
};
@Injectable()
export class CompetitorQueryService implements OnModuleDestroy {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(COMPETITOR_QUERY_REPOSITORY)
    private readonly repository: CompetitorQueryRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async read<T>(
    principal: AuthPrincipal,
    operation: 'list' | 'detail',
    action: (unit: CompetitorQueryUnit) => Promise<T>,
  ) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有竞品入口');
    try {
      return await this.repository.read(async (unit) => {
        await authorizeAdministration(unit, principal, 'asin:read');
        return action(unit);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error instanceof AsinQueryInputError ||
        (error instanceof CompetitorQueryError && error.code === 'input')
      )
        fail(400, '竞品查询参数无效');
      if (error instanceof CompetitorQueryError && error.code === 'capacity')
        fail(429, '竞品查询繁忙，请稍后再试');
      if (
        error instanceof CompetitorQueryError &&
        error.code === 'too-many-children'
      )
        fail(413, '查询包含过多 ASIN，请缩小筛选范围或使用导出');
      this.logger.error('竞品查询失败', 'CompetitorQueryService', {
        operation,
        reason: 'competitor_query_failed',
      });
      return fail(500, '竞品查询失败');
    }
  }
  list(principal: AuthPrincipal, query: unknown) {
    return this.read(principal, 'list', async (unit) => {
      const parsed = parseCompetitorGroupQuery(query);
      const result = await unit.list(parsed);
      return {
        list: mapCompetitorQueryGroups(result),
        total: result.total,
        totalASINs: result.totalASINs,
        current: parsed.current,
        pageSize: parsed.pageSize,
      };
    });
  }
  detail(principal: AuthPrincipal, id: unknown) {
    return this.read(principal, 'detail', async (unit) => {
      const result = await unit.detail(parseCompetitorGroupId(id));
      if (!result.groups.length) fail(404, '竞品变体组不存在');
      return mapCompetitorQueryGroups(result)[0];
    });
  }
  onModuleDestroy() {
    this.repository.close?.();
  }
}
