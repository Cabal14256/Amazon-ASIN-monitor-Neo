import { z } from 'zod';
import { taskStateSchema, type TaskState } from './task-state';

export const TASK_NOTIFICATION_MAX_BYTES = 4096;

/** Internal invalidation notice. Never carries results, paths, messages or credentials. */
export const taskNotificationSchema = taskStateSchema
  .pick({
    taskId: true,
    userId: true,
    taskType: true,
    createdAt: true,
    revision: true,
  })
  .extend({ version: z.literal(1), type: z.literal('task_changed') })
  .strict();

export type TaskNotification = z.infer<typeof taskNotificationSchema>;

export function taskNotificationChannel(prefix: string): string {
  if (!prefix.trim()) throw new Error('TASK_REGISTRY_CONFIG_INVALID');
  return `${prefix.trim()}:neo:task:events`;
}

export function encodeTaskNotification(task: TaskState): string {
  const raw = JSON.stringify(
    taskNotificationSchema.parse({
      version: 1,
      type: 'task_changed',
      taskId: task.taskId,
      userId: task.userId,
      taskType: task.taskType,
      createdAt: task.createdAt,
      revision: task.revision,
    }),
  );
  if (Buffer.byteLength(raw) > TASK_NOTIFICATION_MAX_BYTES)
    throw new Error('TASK_NOTIFICATION_TOO_LARGE');
  return raw;
}

export function parseTaskNotification(raw: string): TaskNotification | null {
  if (Buffer.byteLength(raw) > TASK_NOTIFICATION_MAX_BYTES) return null;
  try {
    const result = taskNotificationSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
