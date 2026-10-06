import type { TaskInfo } from '@asin-monitor/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/http';
import { deferred } from '../../lib/transport-fixtures';
import { importGateKey } from '../asin/asin-import-gate';
import { CatalogBatchDeleteRecovery } from './catalog-batch-delete-recovery';
import {
  catalogSafetyKey,
  readCatalogSafetyGate,
  type CatalogBatchDeleteGate,
} from './catalog-safety-gate';

class MemoryStorage {
  entries = new Map<string, string>();
  getItem = (key: string) => this.entries.get(key) ?? null;
  setItem = (key: string, value: string) => {
    this.entries.set(key, value);
  };
  removeItem = (key: string) => {
    this.entries.delete(key);
  };
}
const counts = {
  mode: 'sync' as const,
  totalRequested: 1,
  deletedGroupCount: 1,
  deletedDirectAsinCount: 0,
  deletedNestedAsinCount: 2,
  skipped: { groupIds: [], asinIds: [] },
};
const task = (status: string, domain = 'asin', result: unknown = counts) =>
  ({
    taskId: 'task-1',
    taskType: 'batch-delete',
    taskSubType:
      domain === 'asin'
        ? 'variant-group-delete'
        : 'competitor-variant-group-delete',
    status,
    result,
  } as TaskInfo);
function fixture(domain: 'asin' | 'competitor' = 'asin') {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request: (key: string, work: () => unknown) => {
      const result = (tails.get(key) ?? Promise.resolve()).then(work);
      tails.set(
        key,
        result.catch(() => undefined),
      );
      return result;
    },
  } as unknown as Pick<LockManager, 'request'>;
  const recovery = new CatalogBatchDeleteRecovery(
    'owner',
    domain,
    local,
    session,
    locks,
    () => 'operation-1',
  );
  return {
    local,
    session,
    locks,
    recovery,
    publish: vi.fn(),
    current: () => true,
  };
}
async function accepted(
  f: ReturnType<typeof fixture>,
  mode: 'sync' | 'async' = 'async',
) {
  const outcome = await f.recovery.submit(
    ['group-1'],
    async () =>
      mode === 'sync'
        ? counts
        : { mode: 'async', taskId: 'task-1', status: 'pending' },
    f.current,
    f.publish,
  );
  if (outcome.kind !== 'accepted') throw new Error('fixture acceptance failed');
  return outcome.gate;
}

