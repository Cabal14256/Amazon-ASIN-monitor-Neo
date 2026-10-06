import {
  backupCreationFilename,
  backupCreationReceiptSchema,
  backupFilenameCreatedAt,
  createBackupJobDataSchema,
  type BackupJobData,
} from '@asin-monitor/contracts';
import { createHash } from 'node:crypto';

/** Canonical parsed immutable payload; never log or expose its contents. */
export function backupCreationIdentity(data: BackupJobData): string {
  const parsed = createBackupJobDataSchema.parse(data);
  return createHash('sha256')
    .update(
      JSON.stringify([
        parsed.taskId,
        parsed.userId,
        parsed.createdAt,
        parsed.target,
        parsed.params,
      ]),
    )
    .digest('hex');
}

/** Queue completions are trusted only with the same immutable creation data. */
export function parseBackupCreationReceipt(input: unknown, result: unknown) {
  const data = createBackupJobDataSchema.safeParse(input);
  const receipt = backupCreationReceiptSchema.safeParse(result);
  if (!data.success || !receipt.success)
    throw new Error('BACKUP_CREATION_RECEIPT_INVALID');
  const { backupCreationCommit: proof } = receipt.data;
  if (
    proof.taskId !== data.data.taskId ||
    proof.userId !== data.data.userId ||
    proof.taskCreatedAt !== data.data.createdAt ||
    proof.creationIdentity !== backupCreationIdentity(data.data) ||
    receipt.data.filename !==
      backupCreationFilename(
        data.data.taskId,
        data.data.createdAt,
        data.data.target,
      ) ||
    receipt.data.target !== data.data.target ||
    (receipt.data.execution
      ? Date.parse(receipt.data.execution.dumpStartedAt) <
        Date.parse(data.data.createdAt)
      : receipt.data.createdAt !==
        backupFilenameCreatedAt(receipt.data.filename))
  )
    throw new Error('BACKUP_CREATION_RECEIPT_INVALID');
  return receipt.data;
}
