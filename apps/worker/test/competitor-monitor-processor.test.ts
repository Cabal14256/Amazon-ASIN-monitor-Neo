import { type CompetitorMonitorJob } from '@asin-monitor/contracts';
import {
  transitionTask,
  type CompetitorMonitorControlUnit,
  type NotificationClaim,
  type TaskState,
} from '@asin-monitor/db';
import { FeishuNotifications } from '@asin-monitor/notify';
import type {
  CompetitorCheckContext,
  CompetitorGroupCheckData,
} from '@asin-monitor/variant-check';
import { type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  competitorMonitorGroupOperation,
  createCompetitorMonitorProcessor,
} from '../src/competitor-monitor-processor';

function fixture() {
  const createdAt = new Date().toISOString();
  const data: CompetitorMonitorJob = {
    taskId: randomUUID(),
    taskType: 'competitor-monitor',
    taskSubType: 'competitor',
    userId: 'competitor-owner',
    createdAt,
    expiresAt: new Date(Date.now() + 604800000).toISOString(),
    countries: ['US'],
  };
  let state: TaskState = {
    taskId: data.taskId,
    taskType: data.taskType,
    taskSubType: data.taskSubType,
    userId: data.userId,
    title: '竞品监控',
    status: 'pending',
    progress: 0,
    message: '',
    error: null,
    result: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    revision: 0,
  };
  const group = {
    groupId: ' raw Gróup ',
    country: 'US' as const,
    snapshotDigest: 'a'.repeat(64),
  };
  const current = {
    enabled: true,
    active: true,
    permission: true,
    groupNotify: true,
    asinNotify: true,
    candidateExists: true,
  };
  const authorization: CompetitorMonitorControlUnit = {
    lockOperator: vi.fn(
      async () =>
        ({
          id: data.userId,
          status: current.active ? 'ACTIVE' : 'DISABLED',
          lockedUntil: null,
          forcePasswordChange: false,
          passwordExpiresAt: null,
        } as never),
    ),
    operatorPermissionCodes: vi.fn(async () =>
      current.permission ? ['monitor:write'] : [],
    ),
    competitorMonitorConfiguration: vi.fn(async () =>
      current.enabled ? 'true' : 'false',
    ),
  };
  const control = vi.fn(
    async (authorize: (unit: CompetitorMonitorControlUnit) => Promise<void>) =>
      authorize(authorization),
  );
  const groups = vi.fn(
    async (
      _job: CompetitorMonitorJob,
      authorize: (unit: CompetitorMonitorControlUnit) => Promise<void>,
    ) => {
      await authorize(authorization);
      return [group];
    },
  );
  const assertNotificationInputs = vi.fn(
    async (
      _job: unknown,
      _country: unknown,
      _candidates: unknown,
      authorize: (unit: CompetitorMonitorControlUnit) => Promise<void>,
    ) => {
      await authorize(authorization);
      if (
        !current.groupNotify ||
        !current.asinNotify ||
        !current.candidateExists
      )
        throw new Error('CURRENT_NOTIFY_DENIED');
    },
  );
  let claim: NotificationClaim | undefined;
  const readNotification = vi.fn(
    async (
      _job: CompetitorMonitorJob,
      _country: unknown,
      authorize: (unit: CompetitorMonitorControlUnit) => Promise<void>,
    ) => {
      await authorize(authorization);
      return claim as Exclude<NotificationClaim, 'new'> | undefined;
    },
  );
  const claimNotification = vi.fn(
    async (...args: Parameters<typeof assertNotificationInputs>) => {
      await assertNotificationInputs(...args);
      if (claim) return claim;
      claim = 'claimed';
      return 'new' as NotificationClaim;
    },
  );
  const completeNotification = vi.fn(
    async (
      _job: unknown,
      _country: unknown,
      sent: boolean,
      authorize: (unit: CompetitorMonitorControlUnit) => Promise<void>,
    ) => {
      await authorize(authorization);
      claim = sent ? 'sent' : 'failed';
    },
  );
  const result: CompetitorGroupCheckData = {
    isBroken: true,
    brokenASINs: [{ asin: 'B000000001', errorType: 'NO_VARIANTS' }],
    brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 1 },
    groupSnapshot: {
      id: group.groupId,
      name: 'Canonical group',
      country: 'US',
      brand: 'Brand',
      feishuNotifyEnabled: 1,
      feishu_notify_enabled: 1,
      isBroken: 1,
      is_broken: 1,
      variantStatus: 'BROKEN',
      variant_status: 'BROKEN',
      createTime: createdAt,
      create_time: createdAt,
      updateTime: createdAt,
      update_time: createdAt,
      lastCheckTime: createdAt,
      last_check_time: createdAt,
      children: [
        {
          id: ' raw Asín ',
          asin: 'B000000001',
          name: 'Child',
          asinType: '1',
          country: 'US',
          parentId: group.groupId,
          isBroken: 1,
          variantStatus: 'BROKEN',
          brand: 'Brand',
          feishuNotifyEnabled: 1,
          createTime: createdAt,
          updateTime: createdAt,
          lastCheckTime: createdAt,
        },
      ],
    },
    details: {
      totalASINs: 1,
      brokenCount: 1,
      results: [
        {
          asin: 'B000000001',
          hasVariants: false,
          variantCount: 0,
          errorType: 'NO_VARIANTS',
        },
      ],
    },
  };
  const checkGroup = vi.fn(
    async (_id: string, context: CompetitorCheckContext) => {
      await context.authorize({ ...authorization } as never);
      await context.checkpoint();
      return result;
    },
  );
  const read = vi.fn(
    async () =>
      ({ webhookUrl: 'https://example.invalid/isolated-fixture' } as
        | { webhookUrl: string }
        | undefined),
  );
  const send = vi.fn(async () => ({ statusCode: 200, code: 0 }));
  const notifications = new FeishuNotifications({
    source: { read },
    transport: { send, close() {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const store = {
    read: vi.fn(async () => state),
    mutate: vi.fn(
      async (_id: string, change: Parameters<typeof transitionTask>[1]) => {
        state = transitionTask(state, change, new Date());
        return state;
      },
    ),
  };
  const assertJobLock = vi.fn(async () => {});
  const processor = createCompetitorMonitorProcessor({
    pipeline: { checkGroup },
    repository: {
      groups,
      control,
      readNotification,
      assertNotificationInputs,
      claimNotification,
      completeNotification,
    },
    store,
    notifications,
    defaultEnabled: true,
    shutdownSignal: new AbortController().signal,
    assertJobLock,
    updateProgress: async () => {},
  });
  const job = {
    id: data.taskId,
    name: 'competitor-monitor',
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as Job;
  return {
    data,
    job,
    group,
    result,
    processor,
    groups,
    checkGroup,
    authorization,
    current,
    read,
    send,
    notifications,
    store,
    readNotification,
    assertNotificationInputs,
    claimNotification,
    completeNotification,
    assertJobLock,
    cancel: () => {
      state = transitionTask(state, { kind: 'cancel-request' }, new Date());
    },
    setState: (next: TaskState) => {
      state = next;
    },
    get state() {
      return state;
    },
    get claim() {
      return claim;
    },
  };
}
describe('competitor manual monitor consumer and real notification service', () => {
  it('selects the committed canonical child when another country has the same code with its switch off', async () => {
    const f = fixture();
    f.result.groupSnapshot.children.push({
      ...f.result.groupSnapshot.children[0],
      id: 'other-country-child',
      country: 'DE',
      brand: 'Other-country brand',
      isBroken: 0,
      feishuNotifyEnabled: 0,
    });
    f.result.details = {
      totalASINs: 2,
      brokenCount: 1,
      results: [
        {
          asin: 'B000000001',
          hasVariants: false,
          variantCount: 0,
          errorType: 'NO_VARIANTS',
        },
        { asin: 'B000000001', hasVariants: true, variantCount: 1 },
      ],
    };
    const output = await f.processor(f.job, 'lock');
    expect(output).toMatchObject({ notificationResults: { US: 'sent' } });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.claimNotification.mock.calls[0][2]).toEqual([
      expect.objectContaining({
        asinId: ' raw Asín ',
        asin: 'B000000001',
        brand: 'Brand',
      }),
    ]);
    expect(JSON.stringify(f.send.mock.calls)).not.toContain(
      'Other-country brand',
    );
    f.notifications.close();
  });
  it('keeps competitor task/operation identity, same task time, and a private bound completion proof', async () => {
    const f = fixture();
    const output = await f.processor(f.job, 'lock');
    expect(f.checkGroup).toHaveBeenCalledWith(
      f.group.groupId,
      expect.objectContaining({
        forceRefresh: false,
        snapshotDigest: f.group.snapshotDigest,
        operation: expect.objectContaining({
          taskType: 'competitor-monitor',
          taskSubType: 'competitor',
          resultKind: 'competitor-group',
          taskCreatedAt: f.data.createdAt,
        }),
      }),
    );
    expect(output).toMatchObject({
      success: true,
      totalChecked: 1,
      totalBroken: 1,
      notificationResults: { US: 'sent' },
      countryResults: { US: { checkTime: f.data.createdAt } },
      _competitorMonitorCommit: { version: 1 },
    });
    expect(f.state.status).toBe('completed');
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.claim).toBe('sent');
    expect(JSON.stringify(output)).not.toContain(' raw Asín ');
    f.notifications.close();
  });
  it.each(['active', 'permission', 'enabled'] as const)(
    'uses current %s control before touching competitor runs',
    async (key) => {
      const f = fixture();
      f.current[key] = false;
      await expect(f.processor(f.job, 'lock')).rejects.toThrow();
      expect(f.groups).not.toHaveBeenCalled();
      expect(f.checkGroup).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      f.notifications.close();
    },
  );
  it('does not start a pre-cancelled task or a foreign queued identity', async () => {
    const f = fixture();
    f.cancel();
    expect(await f.processor(f.job, 'lock')).toEqual({ cancelled: true });
    expect(f.groups).not.toHaveBeenCalled();
    const other = fixture();
    other.job.data = { ...other.data, userId: 'foreign-owner' };
    await expect(other.processor(other.job, 'lock')).rejects.toThrow();
    expect(other.groups).not.toHaveBeenCalled();
    expect(other.state.status).toBe('pending');
    f.notifications.close();
    other.notifications.close();
  });
  it.each(['groupNotify', 'asinNotify'] as const)(
    'requires current %s even when a committed receipt had enabled flags',
    async (key) => {
      const f = fixture();
      f.checkGroup.mockImplementationOnce(async () => {
        f.current[key] = false;
        return f.result;
      });
      await expect(f.processor(f.job, 'lock')).rejects.toThrow();
      expect(f.claimNotification).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      f.notifications.close();
    },
  );
  it('does not claim a disabled current webhook and records skipped delivery', async () => {
    const f = fixture();
    f.read.mockResolvedValue(undefined);
    expect(await f.processor(f.job, 'lock')).toMatchObject({
      notificationResults: { US: 'skipped' },
    });
    expect(f.claimNotification).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.notifications.close();
  });
  it('keeps an uncertain actual POST claimed and never resends on metadata acknowledgement loss', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('FIXTURE_ACK_LOST'));
    const mutate = f.store.mutate.getMockImplementation()!;
    f.store.mutate.mockImplementation(async (id, change) => {
      if (change.kind === 'completed') throw new Error('REDIS_ACK_LOST');
      return mutate(id, change);
    });
    const first = await f.processor(f.job, 'lock');
    expect(first).toMatchObject({ notificationResults: { US: 'unconfirmed' } });
    expect(f.claim).toBe('claimed');
    expect(f.completeNotification).not.toHaveBeenCalled();
    expect(f.state.status).toBe('processing');
    expect(await f.processor(f.job, 'lock')).toMatchObject({
      notificationResults: { US: 'unconfirmed' },
    });
    expect(f.send).toHaveBeenCalledOnce();
    f.notifications.close();
  });
  it.each(
    (['sent', 'failed', 'claimed'] as const).flatMap((state) =>
      (['deleted', 'disabled'] as const).map((change) => ({ state, change })),
    ),
  )(
    'reuses an identity-bound $state delivery after a $change candidate without new delivery preflight',
    async ({ state, change }) => {
      const f = fixture();
      if (state === 'claimed')
        f.send.mockRejectedValueOnce(new Error('FIXTURE_ACK_LOST'));
      else if (state === 'failed')
        f.send.mockResolvedValueOnce({ statusCode: 200, code: 999 });
      const mutate = f.store.mutate.getMockImplementation()!;
      f.store.mutate.mockImplementation(async (id, update) => {
        if (update.kind === 'completed') throw new Error('REDIS_ACK_LOST');
        return mutate(id, update);
      });
      const expected = state === 'claimed' ? 'unconfirmed' : state;
      expect(await f.processor(f.job, 'lock')).toMatchObject({
        notificationResults: { US: expected },
      });
      expect(f.claim).toBe(state);
      expect(f.state.status).toBe('processing');
      const inputChecks = f.assertNotificationInputs.mock.calls.length;
      const configReads = f.read.mock.calls.length;
      f.store.mutate.mockImplementation(mutate);
      if (change === 'deleted') f.current.candidateExists = false;
      else f.current.asinNotify = false;
      expect(await f.processor(f.job, 'lock')).toMatchObject({
        totalChecked: 1,
        totalBroken: 1,
        notificationResults: { US: expected },
        _competitorMonitorCommit: { version: 1 },
      });
      expect(f.state.status).toBe('completed');
      expect(f.readNotification).toHaveBeenCalledTimes(2);
      expect(f.assertNotificationInputs).toHaveBeenCalledTimes(inputChecks);
      expect(f.read).toHaveBeenCalledTimes(configReads);
      expect(f.claimNotification).toHaveBeenCalledOnce();
      expect(f.send).toHaveBeenCalledOnce();
      f.notifications.close();
    },
  );
  it.each(['active', 'permission', 'enabled'] as const)(
    'still rejects current %s control before replaying an old delivery',
    async (key) => {
      const f = fixture();
      const mutate = f.store.mutate.getMockImplementation()!;
      f.store.mutate.mockImplementation(async (id, update) => {
        if (update.kind === 'completed') throw new Error('REDIS_ACK_LOST');
        return mutate(id, update);
      });
      await f.processor(f.job, 'lock');
      expect(f.claim).toBe('sent');
      f.current[key] = false;
      await expect(f.processor(f.job, 'lock')).rejects.toThrow();
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.state.status).toBe('processing');
      f.notifications.close();
    },
  );
  it('preserves committed checks when cancellation occurs before delivery', async () => {
    const f = fixture();
    f.checkGroup.mockImplementationOnce(async () => {
      f.cancel();
      return f.result;
    });
    expect(await f.processor(f.job, 'lock')).toEqual({ cancelled: true });
    expect(f.checkGroup).toHaveBeenCalledOnce();
    expect(f.claimNotification).not.toHaveBeenCalled();
    expect(f.state.status).toBe('cancelled');
    f.notifications.close();
  });
  it('separates competitor group operation digests across task owner/incarnation/input', () => {
    const f = fixture(),
      op = competitorMonitorGroupOperation(f.data, f.group);
    expect(op).toMatchObject({
      taskType: 'competitor-monitor',
      taskSubType: 'competitor',
      resultKind: 'competitor-group',
    });
    expect(
      competitorMonitorGroupOperation(f.data, {
        ...f.group,
        snapshotDigest: 'b'.repeat(64),
      }).requestHash,
    ).not.toBe(op.requestHash);
    f.notifications.close();
  });
});
