import {
  buildScheduledMonitorJobId,
  type ScheduledMonitorJob,
} from '@asin-monitor/contracts';
import {
  scheduledMonitorTaskId,
  type ScheduledMonitorRun,
} from '@asin-monitor/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createScheduledMonitorProcessor,
  type ScheduledMonitorProcessorOptions,
} from '../src/scheduled-monitor-processor';

const plan = {
  domain: 'primary' as const,
  country: 'US' as const,
  plannedSlot: '2030-09-27T00:00:00.000Z',
  intervalMinutes: 15 as const,
  batchConfig: { batchIndex: 0, totalBatches: 1 },
};
const jobData = (): ScheduledMonitorJob => ({
  ...plan,
  version: 1,
  source: 'scheduled',
  taskType: 'scheduled-monitor',
  actor: { kind: 'system', purpose: 'scheduled-monitor' },
  taskId: scheduledMonitorTaskId(plan),
  jobId: buildScheduledMonitorJobId(plan),
  requestedAt: '2030-09-27T00:01:00.000Z',
  createdAt: '2030-09-27T00:01:00.000Z',
  expiresAt: '2030-09-27T01:00:00.000Z',
});

function group(ordinal = 0) {
  return {
    ordinal,
    group: { id: `g${ordinal}` },
  } as ScheduledMonitorRun['groups'][number];
}

function fixture(
  state: ScheduledMonitorRun['state'] = 'pending',
  patch: Partial<ScheduledMonitorRun> = {},
) {
  const data = jobData();
  let run: ScheduledMonitorRun = {
    job: data,
    jobDigest: 'a'.repeat(64),
    groups: [group()],
    snapshotDigest: 'b'.repeat(64),
    totalMembers: 1,
    state,
    businessCompletedAt: state === 'business-completed' ? data.createdAt : null,
    completedAt: null,
    cancelRequestedAt: null,
    result: null,
    followUpJob: null,
    followUpDigest: null,
    ...patch,
  };
  const receipt = vi.fn(async () => undefined as unknown);
  const checkGroup = vi.fn(
    async (_groupId: string, context: { checkpoint: () => Promise<void> }) => {
      await context.checkpoint();
      return { isBroken: false, brokenASINs: [] };
    },
  );
  const deliverNotifications = vi.fn(async () => undefined);
  const enqueueFollowUp = vi.fn(async () => undefined);
  const completeBusiness = vi.fn(async (_job: unknown, result: unknown) => {
    run = {
      ...run,
      state: 'business-completed',
      businessCompletedAt: data.createdAt,
      result: result as ScheduledMonitorRun['result'],
    };
    return run;
  });
  const complete = vi.fn(async () => {
    run = { ...run, state: 'completed', completedAt: data.createdAt };
    return run;
  });
  const finishWithoutBusiness = vi.fn(
    async (_job: unknown, next: ScheduledMonitorRun['state']) => {
      run = { ...run, state: next as ScheduledMonitorRun['state'] };
      return run;
    },
  );
  const read = vi.fn(async () => run);
  const ledger = {
    accept: vi.fn(async () => run),
    read,
    start: vi.fn(async () => {
      run = { ...run, state: 'running' };
      return run;
    }),
    readGroupReceipt: receipt,
    finishWithoutBusiness,
    completeBusiness,
    complete,
  };
  const options: ScheduledMonitorProcessorOptions = {
    primary: ledger,
    competitor: ledger,
    primaryPipeline: { checkGroup: checkGroup as any },
    competitorPipeline: { checkGroup: checkGroup as any },
    shutdownSignal: new AbortController().signal,
    assertJobLock: vi.fn(async () => undefined),
    enqueueFollowUp,
    deliverNotifications,
    maxAgeMs: 25 * 60 * 1000,
  };
  const processor = createScheduledMonitorProcessor(options);
  const job = {
    id: data.jobId,
    name: 'scheduled-monitor',
    data,
    attemptsMade: 0,
    opts: { attempts: 2 },
  } as Job;
  return {
    data,
    run: () => run,
    job,
    processor,
    ledger,
    checkGroup,
    receipt,
    completeBusiness,
    complete,
    finishWithoutBusiness,
    deliverNotifications,
    enqueueFollowUp,
  };
}

