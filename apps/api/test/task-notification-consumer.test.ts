import { encodeTaskNotification, type TaskState } from '@asin-monitor/db';
import { describe, expect, it, vi } from 'vitest';
import { TaskNotificationConsumer } from '../src/websocket/task-notification-consumer';
import { taskFixture } from './helpers/task-query-fixtures';

function fixture(task = taskFixture()) {
  const read = vi.fn(async () => task as TaskState | null);
  const deliver = vi.fn(),
    warn = vi.fn();
  return {
    task,
    read,
    deliver,
    warn,
    consumer: new TaskNotificationConsumer(read, deliver, warn),
  };
}
describe('authoritative task notification consumer', () => {
  it.each([
    'pending',
    'processing',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
  ] as const)(
    'maps %s into the frozen owner-only WS contract without private result fields',
    async (status) => {
      const f = fixture(
        taskFixture({
          status,
          progress: 41,
          revision: 2,
          result: {
            filename: 'C:\\private\\report.json',
            filepath: '/private/result.json',
            downloadUrl: 'https://evil.invalid',
            token: 'private-token',
            errors: ['private-row'],
          },
          error: 'private-database-failure',
        }),
      );
      f.consumer.receive(encodeTaskNotification(f.task));
      await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
      const event = f.deliver.mock.calls[0][0];
      expect(event).toMatchObject({
        audience: 'user',
        userId: f.task.userId,
        message: {
          taskId: f.task.taskId,
          type:
            status === 'completed'
              ? 'task_complete'
              : status === 'failed'
              ? 'task_error'
              : status === 'cancelled'
              ? 'task_cancelled'
              : 'task_progress',
        },
      });
      expect(JSON.stringify(event)).not.toMatch(
        /private|evil.invalid|errors|token/,
      );
      if (status === 'completed')
        expect(event.message).toMatchObject({
          filename: 'report.json',
          downloadUrl: '/api/v1/tasks/task-95/download',
        });
      expect(event.message.timestamp).toBe('2026-09-01T08:00:00.000+08:00');
      f.consumer.stop();
    },
  );
  it.each(['userId', 'taskType', 'createdAt'] as const)(
    'drops a reused task identity with different %s',
    async (field) => {
      const f = fixture();
      const notice = encodeTaskNotification(f.task);
      f.read.mockResolvedValue({
        ...f.task,
        [field]:
          field === 'createdAt' ? '2026-09-02T00:00:00.000Z' : 'replacement',
        revision: 10,
      });
      f.consumer.receive(notice);
      await vi.waitFor(() => expect(f.consumer['active'].size).toBe(0));
      expect(f.deliver).not.toHaveBeenCalled();
    },
  );
  it.each(['expired', 'future'] as const)(
    'does not emit %s metadata or revisions',
    async (kind) => {
      const f = fixture();
      f.read.mockResolvedValue(kind === 'expired' ? null : f.task);
      f.consumer.receive(encodeTaskNotification({ ...f.task, revision: 2 }));
      await vi.waitFor(() => expect(f.consumer['active'].size).toBe(0));
      expect(f.deliver).not.toHaveBeenCalled();
    },
  );
  it('coalesces bursts while rereading, then suppresses duplicate and older revisions', async () => {
    const f = fixture(taskFixture({ revision: 100, status: 'completed' }));
    let release!: (value: TaskState) => void;
    f.read.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    for (let revision = 0; revision <= 100; revision++)
      f.consumer.receive(encodeTaskNotification({ ...f.task, revision }));
    expect(f.read).toHaveBeenCalledOnce();
    release(f.task);
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    for (const revision of [100, 1, 99, 0])
      f.consumer.receive(encodeTaskNotification({ ...f.task, revision }));
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledOnce();
  });
  it('bounds parallel reads and queued distinct tasks under overload', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async (taskId: string) => {
      await gate;
      return taskFixture({ taskId });
    });
    const deliver = vi.fn(),
      warn = vi.fn();
    const consumer = new TaskNotificationConsumer(read, deliver, warn);
    for (let i = 0; i < 300; i++)
      consumer.receive(
        encodeTaskNotification(taskFixture({ taskId: `task-${i}` })),
      );
    expect(read).toHaveBeenCalledTimes(8);
    expect(consumer['pending'].size).toBe(256);
    expect(warn).toHaveBeenCalledWith('task_notification_overload');
    release();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(264));
    expect(read).toHaveBeenCalledTimes(264);
    consumer.stop();
  });
  it.each(['disconnected', 'stop'] as const)(
    'drops late reads after %s',
    async (action) => {
      const f = fixture();
      let release!: (value: TaskState) => void;
      f.read.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      f.consumer.receive(encodeTaskNotification(f.task));
      f.consumer[action]();
      release(f.task);
      await vi.waitFor(() => expect(f.consumer['active'].size).toBe(0));
      expect(f.deliver).not.toHaveBeenCalled();
      f.consumer.receive(encodeTaskNotification(f.task));
      if (action === 'disconnected')
        await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
      else expect(f.read).toHaveBeenCalledOnce();
    },
  );
  it('rejects unknown and oversized payloads before dependency access', () => {
    const f = fixture();
    for (const raw of [
      '{',
      '{}',
      'x'.repeat(4097),
      JSON.stringify({
        ...JSON.parse(encodeTaskNotification(f.task)),
        version: 2,
      }),
    ])
      f.consumer.receive(raw);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledTimes(4);
  });
  it('recovers after a bounded dependency failure without exposing the exception', async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error('private-token'));
    f.consumer.receive(encodeTaskNotification(f.task));
    await vi.waitFor(() =>
      expect(f.warn).toHaveBeenCalledWith('task_notification_read_failed'),
    );
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain('private-token');
    f.consumer.receive(encodeTaskNotification(f.task));
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
  });
});
