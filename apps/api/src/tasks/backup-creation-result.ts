import { parseBackupCreationReceipt, type TaskState } from '@asin-monitor/db';
import type { QueueTaskSnapshot } from './task-query-values';

/** Private Worker publication proof; queue data is not public task output. */
export function backupCreationResult(
  task: TaskState,
  queued: QueueTaskSnapshot,
) {
  if (
    !queued.result ||
    typeof queued.result !== 'object' ||
    !('backupCreationCommit' in queued.result)
  )
    return undefined;
  const data = queued.backupData;
  if (
    !data ||
    task.taskType !== 'backup' ||
    task.taskSubType !== 'create' ||
    data.taskId !== task.taskId ||
    data.userId !== task.userId ||
    data.taskType !== task.taskType ||
    data.taskSubType !== task.taskSubType ||
    data.createdAt !== task.createdAt ||
    queued.taskId !== task.taskId ||
    queued.userId !== task.userId ||
    queued.taskType !== task.taskType ||
    queued.taskSubType !== task.taskSubType ||
    queued.createdAt !== task.createdAt
  )
    throw new Error('BACKUP_CREATION_QUEUE_IDENTITY_INVALID');
  return parseBackupCreationReceipt(data, queued.result);
}
