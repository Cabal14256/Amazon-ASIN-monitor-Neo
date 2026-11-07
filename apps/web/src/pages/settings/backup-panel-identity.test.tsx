// @vitest-environment jsdom
import type { CurrentUserData } from '@asin-monitor/contracts';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
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
import { IdentityStore } from '../../auth/identity';
import { RouteGate } from '../../auth/route-gate';
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

const owner = 'backup-operator';
const taskId = '10000000-0000-4000-8000-000000000221';
const taskPath = `/api/v1/tasks/${taskId}`;
const principal = (
  id = owner,
  sessionId = 'backup-session-221',
): CurrentUserData => ({
  user: {
    id,
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
const file = {
  filename: 'backup_20261007-080000-01234567-primary.dump',
  format: 'custom',
  target: 'primary',
  size: 17,
  createdAt: '2026-10-07T00:00:00.000Z',
  timeSource: 'filename',
  restoreSupported: true,
  restoreMode: 'isolated',
  sourceEngine: 'postgresql',
  scope: 'full',
};
const result = (message = 'Original backup result') =>
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
const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (key: string, work: () => unknown) => {
        const next = (tails.get(key) ?? Promise.resolve()).then(work);
        tails.set(
          key,
          next.catch(() => undefined),
        );
        return next;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
});

async function fixture() {
  const auth = vi.fn(async () =>
    jsonResponse({ success: true, data: principal() }),
  );
  const write = vi.fn(async () =>
    jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
  );
  const list = vi.fn(async () => jsonResponse({ success: true, data: [file] }));
  const task = vi.fn(async () => result());
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/auth/current-user' && init?.method === 'GET')
      return auth();
    if (path === '/api/v1/backup' && init?.method === 'POST') return write();
    if (path === '/api/v1/backup' && init?.method === 'GET') return list();
    if (path === '/api/v1/backup/config' && init?.method === 'GET')
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
    if (path === '/api/v1/backup/scheduled-tasks' && init?.method === 'GET')
      return jsonResponse({ success: true, data: [] });
    if (path === taskPath && init?.method === 'GET') return task();
    throw new Error(
      `Unexpected backup fixture request: ${init?.method} ${path}`,
    );
  });
  const runtime = createTransportRuntime({
    baseURL: '/api/',
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    socket: () => new FakeSocket(),
    fetch: fetcher,
  });
  const identity = new IdentityStore(runtime);
  const history = createMemoryHistory({ initialEntries: ['/settings'] });
  const root = createRootRoute({ component: Outlet });
  const settings = createRoute({
    getParentRoute: () => root,
    path: '/settings',
    component: () => (
      <RouteGate>
        <BackupPanel />
      </RouteGate>
    ),
  });
  const login = createRoute({
    getParentRoute: () => root,
    path: '/login',
    component: () => <p>Fixture login page</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([settings, login]),
    history,
    isServer: false,
  });
  router.update({ origin: 'https://app.test' });
  disposers.push(() => {
    identity.stop();
    runtime.dispose();
    history.destroy();
  });
  expect(await identity.ensure()).toEqual({
    status: 'authenticated',
    identity: principal(),
  });
  await router.load();
  const announce = vi.fn();
  render(
    <AuthContext.Provider value={{ runtime, identity, announce }}>
      <RouterProvider router={router} />
    </AuthContext.Provider>,
  );
  await screen.findByRole('button', { name: '创建异步备份任务' });
  return { auth, write, list, task, fetcher, runtime, identity, announce };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const gate = () => localStorage.getItem(backupGateKey(owner));
const submitButton = () =>
  screen.getByRole('button', { name: '创建异步备份任务' });

async function accepted(f: Fixture) {
  fireEvent.click(submitButton());
  await waitFor(() => expect(gate()).toContain(taskId));
  await screen.findByText(new RegExp(taskId));
  expect(submitButton().hasAttribute('disabled')).toBe(true);
  expect(f.write).toHaveBeenCalledOnce();
  expect(f.task).not.toHaveBeenCalled();
  const post = f.fetcher.mock.calls.find(
    ([, init]) => init?.method === 'POST',
  )!;
  expect(JSON.parse(String(post[1]?.body))).toEqual({
    target: 'primary',
    description: '',
    useAsync: true,
  });
  return gate()!;
}

async function pendingVerification(f: Fixture) {
  const pending = deferred<Response>();
  f.auth.mockReturnValueOnce(pending.promise);
  let verification!: ReturnType<IdentityStore['refresh']>;
  act(() => {
    verification = f.identity.refresh();
  });
  await screen.findByText('正在验证登录状态…');
  expect(screen.queryByRole('button', { name: '创建异步备份任务' })).toBeNull();
  expect(screen.queryByText(new RegExp(taskId))).toBeNull();
  return async (response: Response) => {
    await act(async () => {
      pending.resolve(response);
      await verification;
    });
  };
}

async function lookupOnly(f: Fixture) {
  fireEvent.click(screen.getByRole('button', { name: '查询原任务' }));
  await screen.findByText(/Original backup result/);
  expect(f.task).toHaveBeenCalledOnce();
  expect(f.write).toHaveBeenCalledOnce();
  const lookups = f.fetcher.mock.calls.filter(([input]) =>
    new URL(String(input)).pathname.startsWith('/api/v1/tasks/'),
  );
  expect(lookups).toHaveLength(1);
  expect(lookups[0][1]?.method).toBe('GET');
  expect(new URL(String(lookups[0][0])).pathname).toBe(taskPath);
}

describe('actual IdentityStore and RouteGate backup continuation', () => {
  it.each(['loading', 'error'] as const)(
    'keeps the known ACK through %s and the same verified-session remount, then uses only the original GET',
    async (intermediate) => {
      const f = await fixture();
      const original = await accepted(f);
      const revision = f.runtime.session.revision;
      const finish = await pendingVerification(f);
      expect(gate()).toBe(original);
      if (intermediate === 'error') {
        await finish(jsonResponse({ success: false, errorCode: 500 }, 500));
        await screen.findByText('暂时无法验证登录状态');
        expect(gate()).toBe(original);
        expect(screen.queryByText(new RegExp(taskId))).toBeNull();
        await act(async () => {
          await f.identity.refresh();
        });
      } else await finish(jsonResponse({ success: true, data: principal() }));
      await screen.findByText(new RegExp(taskId));
      expect(f.identity.getSnapshot()).toEqual({
        status: 'authenticated',
        identity: principal(),
      });
      expect(f.runtime.session.revision).toBe(revision);
      expect(gate()).toBe(original);
      expect(submitButton().hasAttribute('disabled')).toBe(true);
      expect(f.task).not.toHaveBeenCalled();
      await lookupOnly(f);
      expect(gate()).toBe(original);
    },
  );

  it('preserves the original local guard and session-only known ACK through real error/reverification', async () => {
    const f = await fixture();
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (
        this === localStorage &&
        key === backupGateKey(owner) &&
        JSON.parse(value).taskId === taskId
      )
        throw new Error('fixture durable ACK unavailable');
      setItem.call(this, key, value);
    });
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(sessionStorage.getItem(backupGateKey(owner))).toContain(taskId),
    );
    const originalLocal = gate();
    const originalSession = sessionStorage.getItem(backupGateKey(owner));
    expect(originalLocal).not.toContain(taskId);
    const finish = await pendingVerification(f);
    await finish(jsonResponse({ success: false, errorCode: 500 }, 500));
    await screen.findByText('暂时无法验证登录状态');
    await act(async () => {
      await f.identity.refresh();
    });
    await screen.findByText(new RegExp(taskId));
    expect(gate()).toBe(originalLocal);
    expect(sessionStorage.getItem(backupGateKey(owner))).toBe(originalSession);
    expect(submitButton().hasAttribute('disabled')).toBe(true);
    await lookupOnly(f);
  });

  it('hides backup context when pending verification ends anonymous without erasing an outstanding operation', async () => {
    const f = await fixture();
    const original = await accepted(f);
    const finish = await pendingVerification(f);
    await finish(jsonResponse({ success: false, errorCode: 401 }, 401));
    await screen.findByText('Fixture login page');
    expect(f.identity.getSnapshot()).toEqual({ status: 'anonymous' });
    expect(screen.queryByText(new RegExp(taskId))).toBeNull();
    expect(gate()).toBe(original);
    expect(f.task).not.toHaveBeenCalled();
    expect(f.write).toHaveBeenCalledOnce();
  });

  it('isolates a different verified owner and only restores the old receipt after its owner verifies again', async () => {
    const f = await fixture();
    const original = await accepted(f);
    const finish = await pendingVerification(f);
    const replacement = principal(
      'other-backup-operator',
      'other-backup-session',
    );
    await finish(jsonResponse({ success: true, data: replacement }));
    await waitFor(() =>
      expect(submitButton().hasAttribute('disabled')).toBe(false),
    );
    expect(f.identity.getSnapshot()).toEqual({
      status: 'authenticated',
      identity: replacement,
    });
    expect(screen.queryByText(new RegExp(taskId))).toBeNull();
    expect(screen.queryByRole('button', { name: '查询原任务' })).toBeNull();
    expect(localStorage.getItem(backupGateKey(replacement.user.id))).toBeNull();
    expect(gate()).toBe(original);
    expect(f.task).not.toHaveBeenCalled();
    await act(async () => {
      await f.identity.refresh();
    });
    await screen.findByText(new RegExp(taskId));
    expect(gate()).toBe(original);
    await lookupOnly(f);
  });

  it('retires an old-session GET result while retaining its owner-scoped durable receipt for fresh GET-only recovery', async () => {
    const f = await fixture();
    const original = await accepted(f);
    const pendingTask = deferred<Response>();
    f.task.mockReturnValueOnce(pendingTask.promise);
    fireEvent.click(screen.getByRole('button', { name: '查询原任务' }));
    await waitFor(() => expect(f.task).toHaveBeenCalledOnce());
    const oldRead = f.fetcher.mock.calls.find(
      ([input]) => new URL(String(input)).pathname === taskPath,
    )!;
    const revision = f.runtime.session.revision;
    const finish = await pendingVerification(f);
    expect(oldRead[1]?.signal?.aborted).toBe(true);
    const replacement = principal(owner, 'replacement-backup-session');
    await finish(jsonResponse({ success: true, data: replacement }));
    await screen.findByText(new RegExp(taskId));
    await act(async () => {
      pendingTask.resolve(result('Retired-session result'));
      await Promise.resolve();
    });
    expect(screen.queryByText(/Retired-session result/)).toBeNull();
    expect(f.identity.getSnapshot()).toEqual({
      status: 'authenticated',
      identity: replacement,
    });
    expect(f.runtime.session.revision).toBe(revision); // The verified sessionId actually changed, not a local hint.
    expect(gate()).toBe(original);
    expect(submitButton().hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '查询原任务' }));
    await screen.findByText(/Original backup result/);
    expect(f.task).toHaveBeenCalledTimes(2);
    expect(f.write).toHaveBeenCalledOnce();
    expect(gate()).toBe(original);
  });

  it('keeps an unconfirmed POST guarded when real identity loading aborts it and refuses a late ACK without resubmission', async () => {
    const f = await fixture();
    const submission = deferred<Response>();
    f.write.mockReturnValueOnce(submission.promise);
    fireEvent.click(submitButton());
    await waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    const original = gate();
    expect(original).toBeTruthy();
    const post = f.fetcher.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    )!;
    const finish = await pendingVerification(f);
    expect(post[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      submission.resolve(
        jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
      );
      await Promise.resolve();
    });
    await finish(jsonResponse({ success: true, data: principal() }));
    await screen.findByRole('button', { name: '创建异步备份任务' });
    await waitFor(() => expect(JSON.parse(gate()!).state).toBe('unknown'));
    expect(JSON.parse(gate()!).requestId).toBe(JSON.parse(original!).requestId);
    expect(gate()).not.toContain(taskId);
    expect(submitButton().hasAttribute('disabled')).toBe(true);
    expect(
      screen
        .getByRole('button', { name: '查询原任务' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(f.task).not.toHaveBeenCalled();
    expect(f.write).toHaveBeenCalledOnce();
  });
});
