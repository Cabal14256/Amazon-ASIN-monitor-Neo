import type {
  BackupCreationReceipt,
  BackupJobData,
} from '@asin-monitor/contracts';
import { backupCreationIdentity, type TaskState } from '@asin-monitor/db';
import { describe, expect, it } from 'vitest';
import {
  serializeTask,
  type QueueTaskSnapshot,
} from '../src/tasks/task-query-values';

const backupData: Extract<BackupJobData, { operation: 'create' }> = {
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
  target: 'primary',
  size: 12,
  sourceEngine: 'postgresql',
  restoreSupported: true,
  backupCreationCommit: {
    version: 1,
    taskId: backupData.taskId,
    userId: backupData.userId,
    taskCreatedAt: backupData.createdAt,
    creationIdentity: backupCreationIdentity(backupData),
    archiveSha256: 'a'.repeat(64),
  },
});
const storedTask = (result: unknown): TaskState => ({
  taskId: backupData.taskId,
  userId: backupData.userId,
  taskType: 'backup',
  taskSubType: 'create',
  title: 'midnight fixture',
  status: 'completed',
  progress: 100,
  message: '',
  error: null,
  result,
  createdAt: backupData.createdAt,
  updatedAt: '2026-09-02T01:00:00.000Z',
  startedAt: backupData.createdAt,
  completedAt: '2026-09-02T01:00:00.000Z',
  cancelRequestedAt: null,
  cancelledAt: null,
  revision: 1,
});
const queueTask = (result: unknown): QueueTaskSnapshot => {
  const { revision: _revision, ...task } = storedTask(result);
  return { ...task, backupData };
};

describe('historical midnight backup serialization', () => {
  it.each([canonical, legacy])(
    'retains original filename-time provenance for stored and retained queue receipts %s',
    (filename) => {
      for (const task of [
        storedTask(receipt(filename)),
        queueTask(receipt(filename)),
      ]) {
        const serialized = serializeTask(task);
        expect(serialized.result).toMatchObject({
          filename,
          createdAt: '2026-09-01T16:00:01.000Z',
          timeSource: 'filename',
        });
        expect(JSON.stringify(serialized)).not.toContain(
          'backupCreationCommit',
        );
        expect(serialized.downloadUrl).toBeNull();
      }
    },
  );

  it('marks changed legacy calendar/task/target/owner/time proof unavailable and checks retained payload digest', () => {
    const original = receipt(legacy);
    for (const result of [
      { ...original, filename: legacy.replace('20260902', '20260903') },
      { ...original, filename: legacy.replace('00000161', '00000162') },
      { ...original, filename: legacy.replace('-primary', '-competitor') },
      { ...original, createdAt: '2026-09-02T16:00:01.000Z' },
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
    ])
      expect(serializeTask(storedTask(result)).result).toMatchObject({
        timeSource: 'unavailable',
      });
    expect(
      serializeTask({
        ...queueTask(original),
        backupData: {
          ...backupData,
          params: { description: 'replacement request' },
        },
      }).result,
    ).toMatchObject({ timeSource: 'unavailable' });
  });
});
