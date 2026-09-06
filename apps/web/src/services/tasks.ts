import {
  createExportTaskRequestSchema,
  createExportTaskResultSchema,
  taskInfoResultSchema,
  taskListQuerySchema,
  taskListResultSchema,
  type CreateExportTaskRequest,
  type TaskInfo,
  type TaskListQuery,
  type WsMessage,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';
import type { RealtimeClient } from '../lib/realtime';

export const isTerminalTask = (status: string) =>
  ['completed', 'failed', 'cancelled'].includes(status);
export const isActiveTask = (status: string) =>
  ['pending', 'processing', 'cancelling'].includes(status);
export const isTaskMessage = (message: WsMessage) =>
  message.type === 'task_progress' ||
  message.type === 'task_complete' ||
  message.type === 'task_error' ||
  message.type === 'task_cancelled';

function taskPath(taskId: string): string {
  if (
    !taskId ||
    taskId.length > 200 ||
    taskId === '.' ||
    taskId === '..' ||
    /[\s/\\?#%]/.test(taskId) ||
    [...taskId].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new ApiError('INVALID_INPUT', '任务标识无效');
  try {
    return `/api/v1/tasks/${encodeURIComponent(taskId)}`;
  } catch {
    throw new ApiError('INVALID_INPUT', '任务标识无效');
  }
}

function requireData<T>(result: { success?: boolean; data?: T }): T {
  if (result.success !== true || result.data === undefined) {
    throw new ApiError('INVALID_RESPONSE', '任务响应缺少数据');
  }
  return result.data;
}

function validateTaskId(taskId: string, expected?: string): void {
  try {
    taskPath(taskId);
    if (expected !== undefined && taskId !== expected) throw new Error();
  } catch {
    throw new ApiError('INVALID_RESPONSE', '任务响应标识不匹配');
  }
}

export class TaskCompletionError extends Error {
  constructor(readonly task: TaskInfo) {
    super(
      (
        task.error ||
        task.message ||
        (task.status === 'cancelled' ? '任务已取消' : '任务执行失败')
      ).slice(0, 500),
    );
    this.name = 'TaskCompletionError';
  }
}

export interface WaitForTaskOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (task: TaskInfo) => void;
}

/** Cookie/legacy transport stays centralized; snapshots always come from HTTP. */
export class TaskApi {
  private readonly waits = new Set<AbortController>();
  constructor(
    private readonly http: HttpClient,
    private readonly realtime: Pick<RealtimeClient, 'onMessage'>,
  ) {}

  async list(query: TaskListQuery = {}, signal?: AbortSignal) {
    const parsed = taskListQuerySchema.safeParse(query);
    if (!parsed.success) throw new ApiError('INVALID_INPUT', '任务筛选无效');
    const data = requireData(
      await this.http.request(
        '/api/v1/tasks',
        { query: parsed.data, signal },
        taskListResultSchema,
      ),
    );
    for (const task of data) validateTaskId(task.taskId);
    return data;
  }
  async get(taskId: string, signal?: AbortSignal) {
    const data = requireData(
      await this.http.request(
        taskPath(taskId),
        { signal },
        taskInfoResultSchema,
      ),
    );
    validateTaskId(data.taskId, taskId);
    return data;
  }
  async cancel(taskId: string, signal?: AbortSignal) {
    const data = requireData(
      await this.http.request(
        `${taskPath(taskId)}/cancel`,
        { method: 'POST', signal },
        taskInfoResultSchema,
      ),
    );
    validateTaskId(data.taskId, taskId);
    return data;
  }
  async createExport(body: CreateExportTaskRequest, signal?: AbortSignal) {
    const parsed = createExportTaskRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError('INVALID_INPUT', '导出任务参数无效');
    const data = requireData(
      await this.http.request(
        '/api/v1/tasks/export',
        { method: 'POST', json: parsed.data, signal },
        createExportTaskResultSchema,
      ),
    );
    validateTaskId(data.taskId);
    return data;
  }
  /** Native browser download uses HttpOnly Cookie, never a token query or WS URL. */
  downloadURL(taskId: string): string {
    return this.http.url(`${taskPath(taskId)}/download`);
  }

  /** Stops local waiting only; server cancellation is the explicit cancel() action. */
  cancelWaits(): void {
    for (const controller of [...this.waits]) controller.abort();
  }

  async wait(
    taskId: string,
    options: WaitForTaskOptions = {},
  ): Promise<TaskInfo> {
    taskPath(taskId);
    const interval = options.intervalMs ?? 1500;
    const timeout = options.timeoutMs ?? 10 * 60 * 1000;
    if (
      !Number.isInteger(interval) ||
      interval < 250 ||
      interval > 60000 ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 2147483647
    ) {
      throw new ApiError('INVALID_INPUT', '任务等待时间配置无效');
    }
    if (this.waits.size >= 64)
      throw new ApiError('CAPACITY', '等待中的任务过多');
    const controller = new AbortController();
    this.waits.add(controller);
    return new Promise<TaskInfo>((resolve, reject) => {
      let settled = false;
      let inFlight = false;
      let refreshAgain = false;
      let progressSignature: string | undefined;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const abort = () => controller.abort();
      const cancelled = () =>
        finish(undefined, new ApiError('CANCELLED', '已停止等待任务'));
      const finish = (task?: TaskInfo, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        clearTimeout(deadline);
        controller.signal.removeEventListener('abort', cancelled);
        options.signal?.removeEventListener('abort', abort);
        try {
          unsubscribe?.();
        } catch {
          /* Complete cleanup even if a subscriber fails. */
        }
        this.waits.delete(controller);
        controller.abort();
        if (task) resolve(task);
        else reject(error);
      };
      const refresh = () => {
        if (settled) return;
        if (inFlight) {
          refreshAgain = true;
          return;
        }
        clearTimeout(pollTimer);
        inFlight = true;
        void this.get(taskId, controller.signal)
          .then((task) => {
            if (settled) return;
            const signature = JSON.stringify([
              task.status,
              task.progress,
              task.message,
              task.error,
            ]);
            if (signature !== progressSignature) {
              progressSignature = signature;
              options.onProgress?.(task);
            }
            if (task.status === 'completed') finish(task);
            else if (isTerminalTask(task.status))
              finish(undefined, new TaskCompletionError(task));
            else if (!isActiveTask(task.status))
              finish(
                undefined,
                new ApiError('INVALID_RESPONSE', '任务状态无法识别'),
              );
          })
          .catch((error: unknown) => finish(undefined, error))
          .finally(() => {
            inFlight = false;
            if (settled) return;
            if (refreshAgain) {
              refreshAgain = false;
              refresh();
            } else pollTimer = setTimeout(refresh, interval);
          });
      };
      const deadline = setTimeout(
        () => finish(undefined, new ApiError('TIMEOUT', '等待任务完成超时')),
        timeout,
      );
      controller.signal.addEventListener('abort', cancelled, { once: true });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      try {
        // Subscribe before the initial GET, so a terminal notification cannot fall in a gap.
        unsubscribe = this.realtime.onMessage((message) => {
          if (
            !isTaskMessage(message) ||
            !('taskId' in message) ||
            message.taskId !== taskId
          )
            return;
          // Progress is sampled by polling; terminal hints fetch the full result immediately.
          if (message.type !== 'task_progress') refresh();
        });
        refresh();
      } catch (error) {
        finish(undefined, error);
      }
    });
  }
}
