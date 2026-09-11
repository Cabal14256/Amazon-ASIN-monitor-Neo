import type { Env } from '@asin-monitor/config';
import { isTerminalTaskStatus, TaskRegistryError } from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { CANCELLABLE_TASK_TYPES } from './task-cancellation-script';
import {
  parseTaskId,
  serializeTask,
  TaskQueryInputError,
} from './task-query-values';
import { TaskQueryRuntime } from './task-query.runtime';

function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
@Injectable()
export class TaskCancellationService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(TaskQueryRuntime) private readonly runtime: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async cancel(principal: AuthPrincipal, raw: unknown) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有任务入口');
    if (this.active >= 8) fail(429, '任务取消繁忙，请稍后再试');
    this.active++;
    const deadline = performance.now() + 3000;
    let closed = false;
    const ensureOpen = () => {
      if (closed || performance.now() >= deadline)
        throw new Error('TASK_CANCEL_DEADLINE');
    };
    try {
      const id = parseTaskId(raw);
      const port = this.runtime.openCancellation(ensureOpen);
      const task = await port.store.read(id);
      if (!task) fail(404, '任务不存在');
      if (!task.userId || task.userId !== principal.userId)
        fail(403, '无权取消此任务');
      if (isTerminalTaskStatus(task.status)) fail(400, '任务已结束，无法取消');
      if (!CANCELLABLE_TASK_TYPES.some((type) => type === task.taskType))
        fail(400, '该任务类型不支持取消');
      ensureOpen();
      const outcome = await port.cancelJob(task);
      if (outcome === 'expired') fail(404, '任务不存在');
      if (outcome === 'foreign') fail(403, '无权取消此任务');
      if (outcome === 'identity-changed') fail(409, '任务已变化，请刷新后重试');
      if (outcome === 'terminal') fail(400, '任务已结束，无法取消');
      if (outcome === 'unsupported') fail(400, '该任务类型不支持取消');
      ensureOpen();
      const next = await port.store.mutate(
        id,
        outcome === 'running'
          ? { kind: 'cancel-request' }
          : {
              kind: 'cancelled',
              message:
                outcome === 'removed'
                  ? '任务已取消（尚未开始执行）'
                  : '任务已取消',
            },
        {
          userId: task.userId,
          taskType: task.taskType,
          createdAt: task.createdAt,
        },
      );
      if (!next) fail(404, '任务不存在');
      if (next.userId !== principal.userId) fail(403, '无权取消此任务');
      if (next.status === 'completed' || next.status === 'failed')
        fail(400, '任务已结束，无法取消');
      this.logger.info('任务取消请求已处理', 'TaskCancellationService', {
        status: next.status,
      });
      return serializeTask(next);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof TaskQueryInputError) fail(400, '任务参数无效');
      if (
        error instanceof TaskRegistryError &&
        error.code === 'TASK_IDENTITY_CHANGED'
      )
        fail(409, '任务已变化，请刷新后重试');
      this.logger.error('取消任务失败', 'TaskCancellationService', {
        reason: 'task_cancellation_failed',
      });
      return fail(500, '取消任务失败，请刷新任务状态后重试');
    } finally {
      closed = true;
      this.active--;
    }
  }
}
