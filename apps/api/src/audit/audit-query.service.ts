import type {
  NeoAuditLogListQuery,
  NeoAuditStatisticsQuery,
} from '@asin-monitor/contracts';
import {
  AuditQueryError,
  type AuditQueryRepositoryPort,
} from '@asin-monitor/db';
import {
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppLogger } from '../logger/app-logger.service';

export const AUDIT_QUERY_REPOSITORY = Symbol('AUDIT_QUERY_REPOSITORY');

@Injectable()
export class AuditQueryService {
  constructor(
    @Inject(AUDIT_QUERY_REPOSITORY)
    private readonly repository: AuditQueryRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async run<T>(operation: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      const reason =
        error instanceof AuditQueryError ? error.reason : 'unavailable';
      const context = { operation, reason };
      if (reason === 'capacity' || reason === 'timeout')
        this.logger.warn('审计查询暂时不可用', 'AuditQueryService', context);
      else this.logger.error('审计查询失败', 'AuditQueryService', context);
      const status =
        reason === 'capacity' ? 503 : reason === 'timeout' ? 504 : 500;
      throw new HttpException(
        { success: false, errorCode: status, errorMessage: '审计查询失败' },
        status,
      );
    }
  }
  list(query: NeoAuditLogListQuery) {
    return this.run('list', () => this.repository.list(query));
  }
  async detail(id: number) {
    const row = await this.run('detail', () => this.repository.detail(id));
    if (!row)
      throw new NotFoundException({
        success: false,
        errorCode: 404,
        errorMessage: '审计日志不存在',
      });
    return row;
  }
  actions(query: NeoAuditStatisticsQuery) {
    return this.run('actions', () => this.repository.actions(query));
  }
  resources(query: NeoAuditStatisticsQuery) {
    return this.run('resources', () => this.repository.resources(query));
  }
}
