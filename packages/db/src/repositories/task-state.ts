import { z } from 'zod';

const identifier = z.string().min(1).max(200);
const timestamp = z.string().datetime();
export const taskStateSchema = z.object({
  taskId: identifier,
  userId: identifier,
  taskType: z.string().min(1).max(100),
  taskSubType: z.string().max(200).nullable(),
  title: z.string().max(500),
  status: z.enum([
    'pending',
    'processing',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
  ]),
  progress: z.number().finite().min(0).max(100),
  message: z.string().max(2000),
  error: z.string().max(2000).nullable(),
  result: z.unknown().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  cancelRequestedAt: timestamp.nullable(),
  cancelledAt: timestamp.nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type TaskState = z.infer<typeof taskStateSchema>;
export const createTaskInputSchema = taskStateSchema
  .pick({
    taskId: true,
    userId: true,
    taskType: true,
  })
  .extend({
    title: taskStateSchema.shape.title.optional(),
    taskSubType: taskStateSchema.shape.taskSubType.optional(),
  });
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

const message = z.string().max(2000).optional();
const mutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('processing'), message }),
  z.object({
    kind: z.literal('progress'),
    progress: taskStateSchema.shape.progress,
    message,
  }),
  z.object({ kind: z.literal('cancel-request'), message }),
  z.object({ kind: z.literal('cancelled'), message }),
  z.object({
    kind: z.literal('completed'),
    result: z.unknown().optional(),
    message,
  }),
  z.object({ kind: z.literal('failed'), message: z.string().min(1).max(2000) }),
]);
export type TaskMutation = z.infer<typeof mutationSchema>;

export function isTerminalTaskStatus(status: string): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

/** Pure transition function; CAS re-evaluates it against the latest shared state. */
export function transitionTask(
  task: TaskState,
  mutation: TaskMutation,
  now: Date,
): TaskState {
  const change = mutationSchema.parse(mutation);
  if (isTerminalTaskStatus(task.status)) return task;
  const timestamp = new Date(
    Math.max(now.getTime(), Date.parse(task.updatedAt) + 1),
  ).toISOString();
  const next = { ...task, updatedAt: timestamp, revision: task.revision + 1 };
  switch (change.kind) {
    case 'processing':
    case 'progress':
      next.status = task.cancelRequestedAt ? 'cancelling' : 'processing';
      next.startedAt ??= timestamp;
      if (change.kind === 'progress') next.progress = change.progress;
      if (change.message !== undefined) next.message = change.message;
      break;
    case 'cancel-request':
      next.status = 'cancelling';
      next.cancelRequestedAt ??= timestamp;
      next.message = change.message ?? '已请求取消，等待当前批次结束';
      break;
    case 'cancelled':
      next.status = 'cancelled';
      next.cancelledAt = timestamp;
      next.completedAt = timestamp;
      next.error = null;
      next.message = change.message ?? '任务已取消';
      break;
    case 'completed':
      next.status = 'completed';
      next.progress = 100;
      next.completedAt = timestamp;
      next.result = change.result ?? null;
      next.error = null;
      next.message = change.message ?? '任务已完成';
      break;
    case 'failed':
      next.status = 'failed';
      next.completedAt = timestamp;
      next.error = change.message;
      next.message = change.message;
      break;
  }
  return taskStateSchema.parse(next);
}
