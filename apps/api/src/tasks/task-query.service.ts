import type { Env } from '@asin-monitor/config';
import { backupRestoreReceiptSchema } from '@asin-monitor/contracts';
import { isTerminalTaskStatus, type TaskState } from '@asin-monitor/db';
import {
  variantCheckResultOperation,
  variantCheckResultReference,
} from '@asin-monitor/variant-check';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { backupCreationResult } from './backup-creation-result';
import {
  parseTaskId,
  parseTaskQuery,
  serializeTask,
  TaskQueryInputError,
  type QueueTaskSnapshot,
} from './task-query-values';
import { TaskQueryRuntime, type TaskQueryPort } from './task-query.runtime';
import { VariantCheckTaskResults } from './variant-check-task-results';

function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
const checkTask = (task: { taskType: string }) =>
  ['variant-check', 'batch-check'].includes(task.taskType);
const backupRestoreTask = (task: {
  taskType: string;
  taskSubType?: string | null;
}) => task.taskType === 'backup' && task.taskSubType === 'restore';
const backupTask = (task: { taskType: string }) => task.taskType === 'backup';
const cancellationSensitiveTask = (task: { taskType: string }) =>
  checkTask(task) || ['monitor', 'competitor-monitor'].includes(task.taskType);
const needsReconciliation = (task: TaskState) =>
  !isTerminalTaskStatus(task.status) ||
  (checkTask(task) && task.status === 'failed') ||
  (backupTask(task) && ['failed', 'cancelled'].includes(task.status));
