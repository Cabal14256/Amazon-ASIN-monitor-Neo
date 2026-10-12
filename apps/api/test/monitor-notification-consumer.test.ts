import {
  monitorNoticeSchema,
  type MonitorProof,
  type TaskState,
} from '@asin-monitor/db';
import { describe, expect, it, vi } from 'vitest';
import { MonitorNotificationConsumer } from '../src/websocket/monitor-notification-consumer';

function event() {
  const task: TaskState = {
    taskId: 'monitor-fixture',
    userId: 'owner',
    taskType: 'monitor',
    taskSubType: 'primary',
    title: '',
    status: 'processing',
    progress: 5,
    message: '',
    error: null,
    result: null,
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:01.000Z',
    startedAt: '2026-10-11T00:00:01.000Z',
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    revision: 1,
  };
  const notice = monitorNoticeSchema.parse({
    version: 1,
    type: 'monitor_changed',
    taskId: task.taskId,
    userId: task.userId,
    taskType: task.taskType,
    taskSubType: task.taskSubType,
    createdAt: task.createdAt,
    revision: task.revision,
    slot: 'US',
    sequence: 10,
  });
  const proof: MonitorProof = {
    notice,
    message: {
      type: 'monitor_progress',
      status: 'progress',
      country: 'US',
      current: 10,
      total: 11,
      progress: 91,
      timestamp: '2026-10-11T08:00:01.000+08:00',
    },
  };
  return { task, proof };
}
describe('validated monitor events', () => {
  it('broadcasts only a current stored proof, suppresses duplicates and older country hints', async () => {
    const value = event(),
      deliver = vi.fn(),
      warn = vi.fn(),
      read = vi.fn(async () => value);
    const consumer = new MonitorNotificationConsumer(read, deliver, warn);
    consumer.receive(JSON.stringify(value.proof.notice));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(deliver).toHaveBeenCalledWith({
      audience: 'all',
      message: value.proof.message,
    });
    consumer.receive(JSON.stringify(value.proof.notice));
    consumer.receive(JSON.stringify({ ...value.proof.notice, sequence: 1 }));
    expect(read).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    consumer.stop();
  });
  it.each([
    'owner',
    'subtype',
    'incarnation',
    'revision',
    'cancelled',
    'failed',
    'completed',
    'missing-proof',
  ])('rejects %s at authoritative read time', async (change) => {
    const value = event(),
      deliver = vi.fn();
    if (change === 'owner') value.task.userId = 'replacement';
    if (change === 'subtype') value.task.taskSubType = 'wrong';
    if (change === 'incarnation')
      value.task.createdAt = '2026-10-11T00:00:00.001Z';
    if (change === 'revision') value.task.revision = 0;
    if (change === 'cancelled')
      value.task.cancelRequestedAt = value.task.updatedAt;
    if (change === 'failed' || change === 'completed')
      value.task.status = change;
    const consumer = new MonitorNotificationConsumer(
      async () => (change === 'missing-proof' ? null : value),
      deliver,
      vi.fn(),
    );
    consumer.receive(JSON.stringify(value.proof.notice));
    await vi.waitFor(() => expect(consumer['active'].size).toBe(0));
    expect(deliver).not.toHaveBeenCalled();
    consumer.stop();
  });
  it('rejects malformed, unknown-field and oversized hints before I/O', () => {
    const read = vi.fn(),
      warn = vi.fn(),
      consumer = new MonitorNotificationConsumer(read, vi.fn(), warn);
    for (const raw of [
      '{',
      'x'.repeat(4097),
      JSON.stringify({ ...event().proof.notice, message: 'private-payload' }),
    ])
      consumer.receive(raw);
    expect(read).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    consumer.stop();
  });
  it.each(['valid', 'partial-result', 'wrong-country', 'wrong-country-counts'])(
    'binds completion to authoritative country counts: %s',
    async (change) => {
      const value = event(),
        deliver = vi.fn();
      value.task.status = 'completed';
      value.task.result = {
        success: true,
        totalChecked: 1,
        totalBroken: 1,
        totalNormal: 0,
        countryResults: {
          [change === 'wrong-country' ? 'DE' : 'US']: {
            totalGroups: change === 'wrong-country-counts' ? 2 : 1,
            brokenGroups: 1,
          },
        },
      };
      if (change === 'partial-result') value.task.status = 'processing';
      value.proof.notice = {
        ...value.proof.notice,
        slot: 'complete',
        sequence: 7000,
      };
      value.proof.message = {
        type: 'monitor_complete',
        success: true,
        totalChecked: 1,
        totalBroken: 1,
        totalNormal: 0,
        duration: '1.25',
        timestamp: '2026-10-11T08:00:01.000+08:00',
        countryResults: {
          US: {
            country: 'US',
            totalGroups: 1,
            brokenGroups: 1,
            brokenGroupNames: ['Fixture'],
            brokenGroupDetails: [{ variantGroupId: 'g', groupName: 'Fixture' }],
            brokenASINs: [],
            brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
            checkedGroupKeys: ['group:g'],
            asinClassifications: {},
            checkTime: value.task.createdAt,
          },
        },
      };
      const consumer = new MonitorNotificationConsumer(
        async () => value,
        deliver,
        vi.fn(),
      );
      consumer.receive(JSON.stringify(value.proof.notice));
      await vi.waitFor(() => expect(consumer['active'].size).toBe(0));
      expect(deliver).toHaveBeenCalledTimes(change === 'valid' ? 1 : 0);
      consumer.stop();
    },
  );
  it('keeps country high water independent and does not mix task_progress with country percentage', async () => {
    const us = event(),
      de = event(),
      deliver = vi.fn();
    de.proof.notice = { ...de.proof.notice, slot: 'DE', sequence: 1002 };
    de.proof.message = {
      ...de.proof.message,
      country: 'DE',
      current: 1,
      total: 1,
      progress: 100,
    } as MonitorProof['message'];
    const consumer = new MonitorNotificationConsumer(
      async (n) => (n.slot === 'US' ? us : de),
      deliver,
      vi.fn(),
    );
    consumer.receive(JSON.stringify(us.proof.notice));
    consumer.receive(JSON.stringify(de.proof.notice));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(
      deliver.mock.calls.map(([e]) => e.message.progress).sort((a, b) => a - b),
    ).toEqual([91, 100]);
    consumer.stop();
  });
  it('discards in-flight reads on disconnect and permits a fresh retry after dependency failure', async () => {
    const value = event(),
      deliver = vi.fn(),
      warn = vi.fn();
    let release!: (result: ReturnType<typeof event>) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('private dependency failure'))
      .mockResolvedValue(value);
    const consumer = new MonitorNotificationConsumer(read, deliver, warn);
    consumer.receive(JSON.stringify(value.proof.notice));
    consumer.disconnected();
    release(value);
    await vi.waitFor(() => expect(consumer['active'].size).toBe(0));
    expect(deliver).not.toHaveBeenCalled();
    consumer.receive(JSON.stringify(value.proof.notice));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('monitor_notification_read_failed'),
    );
    consumer.receive(JSON.stringify(value.proof.notice));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    consumer.stop();
  });
  it.each(['started', 'progress'] as const)(
    'drops a held old %s read after a validated terminal was delivered',
    async (oldPhase) => {
      const old = event(),
        finished = event(),
        deliver = vi.fn();
      if (oldPhase === 'started') {
        old.proof.notice = {
          ...old.proof.notice,
          slot: 'started',
          sequence: 0,
        };
        old.proof.message = {
          type: 'monitor_progress',
          status: 'started',
          countries: ['US'],
          batchInfo: null,
          timestamp: '2026-10-11T08:00:01.000+08:00',
        };
      }
      finished.task.status = 'completed';
      finished.task.result = {
        success: true,
        totalChecked: 0,
        totalBroken: 0,
        totalNormal: 0,
        countryResults: {},
      };
      finished.proof.notice = {
        ...finished.proof.notice,
        slot: 'complete',
        sequence: 7000,
      };
      finished.proof.message = {
        type: 'monitor_complete',
        success: true,
        totalChecked: 0,
        totalBroken: 0,
        totalNormal: 0,
        countryResults: {},
        duration: '1.00',
        timestamp: '2026-10-11T08:00:02.000+08:00',
      };
      let release!: (result: ReturnType<typeof event>) => void;
      const consumer = new MonitorNotificationConsumer(
        async (n) =>
          n.slot === 'complete'
            ? finished
            : new Promise((resolve) => {
                release = resolve;
              }),
        deliver,
        vi.fn(),
      );
      consumer.receive(JSON.stringify(old.proof.notice));
      consumer.receive(JSON.stringify(finished.proof.notice));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      release(old);
      await vi.waitFor(() => expect(consumer['active'].size).toBe(0));
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0][0].message.type).toBe('monitor_complete');
      consumer.stop();
    },
  );
  it('drops held started after validated country progress without suppressing another country', async () => {
    const started = event(),
      us = event(),
      de = event(),
      deliver = vi.fn();
    started.proof.notice = {
      ...started.proof.notice,
      slot: 'started',
      sequence: 0,
    };
    started.proof.message = {
      type: 'monitor_progress',
      status: 'started',
      countries: ['US', 'DE'],
      batchInfo: null,
      timestamp: '2026-10-11T08:00:01.000+08:00',
    };
    de.proof.notice = { ...de.proof.notice, slot: 'DE', sequence: 1002 };
    de.proof.message = {
      ...de.proof.message,
      country: 'DE',
      current: 1,
      total: 1,
      progress: 100,
    } as MonitorProof['message'];
    let release!: (result: ReturnType<typeof event>) => void;
    const consumer = new MonitorNotificationConsumer(
      async (n) =>
        n.slot === 'started'
          ? new Promise((resolve) => {
              release = resolve;
            })
          : n.slot === 'US'
          ? us
          : de,
      deliver,
      vi.fn(),
    );
    consumer.receive(JSON.stringify(started.proof.notice));
    consumer.receive(JSON.stringify(us.proof.notice));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    release(started);
    consumer.receive(JSON.stringify(de.proof.notice));
    await vi.waitFor(() => expect(consumer['active'].size).toBe(0));
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map(([e]) => e.message.country)).toEqual([
      'US',
      'DE',
    ]);
    consumer.stop();
  });
  it('bounds active and pending metadata reads, and stops without delayed broadcasts', async () => {
    const releases: ((value: null) => void)[] = [],
      deliver = vi.fn(),
      warn = vi.fn();
    const read = vi.fn(
      () => new Promise<null>((resolve) => releases.push(resolve)),
    );
    const consumer = new MonitorNotificationConsumer(read, deliver, warn);
    for (let i = 0; i < 300; i++)
      consumer.receive(
        JSON.stringify({ ...event().proof.notice, taskId: `task-${i}` }),
      );
    expect(read).toHaveBeenCalledTimes(8);
    expect(consumer['pending'].size).toBe(256);
    expect(warn).toHaveBeenCalledWith('monitor_notification_overload');
    consumer.stop();
    for (const release of releases) release(null);
    await vi.waitFor(() => expect(consumer['active'].size).toBe(0));
    expect(deliver).not.toHaveBeenCalled();
  });
});
