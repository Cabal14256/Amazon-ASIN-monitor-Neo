// @vitest-environment jsdom
import type { CurrentUserData } from '@asin-monitor/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
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
import { ASIN_CATALOG } from '../asin/config';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { catalogCheckGateKey } from './catalog-check-recovery';
import type { CatalogCheckGate } from './catalog-check-types';
import { catalogSafetyKey } from './catalog-safety-gate';
import { CatalogPage } from './index';

const route = vi.hoisted(() => ({ pathname: '/asin' }));
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  Navigate: ({ to }: { to: string }) => <p role="alert">转到 {to}</p>,
  useRouterState: <T,>({
    select,
  }: {
    select: (state: {
      location: { pathname: string; searchStr: string; hash: string };
    }) => T;
  }) =>
    select({ location: { pathname: route.pathname, searchStr: '', hash: '' } }),
}));

type Domain = 'asin' | 'competitor';
const group = {
  id: ' Mixed-É ',
  name: 'Original group',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  children: [],
};
const verifiedIdentity: CurrentUserData = {
  user: {
    id: 'operator',
    username: 'operator',
    status: 'ACTIVE',
    force_password_change: false,
  },
  roles: [],
  permissions: ['asin:read', 'asin:write', 'asin:delete'],
  sessionId: 'session-1',
  mustChangePassword: false,
  passwordExpired: false,
};
const envelope = (data: unknown) => jsonResponse({ success: true, data });
const catalogResponse = () =>
  envelope({
    list: [group],
    total: 1,
    totalASINs: 0,
    current: 1,
    pageSize: 10,
  });
const cleanups: (() => void)[] = [];

/** A held fetch obeys the native AbortSignal; no late ACK bypasses HttpClient. */
function abortable(response: Promise<Response>, signal?: AbortSignal | null) {
  return new Promise<Response>((resolve, reject) => {
    const cancel = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    response
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', cancel));
  });
}

