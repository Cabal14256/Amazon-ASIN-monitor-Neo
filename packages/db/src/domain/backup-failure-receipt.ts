import {
  backupJobDataSchema,
  type BackupJobData,
} from '@asin-monitor/contracts';
import { createHash } from 'node:crypto';

function failurePrefix(input: BackupJobData): string {
  const data = backupJobDataSchema.parse(input);
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        data.taskId,
        data.userId,
        data.createdAt,
        data.target,
        data.operation,
        data.taskSubType,
        data.params,
      ]),
    )
    .digest('hex');
  return `BACKUP_UNCOMMITTED_FAILURE_V1:${identity}:`;
}

/** Private BullMQ failedReason, emitted only after confirmed no commit/cleanup. */
export function backupUncommittedFailureReason(
  data: BackupJobData,
  message: string,
): string {
  if (message.length > 2000) throw new Error('BACKUP_FAILURE_RECEIPT_INVALID');
  return failurePrefix(data) + JSON.stringify(message);
}

/** Unknown/older failures cannot prove that cancellation is safe to confirm. */
export function isBackupUncommittedFailure(
  data: BackupJobData,
  reason: unknown,
): boolean {
  if (typeof reason !== 'string' || reason.length > 2200) return false;
  const prefix = failurePrefix(data);
  if (!reason.startsWith(prefix)) return false;
  try {
    const message: unknown = JSON.parse(reason.slice(prefix.length));
    return typeof message === 'string' && message.length <= 2000;
  } catch {
    return false;
  }
}
