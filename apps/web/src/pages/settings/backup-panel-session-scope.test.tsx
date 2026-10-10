// @vitest-environment jsdom
import type { CurrentUserData } from '@asin-monitor/contracts';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import type { RouteAuthState } from '../../auth/navigation';
import {
  deferred,
  FakeSocket,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { taskFixture } from '../../services/task-fixtures';
import { BackupPanel } from './backup-panel';
import { backupGateKey } from './backup-recovery';

const owner = 'backup-session-scope-221';
const taskId = '10000000-0000-4000-8000-000000000221';
const principal = (sessionId: string): CurrentUserData => ({
  user: {
    id: owner,
    username: 'fixture',
    status: 'ACTIVE',
    force_password_change: false,
  },
  roles: [],
  permissions: ['settings:read', 'settings:write'],
  sessionId,
  mustChangePassword: false,
  passwordExpired: false,
});
const taskResult = (message: string) =>
  jsonResponse({
    success: true,
    data: taskFixture({
      taskId,
      taskType: 'backup',
      taskSubType: 'create',
      status: 'completed',
      canCancel: false,
      message,
    }),
  });
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
let lockTails = new Map<string, Promise<unknown>>();
const pendingSettlements = new Set<() => Promise<void>>();

function pendingResponse(fallback: Response) {
  const pending = deferred<Response>();
  const settle = async () => {
    await act(async () => {
      pending.resolve(fallback);
      await pending.promise;
    });
    pendingSettlements.delete(settle);
  };
  pendingSettlements.add(settle);
  return { ...pending, settle };
}

beforeEach(() => {
  lockTails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (key: string, work: () => unknown) => {
        const next = (lockTails.get(key) ?? Promise.resolve()).then(work);
        lockTails.set(
          key,
          next.catch(() => undefined),
        );
        return next;
      },
    },
  });
});
afterEach(async () => {
  act(() => cleanup());
  for (const settle of pendingSettlements) await settle();
  // A failed assertion may leave a POST holding the real recovery lock. Drain
  // its completed response and storage writes before the next fixture starts.
  await act(async () => {
    await Promise.allSettled(lockTails.values());
    for (const runtime of runtimes.splice(0)) runtime.dispose();
  });
  localStorage.clear();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks();
});

async function mounted() {
  // This is the authenticated snapshot boundary already consumed by BackupPanel.
  // It intentionally has no loading, runtime reset, owner change or hint revision.
  // The separate IdentityStore/RouteGate suite tests real auth verification.
  let snapshot: RouteAuthState = {
    status: 'authenticated',
    identity: principal('session-a-221'),
  };
  const listeners = new Set<() => void>();
  const identity = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => snapshot),
  } as unknown as IdentityStore;
  const change = (sessionId: string) => {
    snapshot = { status: 'authenticated', identity: principal(sessionId) };
    for (const listener of listeners) listener();
  };
  const write = vi.fn(async () =>
    jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
  );
  const task = vi.fn(async () => taskResult('Fresh-session task result'));
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/backup' && init?.method === 'POST') return write();
    if (path === '/api/v1/backup' && init?.method === 'GET')
      return jsonResponse({ success: true, data: [] });
    if (path === '/api/v1/backup/config')
      return jsonResponse({
        success: true,
        data: {
          id: 1,
          enabled: false,
          scheduleType: 'daily',
          scheduleValue: null,
          backupTime: '02:00',
        },
      });
    if (path === '/api/v1/backup/scheduled-tasks')
      return jsonResponse({ success: true, data: [] });
    if (path === `/api/v1/tasks/${taskId}` && init?.method === 'GET')
      return task();
    throw new Error(
      `Unexpected session-scope fixture request: ${init?.method} ${path}`,
    );
  });
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    baseURL: '/api/',
    session: sessionFixture().store,
    fetch: fetcher,
    socket: () => new FakeSocket(),
  });
  runtimes.push(runtime);
  render(
    <AuthContext.Provider value={{ identity, runtime, announce: vi.fn() }}>
      <BackupPanel />
    </AuthContext.Provider>,
  );
  await waitFor(() =>
    expect(createButton().hasAttribute('disabled')).toBe(false),
  );
  return { identity, runtime, write, task, fetcher, change };
}
const createButton = () =>
  screen.getByRole('button', { name: '创建异步备份任务' });
const lookupButton = () => screen.getByRole('button', { name: '查询原任务' });
const readGate = () => localStorage.getItem(backupGateKey(owner));
const postCall = (f: Awaited<ReturnType<typeof mounted>>) =>
  f.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;

