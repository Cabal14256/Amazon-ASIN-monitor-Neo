// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
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
import type { RouteAuthState } from '../../auth/navigation';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { taskKeys } from '../../services/task-queries';
import { importGateKey, writeImportGate } from '../asin/asin-import-gate';
import { AsinImportPanel } from '../asin/asin-import-panel';
import { ASIN_CATALOG } from '../asin/config';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { writeImportCatalogSafety } from './catalog-operation-lock';
import { catalogSafetyKey } from './catalog-safety-gate';
import { writeImportGate as writeMainImport } from './fixtures/main-197-asin-import-gate';
import { CatalogPage } from './index';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
const configs = { asin: ASIN_CATALOG, competitor: COMPETITOR_CATALOG };
const group = (id: string) => ({
  id,
  name: `Group ${id}`,
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  children: [],
});
const counts = {
  mode: 'sync',
  totalRequested: 2,
  deletedGroupCount: 1,
  deletedDirectAsinCount: 0,
  deletedNestedAsinCount: 3,
  skipped: { groupIds: ['missing'], asinIds: [] },
};
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
beforeEach(() => {
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
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  localStorage.clear();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks();
});
function fixture(
  domain: 'asin' | 'competitor',
  options: {
    base?: string;
    ids?: string[];
    permissions?: string[];
    response?: () => Promise<Response>;
    taskStatus?: string;
    listFailureAfterDelete?: boolean;
    withImport?: boolean;
    importResponse?: () => Promise<Response>;
  } = {},
) {
  let submitted = false;
  let taskStatus = options.taskStatus ?? 'processing';
  let listFailure = options.listFailureAfterDelete ?? false;
  let ids = options.ids ?? ['Grüp-1', 'missing'];
  let listResponse: (() => Promise<Response>) | undefined;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') {
      if (url.pathname.endsWith('/import-excel'))
        return options.importResponse!();
      submitted = true;
      return options.response
        ? options.response()
        : jsonResponse({ success: true, data: counts });
    }
    if (url.pathname.includes('/tasks/'))
      return jsonResponse({
        success: true,
        data: {
          taskId: url.pathname.split('/').at(-1),
          taskType: url.pathname.endsWith('/task-1')
            ? 'batch-delete'
            : 'import',
          taskSubType:
            domain === 'asin'
              ? 'variant-group-delete'
              : 'competitor-variant-group-delete',
          title: '批量删除',
          status: taskStatus,
          progress: taskStatus === 'completed' ? 100 : 50,
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
          result:
            taskStatus === 'completed'
              ? { ...counts, mode: 'async', failedCount: 0 }
              : null,
        },
      });
    if (listResponse) return listResponse();
    if (submitted && listFailure) throw new Error('list offline');
    return jsonResponse({
      success: true,
      data: {
        list: ids.map(group),
        total: 21,
        current: Number(url.searchParams.get('current') || 1),
        pageSize: 10,
      },
    });
  });
  const runtime = createTransportRuntime({
    baseURL: options.base ?? '/api/',
    pageOrigin: 'https://app.test/',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  runtime.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  runtimes.push(runtime);
  let state: RouteAuthState = {
    status: 'authenticated',
    identity: {
      user: {
        id: 'operator',
        username: 'operator',
        status: 'ACTIVE',
        force_password_change: false,
      },
      sessionId: 'session-1',
      roles: [],
      permissions: options.permissions ?? [
        'asin:read',
        'asin:write',
        'asin:delete',
      ],
      mustChangePassword: false,
      passwordExpired: false,
    },
  };
  const listeners = new Set<() => void>();
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: async () => state,
  } as unknown as IdentityStore;
  const element = () => (
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <CatalogPage
          config={configs[domain]}
          extra={options.withImport && <AsinImportPanel domain={domain} />}
        />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  let view = render(element());
  return {
    fetcher,
    runtime,
    setIds: (next: string[]) => {
      ids = next;
    },
    setListResponse: (next: (() => Promise<Response>) | undefined) => {
      listResponse = next;
    },
    setTaskStatus: (status: string) => {
      taskStatus = status;
    },
    recoverList: () => {
      listFailure = false;
    },
    setIdentity: (
      permissions: string[],
      owner = 'operator',
      sessionId = 'session-1',
      mustChangePassword = false,
    ) => {
      if (state.status !== 'authenticated') throw new Error('fixture');
      state = {
        ...state,
        identity: {
          ...state.identity,
          user: { ...state.identity.user, id: owner },
          permissions,
          sessionId,
          mustChangePassword,
        },
      };
      for (const listener of listeners) listener();
    },
    unmount: () => view.unmount(),
    remount: () => {
      view = render(element());
    },
  };
}
async function selectAll() {
  const select = await screen.findByRole('button', {
    name: '选择本页可删除组',
  });
  await waitFor(() => expect(select).toHaveProperty('disabled', false));
  fireEvent.click(select);
}
async function confirm() {
  await selectAll();
  fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
  fireEvent.click(screen.getByRole('button', { name: '确认批量删除' }));
}
const mutations = (f: ReturnType<typeof fixture>) =>
  f.fetcher.mock.calls.filter((call) => call[1]?.method === 'POST');
function expectSelectionBlocked() {
  const button = screen.queryByRole('button', { name: '选择本页可删除组' });
  expect(!button || (button as HTMLButtonElement).disabled).toBe(true);
}

describe('mounted primary and competitor bulk-delete real HTTP transport', () => {
  it.each(['asin', 'competitor'] as const)(
    'rolls back a %s pre-dispatch import bridge when the larger catalog envelope hits quota',
    async (domain) => {
      const f = fixture(domain, { permissions: ['asin:read', 'asin:delete'] });
      await selectAll();
      const original = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key,
        value,
      ) {
        if (
          this === localStorage &&
          key === catalogSafetyKey('operator', domain)
        )
          throw new DOMException('quota', 'QuotaExceededError');
        return original.call(this, key, value);
      });
      fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
      fireEvent.click(screen.getByRole('button', { name: '确认批量删除' }));
      await screen.findByText(/尚未发送请求/);
      expect(mutations(f)).toHaveLength(0);
      expect(
        localStorage.getItem(importGateKey(domain, 'operator')),
      ).toBeNull();
      expect(
        sessionStorage.getItem(
          `${catalogSafetyKey('operator', domain)}:batch-receipt`,
        ),
      ).toBeNull();
      vi.restoreAllMocks();
      f.unmount();
      f.remount();
      await selectAll();
      expect(
        screen.getByRole('button', { name: '选择本页可删除组' }),
      ).toHaveProperty('disabled', false);
    },
  );
  it.each(['asin', 'competitor'] as const)(
    'retains both %s import guards across failed manual reread and reload',
    async (domain) => {
      const gate = {
        phase: 'uncertain' as const,
        taskId: null,
        savedAt: 1,
        operationId: 'original-import',
      };
      writeImportGate(localStorage, domain, 'operator', gate);
      writeImportCatalogSafety(localStorage, 'operator', domain, gate, gate);
      const f = fixture(domain, { withImport: true });
      await screen.findByRole('button', { name: '已核实原任务，允许重新导入' });
      f.setListResponse(async () => {
        throw new Error('offline');
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: '已核实原任务，允许重新导入' }),
        );
      });
      expect(
        localStorage.getItem(importGateKey(domain, 'operator')),
      ).not.toBeNull();
      expect(
        localStorage.getItem(catalogSafetyKey('operator', domain)),
      ).not.toBeNull();
      f.unmount();
      f.remount();
      await screen.findByRole('button', { name: '已核实原任务，允许重新导入' });
      expectSelectionBlocked();
      expect(mutations(f)).toHaveLength(0);
    },
  );
  it.each(['asin', 'competitor'] as const)(
    'keeps %s deletion safety when reconciliation query A changes to B while GET is pending',
    async (domain) => {
      const f = fixture(domain);
      await screen.findAllByText('Group Grüp-1');
      const pending = deferred<Response>();
      let reads = 0;
      f.setListResponse(async () =>
        ++reads === 1
          ? pending.promise
          : jsonResponse({
              success: true,
              data: {
                list: [group('query-B')],
                total: 21,
                current: 2,
                pageSize: 10,
              },
            }),
      );
      await confirm();
      await waitFor(() => expect(reads).toBe(1));
      fireEvent.click(screen.getByRole('button', { name: '下一页' }));
      await screen.findAllByText('Group query-B');
      await act(async () => {
        pending.resolve(
          jsonResponse({
            success: true,
            data: {
              list: [group('query-A')],
              total: 21,
              current: 1,
              pageSize: 10,
            },
          }),
        );
      });
      expect(
        localStorage.getItem(catalogSafetyKey('operator', domain)),
      ).not.toBeNull();
      expectSelectionBlocked();
      expect(mutations(f)).toHaveLength(1);
    },
  );
  it.each(['asin', 'competitor'] as const)(
    'recovers a known %s import receipt from its shared envelope after an old tab clears only the original import key',
    async (domain) => {
      const taskId = 'b2b5894c-5802-4c9f-a1bd-9a20263d270a';
      const f = fixture(domain, {
        withImport: true,
        importResponse: async () =>
          jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
      });
      await screen.findAllByText('Group Grüp-1');
      fireEvent.click(screen.getByRole('button', { name: '导入 CSV / XLSX' }));
      const file = new File(['变体组名称,国家\nGroup,US'], 'fixture.csv');
      fireEvent.change(screen.getByLabelText('选择文件'), {
        target: { files: { length: 1, item: () => file } },
      });
      fireEvent.click(
        screen.getByRole('button', { name: '上传并创建导入任务' }),
      );
      await screen.findByText(`任务编号：${taskId}`);
      f.unmount();
      expect(writeMainImport(localStorage, domain, 'operator', null)).toBe(
        true,
      );
      f.remount();
      await screen.findByText(`任务编号：${taskId}`);
      expectSelectionBlocked();
      f.setTaskStatus('completed');
      await act(async () => {
        await f.runtime.queryClient.invalidateQueries({
          queryKey: taskKeys.detail(taskId),
          exact: true,
        });
      });
      await screen.findByText(
        '导入任务已完成，请核对任务中心的成功、失败行与报告。',
      );
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: '选择本页可删除组' }),
        ).toHaveProperty('disabled', false),
      );
      expect(
        localStorage.getItem(catalogSafetyKey('operator', domain)),
      ).toBeNull();
      expect(mutations(f)).toHaveLength(1);
    },
  );
  it.each(['asin', 'competitor'] as const)(
    'retains a removed %s peer import gate until actual fresh rows load and provides a GET-only retry',
    async (domain) => {
      const f = fixture(domain);
      await screen.findAllByText('Group Grüp-1');
      const key = importGateKey(domain, 'operator');
      act(() => {
        localStorage.setItem(
          key,
          JSON.stringify({
            phase: 'accepted',
            taskId: 'b2b5894c-5802-4c9f-a1bd-9a20263d270a',
            savedAt: 100,
          }),
        );
        window.dispatchEvent(
          new StorageEvent('storage', { key, storageArea: localStorage }),
        );
      });
      await waitFor(expectSelectionBlocked);
      const read = deferred<Response>();
      f.setListResponse(() => read.promise);
      act(() => {
        localStorage.removeItem(key);
        window.dispatchEvent(
          new StorageEvent('storage', { key, storageArea: localStorage }),
        );
      });
      expectSelectionBlocked();
      await act(async () => read.reject(new Error('peer import read offline')));
      await screen.findByText(/目录重读失败，操作保护仍保留/);
      expectSelectionBlocked();
      f.setListResponse(undefined);
      f.setIds(['new-imported']);
      fireEvent.click(
        screen.getByRole('button', {
          name: '重读目录并核实导入保护（不提交）',
        }),
      );
      await screen.findAllByText('Group new-imported');
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: '选择本页可删除组' }),
        ).toHaveProperty('disabled', false),
      );
      expect(screen.queryByText('Group Grüp-1')).toBeNull();
      expect(mutations(f)).toHaveLength(0);
    },
  );
  it.each(['asin', 'competitor'] as const)(
    'rereads stale %s peer rows before unlocking a removed bulk-delete claim and remains guarded on read failure',
    async (domain) => {
      const f = fixture(domain);
      await screen.findAllByText('Group Grüp-1');
      const key = catalogSafetyKey('operator', domain);
      const peer = {
        phase: 'batch-delete',
        operationId: 'peer-delete',
        groupIds: ['Grüp-1'],
        submittedAt: 100,
        state: 'task',
        taskId: 'task-1',
      };
      act(() => {
        localStorage.setItem(key, JSON.stringify(peer));
        window.dispatchEvent(
          new StorageEvent('storage', { key, storageArea: localStorage }),
        );
      });
      await screen.findByRole('heading', {
        name: '批量删除任务已受理，等待核实结果',
      });
      const read = deferred<Response>();
      f.setListResponse(() => read.promise);
      act(() => {
        localStorage.removeItem(key);
        window.dispatchEvent(
          new StorageEvent('storage', { key, storageArea: localStorage }),
        );
      });
      expectSelectionBlocked();
      await act(async () => read.reject(new Error('peer reread offline')));
      expectSelectionBlocked();
      expect(
        f.runtime.queryClient.getQueryData([
          'catalog-write-safety',
          'operator',
          domain,
        ]),
      ).toEqual(peer);
      f.setListResponse(undefined);
      f.setIds(['missing']);
      fireEvent.click(
        screen.getByRole('button', { name: '查询任务并重读目录' }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: '选择本页可删除组' }),
        ).toHaveProperty('disabled', false),
      );
      expect(screen.queryByText('Group Grüp-1')).toBeNull();
      expect(mutations(f)).toHaveLength(0);
    },
  );

  it.each(
    (['asin', 'competitor'] as const).flatMap((domain) =>
      (['import', 'delete'] as const).flatMap((first) =>
        (['accepted', 'unknown'] as const).map((outcome) => ({
          domain,
          first,
          outcome,
        })),
      ),
    ),
  )(
    'serializes queued $domain $first before the other mutation and keeps $outcome exclusion after ACK and remount',
    async ({ domain, first, outcome }) => {
      const barrier = deferred<void>();
      const response = deferred<Response>();
      const tails = new Map<string, Promise<unknown>>();
      const lock = vi.fn((name: string, work: () => unknown) => {
        const result = (tails.get(name) ?? barrier.promise).then(work);
        tails.set(
          name,
          result.catch(() => undefined),
        );
        return result;
      });
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: lock },
      });
      const f = fixture(domain, {
        withImport: true,
        response: first === 'delete' ? () => response.promise : undefined,
        importResponse:
          first === 'import'
            ? () => response.promise
            : async () =>
                jsonResponse({
                  success: true,
                  data: {
                    taskId: 'b2b5894c-5802-4c9f-a1bd-9a20263d270a',
                    status: 'pending',
                  },
                }),
      });
      await selectAll();
      fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
      fireEvent.click(screen.getByRole('button', { name: '导入 CSV / XLSX' }));
      const file = new File(['变体组名称,国家\nGroup,US'], 'fixture.csv');
      fireEvent.change(screen.getByLabelText('选择文件'), {
        target: { files: { length: 1, item: () => file } },
      });
      const submitImport = () =>
        fireEvent.click(
          screen.getByRole('button', { name: '上传并创建导入任务' }),
        );
      const submitDelete = () =>
        fireEvent.click(screen.getByRole('button', { name: '确认批量删除' }));
      if (first === 'import') {
        submitImport();
        submitDelete();
      } else {
        submitDelete();
        submitImport();
      }
      expect(lock.mock.calls.map(([name]) => name)).toEqual([
        catalogSafetyKey('operator', domain),
        catalogSafetyKey('operator', domain),
      ]);
      expect(mutations(f)).toHaveLength(0);
      await act(async () => barrier.resolve());
      await waitFor(() => expect(mutations(f)).toHaveLength(1));
      expect(String(mutations(f)[0][0])).toContain(
        first === 'import' ? '/import-excel' : '/batch-delete',
      );
      await act(async () => {
        if (outcome === 'unknown') response.reject(new Error('response lost'));
        else
          response.resolve(
            jsonResponse({
              success: true,
              data:
                first === 'import'
                  ? {
                      taskId: 'b2b5894c-5802-4c9f-a1bd-9a20263d270a',
                      status: 'pending',
                    }
                  : {
                      mode: 'async',
                      taskId: 'task-1',
                      status: 'pending',
                      totalRequested: 2,
                    },
            }),
          );
      });
      await act(async () => {
        const settled = await Promise.allSettled(
          lock.mock.results.map(({ value }) => value),
        );
        const rejected = settled.filter(
          (result) => result.status === 'rejected',
        );
        expect(rejected).toHaveLength(0);
        if (first === 'import')
          expect(
            settled.some(
              (result) =>
                result.status === 'fulfilled' && result.value?.kind === 'stale',
            ),
          ).toBe(true);
      });
      const key =
        first === 'import'
          ? importGateKey(domain, 'operator')
          : catalogSafetyKey('operator', domain);
      expect(localStorage.getItem(key)).toContain(
        outcome === 'unknown'
          ? first === 'import'
            ? 'uncertain'
            : 'unknown'
          : first === 'import'
          ? 'accepted'
          : 'task',
      );
      f.unmount();
      f.remount();
      await screen.findAllByText('Group Grüp-1');
      expectSelectionBlocked();
      if (first === 'delete') {
        fireEvent.click(
          screen.getByRole('button', { name: '导入 CSV / XLSX' }),
        );
        expect(screen.getByLabelText('选择文件')).toHaveProperty(
          'disabled',
          true,
        );
      }
      expect(mutations(f)).toHaveLength(1);
    },
  );

  it('retains original-session unknown deletion protection after explicit GET-only recovery until manual audit', async () => {
    const f = fixture('asin', {
      response: async () => {
        throw new Error('response lost');
      },
    });
    await confirm();
    await screen.findByRole('heading', { name: '批量删除提交结果未知' });
    act(() =>
      f.setIdentity(['asin:read', 'asin:delete'], 'operator', 'session-2'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: '恢复原会话删除回执（不提交）' }),
    );
    await screen.findByRole('heading', { name: '批量删除提交结果未知' });
    fireEvent.click(screen.getByRole('button', { name: '重读目录核对结果' }));
    await screen.findByText(/读取目录不能证明/);
    expect(
      localStorage.getItem(catalogSafetyKey('operator', 'asin')),
    ).toContain('unknown');
    expect(mutations(f)).toHaveLength(1);
  });
  it.each(['asin', 'competitor'] as const)(
    'requires explicit same-user original-session %s task recovery and never republishes a late original receipt',
    async (domain) => {
      const response = deferred<Response>();
      const f = fixture(domain, { response: () => response.promise });
      await confirm();
      await waitFor(() => expect(mutations(f)).toHaveLength(1));
      act(() =>
        f.setIdentity(['asin:read', 'asin:delete'], 'operator', 'session-2'),
      );
      await act(async () =>
        response.resolve(
          jsonResponse({
            success: true,
            data: {
              mode: 'async',
              taskId: 'task-1',
              status: 'pending',
              totalRequested: 2,
            },
          }),
        ),
      );
      expect(screen.queryByText('任务 ID：task-1')).toBeNull();
      expect(
        f.fetcher.mock.calls.some(([url]) =>
          String(url).includes('/tasks/task-1'),
        ),
      ).toBe(false);
      fireEvent.click(
        screen.getByRole('button', { name: '恢复原会话删除回执（不提交）' }),
      );
      await screen.findByText('任务 ID：task-1');
      expect(screen.getByText(/已显式恢复同一用户原会话/)).toBeTruthy();
      expect(
        localStorage.getItem(catalogSafetyKey('operator', domain)),
      ).toContain('task-1');
      f.setTaskStatus('completed');
      fireEvent.click(
        screen.getByRole('button', { name: '查询任务并重读目录' }),
      );
      await waitFor(() =>
        expect(
          localStorage.getItem(catalogSafetyKey('operator', domain)),
        ).toBeNull(),
      );
      expect(mutations(f)).toHaveLength(1);
    },
  );

  it.each([
    { permissions: ['asin:read'], mustChangePassword: false },
    { permissions: ['asin:read', 'asin:delete'], mustChangePassword: true },
  ])(
    'keeps original-session deletion receipt recovery disabled without delete permission or completed password policy ($mustChangePassword)',
    async ({ permissions, mustChangePassword }) => {
      const f = fixture('asin', { listFailureAfterDelete: true });
      await confirm();
      await screen.findByText(/核实失败，删除保护仍保留/);
      act(() =>
        f.setIdentity(permissions, 'operator', 'session-2', mustChangePassword),
      );
      const button = screen.getByRole('button', {
        name: '恢复原会话删除回执（不提交）',
      });
      expect(button).toHaveProperty('disabled', true);
      fireEvent.click(button);
      expect(screen.queryByText(/实际删除变体组 1 个/)).toBeNull();
      expect(mutations(f)).toHaveLength(1);
      expect(
        localStorage.getItem(catalogSafetyKey('operator', 'asin')),
      ).not.toBeNull();
    },
  );

  it('cancels a queued original-session receipt recovery when the current login session changes', async () => {
    const f = fixture('asin', { listFailureAfterDelete: true });
    await confirm();
    await screen.findByText(/核实失败，删除保护仍保留/);
    act(() =>
      f.setIdentity(['asin:read', 'asin:delete'], 'operator', 'session-2'),
    );
    const lock = deferred<void>();
    let queued = false;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_key: string, work: () => unknown) => {
          queued = true;
          await lock.promise;
          return work();
        },
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: '恢复原会话删除回执（不提交）' }),
    );
    await waitFor(() => expect(queued).toBe(true));
    act(() =>
      f.setIdentity(['asin:read', 'asin:delete'], 'operator', 'session-3'),
    );
    await act(async () => lock.resolve());
    expect(screen.queryByText(/已显式恢复同一用户原会话/)).toBeNull();
    expect(screen.queryByText(/实际删除变体组 1 个/)).toBeNull();
    expect(
      screen.getByRole('button', { name: '恢复原会话删除回执（不提交）' }),
    ).toHaveProperty('disabled', false);
    expect(mutations(f)).toHaveLength(1);
  });

  it.each(['asin', 'competitor'] as const)(
    'cannot dispatch any %s bulk deletion when shared guard storage cannot be read',
    async (domain) => {
      const original = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
        this: Storage,
        key,
      ) {
        if (key === catalogSafetyKey('operator', domain))
          throw new Error('storage read denied');
        return original.call(this, key);
      });
      const f = fixture(domain);
      await screen.findAllByText('Group Grüp-1');
      const select = screen.getByRole('button', { name: '选择本页可删除组' });
      expect(select).toHaveProperty('disabled', true);
      fireEvent.click(select);
      fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
      expect(screen.queryByRole('button', { name: '确认批量删除' })).toBeNull();
      expect(mutations(f)).toHaveLength(0);
    },
  );
  it.each([
    ['asin', '/api/'],
    ['asin', 'https://app.test/gateway/api/'],
    ['competitor', '/api/'],
    ['competitor', 'https://app.test/gateway/api/'],
  ] as const)(
    'submits %s selected raw IDs once with normalized %s and reports actual skipped/counts',
    async (domain, base) => {
      const f = fixture(domain, { base });
      await confirm();
      await screen.findByText(/实际删除变体组 1 个.*跳过 1 项/);
      expect(mutations(f)).toHaveLength(1);
      const [input, options] = mutations(f)[0];
      expect(new URL(String(input)).pathname).toBe(
        `${base.includes('gateway') ? '/gateway' : ''}/api/v1/${
          domain === 'competitor' ? 'competitor/' : ''
        }variant-groups/batch-delete`,
      );
      expect(JSON.parse(String(options?.body))).toEqual({
        groupIds: ['Grüp-1', 'missing'],
        useAsync: true,
      });
      expect(
        localStorage.getItem(catalogSafetyKey('operator', domain)),
      ).toBeNull();
    },
  );
  it.each(['asin', 'competitor'] as const)(
    'selects distinct padded %s IDs and their trimmed neighbours without rewriting either target',
    async (domain) => {
      const f = fixture(domain, { ids: [' Source Ś ', 'Source Ś'] });
      const controls = await screen.findAllByRole('checkbox', {
        name: /ID " Source Ś "/,
      });
      expect(
        controls.every((input) => !(input as HTMLInputElement).disabled),
      ).toBe(true);
      fireEvent.click(controls[0]);
      expect(
        screen.getByRole('button', { name: '批量删除所选组' }),
      ).toHaveProperty('disabled', false);
      await confirm();
      await waitFor(() => expect(mutations(f)).toHaveLength(1));
      expect(JSON.parse(String(mutations(f)[0][1]?.body)).groupIds).toEqual([
        ' Source Ś ',
        'Source Ś',
      ]);
    },
  );
  it.each(['asin', 'competitor'] as const)(
    'write-only %s users cannot bulk delete while delete-only grants can',
    async (domain) => {
      const f = fixture(domain, { permissions: ['asin:read', 'asin:write'] });
      await screen.findAllByText('Group Grüp-1');
      expect(
        screen.queryByRole('button', { name: '批量删除所选组' }),
      ).toBeNull();
      act(() => f.setIdentity(['asin:read', 'asin:delete']));
      await confirm();
      await waitFor(() => expect(mutations(f)).toHaveLength(1));
    },
  );
  it('uses current-page selection and clears it on page/filter changes and cancelled confirmation', async () => {
    const f = fixture('asin');
    await selectAll();
    expect(screen.getByText(/已选择 2 组/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
    fireEvent.click(screen.getByRole('button', { name: '取消批量删除' }));
    expect(mutations(f)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText(/已选择 0 组/);
    await selectAll();
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText(/已选择 0 组/);
    expect(mutations(f)).toHaveLength(0);
  });
  it.each(['permission', 'owner', 'session'] as const)(
    'clears confirmation when %s changes and never dispatches a stale deletion',
    async (change) => {
      const f = fixture('competitor');
      await selectAll();
      fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
      act(() => {
        if (change === 'session') f.runtime.refreshSession();
        else
          f.setIdentity(
            change === 'permission'
              ? ['asin:read', 'asin:write']
              : ['asin:read', 'asin:delete'],
            change === 'owner' ? 'other' : 'operator',
          );
      });
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: '确认批量删除' }),
        ).toBeNull(),
      );
      expect(mutations(f)).toHaveLength(0);
    },
  );
  it('restores lost-response protection on remount; reread never resubmits or releases it without acknowledgment', async () => {
    const f = fixture('asin', {
      response: async () => {
        throw new Error('response lost');
      },
    });
    await confirm();
    await screen.findByRole('heading', { name: '批量删除提交结果未知' });
    f.unmount();
    f.remount();
    await screen.findByRole('heading', { name: '批量删除提交结果未知' });
    fireEvent.click(screen.getByRole('button', { name: '重读目录核对结果' }));
    await screen.findByText(/读取目录不能证明/);
    expect(mutations(f)).toHaveLength(1);
    expect(
      localStorage.getItem(catalogSafetyKey('operator', 'asin')),
    ).toContain('unknown');
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '我已核实目录及任务，不存在待执行删除任务',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: '解除删除保护（不重发请求）' }),
    );
    await waitFor(() =>
      expect(
        localStorage.getItem(catalogSafetyKey('operator', 'asin')),
      ).toBeNull(),
    );
    expect(mutations(f)).toHaveLength(1);
  });
  it('restores a 500 unknown task receipt and requires terminal task plus reread, retaining guard if reread fails', async () => {
    const f = fixture('competitor', {
      response: async () =>
        jsonResponse(
          {
            success: false,
            errorCode: 500,
            errorMessage: 'uncertain',
            data: { taskId: 'task-1', status: 'unknown' },
          },
          500,
        ),
      listFailureAfterDelete: true,
    });
    await confirm();
    await screen.findByText('任务 ID：task-1');
    expect(screen.getByText(/任务提交结果尚未确认/)).toBeTruthy();
    f.unmount();
    f.remount();
    await screen.findByText('任务 ID：task-1');
    f.setTaskStatus('completed');
    fireEvent.click(screen.getByRole('button', { name: '查询任务并重读目录' }));
    await screen.findByText(/核实失败，删除保护仍保留/);
    expect(
      localStorage.getItem(catalogSafetyKey('operator', 'competitor')),
    ).toContain('refresh');
    f.recoverList();
    fireEvent.click(screen.getByRole('button', { name: '查询任务并重读目录' }));
    await waitFor(() =>
      expect(
        localStorage.getItem(catalogSafetyKey('operator', 'competitor')),
      ).toBeNull(),
    );
    expect(mutations(f)).toHaveLength(1);
  });
  it('persists late acceptance for the old owner without displaying it in a new session', async () => {
    const response = deferred<Response>();
    const f = fixture('asin', { response: () => response.promise });
    await confirm();
    await waitFor(() => expect(mutations(f)).toHaveLength(1));
    act(() => f.setIdentity(['asin:read', 'asin:delete'], 'other'));
    await act(async () => {
      response.resolve(
        jsonResponse({
          success: true,
          data: {
            mode: 'async',
            taskId: 'task-1',
            status: 'pending',
            totalRequested: 2,
          },
        }),
      );
    });
    expect(screen.queryByText('任务 ID：task-1')).toBeNull();
    expect(
      localStorage.getItem(catalogSafetyKey('operator', 'asin')),
    ).toContain('task-1');
    expect(localStorage.getItem(catalogSafetyKey('other', 'asin'))).toBeNull();
  });
});
