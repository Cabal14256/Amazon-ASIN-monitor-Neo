// @vitest-environment jsdom
import type { CurrentUserData } from '@asin-monitor/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
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
import { importGateKey, writeImportGate } from '../asin/asin-import-gate';
import { ASIN_CATALOG } from '../asin/config';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import {
  catalogSafetyKey,
  readCatalogSafetyGate,
  writeCatalogSafetyGate,
  type CatalogBatchDeleteGate,
} from './catalog-safety-gate';
import { CatalogPage } from './index';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const owner = 'operator';
const sessionId = 'session-211';
const groupIds = ['Grüp-1', 'Case'];
const user: CurrentUserData = {
  user: {
    id: owner,
    username: 'fixture',
    status: 'ACTIVE',
    force_password_change: false,
  },
  sessionId,
  permissions: ['asin:read', 'asin:write', 'asin:delete'],
  roles: [],
  mustChangePassword: false,
  passwordExpired: false,
};
const configs = { asin: ASIN_CATALOG, competitor: COMPETITOR_CATALOG };
const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, work: () => unknown) => {
        const result = (tails.get(name) ?? Promise.resolve()).then(work);
        tails.set(
          name,
          result.catch(() => undefined),
        );
        return result;
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

async function fixture(domain: 'asin' | 'competitor') {
  const groupsPath =
    domain === 'asin'
      ? '/api/v1/variant-groups'
      : '/api/v1/competitor/variant-groups';
  const taskId = `delete-211-${domain}`;
  const peerTaskId = `delete-211-peer-${domain}`;
  const taskPath = `/api/v1/tasks/${taskId}`;
  const submission = deferred<Response>();
  let authResponse = async () => jsonResponse({ success: true, data: user });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/auth/current-user' && init?.method === 'GET')
      return authResponse();
    if (
      url.pathname === `${groupsPath}/batch-delete` &&
      init?.method === 'POST'
    )
      return submission.promise;
    if (
      [taskPath, `/api/v1/tasks/${peerTaskId}`].includes(url.pathname) &&
      init?.method === 'GET'
    )
      return jsonResponse({
        success: true,
        data: {
          taskId: url.pathname.split('/').at(-1),
          taskType: 'batch-delete',
          taskSubType:
            domain === 'asin'
              ? 'variant-group-delete'
              : 'competitor-variant-group-delete',
          title: '批量删除',
          status: 'processing',
          progress: 50,
          message: 'fixture',
          error: null,
          createdAt: null,
          updatedAt: null,
          startedAt: null,
          completedAt: null,
          cancelRequestedAt: null,
          cancelledAt: null,
          canCancel: false,
          filename: null,
          downloadUrl: null,
          result: null,
        },
      });
    if (url.pathname === groupsPath && init?.method === 'GET')
      return jsonResponse({
        success: true,
        data: {
          list: groupIds.map((id) => ({
            id,
            name: `Group ${id}`,
            country: 'US',
            site: 'amazon.com',
            brand: 'Fixture',
            children: [],
          })),
          total: groupIds.length,
          current: Number(url.searchParams.get('current') || 1),
          pageSize: 10,
        },
      });
    throw new Error(
      `Unexpected fixture request: ${init?.method} ${url.pathname}`,
    );
  });
  const runtime = createTransportRuntime({
    baseURL: '/api/',
    pageOrigin: 'https://app.test/',
    session: sessionFixture().store,
    socket: () => new FakeSocket(),
    fetch: fetcher,
  });
  runtime.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  const identity = new IdentityStore(runtime);
  const history = createMemoryHistory({
    initialEntries: [domain === 'asin' ? '/asin' : '/competitor-asin'],
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const catalogRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: domain === 'asin' ? '/asin' : '/competitor-asin',
    component: () => (
      <RouteGate>
        <CatalogPage config={configs[domain]} />
      </RouteGate>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([catalogRoute]),
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
    identity: user,
  });
  await router.load();
  render(
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return {
    runtime,
    identity,
    fetcher,
    taskId,
    peerTaskId,
    taskPath,
    groupsPath,
    accept: () =>
      submission.resolve(
        jsonResponse({
          success: true,
          data: {
            mode: 'async',
            taskId,
            status: 'pending',
            totalRequested: groupIds.length,
          },
        }),
      ),
    authResponse: (response: Promise<Response>) => {
      authResponse = () => response;
    },
    mutations: () =>
      fetcher.mock.calls.filter((call) => call[1]?.method === 'POST'),
    taskReads: () =>
      fetcher.mock.calls.filter(
        (call) => new URL(String(call[0])).pathname === taskPath,
      ),
  };
}

const domains = ['asin', 'competitor'] as const;
const cases = [
  ...domains.flatMap((domain) =>
    (['loading', 'error'] as const).flatMap((revalidation) =>
      (['before', 'during'] as const).map((ackTiming) => ({
        domain,
        revalidation,
        ackTiming,
        receiptStorage: 'unavailable' as const,
      })),
    ),
  ),
  ...domains.map((domain) => ({
    domain,
    revalidation: 'loading' as const,
    ackTiming: 'before' as const,
    receiptStorage: 'healthy' as const,
  })),
];

describe('bulk-delete receipt through real identity and route revalidation', () => {
  it.each(cases)(
    'retains the $domain known ACK arriving $ackTiming $revalidation with $receiptStorage receipt storage',
    async ({ domain, revalidation, ackTiming, receiptStorage }) => {
      const f = await fixture(domain);
      const revision = f.runtime.session.revision;
      const select = await screen.findByRole('button', {
        name: '选择本页可删除组',
      });
      await waitFor(() => expect(select).toHaveProperty('disabled', false));
      fireEvent.click(select);
      fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
      fireEvent.click(screen.getByRole('button', { name: '确认批量删除' }));
      await waitFor(() => expect(f.mutations()).toHaveLength(1));

      const [request, init] = f.mutations()[0]!;
      expect(new URL(String(request)).pathname).toBe(
        `${f.groupsPath}/batch-delete`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        groupIds,
        useAsync: true,
      });
      expect(init?.credentials).toBe('include');
      const claim = readCatalogSafetyGate(localStorage, owner, domain);
      expect(claim).toMatchObject({
        phase: 'batch-delete',
        state: 'unknown',
        groupIds,
        ownerScope: JSON.stringify([domain, owner, sessionId]),
      });
      if (claim?.phase !== 'batch-delete')
        throw new Error('Missing sent claim');
      expect(claim.taskId).toBeUndefined();
      const key = catalogSafetyKey(owner, domain);
      const bridgeKey = importGateKey(domain, owner);
      const originalGuard = localStorage.getItem(key);
      const originalBridge = localStorage.getItem(bridgeKey);
      expect(originalGuard).not.toBeNull();
      expect(originalBridge).not.toBeNull();

      // Claim succeeded before dispatch. Only the later receipt updates fail;
      // reads and the unrelated writable-storage probe still work normally.
      const failedWrites: { area: 'local' | 'session'; value: string }[] = [];
      const originalSetItem = Storage.prototype.setItem;
      const storageFault = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, name, value) {
          if (
            receiptStorage === 'unavailable' &&
            this === localStorage &&
            (name === key || name === bridgeKey)
          ) {
            failedWrites.push({ area: 'local', value });
            throw new DOMException(
              'Fixture quota exceeded',
              'QuotaExceededError',
            );
          }
          if (
            receiptStorage === 'unavailable' &&
            this === sessionStorage &&
            name === `${key}:batch-receipt`
          ) {
            failedWrites.push({ area: 'session', value });
            throw new DOMException(
              'Fixture quota exceeded',
              'QuotaExceededError',
            );
          }
          originalSetItem.call(this, name, value);
        });
      const expectAckConsumed = async () => {
        if (receiptStorage === 'unavailable') {
          await waitFor(() => {
            expect(failedWrites.some((write) => write.area === 'local')).toBe(
              true,
            );
            expect(
              failedWrites.some(
                (write) =>
                  write.area === 'session' && write.value.includes(f.taskId),
              ),
            ).toBe(true);
          });
          expect(localStorage.getItem(key)).toBe(originalGuard);
          expect(localStorage.getItem(bridgeKey)).toBe(originalBridge);
        } else {
          await waitFor(() =>
            expect(
              readCatalogSafetyGate(localStorage, owner, domain),
            ).toMatchObject({
              phase: 'batch-delete',
              operationId: claim.operationId,
              state: 'task',
              taskId: f.taskId,
              groupIds,
            }),
          );
          expect(failedWrites).toHaveLength(0);
        }
        expect(sessionStorage.getItem(`${key}:batch-receipt`)).toBeNull();
        expect(f.mutations()).toHaveLength(1);
      };
      if (ackTiming === 'before') {
        await act(async () => f.accept());
        await expectAckConsumed();
        await screen.findByText(`任务 ID：${f.taskId}`);
        if (receiptStorage === 'unavailable')
          expect(screen.getByText(/任务回执未能保存到本地/)).toBeTruthy();
      }

      const verificationResponse = deferred<Response>();
      f.authResponse(verificationResponse.promise);
      let verification = Promise.resolve(f.identity.getSnapshot());
      act(() => {
        verification = f.identity.refresh();
      });
      await screen.findByText('正在验证登录状态…');
      expect(screen.queryByText(`任务 ID：${f.taskId}`)).toBeNull();
      expect(screen.queryAllByText(`Group ${groupIds[0]}`)).toHaveLength(0);
      expect(
        screen.queryByRole('button', { name: '选择本页可删除组' }),
      ).toBeNull();
      if (ackTiming === 'during') {
        // This real HTTP request survives a same-session identity refresh.
        // The fixture does not bypass an aborted transport signal.
        expect(init?.signal?.aborted).toBe(false);
        await act(async () => f.accept());
        await expectAckConsumed();
        expect(screen.queryByText(`任务 ID：${f.taskId}`)).toBeNull();
      }

      if (revalidation === 'error') {
        await act(async () => {
          verificationResponse.reject(new Error('Fixture identity offline'));
          await verification;
        });
        await screen.findByRole('heading', { name: '暂时无法验证登录状态' });
        expect(screen.queryByText(`任务 ID：${f.taskId}`)).toBeNull();
        expect(screen.queryAllByText(`Group ${groupIds[0]}`)).toHaveLength(0);
        const retryResponse = deferred<Response>();
        f.authResponse(retryResponse.promise);
        fireEvent.click(screen.getByRole('button', { name: '重试' }));
        await screen.findByText('正在验证登录状态…');
        storageFault.mockRestore();
        await act(async () => {
          retryResponse.resolve(jsonResponse({ success: true, data: user }));
          await f.identity.refresh();
        });
      } else {
        storageFault.mockRestore();
        await act(async () => {
          verificationResponse.resolve(
            jsonResponse({ success: true, data: user }),
          );
          await verification;
        });
      }

      expect(f.identity.getSnapshot()).toEqual({
        status: 'authenticated',
        identity: user,
      });
      expect(f.runtime.session.revision).toBe(revision);
      expect(
        f.fetcher.mock.calls.filter(
          (call) =>
            new URL(String(call[0])).pathname === '/api/v1/auth/current-user' &&
            call[1]?.method === 'GET',
        ),
      ).toHaveLength(revalidation === 'error' ? 3 : 2);
      await screen.findByText(`任务 ID：${f.taskId}`);
      expect(screen.getByText(`原操作：${claim.operationId}`)).toBeTruthy();
      for (const id of groupIds)
        expect(
          screen.getByText(`原始组 ID：${JSON.stringify(id)}`),
        ).toBeTruthy();
      const selectAgain = screen.queryByRole('button', {
        name: '选择本页可删除组',
      });
      expect(!selectAgain || (selectAgain as HTMLButtonElement).disabled).toBe(
        true,
      );

      const readsBeforeRecovery = f.taskReads().length;
      fireEvent.click(
        screen.getByRole('button', { name: '查询任务并重读目录' }),
      );
      await waitFor(() =>
        expect(f.taskReads().length).toBeGreaterThan(readsBeforeRecovery),
      );
      await screen.findByText(/删除任务仍在执行（processing）/);
      expect(screen.getByText(`任务 ID：${f.taskId}`)).toBeTruthy();
      expect(screen.getByText(`原操作：${claim.operationId}`)).toBeTruthy();
      expect(f.mutations()).toHaveLength(1);
      expect(readCatalogSafetyGate(localStorage, owner, domain)).toMatchObject({
        phase: 'batch-delete',
        operationId: claim.operationId,
        submittedAt: claim.submittedAt,
        ownerScope: claim.ownerScope,
        groupIds,
      });
      expect(localStorage.getItem(bridgeKey)).not.toBeNull();
      expect(f.taskReads().every((call) => call[1]?.method === 'GET')).toBe(
        true,
      );
      expect(
        f.fetcher.mock.calls.every(
          (call) => !new URL(String(call[0])).pathname.includes('/api/api/'),
        ),
      ).toBe(true);
    },
  );
});

