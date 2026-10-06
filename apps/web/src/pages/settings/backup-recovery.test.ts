import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/http';
import { taskFixture } from '../../services/task-fixtures';
import { BackupRecovery } from './backup-recovery';

const taskId = '10000000-0000-4000-8000-000000000221';
const operation = { operation: 'create' as const, target: 'primary' as const };
function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
  let tail = Promise.resolve(),
    index = 0;
  const locks = {
    request: async <T>(_key: string, work: () => T | Promise<T>) => {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      try {
        return await work();
      } finally {
        release();
      }
    },
  } as unknown as LockManager;
  const create = (owner = 'operator') =>
    new BackupRecovery(
      owner,
      storage,
      locks,
      () => 1000,
      () => `request-${++index}`,
    );
  return { values, storage, create, recovery: create() };
}
const accepted = async () => ({ taskId, status: 'pending' as const });
const current = () => true;

describe('backup durable submission and GET-only recovery', () => {
  it.each(['NETWORK', 'TIMEOUT', 'CANCELLED', 'INVALID_RESPONSE'] as const)(
    'retains %s across reload and never dispatches a second POST',
    async (kind) => {
      const f = fixture();
      const send = vi.fn(async () => {
        throw new ApiError(kind, 'lost');
      });
      expect((await f.recovery.submit(operation, send, current)).kind).toBe(
        'unknown',
      );
      expect(f.create().read()).toMatchObject({
        ...operation,
        state: 'unknown',
      });
      expect(
        (
          await f
            .create()
            .submit({ ...operation, target: 'competitor' }, send, current)
        ).kind,
      ).toBe('blocked');
      expect(send).toHaveBeenCalledOnce();
    },
  );
  it('keeps an unknown 500 task ID and serializes concurrent tabs', async () => {
    const f = fixture();
    const send = vi.fn(async () => {
      throw new ApiError('HTTP', 'unknown', 500, 500, {
        taskId,
        status: 'unknown',
      });
    });
    const outcomes = await Promise.all([
      f.recovery.submit(operation, send, current),
      f.create().submit(operation, send, current),
    ]);
    expect(outcomes.map((result) => result.kind)).toEqual(['task', 'blocked']);
    expect(f.create().read()).toMatchObject({ state: 'unknown', taskId });
    expect(send).toHaveBeenCalledOnce();
  });
  it('isolates owners and prevents stale session dispatch', async () => {
    const f = fixture();
    await f.recovery.submit(operation, accepted, current);
    expect(f.create('another').read()).toBeNull();
    const send = vi.fn(accepted);
    expect(
      (await f.create('another').submit(operation, send, () => false)).kind,
    ).toBe('stale');
    expect(send).not.toHaveBeenCalled();
  });
  it('fails closed for malformed or unreadable guards without deleting them', async () => {
    const f = fixture();
    f.values.set(f.recovery.key, '{broken');
    expect(() => f.recovery.read()).toThrow();
    await expect(
      f.recovery.submit(operation, accepted, current),
    ).rejects.toThrow();
    expect(f.values.get(f.recovery.key)).toBe('{broken');
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    f.storage.getItem.mockImplementation(() => {
      throw new Error('unreadable');
    });
    await expect(
      f.recovery.submit(operation, accepted, current),
    ).rejects.toThrow();
  });
  it('does not dispatch when durable persistence cannot be verified', async () => {
    const f = fixture();
    f.storage.setItem.mockImplementation(() => undefined);
    const send = vi.fn(accepted);
    await expect(f.recovery.submit(operation, send, current)).rejects.toThrow(
      'BACKUP_GATE_UNAVAILABLE',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('allows a definite pre-enqueue rejection to release its own reservation', async () => {
    const f = fixture();
    expect(
      (
        await f.recovery.submit(
          operation,
          async () => {
            throw new ApiError('HTTP', 'denied', 403);
          },
          current,
        )
      ).kind,
    ).toBe('rejected');
    expect(f.create().read()).toBeNull();
  });
  it('cannot clear an active task, failed GET, or changed session', async () => {
    const f = fixture();
    await f.recovery.submit(operation, accepted, current);
    const gate = f.recovery.read()!;
    const refresh = vi.fn(async () => undefined);
    await expect(
      f.recovery.clearVerified(
        gate,
        async () =>
          taskFixture({
            taskId,
            taskType: 'backup',
            taskSubType: 'create',
            status: 'processing',
          }),
        refresh,
        current,
      ),
    ).rejects.toThrow('任务仍在执行');
    expect(refresh).not.toHaveBeenCalled();
    const task = async () =>
      taskFixture({
        taskId,
        taskType: 'backup',
        taskSubType: 'create',
        status: 'completed',
      });
    await expect(
      f.recovery.clearVerified(
        gate,
        task,
        async () => {
          throw new Error('GET failed');
        },
        current,
      ),
    ).rejects.toThrow('GET failed');
    expect(
      await f.recovery.clearVerified(gate, task, refresh, () => false),
    ).toBe(false);
    expect(f.create().read()?.taskId).toBe(taskId);
  });
  it('treats 404 as unknown history and only clears after explicit verification and successful GET', async () => {
    const f = fixture();
    await f.recovery.submit(operation, accepted, current);
    const gate = f.recovery.read()!;
    const lookup = vi.fn(async () => {
      throw new ApiError('HTTP', 'missing', 404);
    });
    expect(await f.recovery.task(gate, lookup)).toBeNull();
    expect(f.create().read()).not.toBeNull();
    const refresh = vi.fn(async () => undefined);
    expect(await f.recovery.clearVerified(gate, lookup, refresh, current)).toBe(
      true,
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(f.create().read()).toBeNull();
  });
  it('keeps a damaged gate until explicit verification and never clears a replacement', async () => {
    const f = fixture();
    f.values.set(f.recovery.key, '{broken');
    expect(
      await f.recovery.clearDamagedVerified(async () => {
        f.values.set(f.recovery.key, '{new-broken');
      }, current),
    ).toBe(false);
    expect(f.values.get(f.recovery.key)).toBe('{new-broken');
    expect(
      await f.recovery.clearDamagedVerified(async () => undefined, current),
    ).toBe(true);
  });
});
