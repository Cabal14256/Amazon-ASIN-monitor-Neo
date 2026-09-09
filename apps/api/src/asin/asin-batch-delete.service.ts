import type { Env } from '@asin-monitor/config';
import {
  AsinBatchDeleteRepositoryError,
  AsinTimestampPolicyError,
  BatchDeleteInputError,
  parseBatchDeleteRequest,
  useAsyncBatchDelete,
  type AsinBatchDeleteRepositoryPort,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { TaskQueryRuntime } from '../tasks/task-query.runtime';

export const ASIN_BATCH_DELETE_REPOSITORY = Symbol(
  'ASIN_BATCH_DELETE_REPOSITORY',
);
/** A fixed public error with a server-generated lookup ID; never driver payload. */
export class BatchDeleteSubmissionError extends HttpException {
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
    {
      success: false,
      errorCode: status,
      errorMessage: message,
    },
    status,
  );
}
@Injectable()
export class AsinBatchDeleteService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ASIN_BATCH_DELETE_REPOSITORY)
    private readonly repository: AsinBatchDeleteRepositoryPort,
    @Inject(TaskQueryRuntime) private readonly runtime: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async execute(principal: AuthPrincipal, body: unknown) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有 ASIN 入口');
    if (this.active >= 8) fail(429, 'ASIN 写入繁忙，请稍后再试');
    this.active++;
    let taskId: string | undefined;
    let closed = false;
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
          return { mode: 'sync' as const, result: await unit.execute(request) };
        // Authorization is checked at acceptance under current user/session/RBAC locks.
        // Accepted background work remains valid after logout, as in Legacy.
        return { mode: 'async' as const, analysis };
      });
      if (accepted.mode === 'sync') {
        this.logger.info('ASIN 批量删除完成', 'AsinBatchDeleteService', {
          mode: 'sync',
        });
        return accepted.result;
      }
      const deadline = performance.now() + 3000;
      const port = this.runtime.openBatchDelete(() => {
        if (closed || performance.now() >= deadline)
          throw new Error('BATCH_DELETE_ENQUEUE_DEADLINE');
      });
      taskId = randomUUID();
      const task = await port.store.create({
        taskId,
        userId: principal.userId,
        taskType: 'batch-delete',
        taskSubType: 'variant-group-delete',
        title: '批量删除变体组',
        message: '批量删除任务已创建，等待处理',
      });
      await port.enqueue({
        taskId,
        userId: principal.userId,
        createdAt: task.createdAt,
        taskType: 'batch-delete',
        taskSubType: 'variant-group-delete',
        title: '批量删除变体组',
        domain: 'asin',
        groupIds: accepted.analysis.requestedGroupIds,
        asinIds: accepted.analysis.requestedAsinIds,
      });
      this.logger.info('ASIN 批量删除任务已创建', 'AsinBatchDeleteService', {
        mode: 'async',
      });
      return {
        mode: 'async' as const,
        taskId,
        status: 'pending' as const,
        totalRequested: accepted.analysis.totalRequested,
        estimatedAsinCount: accepted.analysis.estimatedAsinCount,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof BatchDeleteInputError)
        fail(
          error.code === 'capacity' ? 413 : 400,
          '批量删除参数无效或目标数量过多',
        );
      if (error instanceof AsinTimestampPolicyError)
        fail(503, 'ASIN 写入暂不可用，请使用现有 ASIN 入口');
      if (error instanceof AsinBatchDeleteRepositoryError) {
        if (error.code === 'capacity') fail(429, 'ASIN 写入繁忙，请稍后再试');
        if (error.code === 'parent-changed')
          fail(409, 'ASIN 所属变体组已改变，请刷新后重试');
      }
      this.logger.error('ASIN 批量删除失败', 'AsinBatchDeleteService', {
        reason: taskId ? 'enqueue_outcome_unknown' : 'batch_delete_failed',
      });
      // A timed-out Redis acknowledgement can still have committed. Never remove an
      // uncertain job or overwrite its terminal state; return the same ID for lookup.
      if (taskId) throw new BatchDeleteSubmissionError(taskId);
      return fail(500, '批量删除失败');
    } finally {
      closed = true;
      this.active--;
    }
  }
}