async function dispatchDeletion(f: Awaited<ReturnType<typeof fixture>>) {
  const select = await screen.findByRole('button', {
    name: '选择本页可删除组',
  });
  await waitFor(() => expect(select).toHaveProperty('disabled', false));
  fireEvent.click(select);
  fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
  fireEvent.click(screen.getByRole('button', { name: '确认批量删除' }));
  await waitFor(() => expect(f.mutations()).toHaveLength(1));
  expect(JSON.parse(String(f.mutations()[0]![1]?.body))).toEqual({
    groupIds,
    useAsync: true,
  });
}

function failReceiptUpdates(domain: 'asin' | 'competitor') {
  const key = catalogSafetyKey(owner, domain);
  const bridgeKey = importGateKey(domain, owner);
  const original = Storage.prototype.setItem;
  return vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(function (this: Storage, name, value) {
      if (
        (this === localStorage && (name === key || name === bridgeKey)) ||
        (this === sessionStorage && name === `${key}:batch-receipt`)
      )
        throw new DOMException('Fixture quota exceeded', 'QuotaExceededError');
      original.call(this, name, value);
    });
}

const peerChanges = [
  'operation',
  'ids-order',
  'submitted-at',
  'session-scope',
  'unknown-field',
  'new-task',
] as const;
const peerCases = domains.flatMap((domain) =>
  peerChanges.flatMap((change) =>
    (['before', 'during', 'active'] as const).map((ackTiming) => ({
      domain,
      change,
      ackTiming,
    })),
  ),
);

