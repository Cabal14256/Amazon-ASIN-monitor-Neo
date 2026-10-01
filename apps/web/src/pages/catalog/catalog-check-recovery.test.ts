import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/http';
import { CatalogCheckRecovery } from './catalog-check-recovery';

const target = { kind: 'group' as const, id: 'g1', label: 'Group' };
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}
function fixture() {
  const local = storage(),
    session = storage();
  let previous = Promise.resolve();
  const locks = {
    request: async <T>(_key: string, callback: () => Promise<T> | T) => {
      const before = previous;
      let release!: () => void;
      previous = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      try {
        return await callback();
      } finally {
        release();
      }
    },
  } as unknown as LockManager;
  let id = 0;
  const create = (owner = 'operator') =>
    new CatalogCheckRecovery(
      'asin',
      owner,
      local,
      session,
      locks,
      () => 1000,
      () => `request-${++id}`,
    );
  return { local, session, create, store: create() };
}

describe('durable immediate check recovery', () => {
  it.each(['NETWORK', 'TIMEOUT', 'CANCELLED', 'INVALID_RESPONSE'] as const)(
    'retains the pre-dispatch guard after %s, including a page reload',
    async (kind) => {
      const f = fixture();
      const send = vi.fn(async () => {
        throw new ApiError(kind, 'response lost after acceptance');
      });
      expect((await f.store.submit(target, send)).kind).toBe('unknown');
      expect(f.create().read()).toMatchObject({ target, submittedAt: 1000 });
      expect((await f.create().submit(target, send)).kind).toBe('blocked');
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves an unknown task receipt and restores its lookup ID', async () => {
    const f = fixture();
    const send = vi.fn(async () => ({
      kind: 'task' as const,
      taskId: 'task-1',
      status: 'unknown' as const,
    }));
    expect(await f.store.submit(target, send)).toMatchObject({
      kind: 'task',
      uncertain: true,
    });
    expect(f.create().read()?.taskId).toBe('task-1');
    expect((await f.create().submit(target, send)).kind).toBe('blocked');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps a task ID in session storage if the receipt update fails', async () => {
    const f = fixture();
    const original = f.local.setItem.getMockImplementation()!;
    f.local.setItem.mockImplementation((key, value) => {
      if (value.includes('taskId')) throw new Error('quota');
      original(key, value);
    });
    const result = await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'unknown',
    }));
    expect(result).toMatchObject({ kind: 'task', persisted: false });
    expect(f.create().read()?.taskId).toBe('task-1');
    expect(f.local.getItem(f.store.key)).not.toContain('taskId');
    expect(f.session.getItem(f.store.key)).toContain('task-1');
  });
  it('still blocks after reload when both receipt stores fail', async () => {
    const f = fixture();
    const result = await f.store.submit(target, async () => {
      f.local.setItem.mockImplementation(() => {
        throw new Error('quota');
      });
      f.session.setItem.mockImplementation(() => {
        throw new Error('quota');
      });
      return { kind: 'task', taskId: 'task-1', status: 'pending' };
    });
    expect(result).toMatchObject({
      kind: 'task',
      gate: { taskId: 'task-1' },
      persisted: false,
    });
    expect(f.create().read()).toMatchObject({ target });
    const send = vi.fn();
    expect((await f.create().submit(target, send)).kind).toBe('blocked');
    expect(send).not.toHaveBeenCalled();
    if (result.kind !== 'task') throw new Error('expected task receipt');
    expect(
      await f.store.reconcile(result.gate, async () => ({
        taskId: 'task-1',
        status: 'completed',
      })),
    ).toBe('cleared');
    expect(f.store.read()).toBeNull();
  });
  it('does not dispatch if the initial guard cannot be saved or read', async () => {
    const f = fixture(),
      send = vi.fn();
    f.local.setItem.mockImplementation(() => {
      throw new Error('quota');
    });
    await expect(f.store.submit(target, send)).rejects.toThrow('STORAGE');
    expect(send).not.toHaveBeenCalled();
    f.local.getItem.mockImplementation(() => {
      throw new Error('security');
    });
    await expect(f.store.submit(target, send)).rejects.toThrow('security');
    expect(send).not.toHaveBeenCalled();
  });
  it('does not discard a malformed existing guard and dispatch again', async () => {
    const f = fixture(),
      send = vi.fn();
    f.local.setItem(f.store.key, '{}');
    await expect(f.store.submit(target, send)).rejects.toThrow('INVALID');
    expect(f.local.getItem(f.store.key)).toBe('{}');
    expect(send).not.toHaveBeenCalled();
  });
  it('serializes concurrent tabs before dispatch and isolates owners', async () => {
    const f = fixture();
    const send = vi.fn(async () => ({
      kind: 'task' as const,
      taskId: 'task-1',
      status: 'pending' as const,
    }));
    const results = await Promise.all([
      f.store.submit(target, send),
      f.create().submit(target, send),
    ]);
    expect(results.map((result) => result.kind)).toEqual(['task', 'blocked']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.create('other').read()).toBeNull();
  });
  it('refuses dispatch if the owner or component changed while waiting for the lock', async () => {
    const f = fixture(),
      send = vi.fn();
    expect(await f.store.submit(target, send, () => false)).toEqual({
      kind: 'stale',
    });
    expect(send).not.toHaveBeenCalled();
    expect(f.store.read()).toBeNull();
  });
  it.each([400, 403, 404, 413, 429])(
    'releases an explicit HTTP %s rejection',
    async (status) => {
      const f = fixture();
      expect(
        (
          await f.store.submit(target, async () => {
            throw new ApiError('HTTP', 'rejected', status);
          })
        ).kind,
      ).toBe('rejected');
      expect(f.store.read()).toBeNull();
    },
  );
  it.each([408, 500, 502, 503, 504])(
    'keeps HTTP %s uncertain',
    async (status) => {
      const f = fixture();
      expect(
        (
          await f.store.submit(target, async () => {
            throw new ApiError('HTTP', 'unknown', status);
          })
        ).kind,
      ).toBe('unknown');
      expect(f.store.read()).not.toBeNull();
    },
  );
  it('allows a new check after reconciliation but never clears a replacement guard', async () => {
    const f = fixture();
    await f.store.submit(target, async () => {
      throw new ApiError('NETWORK', 'unknown');
    });
    const old = f.store.read()!;
    expect(await f.store.clear(old)).toBe(true);
    await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-2',
      status: 'pending',
    }));
    expect(await f.store.clear(old)).toBe(false);
    expect(f.store.read()?.taskId).toBe('task-2');
  });
  it('does not let an old no-ID snapshot unlock a task accepted while reconciliation waited', async () => {
    const f = fixture();
    let initial: ReturnType<typeof f.store.read> = null;
    await f.store.submit(target, async () => {
      initial = f.store.read();
      return { kind: 'task', taskId: 'task-running', status: 'pending' };
    });
    expect(await f.store.clear(initial!)).toBe(false);
    expect(f.store.read()?.taskId).toBe('task-running');
  });
  it.each(['pending', 'processing', 'cancelling'])(
    'refuses manual unlock while the API confirms %s',
    async (status) => {
      const f = fixture();
      await f.store.submit(target, async () => ({
        kind: 'task',
        taskId: 'task-1',
        status: 'pending',
      }));
      expect(
        await f.store.reconcile(f.store.read()!, async () => ({
          taskId: 'task-1',
          status,
        })),
      ).toBe('active');
      expect(f.store.read()?.taskId).toBe('task-1');
    },
  );
  it.each(['completed', 'failed', 'cancelled'])(
    'restores checking after an explicitly confirmed %s task',
    async (status) => {
      const f = fixture();
      await f.store.submit(target, async () => ({
        kind: 'task',
        taskId: 'task-1',
        status: 'pending',
      }));
      expect(
        await f.store.reconcile(f.store.read()!, async () => ({
          taskId: 'task-1',
          status,
        })),
      ).toBe('cleared');
      expect(f.store.read()).toBeNull();
    },
  );
  it('does not mistake a lookup failure or wrong task ID for a resolved submission', async () => {
    const f = fixture();
    await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'pending',
    }));
    await expect(
      f.store.reconcile(f.store.read()!, async () => {
        throw new ApiError('NETWORK', 'offline');
      }),
    ).rejects.toThrow('offline');
    await expect(
      f.store.reconcile(f.store.read()!, async () => ({
        taskId: 'other-task',
        status: 'completed',
      })),
    ).rejects.toThrow('IDENTITY');
    expect(f.store.read()?.taskId).toBe('task-1');
  });
  it('permits explicit reconciliation after an authoritative missing-task response', async () => {
    const f = fixture();
    await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'unknown',
    }));
    expect(
      await f.store.reconcile(f.store.read()!, async () => {
        throw new ApiError('HTTP', 'not found', 404);
      }),
    ).toBe('cleared');
  });
});