describe('catalog batch deletion durable recovery', () => {
  it('preserves known terminal counts through session fallback and refuses to clear while durable receipt writes fail', async () => {
    const f = fixture();
    const gate = await accepted(f);
    const write = f.local.setItem;
    f.local.setItem = () => {
      throw new Error('quota denied');
    };
    const refresh = vi.fn(async () => undefined);
    expect(
      await f.recovery.reconcile(
        gate,
        async () => task('completed'),
        refresh,
        f.current,
      ),
    ).toMatchObject({ kind: 'unsaved' });
    expect(refresh).not.toHaveBeenCalled();
    expect(f.recovery.read()).toMatchObject({
      state: 'refresh',
      message: expect.stringContaining('实际删除变体组 1 个'),
    });
    expect(f.local.entries.get(f.recovery.key)).toContain('task-1');
    const restored = new CatalogBatchDeleteRecovery(
      'owner',
      'asin',
      f.local,
      f.session,
      f.locks,
    );
    const known = restored.read() as CatalogBatchDeleteGate;
    expect(known.state).toBe('refresh');
    f.local.setItem = write;
    expect(
      await restored.reconcile(known, vi.fn(), refresh, f.current),
    ).toMatchObject({ kind: 'cleared' });
    expect(refresh).toHaveBeenCalledOnce();
    expect(restored.read()).toBeNull();
  });
  it.each([
    { ownerScope: ['competitor', 'owner', 'session-1'] },
    { ownerScope: ['asin', 'other', 'session-1'] },
  ])(
    'retains protection for a forged original-session scope $ownerScope',
    ({ ownerScope }) => {
      const f = fixture();
      f.local.setItem(
        f.recovery.key,
        JSON.stringify({
          phase: 'batch-delete',
          operationId: 'original',
          groupIds: ['group-1'],
          state: 'task',
          taskId: 'task-1',
          submittedAt: 1,
          ownerScope: JSON.stringify(ownerScope),
        }),
      );
      expect(f.recovery.read()).toMatchObject({
        operationId: 'invalid-record',
        state: 'unknown',
      });
      expect(f.local.getItem(f.recovery.key)).not.toBeNull();
    },
  );

  it('rejects a session fallback whose original selected groups were coherently changed', async () => {
    const f = fixture();
    const original = await accepted(f);
    const unknown = {
      ...original,
      state: 'unknown',
      taskId: undefined,
      message: undefined,
    };
    f.local.setItem(f.recovery.key, JSON.stringify(unknown));
    f.session.setItem(
      f.recovery.fallbackKey,
      JSON.stringify({ ...original, groupIds: ['other-group'] }),
    );
    expect(f.recovery.read()).toEqual(unknown);
  });

  it('never removes the durable guard when session receipt cleanup fails during reconciliation', async () => {
    const f = fixture();
    const gate = await accepted(f, 'sync');
    f.session.removeItem = () => {
      throw new Error('cleanup denied');
    };
    expect(
      await f.recovery.reconcile(
        gate,
        vi.fn(),
        async () => undefined,
        f.current,
      ),
    ).toMatchObject({ kind: 'changed' });
    expect(f.recovery.read()).toEqual(gate);
  });
  it.each(['unreadable', 'invalid-json'] as const)(
    'never dispatches or removes the guard when local recovery storage is %s',
    async (mode) => {
      const f = fixture();
      f.local.setItem(f.recovery.key, '{broken');
      if (mode === 'unreadable')
        f.local.getItem = () => {
          throw new Error('read denied');
        };
      const send = vi.fn(async () => counts);
      if (mode === 'unreadable')
        await expect(
          f.recovery.submit(['group-1'], send, f.current, f.publish),
        ).rejects.toThrow();
      else
        expect(
          await f.recovery.submit(['group-1'], send, f.current, f.publish),
        ).toMatchObject({ kind: 'blocked' });
      expect(send).not.toHaveBeenCalled();
      expect(f.local.entries.get(f.recovery.key)).toBe('{broken');
    },
  );

  it('keeps a known accepted receipt in fallback and mounted UI when reading local storage fails after POST', async () => {
    const f = fixture();
    const send = vi.fn(async () => {
      f.local.getItem = () => {
        throw new Error('read denied');
      };
      return {
        mode: 'async' as const,
        taskId: 'task-1',
        status: 'pending' as const,
      };
    });
    const outcome = await f.recovery.submit(
      ['group-1'],
      send,
      f.current,
      f.publish,
    );
    expect(outcome).toMatchObject({
      kind: 'accepted',
      persisted: false,
      gate: { taskId: 'task-1' },
    });
    expect(f.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'task', taskId: 'task-1' }),
    );
    expect(f.session.getItem(f.recovery.fallbackKey)).toContain('task-1');
    const readTask = vi.fn();
    const refresh = vi.fn();
    if (outcome.kind !== 'accepted')
      throw new Error('fixture acceptance failed');
    await expect(
      f.recovery.reconcile(outcome.gate, readTask, refresh, f.current),
    ).rejects.toThrow('read denied');
    expect(readTask).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(f.local.entries.get(f.recovery.key)).toContain('unknown');
  });

  it('cannot overwrite a replacement cross-tab claim with a late accepted receipt', async () => {
    const f = fixture();
    const response = deferred<typeof counts>();
    const send = vi.fn(() => response.promise);
    const pending = f.recovery.submit(['group-1'], send, f.current, f.publish);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const replacement = { phase: 'inspection', operationId: 'replacement' };
    f.local.setItem(f.recovery.key, JSON.stringify(replacement));
    response.resolve(counts);
    expect(await pending).toMatchObject({ kind: 'accepted', persisted: false });
    expect(f.recovery.read()).toEqual(replacement);
  });
  it.each(['asin', 'competitor'] as const)(
    'guards %s before dispatch and clears sync only after a successful reread',
    async (domain) => {
      const f = fixture(domain);
      const send = vi.fn(async () => {
        expect(readCatalogSafetyGate(f.local, 'owner', domain)?.phase).toBe(
          'batch-delete',
        );
        return counts;
      });
      const outcome = await f.recovery.submit(
        ['group-1'],
        send,
        f.current,
        f.publish,
      );
      expect(outcome.kind).toBe('accepted');
      const gate = f.recovery.read() as CatalogBatchDeleteGate;
      expect(gate.state).toBe('refresh');
      await expect(
        f.recovery.reconcile(
          gate,
          vi.fn(),
          async () => {
            throw new Error('read unavailable');
          },
          f.current,
        ),
      ).rejects.toThrow('read unavailable');
      expect(f.recovery.read()).toEqual(gate);
      expect(
        await f.recovery.reconcile(
          gate,
          vi.fn(),
          async () => undefined,
          f.current,
        ),
      ).toMatchObject({
        kind: 'cleared',
        message: expect.stringContaining('实际删除变体组 1'),
      });
      expect(f.recovery.read()).toBeNull();
    },
  );
  it('restores accepted tasks, blocks duplicate dispatch, waits for terminal HTTP and keeps partial failure counts', async () => {
    const f = fixture('competitor');
    const gate = await accepted(f);
    const restored = new CatalogBatchDeleteRecovery(
      'owner',
      'competitor',
      f.local,
      f.session,
      f.locks,
    );
    const duplicate = vi.fn(async () => counts);
    expect(
      (await restored.submit(['other'], duplicate, f.current, f.publish)).kind,
    ).toBe('blocked');
    expect(duplicate).not.toHaveBeenCalled();
    const refresh = vi.fn(async () => undefined);
    expect(
      (
        await restored.reconcile(
          gate,
          async () => task('processing', 'competitor'),
          refresh,
          f.current,
        )
      ).kind,
    ).toBe('active');
    expect(refresh).not.toHaveBeenCalled();
    const result = await restored.reconcile(
      gate,
      async () => task('failed', 'competitor', { ...counts, failedCount: 1 }),
      refresh,
      f.current,
    );
    expect(result).toMatchObject({
      kind: 'cleared',
      message: expect.stringContaining('失败分块 1'),
    });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('retains unknown submission through reread until explicit audited acknowledgment, never retries', async () => {
    const f = fixture();
    const send = vi.fn(async () => {
      throw new ApiError('NETWORK', 'lost response');
    });
    const result = await f.recovery.submit(
      ['group-1'],
      send,
      f.current,
      f.publish,
    );
    expect(result.kind).toBe('unknown');
    const gate = f.recovery.read() as CatalogBatchDeleteGate;
    expect(
      (
        await f.recovery.reconcile(
          gate,
          vi.fn(),
          async () => undefined,
          f.current,
        )
      ).kind,
    ).toBe('unknown');
    expect(f.recovery.read()).toEqual(gate);
    expect(
      (await f.recovery.submit(['group-1'], send, f.current, f.publish)).kind,
    ).toBe('blocked');
    expect(send).toHaveBeenCalledOnce();
    expect(
      (
        await f.recovery.reconcile(
          gate,
          vi.fn(),
          async () => undefined,
          f.current,
          true,
        )
      ).kind,
    ).toBe('cleared');
  });
  it('a missing task or a task from another operation cannot release the deletion guard', async () => {
    const f = fixture();
    const gate = await accepted(f);
    await expect(
      f.recovery.reconcile(
        gate,
        async () => {
          throw new ApiError('HTTP', 'missing', 404);
        },
        vi.fn(),
        f.current,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.recovery.reconcile(
        gate,
        async () => task('completed', 'competitor'),
        vi.fn(),
        f.current,
      ),
    ).rejects.toThrow('类型不匹配');
    expect(f.recovery.read()).toEqual(gate);
  });
  it.each([400, 401, 403, 409, 413, 429])(
    'definite %s rejection clears its own pre-dispatch claim',
    async (status) => {
      const f = fixture();
      expect(
        (
          await f.recovery.submit(
            ['group-1'],
            async () => {
              throw new ApiError('HTTP', 'rejected', status);
            },
            f.current,
            f.publish,
          )
        ).kind,
      ).toBe('rejected');
      expect(f.recovery.read()).toBeNull();
    },
  );
  it('uses a session receipt fallback when local storage fails after acceptance', async () => {
    const f = fixture();
    const send = async () => {
      f.local.setItem = () => {
        throw new Error('quota');
      };
      return {
        mode: 'async' as const,
        taskId: 'task-1',
        status: 'unknown' as const,
      };
    };
    const outcome = await f.recovery.submit(
      ['group-1'],
      send,
      f.current,
      f.publish,
    );
    expect(outcome).toMatchObject({ kind: 'accepted', persisted: false });
    expect(readCatalogSafetyGate(f.local, 'owner', 'asin')).toMatchObject({
      state: 'unknown',
    });
    expect(f.recovery.read()).toMatchObject({
      state: 'task',
      taskId: 'task-1',
    });
    expect(f.session.getItem(f.recovery.fallbackKey)).toContain('task-1');
  });
  it('does not dispatch when the first durable write fails or the queued session is stale', async () => {
    const f = fixture();
    const send = vi.fn(async () => counts);
    f.local.setItem = () => {
      throw new Error('denied');
    };
    await expect(
      f.recovery.submit(['group-1'], send, f.current, f.publish),
    ).rejects.toThrow('尚未发送');
    expect(
      (await f.recovery.submit(['group-1'], send, () => false, f.publish)).kind,
    ).toBe('stale');
    expect(send).not.toHaveBeenCalled();
  });
  it('serializes two tabs and persists a late receipt for the original owner without publishing stale UI', async () => {
    const f = fixture();
    const response = deferred<typeof counts>();
    const send = vi.fn(() => response.promise);
    let current = true;
    const first = f.recovery.submit(
      ['group-1'],
      send,
      () => current,
      f.publish,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const secondSend = vi.fn(async () => counts);
    const second = f.recovery.submit(
      ['group-2'],
      secondSend,
      f.current,
      f.publish,
    );
    current = false;
    response.resolve(counts);
    expect((await first).kind).toBe('accepted');
    expect((await second).kind).toBe('blocked');
    expect(secondSend).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.recovery.read()).toMatchObject({
      state: 'refresh',
      groupIds: ['group-1'],
    });
  });
  it('cannot clear a replacement tab claim or a claim after session changes during reread', async () => {
    const f = fixture();
    const gate = await accepted(f, 'sync');
    const changed = { ...gate, operationId: 'replacement' };
    f.local.setItem(f.recovery.key, JSON.stringify(changed));
    f.local.setItem(
      importGateKey('asin', 'owner'),
      JSON.stringify({
        phase: 'uncertain',
        taskId: null,
        savedAt: changed.submittedAt,
        operationId: changed.operationId,
        catalogOperation: 'batch-delete',
      }),
    );
    expect(
      (await f.recovery.reconcile(gate, vi.fn(), vi.fn(), f.current)).kind,
    ).toBe('changed');
    let current = true;
    expect(
      (
        await f.recovery.reconcile(
          changed,
          vi.fn(),
          async () => {
            current = false;
          },
          () => current,
        )
      ).kind,
    ).toBe('stale');
    expect(f.recovery.read()).toEqual(changed);
  });
  it('fails closed on a damaged batch record and scopes records by owner and domain', () => {
    const f = fixture();
    f.local.setItem(
      catalogSafetyKey('owner', 'asin'),
      JSON.stringify({ phase: 'batch-delete', taskId: '../../escape' }),
    );
    expect(f.recovery.read()).toMatchObject({
      state: 'unknown',
      operationId: 'invalid-record',
    });
    expect(readCatalogSafetyGate(f.local, 'other', 'asin')).toBeNull();
    expect(readCatalogSafetyGate(f.local, 'owner', 'competitor')).toBeNull();
    expect(f.local.getItem(f.recovery.key)).not.toBeNull();
  });
});