describe('bulk-delete known ACK immutable peer and identity boundaries', () => {
  it.each(peerCases)(
    'keeps the $domain peer $change ahead of an ACK arriving $ackTiming revalidation',
    async ({ domain, change, ackTiming }) => {
      const f = await fixture(domain);
      const http = vi.spyOn(f.runtime.http, 'request');
      await dispatchDeletion(f);
      const requestIndex = http.mock.calls.findIndex(
        (call) => call[0] === `${f.groupsPath}/batch-delete`,
      );
      const acceptedResponse = http.mock.results[requestIndex]!.value;
      const claim = readCatalogSafetyGate(localStorage, owner, domain);
      if (claim?.phase !== 'batch-delete') throw new Error('Missing claim');
      const fault = failReceiptUpdates(domain);
      if (ackTiming === 'before') {
        await act(async () => {
          f.accept();
          await acceptedResponse;
        });
        await screen.findByText(`任务 ID：${f.taskId}`);
      }
      const response = deferred<Response>();
      f.authResponse(response.promise);
      let verification = Promise.resolve(f.identity.getSnapshot());
      if (ackTiming !== 'active') {
        act(() => {
          verification = f.identity.refresh();
        });
        await screen.findByText('正在验证登录状态…');
        expect(screen.queryByText(`任务 ID：${f.taskId}`)).toBeNull();
      }
      fault.mockRestore();
      const peer: CatalogBatchDeleteGate = {
        ...claim,
        ...(change === 'operation'
          ? { operationId: 'peer-operation-211' }
          : {}),
        ...(change === 'ids-order'
          ? { groupIds: [...claim.groupIds].reverse() }
          : {}),
        ...(change === 'submitted-at'
          ? { submittedAt: claim.submittedAt + 1 }
          : {}),
        ...(change === 'session-scope'
          ? { ownerScope: JSON.stringify([domain, owner, 'peer-session']) }
          : {}),
        ...(change === 'unknown-field'
          ? { futureBinding: 'peer-generation' }
          : {}),
        ...(change === 'new-task'
          ? { state: 'task', taskId: f.peerTaskId }
          : {}),
      };
      expect(writeCatalogSafetyGate(localStorage, owner, domain, peer)).toBe(
        true,
      );
      expect(
        writeImportGate(localStorage, domain, owner, {
          phase: 'uncertain',
          taskId: null,
          savedAt: peer.submittedAt,
          operationId: peer.operationId,
          catalogOperation: 'batch-delete',
        }),
      ).toBe(true);
      const guardRaw = localStorage.getItem(catalogSafetyKey(owner, domain));
      const bridgeRaw = localStorage.getItem(importGateKey(domain, owner));
      const originalReads = f.taskReads().length;
      if (ackTiming !== 'before') {
        expect(f.mutations()[0]![1]?.signal?.aborted).toBe(false);
        await act(async () => {
          f.accept();
          expect(await acceptedResponse).toMatchObject({
            success: true,
            data: { mode: 'async', taskId: f.taskId },
          });
        });
      }
      if (ackTiming !== 'active')
        await act(async () => {
          response.resolve(jsonResponse({ success: true, data: user }));
          await verification;
        });
      await screen.findByRole('alert', { name: '批量删除结果待核实' });
      expect(screen.queryByText(`任务 ID：${f.taskId}`)).toBeNull();
      if (change === 'new-task')
        await screen.findByText(`任务 ID：${f.peerTaskId}`);
      expect(f.taskReads()).toHaveLength(originalReads);
      expect(localStorage.getItem(catalogSafetyKey(owner, domain))).toBe(
        guardRaw,
      );
      expect(localStorage.getItem(importGateKey(domain, owner))).toBe(
        bridgeRaw,
      );
      expect(f.mutations()).toHaveLength(1);
      const select = screen.queryByRole('button', { name: '选择本页可删除组' });
      expect(!select || (select as HTMLButtonElement).disabled).toBe(true);
    },
  );

  it.each(domains)(
    'keeps the %s known receipt when locked recovery cannot save either receipt store',
    async (domain) => {
      const f = await fixture(domain);
      await dispatchDeletion(f);
      const claim = readCatalogSafetyGate(localStorage, owner, domain);
      if (claim?.phase !== 'batch-delete') throw new Error('Missing claim');
      const key = catalogSafetyKey(owner, domain);
      const bridgeKey = importGateKey(domain, owner);
      const guardRaw = localStorage.getItem(key);
      const bridgeRaw = localStorage.getItem(bridgeKey);
      const fault = failReceiptUpdates(domain);
      await act(async () => f.accept());
      await screen.findByText(`任务 ID：${f.taskId}`);
      const response = deferred<Response>();
      f.authResponse(response.promise);
      act(() => {
        void f.identity.refresh();
      });
      await screen.findByText('正在验证登录状态…');
      await act(async () => {
        response.resolve(jsonResponse({ success: true, data: user }));
        await f.identity.refresh();
      });
      await screen.findByText(`任务 ID：${f.taskId}`);
      await screen.findByText(/任务状态：processing/);
      const reads = f.taskReads().length;
      fireEvent.click(
        screen.getByRole('button', { name: '查询任务并重读目录' }),
      );
      await screen.findByText(/已知删除回执无法保存到本地/);
      expect(screen.getByText(`任务 ID：${f.taskId}`)).toBeTruthy();
      expect(screen.getByText(`原操作：${claim.operationId}`)).toBeTruthy();
      expect(f.taskReads()).toHaveLength(reads);
      expect(f.mutations()).toHaveLength(1);
      expect(localStorage.getItem(key)).toBe(guardRaw);
      expect(localStorage.getItem(bridgeKey)).toBe(bridgeRaw);
      fault.mockRestore();
      fireEvent.click(
        screen.getByRole('button', { name: '查询任务并重读目录' }),
      );
      await screen.findByText(/删除任务仍在执行（processing）/);
      expect(f.taskReads().length).toBeGreaterThan(reads);
      expect(f.mutations()).toHaveLength(1);
      expect(readCatalogSafetyGate(localStorage, owner, domain)).toMatchObject({
        phase: 'batch-delete',
        state: 'task',
        taskId: f.taskId,
        operationId: claim.operationId,
        groupIds,
        submittedAt: claim.submittedAt,
        ownerScope: claim.ownerScope,
      });
      expect(localStorage.getItem(bridgeKey)).toBe(bridgeRaw);
    },
  );

  it.each(
    domains.flatMap((domain) =>
      (['owner', 'session', 'revision'] as const).map((change) => ({
        domain,
        change,
      })),
    ),
  )(
    'retires the $domain memory-only ACK after a real $change replacement',
    async ({ domain, change }) => {
      const f = await fixture(domain);
      await dispatchDeletion(f);
      const claim = readCatalogSafetyGate(localStorage, owner, domain);
      if (claim?.phase !== 'batch-delete') throw new Error('Missing claim');
      const guardRaw = localStorage.getItem(catalogSafetyKey(owner, domain));
      const fault = failReceiptUpdates(domain);
      const response = deferred<Response>();
      f.authResponse(response.promise);
      act(() => {
        void f.identity.refresh();
      });
      await screen.findByText('正在验证登录状态…');
      await act(async () => f.accept());
      await waitFor(() =>
        expect(
          f.runtime.queryClient.getQueryData([
            'catalog-write-safety',
            owner,
            domain,
          ]),
        ).toMatchObject({
          phase: 'batch-delete',
          state: 'task',
          taskId: f.taskId,
          operationId: claim.operationId,
        }),
      );
      expect(screen.queryByText(`任务 ID：${f.taskId}`)).toBeNull();
      fault.mockRestore();
      const replacement =
        change === 'owner'
          ? { ...user, user: { ...user.user, id: 'replacement-owner' } }
          : change === 'session'
          ? { ...user, sessionId: 'replacement-session' }
          : user;
      if (change === 'revision')
        act(() => {
          f.runtime.refreshSession();
        });
      await act(async () => {
        response.resolve(jsonResponse({ success: true, data: replacement }));
        await f.identity.refresh();
      });
      expect(f.identity.getSnapshot()).toEqual({
        status: 'authenticated',
        identity: replacement,
      });
      expect(screen.queryByText(`任务 ID：${f.taskId}`)).toBeNull();
      expect(f.taskReads()).toHaveLength(0);
      expect(localStorage.getItem(catalogSafetyKey(owner, domain))).toBe(
        guardRaw,
      );

      // Returning to the original identity cannot resurrect a retired memory ACK.
      const returned = deferred<Response>();
      f.authResponse(returned.promise);
      act(() => {
        void f.identity.refresh();
      });
      await screen.findByText('正在验证登录状态…');
      await act(async () => {
        returned.resolve(jsonResponse({ success: true, data: user }));
        await f.identity.refresh();
      });
      await screen.findByRole('alert', { name: '批量删除结果待核实' });
      expect(screen.queryByText(`任务 ID：${f.taskId}`)).toBeNull();
      expect(f.taskReads()).toHaveLength(0);
      expect(f.mutations()).toHaveLength(1);
      expect(readCatalogSafetyGate(localStorage, owner, domain)).toEqual(claim);
    },
  );
});