describe('scheduled monitor processor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T00:10:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a pending run, checks the missing group, and completes the ledger', async () => {
    const f = fixture();
    await expect(f.processor(f.job, 'lock')).resolves.toMatchObject({
      state: 'completed',
    });
    expect(f.ledger.start).toHaveBeenCalledOnce();
    expect(f.checkGroup).toHaveBeenCalledOnce();
    expect(f.completeBusiness).toHaveBeenCalledWith(
      f.data,
      {
        version: 1,
        totalGroups: 1,
        totalMembers: 1,
        brokenGroups: 0,
        brokenMembers: 0,
      },
      true,
      expect.any(AbortSignal),
    );
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it('does not execute an already expired acceptance', async () => {
    const f = fixture('skipped-expired');
    await expect(f.processor(f.job, 'lock')).resolves.toMatchObject({
      state: 'skipped-expired',
    });
    expect(f.checkGroup).not.toHaveBeenCalled();
    expect(f.ledger.start).not.toHaveBeenCalled();
  });

  it('recovers an existing receipt without repeating upstream work', async () => {
    const result = { isBroken: true, brokenASINs: [{ asin: 'B000000001' }] };
    const f = fixture('running');
    f.receipt.mockResolvedValue(result);
    await expect(f.processor(f.job, 'lock')).resolves.toMatchObject({
      state: 'completed',
    });
    expect(f.checkGroup).not.toHaveBeenCalled();
    expect(f.completeBusiness).toHaveBeenCalledWith(
      f.data,
      expect.objectContaining({ brokenGroups: 1, brokenMembers: 1 }),
      true,
      expect.any(AbortSignal),
    );
  });

  it('finishes cancellation before checking a group', async () => {
    const f = fixture('running');
    f.ledger.read.mockResolvedValue({
      ...f.run(),
      cancelRequestedAt: f.data.createdAt,
    });
    await expect(f.processor(f.job, 'lock')).resolves.toMatchObject({
      state: 'cancelled',
    });
    expect(f.checkGroup).not.toHaveBeenCalled();
    expect(f.finishWithoutBusiness).toHaveBeenCalledWith(f.data, 'cancelled');
  });

  it('retries business-completed follow-up enqueue ACK loss and then completes', async () => {
    const child = { ...jobData(), domain: 'competitor' as const };
    const f = fixture('business-completed', {
      followUpJob: child,
    });
    f.enqueueFollowUp.mockRejectedValueOnce(new Error('ack lost'));
    await expect(f.processor(f.job, 'lock')).rejects.toThrow('ack lost');
    expect(f.complete).not.toHaveBeenCalled();
    await expect(f.processor(f.job, 'lock')).resolves.toMatchObject({
      state: 'completed',
    });
    expect(f.enqueueFollowUp).toHaveBeenCalledTimes(2);
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it('rejects a Bull job whose id does not match the immutable job identity', async () => {
    const f = fixture();
    const invalid = { ...f.job, id: 'different-job-id' } as Job;
    await expect(f.processor(invalid, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('does not mark a final attempt failed when the group commit is uncertain', async () => {
    const f = fixture('running');
    f.job.attemptsMade = 1;
    f.checkGroup.mockRejectedValue({ commitMayHaveSucceeded: true });
    await expect(f.processor(f.job, 'lock')).rejects.toMatchObject({
      commitMayHaveSucceeded: true,
    });
    expect(f.finishWithoutBusiness).not.toHaveBeenCalledWith(
      f.data,
      'failed',
      expect.anything(),
    );
  });
});
