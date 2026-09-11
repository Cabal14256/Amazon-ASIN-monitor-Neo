import type { WsMessage } from '@asin-monitor/contracts';
import {
  parseTaskNotification,
  type TaskNotification,
  type TaskState,
} from '@asin-monitor/db';
import { serializeTask } from '../tasks/task-query-values';
import type { WebSocketEvent } from './websocket-events';

const MAX_PENDING = 256;
const MAX_ACTIVE = 8;
const MAX_SEEN = 4096;
const identity = (task: TaskNotification | TaskState) =>
  JSON.stringify([task.taskId, task.userId, task.taskType, task.createdAt]);

function message(task: TaskState): WsMessage {
  const timestamp = new Date(Date.parse(task.updatedAt) + 8 * 3600_000)
    .toISOString()
    .replace('Z', '+08:00');
  const common = { taskId: task.taskId, timestamp };
  if (task.status === 'completed') {
    const { downloadUrl, filename } = serializeTask(task);
    return { ...common, type: 'task_complete', downloadUrl, filename };
  }
  if (task.status === 'failed')
    return {
      ...common,
      type: 'task_error',
      error: '任务执行失败，请查看任务详情',
    };
  if (task.status === 'cancelled')
    return { ...common, type: 'task_cancelled', message: task.message };
  return {
    ...common,
    type: 'task_progress',
    progress: task.progress,
    message: task.message,
  };
}

/** Pub/Sub is a hint. Authoritative reads enforce ownership, incarnation and revision. */
export class TaskNotificationConsumer {
  private readonly pending = new Map<string, TaskNotification>();
  private readonly active = new Set<string>();
  private readonly seen = new Map<string, number>();
  private generation = 0;
  private stopped = false;

  constructor(
    private readonly read: (taskId: string) => Promise<TaskState | null>,
    private readonly deliver: (event: WebSocketEvent) => void,
    private readonly warn: (reason: string) => void,
  ) {}

  receive(raw: string): void {
    if (this.stopped) return;
    const notice = parseTaskNotification(raw);
    if (!notice) {
      this.warn('invalid_task_notification');
      return;
    }
    const key = identity(notice);
    if ((this.seen.get(key) ?? -1) >= notice.revision) return;
    const queued = this.pending.get(key);
    if (queued && queued.revision >= notice.revision) return;
    if (!queued && this.pending.size >= MAX_PENDING) {
      this.warn('task_notification_overload');
      return; // The authenticated HTTP snapshot remains the recovery source.
    }
    this.pending.set(key, notice);
    this.pump();
  }

  private pump(): void {
    if (this.stopped) return;
    for (const [key, notice] of this.pending) {
      if (this.active.size >= MAX_ACTIVE) break;
      if (this.active.has(key)) continue;
      this.pending.delete(key);
      if ((this.seen.get(key) ?? -1) >= notice.revision) continue;
      this.active.add(key);
      const generation = this.generation;
      void this.process(key, notice, generation).finally(() => {
        this.active.delete(key);
        this.pump();
      });
    }
  }

  private async process(
    key: string,
    notice: TaskNotification,
    generation: number,
  ) {
    try {
      const task = await this.read(notice.taskId);
      if (
        this.stopped ||
        generation !== this.generation ||
        !task ||
        identity(task) !== key ||
        task.revision < notice.revision ||
        (this.seen.get(key) ?? -1) >= task.revision
      )
        return;
      this.deliver({
        audience: 'user',
        userId: task.userId,
        message: message(task),
      });
      this.seen.delete(key);
      this.seen.set(key, task.revision);
      if (this.seen.size > MAX_SEEN)
        this.seen.delete(this.seen.keys().next().value!);
    } catch {
      this.warn('task_notification_read_failed');
    }
  }

  disconnected(): void {
    this.generation++;
    this.pending.clear();
  }

  stop(): void {
    this.stopped = true;
    this.disconnected();
    this.seen.clear();
  }
}