@Injectable()
export class TaskQueryService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(TaskQueryRuntime) private readonly runtime: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(VariantCheckTaskResults)
    private readonly checkResults: VariantCheckTaskResults,
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
    principal: AuthPrincipal,
    ensureOpen: () => void,
    onRecovered?: (result: unknown) => void,
  ): Promise<TaskState> {
    const userId = principal.userId;
    this.owner(task, userId);
    if (!needsReconciliation(task)) return task;
    const queued = await port.findJob(task.taskId, task.taskType);
    // Cleanup, retention limits, or a lost completion acknowledgement can erase
    // the job after a business commit. Without its immutable request digest,
    // absence proves neither non-execution nor a result that we can recover.
    if (!queued) return task;
    this.owner(queued, userId);
    if (queued.taskType !== task.taskType)
      throw new Error('TASK_QUEUE_TYPE_MISMATCH');
    if (cancellationSensitiveTask(task) || backupTask(task)) {
      if (
        queued.createdAt !== task.createdAt ||
        queued.taskSubType !== task.taskSubType
      )
        throw new Error('TASK_QUEUE_IDENTITY_MISMATCH');
    }
    let current: TaskState | null = task;
    const identity = {
      userId: task.userId,
      taskType: task.taskType,
      createdAt: task.createdAt,
      ...(cancellationSensitiveTask(task) || backupTask(task)
        ? { taskSubType: task.taskSubType }
        : {}),
    };
    if (
      task.taskType === 'backup' &&
      task.taskSubType === 'create' &&
      queued.status === 'completed'
    ) {
      const receipt = backupCreationResult(task, queued);
      if (receipt) {
        ensureOpen();
        current = await port.store.mutate(
          task.taskId,
          {
            kind: 'backup-create-committed',
            result: receipt,
            message: '备份完成（已从队列恢复）',
          },
          identity,
        );
        ensureOpen();
        if (!current) fail(404, '任务不存在');
        this.owner(current, userId);
        return current;
      }
      if (isTerminalTaskStatus(task.status)) return task;
    }
    if (backupRestoreTask(task) && queued.status === 'completed') {
      const receipt = backupRestoreReceiptSchema.safeParse(queued.result);
      if (receipt.success) {
        // The in-place transaction committed or the isolated database was
        // verified and retained before registry/cancellation acknowledgements.
        // Its immutable queue incarnation is checked above.
        current = await port.store.mutate(
          task.taskId,
          {
            kind: 'restore-committed',
            result: { ...receipt.data, verification: 'unconfirmed' },
          },
          identity,
        );
        if (receipt.data.verification === 'confirmed')
          current = await port.store.mutate(
            task.taskId,
            {
              kind: 'restore-confirmed',
              result: { ...receipt.data, verification: 'confirmed' },
            },
            identity,
          );
        if (!current) fail(404, '任务不存在');
        this.owner(current, userId);
        return current;
      }
      // BullMQ completes the processor's cancellation marker too. Only a
      // validated commit receipt may override confirmed restore cancellation.
      if (isTerminalTaskStatus(task.status)) return task;
    }
    if (
      cancellationSensitiveTask(task) &&
      (queued.status === 'cancelled' ||
        ((task.cancelRequestedAt || task.status === 'cancelling') &&
          isTerminalTaskStatus(queued.status)))
    ) {
      current = await port.store.mutate(
        task.taskId,
        {
          kind: 'cancelled',
          message: ['monitor', 'competitor-monitor'].includes(task.taskType)
            ? '监控任务已取消，已提交的结果保留'
            : '检查任务已取消，已提交的检查结果保留',
        },
        identity,
      );
      if (!current) fail(404, '任务不存在');
      this.owner(current, userId);
      return current;
    }
    if (
      checkTask(task) &&
      !task.cancelRequestedAt &&
      task.status !== 'cancelling'
    ) {
      const recovered = await this.recoverCheck(
        task,
        queued,
        principal,
        ensureOpen,
      );
      if (recovered) {
        ensureOpen();
        current = await port.store.mutate(
          task.taskId,
          {
            kind: 'check-completed',
            result: recovered.reference,
            message: '检查完成',
          },
          identity,
        );
        if (!current) fail(404, '任务不存在');
        this.owner(current, userId);
        if (current.status === 'completed') onRecovered?.(recovered.result);
        return current;
      }
    }
    if (queued.status === 'completed' && !checkTask(task))
      current = await port.store.mutate(
        task.taskId,
        {
          kind: 'completed',
          result: queued.result ?? task.result,
          message: queued.message || task.message || '任务已完成',
        },
        identity,
      );
    // Cancellation may win the CAS between the initial task read and the
    // completion mutation; monitor completion deliberately leaves it pending.
    if (
      ['monitor', 'competitor-monitor'].includes(task.taskType) &&
      current?.cancelRequestedAt &&
      queued.status === 'completed'
    )
      current = await port.store.mutate(
        task.taskId,
        { kind: 'cancelled', message: '监控任务已取消，已提交的结果保留' },
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
  private async recoverCheck(
    task: TaskState | QueueTaskSnapshot,
    queued: QueueTaskSnapshot,
    principal: AuthPrincipal,
    ensureOpen: () => void,
  ) {
    if (!['completed', 'failed'].includes(queued.status)) return undefined;
    const operation =
      queued.status === 'completed'
        ? variantCheckResultOperation(task, queued.result)
        : queued.checkOperation;
    if (!operation) return undefined;
    const reference = variantCheckResultReference(operation);
    // Bind the original request digest to the independent registry identity.
    variantCheckResultOperation(task, reference);
    if (
      queued.checkOperation &&
      JSON.stringify(operation) !== JSON.stringify(queued.checkOperation)
    )
      throw new Error('TASK_QUEUE_OPERATION_MISMATCH');
    const result = await this.checkResults.read(
      { ...task, result: reference },
      principal,
      ensureOpen,
      true,
    );
    if (result === undefined) {
      if (queued.status === 'completed') fail(404, '检查结果不存在或已过期');
      return undefined;
    }
    return { reference, result };
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
            if (degraded || !needsReconciliation(task)) continue;
            try {
              ensureOpen();
              results[index] = await this.reconcile(
                port,
                task,
                principal,
                ensureOpen,
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
    return this.read(principal, 'detail', async (port, ensureOpen) => {
      const id = parseTaskId(raw);
      const task = await port.store.read(id);
      if (task) {
        let recovered: unknown;
        const current = await this.reconcile(
          port,
          task,
          principal,
          ensureOpen,
          (value) => {
            recovered = value;
          },
        );
        const response = serializeTask(current);
        if (
          current.status === 'completed' &&
          this.checkResults.isReference(current.result)
        )
          response.result =
            recovered ??
            (await this.checkResults.read(current, principal, ensureOpen));
        return response;
      }
      const queued = await port.findJob(id);
      if (!queued) fail(404, '任务不存在');
      this.owner(queued, principal.userId);
      if (checkTask(queued) && queued.status === 'failed') {
        const recovered = await this.recoverCheck(
          queued,
          queued,
          principal,
          ensureOpen,
        );
        if (recovered) {
          // Missing metadata is never recreated. The owned queue still identifies
          // the original operation for its retained result/download lifetime.
          const response = serializeTask({
            ...queued,
            status: 'completed',
            progress: 100,
            error: null,
            message: '检查完成',
            result: recovered.reference,
          });
          response.result = recovered.result;
          return response;
        }
      }
      const response = serializeTask(queued);
      if (
        queued.status === 'completed' &&
        this.checkResults.isReference(queued.result)
      )
        response.result = await this.checkResults.read(
          queued,
          principal,
          ensureOpen,
        );
      return response;
    });
  }
}
