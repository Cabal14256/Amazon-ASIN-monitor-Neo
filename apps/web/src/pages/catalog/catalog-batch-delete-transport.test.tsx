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
import { ASIN_CATALOG } from '../asin/config';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { catalogSafetyKey } from './catalog-safety-gate';
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
  let tail: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, work: () => unknown) => {
        const result = tail.then(work);
        tail = result.catch(() => undefined);
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
  } = {},
) {
  let submitted = false;
  let taskStatus = options.taskStatus ?? 'processing';
  let listFailure = options.listFailureAfterDelete ?? false;
  const ids = options.ids ?? ['Grüp-1', 'missing'];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') {
      submitted = true;
      return options.response
        ? options.response()
        : jsonResponse({ success: true, data: counts });
    }
    if (url.pathname.includes('/tasks/'))
      return jsonResponse({
        success: true,
        data: {
          taskId: 'task-1',
          taskType: 'batch-delete',
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
        <CatalogPage config={configs[domain]} />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  let view = render(element());
  return {
    fetcher,
    runtime,
    setTaskStatus: (status: string) => {
      taskStatus = status;
    },
    recoverList: () => {
      listFailure = false;
    },
    setIdentity: (permissions: string[], owner = 'operator') => {
      if (state.status !== 'authenticated') throw new Error('fixture');
      state = {
        ...state,
        identity: {
          ...state.identity,
          user: { ...state.identity.user, id: owner },
          permissions,
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
  fireEvent.click(
    await screen.findByRole('button', { name: '选择本页可删除组' }),
  );
}
async function confirm() {
  await selectAll();
  fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
  fireEvent.click(screen.getByRole('button', { name: '确认批量删除' }));
}
const mutations = (f: ReturnType<typeof fixture>) =>
  f.fetcher.mock.calls.filter((call) => call[1]?.method === 'POST');

describe('mounted primary and competitor bulk-delete real HTTP transport', () => {
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
    'cannot select padded %s IDs or send them in a bulk POST',
    async (domain) => {
      const f = fixture(domain, { ids: [' Source Ś ', 'Source Ś'] });
      const controls = await screen.findAllByRole('checkbox', {
        name: /ID " Source Ś "/,
      });
      expect(
        controls.every((input) => (input as HTMLInputElement).disabled),
      ).toBe(true);
      fireEvent.click(controls[0]);
      expect(
        screen.getByRole('button', { name: '批量删除所选组' }),
      ).toHaveProperty('disabled', true);
      await confirm();
      await waitFor(() => expect(mutations(f)).toHaveLength(1));
      expect(JSON.parse(String(mutations(f)[0][1]?.body)).groupIds).toEqual([
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