beforeEach(() => {
  let previous = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, callback: () => unknown) => {
        const next = previous.then(callback);
        previous = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function fixture(domain: Domain = 'asin', failAcceptedReceipt = false) {
  route.pathname = domain === 'asin' ? '/asin' : '/competitor-asin';
  const safetyKey = catalogSafetyKey('operator', domain);
  const receiptKey = catalogCheckGateKey(domain, 'operator');
  const originalSetItem = Storage.prototype.setItem;
  let rejectKnownWrites = false;
  const setItem = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(function (this: Storage, key: string, value: string) {
      if (
        rejectKnownWrites &&
        (key === safetyKey || key === receiptKey) &&
        value.includes('"taskId"')
      )
        throw new DOMException('Receipt storage full', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    });
  let currentIdentity = verifiedIdentity;
  let nextIdentity: Promise<Response> | null = null;
  let heldPost: ReturnType<typeof deferred<Response>> | null = null;
  let heldTask: ReturnType<typeof deferred<Response>> | null = null;
  let heldCatalog: ReturnType<typeof deferred<Response>> | null = null;
  let heldCatalogStarted = false;
  let failCatalogReads = false;
  let rejectNextTask = false;
  let rejectAllTasks = false;
  let status: 'pending' | 'completed' = 'pending';
  const catalogReads: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/current-user')) {
      const held = nextIdentity;
      nextIdentity = null;
      return held
        ? abortable(held, options?.signal)
        : envelope(currentIdentity);
    }
    if (options?.method === 'POST') {
      rejectKnownWrites = failAcceptedReceipt;
      if (heldPost) {
        const held = heldPost;
        heldPost = null;
        return abortable(held.promise, options?.signal);
      }
      return envelope({
        taskId: 'job-1',
        taskType:
          domain === 'asin'
            ? 'variant-group'
            : 'competitor-variant-group-check',
        status: 'pending',
      });
    }
    if (url.pathname.includes('/tasks/')) {
      if (heldTask) {
        const held = heldTask;
        heldTask = null;
        return abortable(held.promise, options?.signal);
      }
      if (rejectNextTask || rejectAllTasks) {
        rejectNextTask = false;
        return jsonResponse(
          { success: false, errorMessage: 'task access denied' },
          403,
        );
      }
      const taskId = decodeURIComponent(url.pathname.split('/').at(-1)!);
      return envelope(
        taskFixture({
          taskId,
          taskType: domain === 'asin' ? 'batch-check' : 'variant-check',
          taskSubType:
            domain === 'asin'
              ? 'variant-group'
              : 'competitor-variant-group-check',
          status,
          canCancel: status === 'pending',
        }),
      );
    }
    if (url.pathname.endsWith(encodeURIComponent(group.id)))
      return envelope(group);
    catalogReads.push(url);
    if (heldCatalog) {
      const held = heldCatalog;
      heldCatalog = null;
      heldCatalogStarted = true;
      return abortable(held.promise, options?.signal);
    }
    return failCatalogReads
      ? jsonResponse(
          { success: false, errorMessage: 'current catalog failed' },
          500,
        )
      : catalogResponse();
  });
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    baseURL: 'https://api.test/api/',
    session: sessionFixture().store,
    fetch: fetcher,
    socket: () => new FakeSocket(),
  });
  runtime.queryClient.setDefaultOptions({ queries: { retry: false } });
  const identity = new IdentityStore(runtime);
  cleanups.push(() => {
    identity.stop();
    runtime.dispose();
  });
  expect((await identity.ensure()).status).toBe('authenticated');
  render(
    <AuthContext.Provider value={{ identity, runtime, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <RouteGate>
          <CatalogPage
            config={domain === 'asin' ? ASIN_CATALOG : COMPETITOR_CATALOG}
          />
        </RouteGate>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  const posts = () =>
    fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
  const taskReads = (id = 'job-1') =>
    fetcher.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.endsWith(`/tasks/${id}`),
    );
  return {
    domain,
    runtime,
    identity,
    setItem,
    receiptKey,
    safetyKey,
    catalogReads,
    posts,
    taskReads,
    identityReads: () =>
      fetcher.mock.calls.filter(([input]) =>
        new URL(String(input)).pathname.endsWith('/auth/current-user'),
      ),
    setStatus: (next: typeof status) => {
      status = next;
    },
    failCatalog: (failed: boolean) => {
      failCatalogReads = failed;
    },
    rejectNextTaskAuthorization: () => {
      rejectNextTask = true;
    },
    rejectAllTaskAuthorization: () => {
      rejectAllTasks = true;
    },
    allowTaskAuthorization: () => {
      rejectAllTasks = false;
    },
    holdPost: () => {
      heldPost = deferred<Response>();
      return heldPost;
    },
    holdTask: () => {
      heldTask = deferred<Response>();
      return heldTask;
    },
    holdCatalog: () => {
      heldCatalog = deferred<Response>();
      heldCatalogStarted = false;
      return heldCatalog;
    },
    catalogHeld: () => heldCatalogStarted,
    holdIdentity: () => {
      const held = deferred<Response>();
      nextIdentity = held.promise;
      return held;
    },
    setIdentity: (next: CurrentUserData) => {
      currentIdentity = next;
    },
    installPeer: () => {
      const peer: CatalogCheckGate = {
        requestId: 'peer-request-2',
        submittedAt: Date.now(),
        target: { kind: 'group', id: group.id, label: group.name },
        taskId: 'job-2',
      };
      const raw = JSON.stringify({
        phase: 'inspection',
        operationId: peer.requestId,
        check: peer,
      });
      // Model a different tab whose storage write succeeds, while this tab's
      // original ACK update remains unavailable.
      originalSetItem.call(
        window.localStorage,
        receiptKey,
        JSON.stringify(peer),
      );
      originalSetItem.call(window.localStorage, safetyKey, raw);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: safetyKey,
          newValue: raw,
          storageArea: window.localStorage,
        }),
      );
      return raw;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function submitAndReceiveAck(f: Fixture) {
  if (f.domain === 'asin') {
    fireEvent.click(
      (
        await screen.findAllByRole('checkbox', {
          name: `选择变体组 ${group.name}，ID ${JSON.stringify(group.id)}`,
        })
      )[0],
    );
    fireEvent.click(screen.getByRole('button', { name: '检查所选组' }));
  } else {
    fireEvent.click(
      (await screen.findAllByRole('button', { name: '查看 ASIN' }))[0],
    );
    fireEvent.click(
      (await screen.findAllByRole('button', { name: '立即检查' }))[0],
    );
  }
  fireEvent.click(
    within(screen.getByRole('region', { name: '确认检查' })).getByRole(
      'button',
      {
        name: '确认提交检查',
      },
    ),
  );
  // This is after a valid ACK passes the actual HttpClient and Zod service;
  // identity refresh never aborts a still-pending submission in these cases.
  await screen.findByText('job-1');
  await waitFor(() => expect(f.taskReads().length).toBeGreaterThan(0));
  expect(f.posts()).toHaveLength(1);
}
async function invalidateTask(f: Fixture) {
  await act(async () => {
    await f.runtime.queryClient.invalidateQueries({
      queryKey: ['tasks', 'detail', 'job-1'],
    });
  });
}
function expectUnknownDurableReceipt(f: Fixture) {
  expect(JSON.parse(window.localStorage.getItem(f.receiptKey)!)).toMatchObject({
    target:
      f.domain === 'asin'
        ? { kind: 'batch', groupIds: [group.id] }
        : { kind: 'group', id: group.id },
  });
  expect(window.localStorage.getItem(f.receiptKey)).not.toContain('taskId');
  expect(window.localStorage.getItem(f.safetyKey)).not.toContain('taskId');
  expect(window.sessionStorage.getItem(f.receiptKey)).toBeNull();
  expect(
    f.setItem.mock.calls.filter(
      ([key, value]) =>
        (key === f.receiptKey || key === f.safetyKey) &&
        value.includes('"taskId"'),
    ).length,
  ).toBeGreaterThanOrEqual(2);
}

describe('manual check catalog reconciliation with actual identity and transport', () => {
  it.each(
    (['terminal', 'manual'] as const).flatMap((path) =>
      (['different', 'roundtrip', 'stable'] as const).map((query) => ({
        path,
        query,
      })),
    ),
  )(
    'keeps the original guard until the current query is read (%j)',
    async ({ path, query }) => {
      const f = await fixture();
      await submitAndReceiveAck(f);
      const originalReceipt = window.localStorage.getItem(f.receiptKey);
      const originalSafety = window.localStorage.getItem(f.safetyKey);
      f.setStatus('completed');
      if (path === 'manual') {
        f.failCatalog(true);
        await invalidateTask(f);
        await screen.findByRole('button', { name: '已核实原任务，恢复检查' });
        expect(window.localStorage.getItem(f.safetyKey)).toBe(originalSafety);
        f.failCatalog(false);
      }
      const held = f.holdCatalog();
      if (path === 'terminal') await invalidateTask(f);
      else
        fireEvent.click(
          screen.getByRole('button', { name: '已核实原任务，恢复检查' }),
        );
      await waitFor(() => expect(f.catalogHeld()).toBe(true));
      if (query !== 'stable') {
        f.failCatalog(true);
        fireEvent.click(screen.getByRole('button', { name: '异常' }));
        await waitFor(() =>
          expect(
            f.catalogReads.some(
              (url) => url.searchParams.get('variantStatus') === 'BROKEN',
            ),
          ).toBe(true),
        );
        await screen.findByText('ASIN目录暂不可用');
        if (query === 'roundtrip') {
          const before = f.catalogReads.length;
          fireEvent.click(screen.getByRole('button', { name: '全部' }));
          await waitFor(() =>
            expect(f.catalogReads.length).toBeGreaterThan(before),
          );
          await screen.findByText('刷新失败，当前展示上一次成功读取的数据。');
        }
      }
      await act(async () => held.resolve(catalogResponse()));
      if (query === 'stable') {
        await waitFor(() =>
          expect(window.localStorage.getItem(f.safetyKey)).toBeNull(),
        );
        expect(window.localStorage.getItem(f.receiptKey)).toBeNull();
      } else {
        await waitFor(() =>
          expect(screen.queryByText('正在更新目录…')).toBeNull(),
        );
        expect(window.localStorage.getItem(f.safetyKey)).toBe(originalSafety);
        expect(window.localStorage.getItem(f.receiptKey)).toBe(originalReceipt);
        expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
      }
      expect(f.posts()).toHaveLength(1);
    },
  );

  it.each(
    (['asin', 'competitor'] as const).flatMap((domain) =>
      (['loading', 'error'] as const).map((boundary) => ({ domain, boundary })),
    ),
  )(
    'retains an already accepted ID across transient identity unmounts (%j)',
    async ({ domain, boundary }) => {
      const f = await fixture(domain, true);
      await submitAndReceiveAck(f);
      expectUnknownDurableReceipt(f);
      const originalReceipt = window.localStorage.getItem(f.receiptKey);
      const beforeReads = f.taskReads().length;
      const held = f.holdIdentity();
      let refresh!: ReturnType<IdentityStore['refresh']>;
      act(() => {
        refresh = f.identity.refresh();
      });
      await screen.findByText('正在验证登录状态…');
      expect(f.identity.getSnapshot().status).toBe('loading');
      expect(screen.queryByRole('region', { name: '即时检查状态' })).toBeNull();
      if (boundary === 'error') {
        await act(async () => {
          held.reject(new TypeError('identity network unavailable'));
          await refresh;
        });
        await screen.findByText('暂时无法验证登录状态');
        expect(f.identity.getSnapshot().status).toBe('error');
        expect(screen.queryByText('job-1')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '重试' }));
      } else {
        await act(async () => {
          held.resolve(envelope(verifiedIdentity));
          await refresh;
        });
      }
      await screen.findByText('job-1');
      await invalidateTask(f);
      await waitFor(() =>
        expect(f.taskReads().length).toBeGreaterThan(beforeReads),
      );
      expect(window.localStorage.getItem(f.receiptKey)).toBe(originalReceipt);
      expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
      expect(f.posts()).toHaveLength(1);
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'keeps the accepted %s ID readable while its original mounted page remains stable',
    async (domain) => {
      const f = await fixture(domain, true);
      await submitAndReceiveAck(f);
      expectUnknownDurableReceipt(f);
      const before = f.taskReads().length;
      await invalidateTask(f);
      await waitFor(() => expect(f.taskReads().length).toBeGreaterThan(before));
      expect(screen.getByText('job-1')).toBeTruthy();
      expect(f.posts()).toHaveLength(1);
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'prefers a replacement peer %s receipt over the old accepted ID after identity refresh',
    async (domain) => {
      const f = await fixture(domain, true);
      await submitAndReceiveAck(f);
      expectUnknownDurableReceipt(f);
      const held = f.holdIdentity();
      let refresh!: ReturnType<IdentityStore['refresh']>;
      act(() => {
        refresh = f.identity.refresh();
      });
      await screen.findByText('正在验证登录状态…');
      let peerRaw!: string;
      act(() => {
        peerRaw = f.installPeer();
      });
      const before = f.taskReads().length;
      await act(async () => {
        held.resolve(envelope(verifiedIdentity));
        await refresh;
      });
      await screen.findByText('job-2');
      expect(screen.queryByText('job-1')).toBeNull();
      expect(window.localStorage.getItem(f.safetyKey)).toBe(peerRaw);
      expect(f.taskReads()).toHaveLength(before);
      expect(f.posts()).toHaveLength(1);
    },
  );

  it.each(['owner', 'session', 'anonymous'] as const)(
    'does not restore a volatile accepted ID into a confirmed different %s scope',
    async (boundary) => {
      const f = await fixture('asin', true);
      await submitAndReceiveAck(f);
      expectUnknownDurableReceipt(f);
      const originalReceipt = window.localStorage.getItem(f.receiptKey);
      const held = f.holdIdentity();
      let refresh!: ReturnType<IdentityStore['refresh']>;
      act(() => {
        refresh = f.identity.refresh();
      });
      await screen.findByText('正在验证登录状态…');
      const before = f.taskReads().length;
      const next: CurrentUserData = {
        ...verifiedIdentity,
        user: {
          ...verifiedIdentity.user,
          id: boundary === 'owner' ? 'other' : verifiedIdentity.user.id,
        },
        sessionId:
          boundary === 'session' ? 'session-2' : verifiedIdentity.sessionId,
      };
      f.setIdentity(next);
      await act(async () => {
        held.resolve(
          boundary === 'anonymous'
            ? jsonResponse({ success: false, errorCode: 401 }, 401)
            : envelope(next),
        );
        await refresh;
      });
      if (boundary === 'anonymous') {
        await screen.findByText(/转到 \/login/);
        expect(f.identity.getSnapshot().status).toBe('anonymous');
      } else await screen.findByText('已选 0 组');
      expect(screen.queryByText('job-1')).toBeNull();
      expect(f.taskReads()).toHaveLength(before);
      expect(window.localStorage.getItem(f.receiptKey)).toBe(originalReceipt);
      expect(
        window.localStorage.getItem(catalogCheckGateKey('asin', 'other')),
      ).toBeNull();
      expect(f.posts()).toHaveLength(1);
    },
  );
});

describe('accepted receipt lock handoff and authorization revalidation', () => {
  it.each(['active', 'denied'] as const)(
    'ignores a late manual task %s result after a replacement peer receipt',
    async (result) => {
      const f = await fixture('asin', true);
      await submitAndReceiveAck(f);
      f.rejectAllTaskAuthorization();
      await invalidateTask(f);
      await screen.findByRole('button', { name: '已核实原任务，恢复检查' });
      f.allowTaskAuthorization();
      const held = f.holdTask();
      const before = f.taskReads().length;
      fireEvent.click(
        screen.getByRole('button', { name: '已核实原任务，恢复检查' }),
      );
      await waitFor(() => expect(f.taskReads()).toHaveLength(before + 1));
      let peerRaw!: string;
      act(() => {
        peerRaw = f.installPeer();
      });
      await screen.findByText('job-2');
      await waitFor(() =>
        expect(f.taskReads('job-2').length).toBeGreaterThan(0),
      );
      const identityReads = f.identityReads().length;
      await act(async () =>
        held.resolve(
          result === 'active'
            ? envelope(
                taskFixture({
                  taskId: 'job-1',
                  status: 'pending',
                  canCancel: true,
                }),
              )
            : jsonResponse(
                { success: false, errorMessage: 'old task denied' },
                403,
              ),
        ),
      );
      await screen.findByText('job-2');
      expect(screen.queryByText('job-1')).toBeNull();
      expect(f.taskReads()).toHaveLength(before + 1);
      expect(f.identityReads()).toHaveLength(identityReads);
      expect(window.localStorage.getItem(f.safetyKey)).toBe(peerRaw);
      expect(f.posts()).toHaveLength(1);
    },
  );
  it.each([true, false])(
    'bounds persistent TaskApi 403 recovery while retaining the known ID (storage fails: %s)',
    async (failAcceptedReceipt) => {
      const f = await fixture('asin', failAcceptedReceipt);
      await submitAndReceiveAck(f);
      const originalReceipt = window.localStorage.getItem(f.receiptKey);
      const before = f.taskReads().length;
      f.rejectAllTaskAuthorization();
      await invalidateTask(f);
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: '已核实原任务，恢复检查' }),
          `actual TaskApi 403 reads since rejection: ${
            f.taskReads().length - before
          }`,
        ).toBeTruthy(),
      );
      expect(screen.getByText('job-1')).toBeTruthy();
      expect(f.identity.getSnapshot().status).toBe('authenticated');
      expect(f.taskReads()).toHaveLength(before + 2);
      expect(window.localStorage.getItem(f.receiptKey)).toBe(originalReceipt);
      expect(f.posts()).toHaveLength(1);
      const pausedReads = f.taskReads().length;
      f.allowTaskAuthorization();
      fireEvent.click(
        screen.getByRole('button', { name: '已核实原任务，恢复检查' }),
      );
      await screen.findByText(
        '该任务仍在排队或执行，请等待终态或到任务中心核实。',
      );
      await waitFor(() =>
        expect(f.taskReads().length).toBeGreaterThan(pausedReads),
      );
      expect(screen.getByText('job-1')).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: '已核实原任务，恢复检查' }),
      ).toBeNull();
      expect(window.localStorage.getItem(f.receiptKey)).toBe(originalReceipt);
      expect(f.posts()).toHaveLength(1);
    },
  );
  it('does not transfer a paused authorization budget to a replacement peer receipt', async () => {
    const f = await fixture('asin', true);
    await submitAndReceiveAck(f);
    const before = f.taskReads().length;
    f.rejectAllTaskAuthorization();
    await invalidateTask(f);
    await screen.findByRole('button', { name: '已核实原任务，恢复检查' });
    expect(f.taskReads()).toHaveLength(before + 2);
    f.allowTaskAuthorization();
    let peerRaw!: string;
    act(() => {
      peerRaw = f.installPeer();
    });
    await screen.findByText('job-2');
    await waitFor(() => expect(f.taskReads('job-2').length).toBeGreaterThan(0));
    expect(screen.queryByText('job-1')).toBeNull();
    expect(
      screen.queryByRole('button', { name: '已核实原任务，恢复检查' }),
    ).toBeNull();
    expect(window.localStorage.getItem(f.safetyKey)).toBe(peerRaw);
    expect(f.posts()).toHaveLength(1);
  });
  it('does not recreate a retired submission scope after verified owner change, loading and a late wire ACK', async () => {
    const f = await fixture('asin', true);
    const post = f.holdPost();
    fireEvent.click(
      (
        await screen.findAllByRole('checkbox', {
          name: `选择变体组 ${group.name}，ID ${JSON.stringify(group.id)}`,
        })
      )[0],
    );
    fireEvent.click(screen.getByRole('button', { name: '检查所选组' }));
    fireEvent.click(
      within(screen.getByRole('region', { name: '确认检查' })).getByRole(
        'button',
        {
          name: '确认提交检查',
        },
      ),
    );
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    const oldKey = [
      'catalog-check-accepted',
      'asin',
      'operator',
      'session-1',
      f.runtime.session.revision,
    ];
    expect(f.runtime.queryClient.getQueryData(oldKey)).toBeTruthy();
    const originalReceipt = window.localStorage.getItem(f.receiptKey);
    const next: CurrentUserData = {
      ...verifiedIdentity,
      user: { ...verifiedIdentity.user, id: 'other' },
    };
    f.setIdentity(next);
    await act(async () => {
      await f.identity.refresh();
    });
    await screen.findByText('已选 0 组');
    expect(f.runtime.queryClient.getQueryData(oldKey)).toBeUndefined();
    expect(f.posts()[0][1]?.signal?.aborted).toBe(true);

    const held = f.holdIdentity();
    let refresh!: ReturnType<IdentityStore['refresh']>;
    act(() => {
      refresh = f.identity.refresh();
    });
    await screen.findByText('正在验证登录状态…');
    await act(async () =>
      post.resolve(
        envelope({
          taskId: 'job-1',
          taskType: 'variant-group',
          status: 'pending',
        }),
      ),
    );
    expect(f.runtime.queryClient.getQueryData(oldKey)).toBeUndefined();
    await act(async () => {
      held.resolve(envelope(next));
      await refresh;
    });
    await screen.findByText('已选 0 组');
    f.setIdentity(verifiedIdentity);
    await act(async () => {
      await f.identity.refresh();
    });
    await screen.findByRole('button', { name: '已核实原任务，恢复检查' });
    expect(screen.queryByText('job-1')).toBeNull();
    expect(f.runtime.queryClient.getQueryData(oldKey)).toBeUndefined();
    expect(f.taskReads()).toHaveLength(0);
    expect(window.localStorage.getItem(f.receiptKey)).toBe(originalReceipt);
    expect(f.posts()).toHaveLength(1);
  });
  it.each(['asin', 'competitor'] as const)(
    'retains an accepted %s ID when identity unmounts before the lock promise returns',
    async (domain) => {
      const acknowledged = deferred<void>();
      const release = deferred<void>();
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
          request: async (_key: string, callback: () => unknown) => {
            const result = await callback();
            if (
              result &&
              typeof result === 'object' &&
              'kind' in result &&
              result.kind === 'task'
            ) {
              acknowledged.resolve();
              await release.promise;
            }
            return result;
          },
        },
      });
      const f = await fixture(domain, true);
      if (domain === 'asin') {
        fireEvent.click(
          (
            await screen.findAllByRole('checkbox', {
              name: `选择变体组 ${group.name}，ID ${JSON.stringify(group.id)}`,
            })
          )[0],
        );
        fireEvent.click(screen.getByRole('button', { name: '检查所选组' }));
      } else {
        fireEvent.click(
          (await screen.findAllByRole('button', { name: '查看 ASIN' }))[0],
        );
        fireEvent.click(
          (await screen.findAllByRole('button', { name: '立即检查' }))[0],
        );
      }
      fireEvent.click(
        within(screen.getByRole('region', { name: '确认检查' })).getByRole(
          'button',
          {
            name: '确认提交检查',
          },
        ),
      );
      await act(async () => acknowledged.promise);
      expectUnknownDurableReceipt(f);
      expect(screen.queryByText('job-1')).toBeNull();
      const held = f.holdIdentity();
      let refresh!: ReturnType<IdentityStore['refresh']>;
      act(() => {
        refresh = f.identity.refresh();
      });
      await screen.findByText('正在验证登录状态…');
      await act(async () => release.resolve());
      await act(async () => {
        held.resolve(envelope(verifiedIdentity));
        await refresh;
      });
      await screen.findByText('job-1');
      await waitFor(() => expect(f.taskReads().length).toBeGreaterThan(0));
      expect(f.posts()).toHaveLength(1);
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'retains the known %s ID after a real TaskApi 403 and same identity revalidation',
    async (domain) => {
      const f = await fixture(domain, true);
      await submitAndReceiveAck(f);
      expectUnknownDurableReceipt(f);
      const originalReceipt = window.localStorage.getItem(f.receiptKey);
      const before = f.taskReads().length;
      const held = f.holdIdentity();
      f.rejectNextTaskAuthorization();
      await invalidateTask(f);
      await screen.findByText('正在验证登录状态…');
      await act(async () => held.resolve(envelope(verifiedIdentity)));
      await screen.findByText('job-1');
      await waitFor(() =>
        expect(f.taskReads().length).toBeGreaterThan(before + 1),
      );
      expect(window.localStorage.getItem(f.receiptKey)).toBe(originalReceipt);
      expect(f.posts()).toHaveLength(1);
    },
  );

  it.each(['owner', 'session'] as const)(
    'retires the known ID when real TaskApi 403 revalidation confirms a changed %s',
    async (boundary) => {
      const f = await fixture('asin', true);
      await submitAndReceiveAck(f);
      expectUnknownDurableReceipt(f);
      const originalReceipt = window.localStorage.getItem(f.receiptKey);
      const before = f.taskReads().length;
      const held = f.holdIdentity();
      const next: CurrentUserData = {
        ...verifiedIdentity,
        user: {
          ...verifiedIdentity.user,
          id: boundary === 'owner' ? 'other' : verifiedIdentity.user.id,
        },
        sessionId:
          boundary === 'session' ? 'session-2' : verifiedIdentity.sessionId,
      };
      f.setIdentity(next);
      f.rejectNextTaskAuthorization();
      await invalidateTask(f);
      await screen.findByText('正在验证登录状态…');
      await act(async () => held.resolve(envelope(next)));
      await screen.findByText('已选 0 组');
      expect(screen.queryByText('job-1')).toBeNull();
      expect(f.taskReads()).toHaveLength(before + 1);
      expect(window.localStorage.getItem(f.receiptKey)).toBe(originalReceipt);
      expect(f.posts()).toHaveLength(1);
    },
  );
});
