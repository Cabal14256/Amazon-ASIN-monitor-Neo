import {
  taskInfoSchema,
  taskListQuerySchema,
  type TaskInfo,
} from '@asin-monitor/contracts';
import {
  isTerminalTaskStatus,
  TASK_RECORD_MAX_BYTES,
  type TaskState,
} from '@asin-monitor/db';
import { z } from 'zod';

export type QueueTaskSnapshot = Omit<
  TaskInfo,
  'canCancel' | 'filename' | 'downloadUrl'
> & { userId: string | null };
export class TaskQueryInputError extends Error {}
export function parseTaskId(raw: unknown): string {
  const value = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\x00-\x1f\x7f]*$/u)
    .safeParse(raw);
  if (!value.success) throw new TaskQueryInputError();
  return value.data;
}
export function parseTaskQuery(raw: unknown) {
  const value = taskListQuerySchema
    .extend({ status: z.string().max(100).optional() })
    .strict()
    .safeParse(raw);
  if (!value.success) throw new TaskQueryInputError();
  return { status: value.data.status || 'all', limit: value.data.limit ?? 50 };
}
const privateKey =
  /password|token|secret|authorization|cookie|credential|file.?path|^path$|directory|^stack$|^__proto__$|^constructor$|^prototype$/i;
/** Preserve structured business results while excluding server-only fields at every depth. */
export function publicTaskResult(raw: unknown): unknown {
  if (!raw) return null;
  const json = JSON.stringify(raw);
  if (!json || Buffer.byteLength(json) > TASK_RECORD_MAX_BYTES)
    throw new Error('TASK_RESULT_INVALID');
  let nodes = 0;
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 20_000 || depth > 20) throw new Error('TASK_RESULT_INVALID');
    if (Array.isArray(value))
      return value.map((item) => visit(item, depth + 1));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !privateKey.test(key))
          .map(([key, item]) => [key, visit(item, depth + 1)]),
      );
    return value;
  }
  return visit(JSON.parse(json), 0);
}
function filename(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1000 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return null;
  return value.split(/[\\/]/).pop() || null;
}
export function serializeTask(task: TaskState | QueueTaskSnapshot): TaskInfo {
  const raw =
    task.result &&
    typeof task.result === 'object' &&
    !Array.isArray(task.result)
      ? (task.result as Record<string, unknown>)
      : {};
  const result = publicTaskResult(task.result);
  const publicFilename = filename(raw.filename) ?? filename(raw.filepath);
  // Only this authenticated task's own download endpoint may be advertised.
  const downloadUrl =
    raw.downloadUrl || raw.filepath
      ? `/api/v1/tasks/${encodeURIComponent(task.taskId)}/download`
      : null;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const data = result as Record<string, unknown>;
    if ('filename' in data) data.filename = publicFilename;
    if ('downloadUrl' in data) data.downloadUrl = downloadUrl;
  }
  return taskInfoSchema.parse({
    taskId: task.taskId,
    taskType: task.taskType,
    taskSubType: task.taskSubType || null,
    title: task.title || task.taskType,
    status: task.status,
    progress: task.progress || 0,
    message: task.message || '',
    error: task.error || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cancelRequestedAt: task.cancelRequestedAt,
    cancelledAt: task.cancelledAt,
    canCancel: !isTerminalTaskStatus(task.status),
    filename: publicFilename,
    downloadUrl,
    result,
  });
}
