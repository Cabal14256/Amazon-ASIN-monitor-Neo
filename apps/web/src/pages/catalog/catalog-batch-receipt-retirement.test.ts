// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteAuthState } from '../../auth/navigation';
import { deferred } from '../../lib/transport-fixtures';
import type { SessionEvent } from '../../services/runtime';
import {
  readAsinBatchReceipt,
  saveAsinBatchReceipt,
  type AsinBatchReceipt,
} from '../asin/asin-batch-receipt';
import { retireBatchReceiptAfterIdentityChange } from './catalog-batch-receipt-retirement';
import { catalogSafetyKey } from './catalog-safety-gate';

const owner = JSON.stringify(['asin', 'operator', 'session-1']);
const guardKey = catalogSafetyKey('operator', 'asin');
function receipt(): AsinBatchReceipt {
  return {
    operationId: 'operation-1',
    owner,
    submittedAt: 100,
    groupId: 'group-1',
    groupName: 'Fixture',
    items: [
      {
        asin: 'B000000001',
        country: 'US',
        parentId: 'group-1',
        site: 'amazon.com',
        brand: 'Fixture',
      },
    ],
    result: {
      total: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          index: 0,
          asin: 'B000000001',
          country: 'US',
          success: true,
          id: 'created-1',
          parentId: 'group-1',
        },
      ],
      errors: [],
    },
  };
}
function authenticated(
  user = 'operator',
  session = 'session-1',
): RouteAuthState {
  return {
    status: 'authenticated',
    identity: {
      user: {
        id: user,
        username: 'Fixture',
        status: 'ACTIVE',
        force_password_change: false,
      },
      sessionId: session,
      roles: [],
      permissions: ['asin:read', 'asin:write'],
      mustChangePassword: false,
      passwordExpired: false,
    },
  };
}
function observers(initial: RouteAuthState) {
  let state = initial;
  const identityListeners = new Set<() => void>();
  const runtimeListeners = new Set<(event: SessionEvent) => void>();
  return {
    identity: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        identityListeners.add(listener);
        return () => {
          identityListeners.delete(listener);
        };
      },
    },
    runtime: {
      subscribeSession: (listener: (event: SessionEvent) => void) => {
        runtimeListeners.add(listener);
        return () => {
          runtimeListeners.delete(listener);
        };
      },
    },
    publish: (next: RouteAuthState) => {
      state = next;
      for (const listener of identityListeners) listener();
    },
    dispose: () => {
      for (const listener of runtimeListeners) listener('dispose');
      runtimeListeners.clear();
    },
    listenerCounts: () => [identityListeners.size, runtimeListeners.size],
  };
}
function installLock(
  request: (name: string, work: () => unknown) => Promise<unknown>,
) {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request },
  });
}
function queuedLock() {
  const grant = deferred<void>();
  const request = vi.fn(async (_name: string, work: () => unknown) => {
    await grant.promise;
    return work();
  });
  installLock(request);
  return { grant, request };
}

beforeEach(() => {
  installLock(async (_name, work) => work());
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks();
});

