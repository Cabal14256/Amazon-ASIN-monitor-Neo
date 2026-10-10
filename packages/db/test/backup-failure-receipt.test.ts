import type { BackupJobData } from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import {
  backupUncommittedFailureReason,
  isBackupUncommittedFailure,
} from '../src/domain/backup-failure-receipt';

const data: BackupJobData = {
  taskId: '10000000-0000-4000-8000-000000000161',
  userId: 'worker-fixture',
  taskType: 'backup',
  taskSubType: 'restore',
  operation: 'restore',
  createdAt: '2026-10-08T12:00:00.000Z',
  target: 'primary',
  params: { filename: 'backup_20261008-200000-abcdef01-primary.dump' },
};
describe('private clean backup failure receipt', () => {
  it('accepts the exact immutable queue request without including its params or owner', () => {
    const reason = backupUncommittedFailureReason(data, '备份任务失败');
    expect(isBackupUncommittedFailure(data, reason)).toBe(true);
    expect(reason).not.toContain(data.userId);
    expect(reason).not.toContain(data.params.filename);
  });
  it.each(['taskId', 'userId', 'createdAt', 'target', 'params'])(
    'rejects a receipt from another immutable %s',
    (field) => {
      const other = {
        ...data,
        [field]:
          field === 'taskId'
            ? '20000000-0000-4000-8000-000000000161'
            : field === 'createdAt'
            ? '2026-10-07T12:00:00.000Z'
            : field === 'target'
            ? 'competitor'
            : field === 'params'
            ? { filename: 'backup_20261008-200000-abcdef02-primary.dump' }
            : 'another-worker',
      } as BackupJobData;
      // Competitor target requires a matching filename even for valid input.
      if (field === 'target')
        other.params = {
          filename: data.params.filename.replace('primary', 'competitor'),
        };
      expect(
        isBackupUncommittedFailure(
          data,
          backupUncommittedFailureReason(other, 'failed'),
        ),
      ).toBe(false);
    },
  );
  it.each([
    undefined,
    'failed',
    'BACKUP_UNCOMMITTED_FAILURE_V1:',
    'x'.repeat(2201),
  ])('rejects missing, old, malformed or oversized failure (%s)', (reason) => {
    expect(isBackupUncommittedFailure(data, reason)).toBe(false);
  });
  it('rejects a truncated proof and non-string payload', () => {
    const reason = backupUncommittedFailureReason(data, 'failed');
    expect(isBackupUncommittedFailure(data, reason.slice(0, -1))).toBe(false);
    expect(
      isBackupUncommittedFailure(data, reason.replace('"failed"', 'null')),
    ).toBe(false);
  });
});
