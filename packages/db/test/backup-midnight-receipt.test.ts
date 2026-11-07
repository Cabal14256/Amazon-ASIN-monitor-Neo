import type {
  BackupCreationReceipt,
  BackupJobData,
} from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import {
  backupCreationIdentity,
  parseBackupCreationReceipt,
} from '../src/domain/backup-creation-receipt';
import { transitionTask, type TaskState } from '../src/repositories/task-state';

const data: Extract<BackupJobData, { operation: 'create' }> = {
  taskId: '10000000-0000-4000-8000-000000000161',
  userId: 'midnight-owner',
  taskType: 'backup',
  taskSubType: 'create',
  operation: 'create',
  target: 'primary',
  createdAt: '2026-09-01T16:00:01.123Z',
  params: { description: 'immutable request' },
};
const canonical =
  'backup_20260902-000001-10000000000040008000000000000161-primary.dump';
const legacy = canonical.replace('-000001-', '-240001-');
const receipt = (filename: string): BackupCreationReceipt => ({
  operation: 'create',
  format: 'custom',
  filename,
  createdAt: '2026-09-01T16:00:01.000Z',
  target: data.target,
  size: 12,
  sourceEngine: 'postgresql',
  restoreSupported: true,
  backupCreationCommit: {
    version: 1,
    taskId: data.taskId,
    userId: data.userId,
    taskCreatedAt: data.createdAt,
    creationIdentity: backupCreationIdentity(data),
    archiveSha256: 'a'.repeat(64),
  },
});
const task: TaskState = {
  taskId: data.taskId,
  userId: data.userId,
  taskType: 'backup',
  taskSubType: 'create',
  title: 'midnight fixture',
  status: 'cancelled',
  progress: 0,
  message: '',
  error: null,
  result: null,
  createdAt: data.createdAt,
  updatedAt: data.createdAt,
  startedAt: data.createdAt,
  completedAt: data.createdAt,
  cancelRequestedAt: data.createdAt,
  cancelledAt: data.createdAt,
  revision: 1,
};

describe('midnight backup receipt recovery remains identity-bound', () => {
  it.each([canonical, legacy])(
    'reconciles the same immutable task and idempotent terminal receipt %s',
    (filename) => {
      const result = receipt(filename);
      expect(parseBackupCreationReceipt(data, result)).toEqual(result);
      const completed = transitionTask(
        task,
        { kind: 'backup-create-committed', result },
        new Date('2026-09-02T01:00:00.000Z'),
      );
      expect(completed).toMatchObject({
        status: 'completed',
        createdAt: data.createdAt,
        cancelledAt: null,
        result,
      });
      expect(
        transitionTask(
          completed,
          { kind: 'backup-create-committed', result },
          new Date('2026-09-03T01:00:00.000Z'),
        ),
      ).toEqual(completed);
      expect(result.backupCreationCommit.creationIdentity).toBe(
        backupCreationIdentity(data),
      );
    },
  );

  it('rejects a different date, task suffix, target, owner, task time or request digest on legacy recovery', () => {
    const original = receipt(legacy);
    const changes = [
      { ...original, filename: legacy.replace('20260902', '20260903') },
      { ...original, filename: legacy.replace('00000161', '00000162') },
      { ...original, filename: legacy.replace('-primary', '-competitor') },
      { ...original, target: 'competitor' },
      {
        ...original,
        backupCreationCommit: {
          ...original.backupCreationCommit,
          userId: 'other-owner',
        },
      },
      {
        ...original,
        backupCreationCommit: {
          ...original.backupCreationCommit,
          taskCreatedAt: '2026-09-02T16:00:01.123Z',
        },
      },
      {
        ...original,
        backupCreationCommit: {
          ...original.backupCreationCommit,
          creationIdentity: 'b'.repeat(64),
        },
      },
      { ...original, createdAt: '2026-09-02T16:00:01.000Z' },
    ];
    for (const result of changes)
      expect(() => parseBackupCreationReceipt(data, result)).toThrow(
        'BACKUP_CREATION_RECEIPT_INVALID',
      );
    for (const result of changes.filter(
      (value) =>
        value.backupCreationCommit.creationIdentity ===
        original.backupCreationCommit.creationIdentity,
    ))
      expect(() =>
        transitionTask(
          task,
          {
            kind: 'backup-create-committed',
            result: result as BackupCreationReceipt,
          },
          new Date('2026-09-02T01:00:00.000Z'),
        ),
      ).toThrow();
  });
});
