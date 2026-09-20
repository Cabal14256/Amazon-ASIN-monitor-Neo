import type { Env } from '@asin-monitor/config';
import { batchDeleteSyncDataSchema } from '@asin-monitor/contracts';
import {
  AsinBatchDeleteRepositoryError,
  BatchDeleteInputError,
  CompetitorTransactionError,
  CompetitorWriteError,
  parseBatchDeleteRequest,
  useAsyncBatchDelete,
  type CompetitorBatchDeleteRepositoryPort,
} from '@asin-monitor/db';
import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { TaskQueryRuntime } from '../tasks/task-query.runtime';
import { CompetitorCommitUncertainError } from './competitor-write.service';

export const COMPETITOR_BATCH_DELETE_REPOSITORY = Symbol(
  'COMPETITOR_BATCH_DELETE_REPOSITORY',
);
export class CompetitorBatchDeleteSubmissionError extends HttpException {
  constructor(taskId: string) {
    super(
      {
        success: false,
        errorCode: 500,
        errorMessage: '任务提交结果未确认，请查询此任务状态后再操作',
        data: { taskId, status: 'unknown' },
      },
      500,
    );
  }
}
function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
@Injectable()
export class CompetitorBatchDeleteService implements OnModuleDestroy {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(COMPETITOR_BATCH_DELETE_REPOSITORY)
    private readonly repository: CompetitorBatchDeleteRepositoryPort,
    @Inject(TaskQueryRuntime) private readonly runtime: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async execute(principal: AuthPrincipal, body: unknown) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有竞品入口');
    if (this.active >= 8) fail(429, '竞品写入繁忙，请稍后再试');
    this.active++;
    let taskId: string | undefined,
      closed = false;
    try {
      const accepted = await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'asin:delete');
        const request = parseBatchDeleteRequest(body);
        const analysis = await unit.analyze(request);
        if (
          !useAsyncBatchDelete(analysis, request.useAsync, {
            syncMaxItems: this.env.BATCH_DELETE_SYNC_MAX_ITEMS,
            syncMaxAsins: this.env.BATCH_DELETE_SYNC_MAX_ASINS,
            chunkSize: this.env.BATCH_DELETE_CHUNK_SIZE,
          })
        )
          return {
            mode: 'sync' as const,
            result: batchDeleteSyncDataSchema.parse(
              await unit.execute(request),
            ),
          };
        return { mode: 'async' as const, analysis };
      });
      if (accepted.mode === 'sync') {
        this.logger.info('竞品批量删除完成', 'CompetitorBatchDeleteService', {
          mode: 'sync',
        });
        return accepted.result;
      }
      const deadline = performance.now() + 3000;
      const port = this.runtime.openBatchDelete(() => {
        if (closed || performance.now() >= deadline)
          throw new Error('COMPETITOR_BATCH_DELETE_ENQUEUE_DEADLINE');
      });
      taskId = randomUUID();
      const identity = {
        taskId,
        userId: principal.userId,
        taskType: 'batch-delete' as const,
        taskSubType: 'competitor-variant-group-delete' as const,
        title: '批量删除竞品变体组' as const,
      };
      const task = await port.store.create({
        ...identity,
        message: '批量删除任务已创建，等待处理',
      });
      // Acceptance above captures authorization. Workers preserve accepted work
      // after logout, and verify task identity/cancellation/lease on every chunk.
      await port.enqueue({
        ...identity,
        createdAt: task.createdAt,
        domain: 'competitor',
        groupIds: accepted.analysis.requestedGroupIds,
        asinIds: accepted.analysis.requestedAsinIds,
      });
      this.logger.info(
        '竞品批量删除任务已创建',
        'CompetitorBatchDeleteService',
        { mode: 'async' },
      );
      return {
        mode: 'async' as const,
        taskId,
        status: 'pending' as const,
        totalRequested: accepted.analysis.totalRequested,
        estimatedAsinCount: accepted.analysis.estimatedAsinCount,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof BatchDeleteInputError && error.code === 'empty')
        fail(400, '请提供变体组ID或ASIN ID列表');
      if (error instanceof BatchDeleteInputError)
        fail(
          error.code === 'capacity' ? 413 : 400,
          '批量删除参数无效或目标数量过多',
        );
      if (
        error instanceof CompetitorWriteError &&
        error.code === 'timestamp-policy'
      )
        fail(503, '竞品写入暂不可用，请使用现有竞品入口');
      if (
        error instanceof AsinBatchDeleteRepositoryError &&
        error.code === 'parent-changed'
      )
        fail(409, 'ASIN 所属竞品组已改变，请刷新后重试');
      if (error instanceof CompetitorTransactionError) {
        if (error.code === 'capacity') fail(429, '竞品写入繁忙，请稍后再试');
        if (error.code === 'commit-uncertain') {
          this.logger.error(
            '竞品提交结果未确认',
            'CompetitorBatchDeleteService',
            { reason: 'competitor_commit_uncertain' },
          );
          throw new CompetitorCommitUncertainError();
        }
      }
      this.logger.error('竞品批量删除失败', 'CompetitorBatchDeleteService', {
        reason: taskId ? 'enqueue_outcome_unknown' : 'batch_delete_failed',
      });
      if (taskId) throw new CompetitorBatchDeleteSubmissionError(taskId);
      return fail(500, '批量删除失败');
    } finally {
      closed = true;
      this.active--;
    }
  }
  onModuleDestroy() {
    this.repository.close?.();
  }
}