describe('deferred batch receipt retirement lifecycle', () => {
  it.each(['loading', 'error'] as const)(
    'disposes observers during %s without retiring recovery evidence',
    (status) => {
      const f = observers({ status });
      const expected = receipt();
      const gate = JSON.stringify({
        phase: 'inspection',
        operationId: 'replacement-operation',
      });
      expect(saveAsinBatchReceipt('operator', expected)).toBe(true);
      window.localStorage.setItem(guardKey, gate);
      const removed = vi.fn();
      retireBatchReceiptAfterIdentityChange(
        f.identity,
        f.runtime,
        expected,
        owner,
        removed,
      );
      expect(f.listenerCounts()).toEqual([1, 1]);

      f.dispose();
      expect(f.listenerCounts()).toEqual([0, 0]);
      f.publish({ status: 'anonymous' });
      expect(readAsinBatchReceipt('operator', owner)?.receipt).toEqual(
        expected,
      );
      expect(window.localStorage.getItem(guardKey)).toBe(gate);
      expect(removed).not.toHaveBeenCalled();
    },
  );

  it('retains a queued receipt when verification resumes and confirms its original session', async () => {
    const f = observers({ status: 'anonymous' });
    const expected = receipt();
    expect(saveAsinBatchReceipt('operator', expected)).toBe(true);
    const lock = queuedLock();
    const removed = vi.fn();
    retireBatchReceiptAfterIdentityChange(
      f.identity,
      f.runtime,
      expected,
      owner,
      removed,
    );
    expect(lock.request).toHaveBeenCalledOnce();

    f.publish({ status: 'loading' });
    lock.grant.resolve();
    await lock.request.mock.results[0].value;
    expect(readAsinBatchReceipt('operator', owner)?.receipt).toEqual(expected);
    expect(f.listenerCounts()).toEqual([1, 1]);

    f.publish(authenticated());
    expect(f.listenerCounts()).toEqual([0, 0]);
    expect(readAsinBatchReceipt('operator', owner)?.receipt).toEqual(expected);
    expect(lock.request).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
  });

  it('keeps an explicitly restored old-session receipt while its displaying session is still verified', () => {
    const f = observers(authenticated('operator', 'session-2'));
    const expected = receipt();
    const displayedOwner = JSON.stringify(['asin', 'operator', 'session-2']);
    expect(saveAsinBatchReceipt('operator', expected)).toBe(true);
    const request = vi.fn(async (_name: string, work: () => unknown) => work());
    installLock(request);
    const removed = vi.fn();

    retireBatchReceiptAfterIdentityChange(
      f.identity,
      f.runtime,
      expected,
      displayedOwner,
      removed,
    );

    expect(window.localStorage.getItem(guardKey)).toBeNull();
    expect(readAsinBatchReceipt('operator', owner)?.receipt).toEqual(expected);
    expect(request).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(f.listenerCounts()).toEqual([0, 0]);
  });

  it('requeues cleanup after an inconclusive lock-time identity eventually logs out', async () => {
    const f = observers(authenticated('other', 'session-2'));
    const expected = receipt();
    const newer = {
      ...receipt(),
      operationId: 'operation-new',
      owner: JSON.stringify(['asin', 'other', 'session-2']),
    };
    expect(saveAsinBatchReceipt('operator', expected)).toBe(true);
    expect(saveAsinBatchReceipt('other', newer)).toBe(true);
    const lock = queuedLock();
    const removed = vi.fn();
    retireBatchReceiptAfterIdentityChange(
      f.identity,
      f.runtime,
      expected,
      owner,
      removed,
    );

    f.publish({ status: 'error' });
    lock.grant.resolve();
    await lock.request.mock.results[0].value;
    expect(readAsinBatchReceipt('operator', owner)?.receipt).toEqual(expected);
    expect(f.listenerCounts()).toEqual([1, 1]);

    f.publish({ status: 'anonymous' });
    await lock.request.mock.results[1].value;
    expect(lock.request.mock.calls.map(([name]) => name)).toEqual([
      guardKey,
      guardKey,
    ]);
    expect(readAsinBatchReceipt('operator', owner)).toBeNull();
    expect(readAsinBatchReceipt('other', newer.owner)?.receipt).toEqual(newer);
    expect(removed).toHaveBeenCalledOnce();
    expect(f.listenerCounts()).toEqual([0, 0]);
  });

  it('preserves a protection gate installed while original-owner cleanup waits for its lock', async () => {
    const f = observers(authenticated('operator', 'session-2'));
    const expected = receipt();
    expect(saveAsinBatchReceipt('operator', expected)).toBe(true);
    const lock = queuedLock();
    const removed = vi.fn();
    retireBatchReceiptAfterIdentityChange(
      f.identity,
      f.runtime,
      expected,
      owner,
      removed,
    );
    expect(lock.request.mock.calls[0][0]).toBe(guardKey);
    const gate = JSON.stringify({
      phase: 'inspection',
      operationId: expected.operationId,
    });
    window.localStorage.setItem(guardKey, gate);

    lock.grant.resolve();
    await lock.request.mock.results[0].value;
    expect(readAsinBatchReceipt('operator', owner)?.receipt).toEqual(expected);
    expect(window.localStorage.getItem(guardKey)).toBe(gate);
    expect(removed).not.toHaveBeenCalled();
    expect(f.listenerCounts()).toEqual([0, 0]);
  });

  it('preserves receipt and gate without installing observers when Web Locks are unavailable', () => {
    Reflect.deleteProperty(navigator, 'locks');
    const f = observers({ status: 'anonymous' });
    const expected = receipt();
    expect(saveAsinBatchReceipt('operator', expected)).toBe(true);
    const gate = JSON.stringify({
      phase: 'inspection',
      operationId: expected.operationId,
    });
    window.localStorage.setItem(guardKey, gate);
    const removed = vi.fn();

    retireBatchReceiptAfterIdentityChange(
      f.identity,
      f.runtime,
      expected,
      owner,
      removed,
    );

    expect(readAsinBatchReceipt('operator', owner)?.receipt).toEqual(expected);
    expect(window.localStorage.getItem(guardKey)).toBe(gate);
    expect(f.listenerCounts()).toEqual([0, 0]);
    expect(removed).not.toHaveBeenCalled();
  });
});
