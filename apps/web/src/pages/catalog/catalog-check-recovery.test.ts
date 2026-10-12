import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/http';
import {
  readCatalogSafetyGate as readMainGate,
  writeCatalogSafetyGate as writeMainGate,
} from './__fixtures__/catalog-safety-gate-main-197925d';
import { CatalogCheckRecovery } from './catalog-check-recovery';
import { catalogSafetyKey, readCatalogSafetyGate } from './catalog-safety-gate';

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
function fixture(shared = false, catalog: 'asin' | 'competitor' = 'asin') {
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
      catalog,
      owner,
      local,
      session,
      locks,
      () => 1000,
      () => `request-${++id}`,
      shared ? { owner, catalog } : undefined,
    );
  return { local, session, create, store: create() };
}

describe('shared catalog check operation gate', () => {
  it.each(['asin', 'competitor'] as const)(
    'executes the old main parser against a new %s check envelope without dropping the guard or receipt',
    async (catalog) => {
      const f = fixture(true, catalog),
        key = catalogSafetyKey('operator', catalog);
      const send = vi.fn(async () => {
        const raw = f.local.getItem(key);
        expect(JSON.parse(raw!)).toMatchObject({
          phase: 'inspection',
          check: { requestId: 'request-1' },
        });
        const oldView = readMainGate(f.local, 'operator', catalog);
        expect(oldView).toEqual({
          phase: 'inspection',
          operationId: 'request-1',
        });
        expect(f.local.getItem(key)).toBe(raw);
        // Exercise an old bundle rewriting the reservation after parsing it.
        expect(writeMainGate(f.local, 'operator', catalog, oldView)).toBe(true);
        expect(f.local.getItem(key)).not.toContain('check');
        return {
          kind: 'task' as const,
          taskId: 'task-1',
          status: 'pending' as const,
        };
      });
      const result = await f.store.submit(target, send);
      expect(result).toMatchObject({ kind: 'task', persisted: true });
      const acceptedRaw = f.local.getItem(key);
      const oldView = readMainGate(f.local, 'operator', catalog);
      expect(oldView?.phase).toBe('inspection');
      expect(f.local.getItem(key)).toBe(acceptedRaw);
      writeMainGate(f.local, 'operator', catalog, oldView);
      expect(f.create().read()).toMatchObject({ taskId: 'task-1' });
      expect((await f.create().submit(target, send)).kind).toBe('blocked');
      expect(send).toHaveBeenCalledTimes(1);
      if (result.kind !== 'task') throw new Error('task');
      expect(
        await f.create().reconcile(result.gate, async () => ({
          taskId: 'task-1',
          status: 'completed',
        })),
      ).toBe('cleared');
      expect(f.local.getItem(key)).toBeNull();
      expect(f.local.getItem(f.store.key)).toBeNull();
    },
  );
  it('never claims or clears a different old inspection reservation after payload loss', async () => {
    const f = fixture(true);
    const result = await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'pending',
    }));
    if (result.kind !== 'task') throw new Error('task');
    const replacement = { phase: 'inspection' as const, operationId: 'other' };
    writeMainGate(f.local, 'operator', 'asin', replacement);
    expect(await f.store.clear(result.gate)).toBe(false);
    expect(readMainGate(f.local, 'operator', 'asin')).toEqual(replacement);
    expect(f.store.read()?.taskId).toBe('task-1');
  });
  it.each([
    { phase: 'inspection', operationId: 'broken', check: {} },
    { phase: 'inspection', operationId: 'other', batchDelete: {} },
    { phase: 'inspection', operationId: 'other', importOperation: true },
  ])('preserves other or malformed inspection envelopes: %j', async (value) => {
    const f = fixture(true),
      key = catalogSafetyKey('operator', 'asin'),
      raw = JSON.stringify(value),
      send = vi.fn();
    f.local.setItem(key, raw);
    expect(readMainGate(f.local, 'operator', 'asin')?.phase).toBe('inspection');
    expect(readCatalogSafetyGate(f.local, 'operator', 'asin')?.phase).toBe(
      Object.hasOwn(value, 'check') ? 'check-invalid' : 'inspection',
    );
    await expect(f.store.submit(target, send)).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.local.getItem(key)).toBe(raw);
    expect(send).not.toHaveBeenCalled();
  });
  it('does not discard an unreadable foreign inspection envelope', async () => {
    const f = fixture(true),
      key = catalogSafetyKey('operator', 'asin'),
      raw = '{"phase":"inspection","batchDelete":',
      send = vi.fn();
    f.local.setItem(key, raw);
    expect(readCatalogSafetyGate(f.local, 'operator', 'asin')?.phase).toBe(
      'inspection',
    );
    await expect(f.store.submit(target, send)).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.local.getItem(key)).toBe(raw);
    expect(send).not.toHaveBeenCalled();
  });
  it('claims the shared gate before dispatch and restores raw selected IDs with the accepted task', async () => {
    const f = fixture(true);
    const batch = {
      kind: 'batch' as const,
      id: 'batch' as const,
      label: 'Selected groups',
      groupIds: [' Mixed-É ', 'mixed-é', 'a/b'],
    };
    const result = await f.store.submit(batch, async () => {
      expect(readCatalogSafetyGate(f.local, 'operator', 'asin')).toMatchObject({
        phase: 'check',
        check: { target: batch },
      });
      return { kind: 'task', taskId: 'batch-1', status: 'pending' };
    });
    expect(result.kind).toBe('task');
    expect(f.create().read()).toMatchObject({
      target: batch,
      taskId: 'batch-1',
    });
    expect(readCatalogSafetyGate(f.local, 'operator', 'asin')).toMatchObject({
      phase: 'check',
      check: { taskId: 'batch-1' },
    });
  });
  it.each(['refresh', 'inspection'] as const)(
    'blocks a new check when another %s catalog operation is outstanding',
    async (phase) => {
      const f = fixture(true),
        send = vi.fn();
      const record =
        phase === 'inspection'
          ? { phase }
          : { phase, message: null, detailId: null, createUncertain: false };
      f.local.setItem(
        catalogSafetyKey('operator', 'asin'),
        JSON.stringify(record),
      );
      await expect(f.store.submit(target, send)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('does not release either gate if the current session changes while clear waits for its lock', async () => {
    const f = fixture(true);
    const result = await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'pending',
    }));
    if (result.kind !== 'task') throw new Error('task');
    expect(await f.store.clear(result.gate, () => false)).toBe(false);
    expect(f.store.read()?.taskId).toBe('task-1');
    expect(readCatalogSafetyGate(f.local, 'operator', 'asin')?.phase).toBe(
      'check',
    );
  });
  it('retains the shared guard if legacy receipt deletion fails', async () => {
    const f = fixture(true);
    const result = await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'pending',
    }));
    if (result.kind !== 'task') throw new Error('task');
    f.local.removeItem.mockImplementation(() => {
      throw new Error('quota');
    });
    expect(await f.store.clear(result.gate)).toBe(false);
    expect(readCatalogSafetyGate(f.local, 'operator', 'asin')?.phase).toBe(
      'check',
    );
  });
  it('keeps an active task and reread failures guarded before clearing both records after successful reconciliation', async () => {
    const f = fixture(true);
    const result = await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'unknown',
    }));
    if (result.kind !== 'task') throw new Error('task');
    const reread = vi.fn(async () => {
      throw new Error('read failed');
    });
    expect(
      await f.store.reconcile(
        result.gate,
        async () => ({ taskId: 'task-1', status: 'processing' }),
        reread,
      ),
    ).toBe('active');
    expect(reread).not.toHaveBeenCalled();
    await expect(
      f.store.reconcile(
        result.gate,
        async () => ({ taskId: 'task-1', status: 'completed' }),
        reread,
      ),
    ).rejects.toThrow('read failed');
    expect(f.store.read()).not.toBeNull();
    expect(
      await f.store.reconcile(result.gate, async () => ({
        taskId: 'task-1',
        status: 'completed',
      })),
    ).toBe('cleared');
    expect(f.store.read()).toBeNull();
    expect(readCatalogSafetyGate(f.local, 'operator', 'asin')).toBeNull();
  });
  it('keeps a malformed shared async guard fail closed without removing its raw bytes', async () => {
    const f = fixture(true),
      key = catalogSafetyKey('operator', 'asin'),
      send = vi.fn();
    const raw = JSON.stringify({
      phase: 'check',
      operationId: 'broken',
      check: {},
    });
    f.local.setItem(key, raw);
    expect(readCatalogSafetyGate(f.local, 'operator', 'asin')?.phase).toBe(
      'check-invalid',
    );
    await expect(f.store.submit(target, send)).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.local.getItem(key)).toBe(raw);
    expect(send).not.toHaveBeenCalled();
  });
});

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
  it('accepts a guard already cleared by another tab without removing a replacement', async () => {
    const f = fixture();
    await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'pending',
    }));
    const gate = f.store.read()!;
    const otherTab = f.create();
    expect(await otherTab.clear(gate)).toBe(true);
    expect(await f.store.clear(gate)).toBe(true);
    await otherTab.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-2',
      status: 'pending',
    }));
    expect(await f.store.clear(gate)).toBe(false);
    expect(otherTab.read()?.taskId).toBe('task-2');
  });
  it('keeps the guard until the confirmed terminal catalog refresh succeeds', async () => {
    const f = fixture();
    await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'pending',
    }));
    const gate = f.store.read()!;
    const refresh = vi.fn(async (): Promise<void> => {
      expect(f.store.read()).toEqual(gate);
      throw new ApiError('NETWORK', 'catalog offline');
    });
    const readTask = vi.fn(async () => ({
      taskId: 'task-1',
      status: 'completed',
    }));
    await expect(f.store.reconcile(gate, readTask, refresh)).rejects.toThrow(
      'catalog offline',
    );
    expect(f.store.read()).toEqual(gate);
    refresh.mockImplementation(async () => {
      expect(f.store.read()).toEqual(gate);
    });
    expect(await f.store.reconcile(gate, readTask, refresh)).toBe('cleared');
    expect(f.store.read()).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('does not refresh or unlock a task still confirmed active', async () => {
    const f = fixture();
    await f.store.submit(target, async () => ({
      kind: 'task',
      taskId: 'task-1',
      status: 'pending',
    }));
    const refresh = vi.fn();
    expect(
      await f.store.reconcile(
        f.store.read()!,
        async () => ({ taskId: 'task-1', status: 'processing' }),
        refresh,
      ),
    ).toBe('active');
    expect(refresh).not.toHaveBeenCalled();
    expect(f.store.read()?.taskId).toBe('task-1');
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
