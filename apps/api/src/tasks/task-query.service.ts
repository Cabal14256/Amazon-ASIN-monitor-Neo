import type { Env } from '@asin-monitor/config';
import { isTerminalTaskStatus, type TaskState } from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import {
  parseTaskId,
  parseTaskQuery,
  serializeTask,
  TaskQueryInputError,
  type QueueTaskSnapshot,
} from './task-query-values';
import { TaskQueryRuntime, type TaskQueryPort } from './task-query.runtime';

function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
@Injectable()
export class TaskQueryService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(TaskQueryRuntime) private readonly runtime: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private owner(task: TaskState | QueueTaskSnapshot, userId: string) {
    if (!task.userId || task.userId !== userId) fail(403, '无权访问此任务');
  }
  private async read<T>(
    principal: AuthPrincipal,
    operation: 'list' | 'detail',
    action: (port: TaskQueryPort, ensureOpen: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有任务入口');
    if (this.active >= 8) fail(429, '任务查询繁忙，请稍后再试');
    this.active++;
    const deadline = performance.now() + 3000;
    let closed = false;
    const ensureOpen = () => {
      if (closed || performance.now() >= deadline)
        throw new Error('TASK_QUERY_DEADLINE');
    };
    try {
      return await action(this.runtime.open(ensureOpen), ensureOpen);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof TaskQueryInputError) fail(400, '任务查询参数无效');
      this.logger.error('任务查询失败', 'TaskQueryService', {
        operation,
        reason: 'task_query_failed',
      });
      return fail(500, '任务查询失败');
    } finally {
      closed = true;
      this.active--;
    }
  }
  private async reconcile(
    port: TaskQueryPort,
    task: TaskState,
    userId: string,
  ): Promise<TaskState> {
    this.owner(task, userId);
    if (isTerminalTaskStatus(task.status)) return task;
    const queued = await port.findJob(task.taskId, task.taskType);
    if (!queued) return task;
    this.owner(queued, userId);
    if (queued.taskType !== task.taskType)
      throw new Error('TASK_QUEUE_TYPE_MISMATCH');
    let current: TaskState | null = task;
    const identity = {
      userId: task.userId,
      taskType: task.taskType,
      createdAt: task.createdAt,
    };
    if (queued.status === 'completed')
      current = await port.store.mutate(
        task.taskId,
        {
          kind: 'completed',
          result: queued.result ?? task.result,
          message: queued.message || task.message || '任务已完成',
        },
        identity,
      );
    if (queued.status === 'failed')
      current = await port.store.mutate(
        task.taskId,
        {
          kind: 'failed',
          message: '任务执行失败',
        },
        identity,
      );
    if (!current) fail(404, '任务不存在');
    this.owner(current, userId);
    return current;
  }
  list(principal: AuthPrincipal, raw: unknown) {
    return this.read(principal, 'list', async (port, ensureOpen) => {
      const tasks = await port.store.listUser(
        principal.userId,
        parseTaskQuery(raw),
      );
      const results = [...tasks];
      tasks.forEach((task) => this.owner(task, principal.userId));
      let next = 0,
        degraded = false;
      // At most four reconciliations per request; a failed/deadline dependency stops further queue work.
      await Promise.all(
        Array.from({ length: Math.min(4, tasks.length) }, async () => {
          while (next < tasks.length) {
            const index = next++,
              task = tasks[index];
            if (degraded || isTerminalTaskStatus(task.status)) continue;
            try {
              ensureOpen();
              results[index] = await this.reconcile(
                port,
                task,
                principal.userId,
              );
            } catch {
              degraded = true;
            }
          }
        }),
      );
      if (degraded)
        this.logger.warn('任务列表对账暂不可用', 'TaskQueryService', {
          reason: 'queue_reconciliation_failed',
        });
      return results.map(serializeTask);
    });
  }
  detail(principal: AuthPrincipal, raw: unknown) {
    return this.read(principal, 'detail', async (port) => {
      const id = parseTaskId(raw);
      const task = await port.store.read(id);
      if (task)
        return serializeTask(
          await this.reconcile(port, task, principal.userId),
        );
      const queued = await port.findJob(id);
      if (!queued) fail(404, '任务不存在');
      this.owner(queued, principal.userId);
      return serializeTask(queued);
    });
  }
}
