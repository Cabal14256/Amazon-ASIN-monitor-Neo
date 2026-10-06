// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import { ApiError } from '../../lib/http';
import type { createTransportRuntime } from '../../services/runtime';
import { ASIN_CATALOG } from '../asin/config';
import {
  catalogCheckGateKey,
  type CatalogCheckGate,
} from './catalog-check-recovery';
import type { CatalogGroup, CatalogListData } from './catalog-types';
import { CatalogPage } from './index';

const taskSnapshot = vi.hoisted(() => ({
  data: undefined as
    | { taskId: string; status: string; result?: unknown; progress?: number }
    | undefined,
  error: null as Error | null,
}));
vi.mock('../../hooks/tasks', () => ({
  useTaskQuery: (_runtime: unknown, _id: string, enabled: boolean) => ({
    data: enabled ? taskSnapshot.data : undefined,
    isError: enabled && Boolean(taskSnapshot.error),
    error: taskSnapshot.error,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const group: CatalogGroup = {
  id: 'group-1',
  name: 'Original group',
  country: 'US',
  brand: 'Brand',
  children: [],
};
const updated = {
  ...group,
  name: 'Checked group',
  lastCheckTime: '2026-10-02',
};
const taskId = 'task-1';
const key = catalogCheckGateKey('asin', 'operator');
const gate: CatalogCheckGate = {
  requestId: 'original-request',
  submittedAt: 1000,
  target: { kind: 'group', id: group.id, label: group.name },
  taskId,
};
const listData = (row: CatalogGroup): CatalogListData => ({
  list: [row],
  total: 1,
  totalASINs: 0,
  current: 1,
  pageSize: 10,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function fixture() {
  let auth = {
    status: 'authenticated' as const,
    identity: {
      user: { id: 'operator', username: 'operator', status: 'ACTIVE' as const },
      roles: [],
      permissions: ['asin:read'],
    },
  };
  const listeners = new Set<() => void>();
  const identity = {
    getSnapshot: () => auth,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => auth),
  } as unknown as IdentityStore;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const list = vi.fn(async () => listData(group));
  const detail = vi.fn(async () => group);
  const send = vi.fn(async () => ({
    kind: 'task' as const,
    taskId: 'task-2',
    status: 'pending' as const,
  }));
  const getTask = vi.fn(async () => ({ taskId, status: 'completed' }));
  const runtime = {
    http: { request: vi.fn() },
    queryClient,
    tasks: { get: getTask },
    clearUserWork: vi.fn(),
  } as unknown as ReturnType<typeof createTransportRuntime>;
  const config = {
    ...ASIN_CATALOG,
    list,
    detail,
    writes: undefined,
    checks: { group: send, asin: send },
  };
  const element = () => (
    <AuthContext.Provider value={{ identity, runtime, announce: vi.fn() }}>
      <QueryClientProvider client={queryClient}>
        <CatalogPage config={config} />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  const view = render(element());
  return {
    list,
    detail,
    send,
    getTask,
    identity,
    runtime,
    rerender: () => view.rerender(element()),
    setOwner: (id: string) => {
      auth = {
        ...auth,
        identity: { ...auth.identity, user: { ...auth.identity.user, id } },
      };
      for (const listener of listeners) listener();
    },
  };
}
async function openDetails() {
  fireEvent.click(
    (await screen.findAllByRole('button', { name: '查看 ASIN' }))[0],
  );
  await screen.findAllByRole('button', { name: '立即检查' });
}
function otherTabWrites(next: CatalogCheckGate | null) {
  if (next) window.localStorage.setItem(key, JSON.stringify(next));
  else window.localStorage.removeItem(key);
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      newValue: next ? JSON.stringify(next) : null,
    }),
  );
}
beforeEach(() => {
  taskSnapshot.data = { taskId, status: 'pending' };
  taskSnapshot.error = null;
  window.localStorage.setItem(key, JSON.stringify(gate));
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_key: string, callback: () => unknown) => callback(),
    },
  });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('mounted immediate-check recovery', () => {
  it('releases an old queued submission after the authenticated owner changes and actually submits for the new owner', async () => {
    window.localStorage.removeItem(key);
    const lock = deferred<void>();
    const locks = vi.fn(async (_key: string, callback: () => unknown) => {
      await lock.promise;
      return callback();
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: locks },
    });
    const f = fixture();
    await openDetails();
    fireEvent.click(screen.getAllByRole('button', { name: '立即检查' })[0]);
    await waitFor(() => expect(locks).toHaveBeenCalledTimes(1));
    act(() => f.setOwner('next-operator'));
    await act(async () => lock.resolve());
    // A new identity no longer inherits the previous user's expanded detail.
    await openDetails();
    await waitFor(() =>
      expect(
        (
          screen.getAllByRole('button', {
            name: '立即检查',
          })[0] as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(f.send).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '立即检查' })[0]);
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(
        window.localStorage.getItem(
          catalogCheckGateKey('asin', 'next-operator'),
        )!,
      ),
    ).toMatchObject({ taskId: 'task-2' });
  });

  it('preserves the new owner guard when an old queued submission becomes stale', async () => {
    window.localStorage.removeItem(key);
    const lock = deferred<void>();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_key: string, callback: () => unknown) => {
          await lock.promise;
          return callback();
        },
      },
    });
    const f = fixture();
    await openDetails();
    fireEvent.click(screen.getAllByRole('button', { name: '立即检查' })[0]);
    const nextKey = catalogCheckGateKey('asin', 'next-operator');
    const nextGuard = {
      ...gate,
      requestId: 'next-request',
      taskId: 'next-task',
    };
    window.localStorage.setItem(nextKey, JSON.stringify(nextGuard));
    act(() => f.setOwner('next-operator'));
    await act(async () => lock.resolve());
    await screen.findByText('next-task');
    await openDetails();
    expect(JSON.parse(window.localStorage.getItem(nextKey)!)).toEqual(
      nextGuard,
    );
    expect(
      screen
        .getAllByRole('button', { name: '立即检查' })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('keeps a late accepted task under its original owner while releasing the new owner pending UI', async () => {
    window.localStorage.removeItem(key);
    const f = fixture();
    const reply = deferred<{
      kind: 'task';
      taskId: string;
      status: 'pending';
    }>();
    f.send.mockImplementationOnce(() => reply.promise);
    await openDetails();
    fireEvent.click(screen.getAllByRole('button', { name: '立即检查' })[0]);
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    act(() => f.setOwner('next-operator'));
    await act(async () =>
      reply.resolve({
        kind: 'task',
        taskId: 'old-owner-task',
        status: 'pending',
      }),
    );
    await openDetails();
    await waitFor(() =>
      expect(
        (
          screen.getAllByRole('button', {
            name: '立即检查',
          })[0] as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(JSON.parse(window.localStorage.getItem(key)!)).toMatchObject({
      taskId: 'old-owner-task',
    });
    expect(
      window.localStorage.getItem(catalogCheckGateKey('asin', 'next-operator')),
    ).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '立即检查' })[0]);
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(JSON.parse(window.localStorage.getItem(key)!)).toMatchObject({
      taskId: 'old-owner-task',
    });
  });

  it('can actually submit again when another tab clears the guard during terminal refresh', async () => {
    const f = fixture();
    await openDetails();
    const refresh = deferred<CatalogListData>();
    f.list.mockImplementationOnce(() => refresh.promise);
    taskSnapshot.data = {
      taskId,
      status: 'completed',
      result: { isBroken: false },
    };
    f.rerender();
    await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
    act(() => otherTabWrites(null));
    await waitFor(() => expect(screen.queryByText('正在更新目录…')).toBeNull());
    await act(async () => refresh.resolve(listData(updated)));
    await screen.findAllByText(updated.name);
    const button = screen.getAllByRole('button', { name: '立即检查' })[0];
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(JSON.parse(window.localStorage.getItem(key)!)).toMatchObject({
      taskId: 'task-2',
    });
  });

  it('preserves a replacement guard installed while the old terminal task refreshes', async () => {
    const f = fixture();
    await openDetails();
    const refresh = deferred<CatalogListData>();
    f.list.mockImplementationOnce(() => refresh.promise);
    taskSnapshot.data = { taskId, status: 'completed' };
    f.rerender();
    await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
    const replacement = { ...gate, requestId: 'new-request', taskId: 'task-2' };
    act(() => otherTabWrites(replacement));
    await act(async () => refresh.resolve(listData(updated)));
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(replacement);
    expect(f.send).not.toHaveBeenCalled();
    expect(
      screen
        .getAllByRole('button', { name: '立即检查' })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it.each(['completed', 'failed', 'cancelled', 'missing'])(
    'refreshes both list and selected detail before unlocking a manually confirmed %s task',
    async (status) => {
      taskSnapshot.error = new ApiError('NETWORK', 'poll unavailable');
      const f = fixture();
      await openDetails();
      fireEvent.click(await screen.findByRole('button', { name: '停止跟踪' }));
      const refresh = deferred<CatalogListData>();
      const detail = deferred<CatalogGroup>();
      f.list.mockImplementationOnce(() => refresh.promise);
      f.detail.mockImplementationOnce(() => detail.promise);
      f.getTask.mockImplementationOnce(async () => {
        if (status === 'missing') throw new ApiError('HTTP', 'not found', 404);
        return { taskId, status };
      });
      fireEvent.click(
        screen.getByRole('button', { name: '已核实原任务，恢复检查' }),
      );
      await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
      expect(window.localStorage.getItem(key)).not.toBeNull();
      expect(screen.queryByText('已核实原任务，可以重新提交检查。')).toBeNull();
      await act(async () => refresh.resolve(listData(updated)));
      await waitFor(() => expect(f.detail).toHaveBeenCalledTimes(2));
      expect(window.localStorage.getItem(key)).not.toBeNull();
      await act(async () => detail.resolve(updated));
      await screen.findByText('已核实原任务，可以重新提交检查。');
      expect(window.localStorage.getItem(key)).toBeNull();
      expect(screen.getAllByText(updated.name).length).toBeGreaterThan(0);
      expect(
        screen
          .getAllByRole('button', { name: '立即检查' })
          .every((button) => !(button as HTMLButtonElement).disabled),
      ).toBe(true);
    },
  );

  it('keeps manual recovery guarded after a catalog read fails and permits a successful retry', async () => {
    taskSnapshot.error = new ApiError('NETWORK', 'poll unavailable');
    const f = fixture();
    await openDetails();
    fireEvent.click(await screen.findByRole('button', { name: '停止跟踪' }));
    f.list.mockRejectedValueOnce(new ApiError('NETWORK', 'catalog offline'));
    fireEvent.click(
      screen.getByRole('button', { name: '已核实原任务，恢复检查' }),
    );
    await screen.findByText(/目录重读未完成，防重记录继续保留/);
    expect(window.localStorage.getItem(key)).not.toBeNull();
    expect(f.send).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: '已核实原任务，恢复检查' }),
    );
    await screen.findByText('已核实原任务，可以重新提交检查。');
    expect(window.localStorage.getItem(key)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '立即检查' })[0]);
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  });

  it('retries the same terminal task after an authorization-aborted refresh and identity revalidation', async () => {
    const f = fixture();
    await openDetails();
    f.list.mockRejectedValueOnce(new ApiError('HTTP', 'revoked', 403));
    taskSnapshot.data = {
      taskId,
      status: 'completed',
      result: { isBroken: false },
    };
    f.rerender();
    await waitFor(() =>
      expect(f.runtime.clearUserWork).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(f.identity.refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(f.list).toHaveBeenCalledTimes(3));
    expect(window.localStorage.getItem(key)).not.toBeNull();
    // Authorization recovery collapses the previously selected detail.
    await openDetails();
    await waitFor(() => {
      expect(
        (
          screen.getAllByRole('button', {
            name: '立即检查',
          })[0] as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getAllByRole('button', { name: '立即检查' })[0]);
    await waitFor(() => expect(window.localStorage.getItem(key)).toBeNull());
    expect(f.send).not.toHaveBeenCalled();
    await screen.findByText(/检查完成：未发现异常/);
    fireEvent.click(screen.getAllByRole('button', { name: '立即检查' })[0]);
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  });
});
