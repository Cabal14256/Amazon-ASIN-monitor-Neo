import {
  backupCreationFilename,
  backupFilenameCreatedAt,
  type BackupCreationReceipt,
  type BackupJobData,
} from '@asin-monitor/contracts';
import { backupCreationIdentity } from '@asin-monitor/db';
import { createHash } from 'node:crypto';

export function backupCreationFixture(
  userId: string,
  createdAt = '2026-09-01T00:00:00.000Z',
) {
  const data: Extract<BackupJobData, { operation: 'create' }> = {
    taskId: '10000000-0000-4000-8000-000000000161',
    userId,
    createdAt,
    taskType: 'backup',
    taskSubType: 'create',
    operation: 'create',
    target: 'primary',
    params: { description: 'nightly fixture' },
  };
  const filename = backupCreationFilename(data.taskId, createdAt, 'primary');
  const result: BackupCreationReceipt = {
    operation: 'create',
    filename,
    createdAt: backupFilenameCreatedAt(filename)!,
    target: 'primary',
    format: 'custom',
    size: 12,
    sourceEngine: 'postgresql',
    restoreSupported: true,
    description: 'nightly fixture',
    backupCreationCommit: {
      version: 1,
      taskId: data.taskId,
      userId,
      taskCreatedAt: createdAt,
      creationIdentity: backupCreationIdentity(data),
      archiveSha256: createHash('sha256').update('PGDMPfixture').digest('hex'),
    },
  };
  return { data, result };
}
