import { describe, expect, it, vi } from 'vitest';
import {
  RedisTaskRepository,
  type TaskRedisPort,
} from '../src/repositories/redis-task-repository';
import {
  encodeTaskNotification,
  parseTaskNotification,
  taskNotificationChannel,
} from '../src/repositories/task-notification';

const config = {
  BULL_PREFIX: ' fixture ',
  TASK_META_TTL_SECONDS: 60,
  TASK_USER_MAX_ITEMS: 20,
};
const input = { taskId: 'task', userId: 'owner', taskType: 'import' };
const now = () => new Date('2026-09-01T00:00:00Z');
const valid = {
  ...input,
  version: 1,
  type: 'task_changed',
  createdAt: now().toISOString(),
  revision: 0,
};
describe('internal task notification wire format', () => {
  it('includes only immutable identity and committed revision, in the matching environment channel', async () => {
    const evalCommand = vi.fn(async () => 1);
    const repository = new RedisTaskRepository(
      { eval: evalCommand } as unknown as TaskRedisPort,
      config,
      now,
    );
    const task = await repository.create({
      ...input,
      message: 'private fixture',
    });
    expect(
      JSON.parse(
        encodeTaskNotification({
          ...task,
          result: { token: 'private', filepath: '/private/path' },
        }),
      ),
    ).toEqual(valid);
    const args = (evalCommand.mock.calls as unknown as unknown[][])[0];
    expect(args[10]).toBe('fixture:neo:task:events');
    expect(JSON.parse(args[11] as string)).toEqual(valid);
    expect(taskNotificationChannel(' other ')).not.toBe(args[10]);
    expect(() => taskNotificationChannel(' ')).toThrow(
      'TASK_REGISTRY_CONFIG_INVALID',
    );
  });
  it.each([
    null,
    {},
    { ...valid, version: 2 },
    { ...valid, type: 'task_complete' },
    { ...valid, result: 'private' },
    { ...valid, userId: '' },
    { ...valid, revision: -1 },
    { ...valid, revision: 1.1 },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, createdAt: 'invalid' },
    { ...valid, taskId: 'x'.repeat(201) },
  ])('rejects malformed, extended or unknown notices %#', (value) => {
    expect(parseTaskNotification(JSON.stringify(value))).toBeNull();
  });
  it('bounds input before parsing and tolerates invalid JSON', () => {
    expect(parseTaskNotification(' '.repeat(4097))).toBeNull();
    expect(parseTaskNotification('{')).toBeNull();
    expect(parseTaskNotification(JSON.stringify(valid))).toEqual(valid);
  });
  it.each([false, true])(
    'keeps committed success when publication fails and warning throws=%s',
    async (throws) => {
      const callback = vi.fn(() => {
        if (throws) throw new Error('diagnostic failed');
      });
      const evalCommand = vi.fn(async () => 2);
      const repository = new RedisTaskRepository(
        { eval: evalCommand } as unknown as TaskRedisPort,
        config,
        now,
        callback,
      );
      await expect(repository.create(input)).resolves.toMatchObject({
        status: 'pending',
        revision: 0,
      });
      expect(evalCommand).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledOnce();
    },
  );
});
