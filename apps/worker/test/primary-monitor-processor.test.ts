import type {
  PrimaryMonitorJob,
  VariantGroupCheckData,
} from '@asin-monitor/contracts';
import {
  transitionTask,
  VariantCheckError,
  type NotificationClaim,
  type TaskState,
} from '@asin-monitor/db';
import {
  FeishuNotifications,
  type NotificationData,
} from '@asin-monitor/notify';
import type { VariantCheckContext } from '@asin-monitor/variant-check';
import { UnrecoverableError, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPrimaryMonitorProcessor,
  monitorGroupOperation,
} from '../src/primary-monitor-processor';

const createdAt = '2026-09-27T00:00:00.000Z';
const jobData = (): PrimaryMonitorJob => ({
  taskId: randomUUID(),
  taskType: 'monitor',
  taskSubType: 'primary',
  userId: 'monitor-owner',
  createdAt,
  expiresAt: '2026-10-04T00:00:00.000Z',
  countries: ['US', 'DE'],
});
function result(id: string, broken: boolean): VariantGroupCheckData {
  return {
    isBroken: broken,
    brokenASINs: broken ? [{ asin: 'B000000001', statusSource: 'AUTO' }] : [],
    brokenByType: {
      SP_API_ERROR: 0,
      NOT_FOUND: 0,
      NO_VARIANTS: broken ? 1 : 0,
    },
    groupSnapshot: {
      id,
      name: `Group ${id}`,
      country: id === 'g1' ? 'US' : 'DE',
      feishuNotifyEnabled: 1,
      children: [
        { asin: 'B000000001', feishuNotifyEnabled: 1, brand: 'Fixture' },
      ],
    },
    details: { results: [] },
  };
}
function fixture(
  notifications?: Pick<FeishuNotifications, 'withCountryDelivery'>,
) {
  const data = jobData();
  let state: TaskState = {
    taskId: data.taskId,
    taskType: 'monitor',
    taskSubType: 'primary',
    userId: data.userId,
    title: '主营 ASIN 监控',
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
  const order: string[] = [];
  const groups = vi.fn(async () => [
    { country: 'US' as const, groupId: 'g1' },
    { country: 'DE' as const, groupId: 'g2' },
  ]);
  const claimNotification = vi.fn(async (_taskId: string, country: string) => {
    order.push(`claim:${country}`);
    return 'new' as NotificationClaim;
  });
  const completeNotification = vi.fn(
    async (_taskId: string, country: string) => {
      order.push(`notification-committed:${country}`);
    },
  );
  const sendCountry = vi.fn(
    async (_domain: string, country: string, _data: NotificationData) => {
      order.push(`send:${country}`);
      return { success: true as const, skipped: false as const };
    },
  );
  const checkGroup = vi.fn(
    async (id: string, _context: VariantCheckContext) => {
      order.push(`check:${id}`);
      return result(id, id === 'g2');
    },
  );
  const store = {
    read: vi.fn(async () => state),
    mutate: vi.fn(
      async (_id: string, change: Parameters<typeof transitionTask>[1]) => {
        state = transitionTask(state, change, new Date());
        return state;
      },
    ),
  };
  const processor = createPrimaryMonitorProcessor({
    pipeline: { checkGroup },
    repository: { groups, claimNotification, completeNotification },
    store,
    notifications: notifications ?? {
      withCountryDelivery: async (domain, country, summary, run) =>
        run(() => sendCountry(domain, country, summary)),
    },
    shutdownSignal: new AbortController().signal,
    assertJobLock: async () => undefined,
    updateProgress: async () => undefined,
  });
  const job = {
    id: data.taskId,
    name: 'primary-monitor',
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as Job;
  return {
    data,
    job,
    processor,
    order,
    groups,
    checkGroup,
    claimNotification,
    completeNotification,
    sendCountry,
    store,
    requestCancellation: () => {
      state = transitionTask(state, { kind: 'cancel-request' }, new Date());
    },
    get state() {
      return state;
    },
  };
}

describe('primary monitor BullMQ processor', () => {
  beforeEach(() => {
    // Keep notification delays real while fixing the job's fixture clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T00:30:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('accepts a job one millisecond before its expiry', async () => {
    const f = fixture();
    f.data.countries = ['US'];
    f.groups.mockResolvedValueOnce([{ country: 'US', groupId: 'g1' }]);
    vi.setSystemTime(new Date(Date.parse(f.data.expiresAt) - 1));
    await expect(f.processor(f.job, 'fixture-lock')).resolves.toMatchObject({
      totalChecked: 1,
      totalBroken: 0,
    });
    expect(f.state.status).toBe('completed');
    expect(f.checkGroup).toHaveBeenCalledOnce();
    expect(f.sendCountry).toHaveBeenCalledOnce();
  });
  it('rejects a job at its exact expiry before database or upstream work', async () => {
    const f = fixture();
    vi.setSystemTime(new Date(f.data.expiresAt));
    await expect(f.processor(f.job, 'fixture-lock')).rejects.toThrow(
      '监控任务未完成',
    );
    expect(f.state.status).toBe('pending');
    expect(f.store.mutate).not.toHaveBeenCalled();
    expect(f.groups).not.toHaveBeenCalled();
    expect(f.checkGroup).not.toHaveBeenCalled();
    expect(f.claimNotification).not.toHaveBeenCalled();
    expect(f.sendCountry).not.toHaveBeenCalled();
  });
  it('checks each country before claiming country notifications and completes the owned task', async () => {
    const f = fixture();
    const output = await f.processor(f.job, 'fixture-lock');
    expect(f.order).toEqual([
      'check:g1',
      'check:g2',
      'claim:US',
      'send:US',
      'notification-committed:US',
      'claim:DE',
      'send:DE',
      'notification-committed:DE',
    ]);
    expect(output).toMatchObject({ totalChecked: 2, totalBroken: 1 });
    expect(f.state.status).toBe('completed');
    expect(f.checkGroup.mock.calls[0][1].operation).toEqual(
      monitorGroupOperation(f.data, 'g1'),
    );
    const context = f.checkGroup.mock.calls[0][1];
    expect(context.validateResult).toBeDefined();
    expect(() =>
      context.validateResult?.({
        ...result('g1', false),
        groupSnapshot: { ...result('g1', false).groupSnapshot, country: 'DE' },
      }),
    ).toThrow(VariantCheckError);
    expect(() =>
      context.validateResult?.({
        ...result('g1', false),
        groupSnapshot: { ...result('g1', false).groupSnapshot, country: 'us ' },
      }),
    ).not.toThrow();
    expect(monitorGroupOperation(f.data, 'g1').operationKey).not.toBe(
      monitorGroupOperation(f.data, 'g2').operationKey,
    );
  });
  it('does not resend a notification whose previous attempt was uncertain', async () => {
    const f = fixture();
    f.claimNotification.mockImplementationOnce(async () => 'claimed');
    const output = await f.processor(f.job, 'fixture-lock');
    expect(f.sendCountry).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({
      notificationResults: { US: 'unconfirmed', DE: 'sent' },
    });
  });
  it('rejects a fifth concurrent notification before its claim and sends it once on retry', async () => {
    const releases: (() => void)[] = [];
    const read = vi.fn(
      () =>
        new Promise<{ webhookUrl: string }>((resolve) => {
          releases.push(() =>
            resolve({ webhookUrl: 'https://example.invalid' }),
          );
        }),
    );
    const send = vi.fn(async () => ({ statusCode: 200, code: 0 }));
    const notifications = new FeishuNotifications({
      source: { read },
      transport: { send, close() {} },
      logger: { info() {}, warn() {}, error() {} },
    });
    const fixtures = Array.from({ length: 5 }, () => {
      const f = fixture(notifications);
      f.data.countries = ['US'];
      f.groups.mockResolvedValue([{ country: 'US', groupId: 'g1' }]);
      return f;
    });
    const running = fixtures.map((f) =>
      f.processor(f.job, 'fixture-lock').then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
    );
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(4));
      await vi.waitFor(() => expect(fixtures[4].checkGroup).toHaveBeenCalled());
      expect(await running[4]).toHaveProperty('error');
      expect(fixtures[4].claimNotification).not.toHaveBeenCalled();
      expect(fixtures[4].completeNotification).not.toHaveBeenCalled();
      expect(fixtures[4].state.status).toBe('processing');
      for (const release of releases) release();
      for (const task of running.slice(0, 4))
        expect(await task).toHaveProperty('value');
      read.mockResolvedValue({ webhookUrl: 'https://example.invalid' });
      fixtures[4].job.attemptsMade = 1;
      expect(
        await fixtures[4].processor(fixtures[4].job, 'fixture-lock'),
      ).toMatchObject({ notificationResults: { US: 'sent' } });
      expect(fixtures[4].claimNotification).toHaveBeenCalledOnce();
      expect(fixtures[4].completeNotification).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledTimes(5);
      expect(fixtures.every((f) => f.state.status === 'completed')).toBe(true);
    } finally {
      notifications.close();
      for (const release of releases) release();
      await Promise.all(running);
    }
  });
  it.each([false, true])(
    'completes a legacy group with an empty name (broken=%s)',
    async (broken) => {
      const f = fixture();
      f.data.countries = ['US'];
      f.groups.mockResolvedValueOnce([{ country: 'US', groupId: 'g1' }]);
      f.checkGroup.mockResolvedValueOnce({
        ...result('g1', broken),
        groupSnapshot: { ...result('g1', broken).groupSnapshot, name: '' },
      });
      await expect(f.processor(f.job, 'fixture-lock')).resolves.toMatchObject({
        totalChecked: 1,
        totalBroken: broken ? 1 : 0,
      });
      expect(f.state.status).toBe('completed');
      expect(f.sendCountry).toHaveBeenCalledTimes(1);
      if (broken) {
        const summary = f.sendCountry.mock.calls[0][2];
        expect(summary.brokenGroupNames).toEqual(['']);
        expect(summary.brokenASINs?.[0]?.groupName).toBe('');
      }
    },
  );
  it('includes every broken group and ASIN when the country has more than 100 groups', async () => {
    const f = fixture();
    f.data.countries = ['US'];
    f.groups.mockImplementationOnce(async () =>
      Array.from({ length: 101 }, (_, index) => ({
        country: 'US' as const,
        groupId: `g${index}`,
      })),
    );
    f.checkGroup.mockImplementation(async (id) => ({
      ...result(id, true),
      groupSnapshot: { ...result(id, true).groupSnapshot, country: 'US' },
    }));
    await f.processor(f.job, 'fixture-lock');
    const summary = f.sendCountry.mock.calls[0][2];
    expect(summary.brokenGroupNames).toHaveLength(101);
    expect(summary.brokenGroupDetails).toHaveLength(101);
    expect(summary.brokenASINs).toHaveLength(101);
  });
  it.each([
    { label: 'item count', groups: 3, brand: 'Fixture' },
    { label: 'text bytes', groups: 2, brand: 'B'.repeat(160) },
  ])(
    'fails a legal multi-group country at the $label cap without a retry or notification claim',
    async ({ groups, brand }) => {
      const f = fixture();
      f.data.countries = ['US'];
      f.groups.mockImplementationOnce(async () =>
        Array.from({ length: groups }, (_, index) => ({
          country: 'US' as const,
          groupId: `g${index + 1}`,
        })),
      );
      f.checkGroup.mockImplementation(async (id) => {
        const groupIndex = Number(id.slice(1)) - 1;
        const asins = Array.from(
          { length: 4_000 },
          (_, index) =>
            `B${String(groupIndex * 4_000 + index + 1).padStart(9, '0')}`,
        );
        return {
          ...result(id, true),
          brokenASINs: asins.map((asin) => ({
            asin,
            statusSource: 'AUTO',
          })),
          groupSnapshot: {
            ...result(id, true).groupSnapshot,
            country: 'US',
            children: asins.map((asin) => ({
              asin,
              feishuNotifyEnabled: 1,
              brand,
            })),
          },
        };
      });

      await expect(f.processor(f.job, 'fixture-lock')).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(f.checkGroup).toHaveBeenCalledTimes(groups);
      expect(f.state.status).toBe('failed');
      expect(f.state.message).toContain('通知摘要超出容量');
      expect(f.claimNotification).not.toHaveBeenCalled();
      expect(f.sendCountry).not.toHaveBeenCalled();
    },
  );
  it('rejects a rendered country card before claiming any country delivery', async () => {
    const f = fixture();
    const asins = Array.from(
      { length: 5000 },
      (_, index) => `B${String(index).padStart(9, '0')}`,
    );
    // US is small; the later DE card exceeds the sender limit after Markdown
    // expansion, while its raw notification text remains within the input cap.
    f.checkGroup.mockImplementation(async (id) =>
      id === 'g1'
        ? result(id, false)
        : {
            ...result(id, true),
            brokenASINs: asins.map((asin) => ({ asin, statusSource: 'AUTO' })),
            groupSnapshot: {
              ...result(id, true).groupSnapshot,
              children: asins.map((asin) => ({
                asin,
                brand: 'B'.repeat(140),
                feishuNotifyEnabled: 1,
              })),
            },
          },
    );
    await expect(f.processor(f.job, 'fixture-lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.checkGroup).toHaveBeenCalledTimes(2);
    expect(f.state.status).toBe('failed');
    expect(f.state.message).toContain('通知摘要超出容量');
    expect(f.claimNotification).not.toHaveBeenCalled();
    expect(f.completeNotification).not.toHaveBeenCalled();
    expect(f.sendCountry).not.toHaveBeenCalled();
  });
  it('timestamps the country after its group checks finish', async () => {
    const f = fixture();
    f.data.countries = ['US'];
    f.groups.mockImplementationOnce(async () => [
      { country: 'US' as const, groupId: 'g1' },
    ]);
    const finishedAt = new Date('2026-09-27T01:00:00.000Z');
    f.checkGroup.mockImplementationOnce(async () => {
      vi.setSystemTime(finishedAt);
      return result('g1', false);
    });
    await f.processor(f.job, 'fixture-lock');
    expect(f.sendCountry.mock.calls[0][2].checkTime).toBe(
      finishedAt.toISOString(),
    );
  });
  it('rejects a substituted job before database or upstream work', async () => {
    const f = fixture();
    f.job.data = { ...f.data, userId: 'other' };
    await expect(f.processor(f.job, 'fixture-lock')).rejects.toThrow();
    expect(f.groups).not.toHaveBeenCalled();
    expect(f.checkGroup).not.toHaveBeenCalled();
  });
  it('stops after the current committed group when cancellation is requested', async () => {
    const f = fixture();
    f.checkGroup.mockImplementationOnce(async (id) => {
      f.order.push(`check:${id}`);
      f.requestCancellation();
      return result(id, false);
    });
    expect(await f.processor(f.job, 'fixture-lock')).toEqual({
      cancelled: true,
    });
    expect(f.state.status).toBe('cancelled');
    expect(f.checkGroup).toHaveBeenCalledTimes(1);
    expect(f.sendCountry).not.toHaveBeenCalled();
  });
  it('keeps a fully committed final attempt recoverable when Redis completion fails', async () => {
    const f = fixture();
    f.job.attemptsMade = 2;
    const mutate = f.store.mutate.getMockImplementation()!;
    f.store.mutate.mockImplementation(async (id, change) => {
      if (change.kind === 'completed') throw new Error('Redis unavailable');
      return mutate(id, change);
    });
    const output = await f.processor(f.job, 'fixture-lock');
    expect(output).toMatchObject({ totalChecked: 2, totalBroken: 1 });
    expect(f.state.status).toBe('processing');
    expect(
      f.store.mutate.mock.calls.map(([, change]) => change.kind),
    ).not.toContain('failed');
    expect(f.sendCountry).toHaveBeenCalledTimes(2);
  });
  it('honors cancellation accepted between the final check and completion CAS', async () => {
    const f = fixture();
    const mutate = f.store.mutate.getMockImplementation()!;
    f.store.mutate.mockImplementation(async (id, change) => {
      if (change.kind === 'completed') f.requestCancellation();
      return mutate(id, change);
    });
    expect(await f.processor(f.job, 'fixture-lock')).toEqual({
      cancelled: true,
    });
    expect(f.state.status).toBe('cancelled');
    expect(f.state.result).toBeNull();
    expect(
      f.store.mutate.mock.calls.map(([, change]) => change.kind),
    ).toContain('cancelled');
  });
  it('isolates a deleted group but does not notify or report partial work as success', async () => {
    const f = fixture();
    f.checkGroup.mockRejectedValueOnce(
      new VariantCheckError('group-not-found'),
    );
    await expect(f.processor(f.job, 'fixture-lock')).rejects.toThrow();
    expect(f.checkGroup).toHaveBeenCalledTimes(2);
    expect(f.sendCountry).not.toHaveBeenCalled();
    expect(f.state.status).toBe('processing');
  });
});
