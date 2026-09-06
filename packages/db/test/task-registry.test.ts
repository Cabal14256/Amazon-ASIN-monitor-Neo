import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  RedisTaskRepository,
  TASK_RECORD_MAX_BYTES,
  type TaskRedisPort,
} from '../src/repositories/redis-task-repository';
import { transitionTask } from '../src/repositories/task-state';

const config = {
  BULL_PREFIX: 'fixture',
  TASK_META_TTL_SECONDS: 604800,
  TASK_USER_MAX_ITEMS: 200,
};
const input = { taskId: 'task-a', userId: 'owner-a', taskType: 'export' };
function fixture() {
  const rows = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => rows.get(key) ?? null),
    eval: vi.fn(
      async (
        _script: string,
        _count: number,
        key: string,
        _index: string,
        expected: string,
        value: string,
      ) => {
        if ((rows.get(key) ?? '') !== expected) return 0;
        rows.set(key, value);
        return 1;
      },
    ),
    zrevrange: vi.fn(async () => ['task-a']),
    mget: vi.fn(async (...keys: string[]) =>
      keys.map((key) => rows.get(key) ?? null),
    ),
  };
  const repository = new RedisTaskRepository(
    redis as unknown as TaskRedisPort,
    config,
    () => new Date('2026-09-01T00:00:00Z'),
  );
  return { repository, redis, rows };
}
describe('Redis task registry behavior', () => {
  it('matches Legacy creation and transition fields for sequential happy paths', async () => {
    const { repository } = fixture();
    const legacyPath = resolve(
      __dirname,
      '../../../server/src/services/taskRegistryService.js',
    );
    const module = {
      exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
    };
    const nativeRequire = createRequire(legacyPath);
    runInNewContext(readFileSync(legacyPath, 'utf8'), {
      module,
      exports: module.exports,
      process: { env: { TASK_REGISTRY_MEMORY_ONLY: 'true' } },
      require: (name: string) =>
        name.includes('logger')
          ? { warn: vi.fn() }
          : name.includes('config/redis')
          ? {}
          : nativeRequire(name),
    });
    const strip = (task: unknown) =>
      Object.fromEntries(
        Object.entries(task as Record<string, unknown>).filter(
          ([key]) =>
            !key.endsWith('At') &&
            !['revision', 'title', 'taskSubType'].includes(key),
        ),
      );
    expect(strip(await repository.create(input))).toEqual(
      strip(await module.exports.createTask(input)),
    );
    expect(
      strip(
        await repository.mutate(input.taskId, {
          kind: 'progress',
          progress: 20,
          message: 'fixture',
        }),
      ),
    ).toEqual(
      strip(
        await module.exports.updateTaskProgress(input.taskId, 20, 'fixture'),
      ),
    );
    expect(
      strip(await repository.mutate(input.taskId, { kind: 'cancel-request' })),
    ).toEqual(
      strip(await module.exports.requestTaskCancellation(input.taskId)),
    );
    expect(
      strip(await repository.mutate(input.taskId, { kind: 'cancelled' })),
    ).toEqual(strip(await module.exports.markTaskCancelled(input.taskId)));
  });
  it('creates immutable owner metadata and uses independent Neo keys and default TTL/index cap', async () => {
    const { repository, redis } = fixture();
    const task = await repository.create(input);
    expect(task).toMatchObject({
      ...input,
      status: 'pending',
      revision: 0,
      progress: 0,
    });
    const call = redis.eval.mock.calls[0] as unknown[];
    expect(call.slice(1, 5)).toEqual([
      2,
      'fixture:neo:task:meta:task-a',
      'fixture:neo:task:user:owner-a',
      '',
    ]);
    expect(call.slice(6)).toEqual([
      604800,
      Date.parse(task.updatedAt),
      'task-a',
      200,
    ]);
    await expect(
      repository.create({ ...input, userId: 'attacker' }),
    ).rejects.toMatchObject({ code: 'TASK_EXISTS' });
    expect((await repository.read(input.taskId))?.userId).toBe('owner-a');
  });
  it('does not implicitly create missing or expired metadata', async () => {
    const { repository, redis, rows } = fixture();
    expect(
      await repository.mutate('missing', { kind: 'processing' }),
    ).toBeNull();
    await repository.create(input);
    rows.clear();
    expect(await repository.read(input.taskId)).toBeNull();
    expect(await repository.listUser(input.userId)).toEqual([]);
    expect(
      await repository.mutate(input.taskId, { kind: 'completed' }),
    ).toBeNull();
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });
  it('retains cancellation across a conflicting progress write', async () => {
    const { repository, redis, rows } = fixture();
    const task = await repository.create(input);
    redis.eval.mockImplementationOnce(async () => {
      rows.set(
        'fixture:neo:task:meta:task-a',
        JSON.stringify(
          transitionTask(
            task,
            { kind: 'cancel-request' },
            new Date(task.updatedAt),
          ),
        ),
      );
      return 0;
    });
    const next = await repository.mutate(input.taskId, {
      kind: 'progress',
      progress: 40,
    });
    expect(next).toMatchObject({
      status: 'cancelling',
      progress: 40,
      revision: 2,
    });
    expect(next?.cancelRequestedAt).not.toBeNull();
  });
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'first %s terminal state wins and does not refresh TTL',
    async (status) => {
      const { repository, redis } = fixture();
      await repository.create(input);
      const terminal = await repository.mutate(input.taskId, {
        kind: status,
        message: 'terminal',
      });
      for (const kind of [
        'processing',
        'completed',
        'cancel-request',
        'cancelled',
        'failed',
      ] as const) {
        expect(
          await repository.mutate(input.taskId, { kind, message: 'late' }),
        ).toEqual(terminal);
      }
      expect(redis.eval).toHaveBeenCalledTimes(2);
    },
  );
  it('bounds CAS conflict retries and propagates Redis failures without fake success', async () => {
    const { repository, redis } = fixture();
    await repository.create(input);
    redis.eval.mockClear().mockResolvedValue(0);
    await expect(
      repository.mutate(input.taskId, { kind: 'processing' }),
    ).rejects.toMatchObject({ code: 'TASK_CONTENTION' });
    expect(redis.eval).toHaveBeenCalledTimes(8);
    redis.get.mockRejectedValue(new Error('fixture unavailable'));
    await expect(repository.read(input.taskId)).rejects.toThrow(
      'fixture unavailable',
    );
    redis.eval.mockRejectedValue(new Error('fixture write unavailable'));
    await expect(
      repository.create({ ...input, taskId: 'new' }),
    ).rejects.toThrow('fixture write unavailable');
  });
  it('rejects malformed, mismatched, oversized and non-JSON records before writing', async () => {
    const { repository, redis, rows } = fixture();
    const task = await repository.create(input);
    for (const raw of [
      '{',
      JSON.stringify({ ...task, taskId: 'other' }),
      'x'.repeat(TASK_RECORD_MAX_BYTES + 1),
    ]) {
      rows.set('fixture:neo:task:meta:task-a', raw);
      await expect(repository.read(input.taskId)).rejects.toMatchObject({
        code: 'TASK_RECORD_INVALID',
      });
    }
    rows.set('fixture:neo:task:meta:task-a', JSON.stringify(task));
    redis.eval.mockClear();
    await expect(
      repository.mutate(input.taskId, {
        kind: 'completed',
        result: 'x'.repeat(TASK_RECORD_MAX_BYTES),
      }),
    ).rejects.toMatchObject({ code: 'TASK_RECORD_TOO_LARGE' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      repository.mutate(input.taskId, { kind: 'completed', result: circular }),
    ).rejects.toMatchObject({ code: 'TASK_RECORD_INVALID' });
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it.each([undefined, () => 'value', Symbol('fixture'), 1n, NaN, Infinity])(
    'rejects unsupported nested result values (%s)',
    async (value) => {
      const { repository, redis } = fixture();
      await repository.create(input);
      redis.eval.mockClear();
      await expect(
        repository.mutate(input.taskId, {
          kind: 'completed',
          result: { value },
        }),
      ).rejects.toMatchObject({ code: 'TASK_RECORD_INVALID' });
      expect(redis.eval).not.toHaveBeenCalled();
    },
  );
  it('filters after reading the bounded full index and verifies owner again', async () => {
    const { repository, redis, rows } = fixture();
    const task = await repository.create(input);
    const ids = Array.from({ length: 12 }, (_, i) => `other-${i}`);
    for (const id of ids)
      rows.set(
        `fixture:neo:task:meta:${id}`,
        JSON.stringify({ ...task, taskId: id, status: 'completed' }),
      );
    rows.set(
      'fixture:neo:task:meta:foreign',
      JSON.stringify({ ...task, taskId: 'foreign', userId: 'other' }),
    );
    redis.zrevrange.mockResolvedValue([
      ...ids,
      'foreign',
      'expired',
      input.taskId,
    ]);
    expect(
      (
        await repository.listUser(input.userId, { limit: 1, status: 'active' })
      ).map((t) => t.taskId),
    ).toEqual([input.taskId]);
    expect(redis.zrevrange).toHaveBeenCalledWith(
      'fixture:neo:task:user:owner-a',
      0,
      199,
    );
    await expect(
      repository.listUser(input.userId, { limit: 0 }),
    ).rejects.toThrow('TASK_LIMIT_INVALID');
  });
});
