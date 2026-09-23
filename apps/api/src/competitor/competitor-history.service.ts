import type { Env } from '@asin-monitor/config';
import {
  MonitorHistoryQueryError,
  parseCompetitorHistoryQuery,
  parseMonitorHistoryId,
  type CompetitorHistoryQueryRepositoryPort,
  type CompetitorHistoryQueryUnit,
} from '@asin-monitor/db';
import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';

export const COMPETITOR_HISTORY_REPOSITORY = Symbol(
  'COMPETITOR_HISTORY_REPOSITORY',
);
const fail = (status: number, message: string): never => {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
};

@Injectable()
export class CompetitorHistoryService implements OnModuleDestroy {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(COMPETITOR_HISTORY_REPOSITORY)
    private readonly repository: CompetitorHistoryQueryRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async read<T>(
    principal: AuthPrincipal,
    reply: FastifyReply,
    operation: 'list' | 'detail',
    action: (unit: CompetitorHistoryQueryUnit) => Promise<T>,
  ): Promise<T> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有竞品监控历史入口');
    if (this.active >= 2) fail(429, '竞品监控历史查询繁忙，请稍后再试');
    this.active++;
    let settled = false,
      finished = false,
      released = false;
    const release = () => {
      if (!settled || !finished || released) return;
      released = true;
      this.active--;
      clearTimeout(timer);
      reply.raw.off('finish', finish);
      reply.raw.off('close', finish);
    };
    const finish = () => {
      finished = true;
      release();
    };
    reply.raw.once('finish', finish);
    reply.raw.once('close', finish);
    const timer = setTimeout(() => reply.raw.destroy(), 60_000);
    timer.unref();
    try {
      const result = await this.repository.read(async (unit) => {
        await authorizeAdministration(unit, principal, 'monitor:read');
        return action(unit);
      });
      if (finished || reply.raw.destroyed)
        throw new Error('COMPETITOR_HISTORY_RESPONSE_CLOSED');
      return result;
    } catch (error) {
      finished = true;
      if (error instanceof HttpException) throw error;
      if (error instanceof MonitorHistoryQueryError) {
        if (error.code === 'input') fail(400, '竞品监控历史查询参数无效');
        if (error.code === 'capacity')
          fail(429, '竞品监控历史查询繁忙，请稍后再试');
        if (error.code === 'too-large')
          fail(413, '竞品监控历史结果过大，请缩小查询范围或使用导出');
      }
      this.logger.error('竞品监控历史查询失败', 'CompetitorHistoryService', {
        operation,
        reason: 'competitor_history_query_failed',
      });
      return fail(500, '查询竞品监控历史失败');
    } finally {
      settled = true;
      release();
    }
  }
  list(principal: AuthPrincipal, reply: FastifyReply, raw: unknown) {
    return this.read(principal, reply, 'list', async (unit) => {
      const query = parseCompetitorHistoryQuery(raw);
      const result = await unit.listHistory(query);
      return { ...result, current: query.current, pageSize: query.pageSize };
    });
  }
  detail(principal: AuthPrincipal, reply: FastifyReply, raw: unknown) {
    return this.read(principal, reply, 'detail', async (unit) => {
      const record = await unit.historyById(parseMonitorHistoryId(raw));
      if (!record) fail(404, '竞品监控历史不存在');
      return record;
    });
  }
  onModuleDestroy() {
    this.repository.close?.();
  }
}