describe('mounted backup authenticated sessionId boundary without loading unmount', () => {
  it('keeps an in-flight ACK for the same verified owner and session despite a new snapshot object', async () => {
    const f = await mounted();
    const pending = pendingResponse(
      jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
    );
    try {
      f.write.mockReturnValueOnce(pending.promise);
      fireEvent.click(createButton());
      await waitFor(() => expect(f.write).toHaveBeenCalledOnce());
      const revision = f.runtime.session.revision;
      act(() => f.change('session-a-221'));
      expect(f.identity.getSnapshot()).toEqual({
        status: 'authenticated',
        identity: principal('session-a-221'),
      });
      expect(f.runtime.session.revision).toBe(revision);
      expect(postCall(f)[1]?.signal?.aborted).toBe(false);
      await act(async () => {
        pending.resolve(
          jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
        );
      });
      await waitFor(() => expect(readGate()).toContain(taskId));
      expect(screen.getByText(new RegExp(taskId))).toBeTruthy();
      expect(createButton().hasAttribute('disabled')).toBe(true);
      expect(f.write).toHaveBeenCalledOnce();
      expect(f.task).not.toHaveBeenCalled();
    } finally {
      await pending.settle();
    }
  });

  it('aborts the old POST and retains its unknown guard when only the authenticated sessionId changes', async () => {
    const f = await mounted();
    const pending = pendingResponse(
      jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
    );
    try {
      f.write.mockReturnValueOnce(pending.promise);
      fireEvent.click(createButton());
      await waitFor(() => expect(f.write).toHaveBeenCalledOnce());
      const original = JSON.parse(readGate()!);
      const revision = f.runtime.session.revision;
      act(() => f.change('session-b-221'));
      expect(f.identity.getSnapshot()).toEqual({
        status: 'authenticated',
        identity: principal('session-b-221'),
      });
      expect(f.runtime.session.revision).toBe(revision);
      expect(postCall(f)[1]?.signal?.aborted).toBe(true);
      await act(async () => {
        pending.resolve(
          jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
        );
      });
      await waitFor(() =>
        expect(JSON.parse(readGate()!).state).toBe('unknown'),
      );
      expect(JSON.parse(readGate()!).requestId).toBe(original.requestId);
      expect(readGate()).not.toContain(taskId);
      expect(screen.queryByText(new RegExp(taskId))).toBeNull();
      expect(createButton().hasAttribute('disabled')).toBe(true);
      expect(lookupButton().hasAttribute('disabled')).toBe(true);
      expect(f.write).toHaveBeenCalledOnce();
      expect(f.task).not.toHaveBeenCalled();
    } finally {
      await pending.settle();
    }
  });

  it('retires the old GET and enables fresh GET-only recovery after an authenticated sessionId-only change', async () => {
    const f = await mounted();
    fireEvent.click(createButton());
    await waitFor(() => expect(readGate()).toContain(taskId));
    const original = readGate();
    const pending = pendingResponse(taskResult('Retired-session task result'));
    try {
      f.task.mockReturnValueOnce(pending.promise);
      fireEvent.click(lookupButton());
      await waitFor(() => expect(f.task).toHaveBeenCalledOnce());
      const old = f.fetcher.mock.calls.find(
        ([input]) =>
          new URL(String(input)).pathname === `/api/v1/tasks/${taskId}`,
      )!;
      const revision = f.runtime.session.revision;
      act(() => f.change('session-b-221'));
      expect(f.identity.getSnapshot()).toEqual({
        status: 'authenticated',
        identity: principal('session-b-221'),
      });
      expect(f.runtime.session.revision).toBe(revision);
      expect(old[1]?.signal?.aborted).toBe(true);
      await act(async () => {
        pending.resolve(taskResult('Retired-session task result'));
      });
      expect(screen.queryByText(/Retired-session task result/)).toBeNull();
      await waitFor(() =>
        expect(lookupButton().hasAttribute('disabled')).toBe(false),
      );
      expect(readGate()).toBe(original);
      expect(createButton().hasAttribute('disabled')).toBe(true);
      fireEvent.click(lookupButton());
      await screen.findByText(/Fresh-session task result/);
      expect(f.task).toHaveBeenCalledTimes(2);
      expect(f.write).toHaveBeenCalledOnce();
      expect(readGate()).toBe(original);
    } finally {
      await pending.settle();
    }
  });
});
