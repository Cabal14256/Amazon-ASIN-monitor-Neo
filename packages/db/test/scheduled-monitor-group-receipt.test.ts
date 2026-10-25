import { describe, expect, it, vi } from 'vitest';
import { scheduledMonitorJobDigest } from '../src/domain/scheduled-monitor-policy';
import {
  freezeScheduledMonitorSnapshot,
  scheduledMonitorGroupOperation,
  scheduledMonitorSnapshotDigest,
} from '../src/domain/scheduled-monitor-run';
import {
  readScheduledMonitorGroupReceipt,
  writeScheduledMonitorGroupReceipt,
} from '../src/repositories/scheduled-monitor-group-receipt';
import { assertScheduledMonitorSnapshot } from '../src/repositories/scheduled-monitor-snapshot-check';
import {
  scheduledGroup,
  scheduledJob,
  scheduledMember,
} from './helpers/scheduled-monitor-fixtures';

const result = (groupId: string, memberId: string) => ({
  isBroken: false,
  brokenASINs: [],
  brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
  groupSnapshot: {
    id: groupId,
    country: 'US',
    children: [{ id: memberId, asin: 'B000000001' }],
  },
  details: { results: [] },
});

function ledgerRow(
  job: ReturnType<typeof scheduledJob>,
  snapshots: unknown[],
  state = 'running',
) {
  return {
    task_id: job.taskId,
    job_id: job.jobId,
    job: job,
    job_digest: scheduledMonitorJobDigest(job),
    domain: job.domain,
    country: job.country,
    interval_minutes: job.intervalMinutes,
    batch_index: job.batchConfig.batchIndex,
    total_batches: job.batchConfig.totalBatches,
    groups: snapshots,
    snapshot_digest: scheduledMonitorSnapshotDigest(job, snapshots as never),
    total_members: (snapshots as { members: unknown[] }[]).reduce(
      (sum, snapshot) => sum + snapshot.members.length,
      0,
    ),
    state,
    business_completed_at:
      state === 'completed' ? new Date(job.createdAt) : null,
    completed_at: state === 'completed' ? new Date(job.createdAt) : null,
    cancel_requested_at: null,
    fresh: state === 'running',
  };
}

describe('scheduled monitor business transaction helpers', () => {
  it('checks the ledger before comparing native microsecond catalog rows', async () => {
    const job = scheduledJob();
    const group = scheduledGroup();
    const member = scheduledMember();
    const [snapshot] = freezeScheduledMonitorSnapshot(job, [group], [member]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [ledgerRow(job, [snapshot])],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              value: {
                ...group,
                name: 'changed after acceptance',
              },
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ value: member }] }),
    };
    await expect(
      assertScheduledMonitorSnapshot(
        db as never,
        { job, group: snapshot },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'snapshot-changed' });
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it('replays a committed receipt after expiry without reading the live catalog', async () => {
    const job = scheduledJob();
    const group = scheduledGroup();
    const member = scheduledMember();
    const [snapshot] = freezeScheduledMonitorSnapshot(job, [group], [member]);
    const operation = scheduledMonitorGroupOperation(job, snapshot);
    const value = result(group.id as string, member.id as string);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [ledgerRow(job, [snapshot], 'completed')],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              operation_key: operation.operationKey,
              request_hash: operation.requestHash,
              task_id: operation.taskId,
              job_digest: operation.jobDigest,
              country: operation.country,
              group_id: operation.groupId,
              ordinal: operation.ordinal,
              snapshot_digest: operation.snapshotDigest,
              result_kind: operation.resultKind,
              result: value,
            },
          ],
        }),
    };
    await expect(
      readScheduledMonitorGroupReceipt(
        db as never,
        { job, group: snapshot },
        () => {},
      ),
    ).resolves.toEqual(value);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('rejects a receipt operation that does not match the frozen run identity', async () => {
    const job = scheduledJob();
    const [snapshot] = freezeScheduledMonitorSnapshot(
      job,
      [scheduledGroup()],
      [scheduledMember()],
    );
    const operation = scheduledMonitorGroupOperation(job, snapshot);
    const db = {
      execute: vi.fn().mockResolvedValueOnce({
        rows: [ledgerRow(job, [snapshot])],
      }),
    };
    await expect(
      writeScheduledMonitorGroupReceipt(
        db as never,
        'primary',
        { ...operation, groupId: 'different' },
        result(snapshot.group.id, snapshot.members[0].id),
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'identity' });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
