import { describe, expect, it, vi } from 'vitest';
import {
  RedisMonitorEventRepository,
  parseMonitorNotice,
  type MonitorMessage,
} from '../src/repositories/monitor-events';
import type { TaskState } from '../src/repositories/task-state';

const active: TaskState = {
  taskId: 'fixture-252',
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
const message: MonitorMessage = {
  type: 'monitor_progress',
  status: 'progress',
  country: 'US',
  current: 10,
  total: 11,
  progress: 91,
  timestamp: '2026-10-11T08:00:01.000+08:00',
};
const config = { BULL_PREFIX: 'fixture-252', TASK_META_TTL_SECONDS: 60 };
describe('monitor publisher input boundary', () => {
  it('reads a verified proof when the same valid hint has a different property order', async () => {
    const evalCommand = vi.fn(
        async (..._args: unknown[]): Promise<unknown> => 1,
      ),
      repository = new RedisMonitorEventRepository(
        { eval: evalCommand },
        config,
      );
    await repository.publish(active, 10, message);
    const args = evalCommand.mock.calls[0],
      hint = parseMonitorNotice(args.at(-1) as string)!;
    const reordered = Object.fromEntries(
      Object.entries(hint).reverse(),
    ) as typeof hint;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(hint));
    evalCommand.mockResolvedValueOnce([JSON.stringify(active), args.at(-4)]);
    const verified = await repository.read(reordered);
    expect(verified?.proof.message).toEqual(message);
    expect(verified?.task).toEqual(active);
  });
  it('enforces the encoded byte budget before deep schema validation and before Redis I/O', async () => {
    const evalCommand = vi.fn(),
      repository = new RedisMonitorEventRepository(
        { eval: evalCommand },
        config,
      );
    const oversized = {
      type: 'monitor_complete',
      unknownField: 'x'.repeat(1024 * 1024 + 1),
    } as unknown as MonitorMessage;
    await expect(repository.publish(active, 7000, oversized)).rejects.toThrow(
      'MONITOR_EVENT_TOO_LARGE',
    );
    expect(evalCommand).not.toHaveBeenCalled();
  });
  it('rejects unknown public fields, wrong percentage, cancellation and type/subtype mismatch before I/O', async () => {
    const evalCommand = vi.fn(),
      repository = new RedisMonitorEventRepository(
        { eval: evalCommand },
        config,
      );
    await expect(
      repository.publish(active, 10, {
        ...message,
        secret: 'private',
      } as MonitorMessage),
    ).rejects.toThrow();
    await expect(
      repository.publish(active, 10, { ...message, progress: 90 }),
    ).rejects.toThrow();
    await expect(
      repository.publish(
        { ...active, cancelRequestedAt: active.updatedAt },
        10,
        message,
      ),
    ).rejects.toThrow('MONITOR_EVENT_STATE_INVALID');
    await expect(
      repository.publish({ ...active, taskSubType: 'competitor' }, 10, message),
    ).rejects.toThrow();
    expect(evalCommand).not.toHaveBeenCalled();
  });
  it('publishes a small strict hint with incarnation/phase, without the business payload', async () => {
    const evalCommand = vi.fn(async () => 1),
      repository = new RedisMonitorEventRepository(
        { eval: evalCommand },
        config,
      );
    await repository.publish(active, 10, message);
    expect(evalCommand).toHaveBeenCalledOnce();
    const args = evalCommand.mock.calls[0] as unknown as unknown[];
    expect(args.at(-2)).toBe('fixture-252:neo:monitor:events');
    const hint = args.at(-1) as string;
    expect(parseMonitorNotice(hint)).toMatchObject({
      taskId: active.taskId,
      userId: active.userId,
      taskType: 'monitor',
      taskSubType: 'primary',
      createdAt: active.createdAt,
      slot: 'US',
      sequence: 10,
      revision: 1,
    });
    expect(hint).not.toContain('timestamp');
    expect(hint).not.toContain('countryResults');
  });
});
