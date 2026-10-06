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
import { ASIN_CATALOG } from '../asin/config';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { catalogCheckGateKey } from './catalog-check-recovery';
import { catalogSafetyKey } from './catalog-safety-gate';
import { CatalogPage } from './index';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
const rawId = ' Mixed-É ';
const group = {
  id: rawId,
  name: 'Primary group',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  children: [
    { id: ' Child-É ', asin: 'B00FIXTURE', country: 'US', isBroken: false },
  ],
};
const second = { ...group, id: 'mixed-é', name: 'Second group', children: [] };
const envelope = (data: unknown) => jsonResponse({ success: true, data });
beforeEach(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_key: string, callback: () => unknown) => callback(),
    },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});
function fixture(
  domain: 'asin' | 'competitor' = 'asin',
  permissions = ['asin:read'],
) {
  let auth: RouteAuthState = {
    status: 'authenticated',
    identity: {
      user: {
        id: 'operator',
        username: 'operator',
        status: 'ACTIVE',
        force_password_change: false,
      },
      roles: [],
      permissions,
      sessionId: 'session-1',
      mustChangePassword: false,
      passwordExpired: false,
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
  let listFails = false,
    taskStatus = 'pending';
  let checkResponse: () => Promise<Response> = async () =>
    envelope({
      taskId: 'job-1',
      status: 'pending',
      taskType:
        domain === 'asin' ? 'variant-group' : 'competitor-variant-group-check',
    });
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (options?.method === 'POST') return checkResponse();
    if (path.includes('/tasks/'))
      return envelope(
        taskFixture({
          taskId: 'job-1',
          taskType: domain === 'asin' ? 'batch-check' : 'variant-check',
          taskSubType:
            domain === 'asin'
              ? 'variant-group'
              : 'competitor-variant-group-check',
          status: taskStatus,
        }),
      );
    if (path.endsWith(encodeURIComponent(group.id))) return envelope(group);
    if (listFails)
      return jsonResponse({ success: false, errorMessage: 'read failed' }, 500);
    return envelope({
      list: [group, second],
      total: 2,
      totalASINs: 1,
      current: 1,
      pageSize: 10,
    });
  });
  const session = sessionFixture().store;
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    baseURL: 'https://api.test/api/',
    session,
    fetch: fetcher,
    socket: () => new FakeSocket(),
  });
  runtime.queryClient.setDefaultOptions({ queries: { retry: false } });
  runtimes.push(runtime);
  const config = domain === 'asin' ? ASIN_CATALOG : COMPETITOR_CATALOG;
  const element = () => (
    <AuthContext.Provider value={{ identity, runtime, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <CatalogPage config={config} />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  let view = render(element());
  return {
    runtime,
    fetcher,
    checkCalls: () =>
      fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'),
    setCheck: (next: () => Promise<Response>) => {
      checkResponse = next;
    },
    setListFailure: (value: boolean) => {
      listFails = value;
    },
    setTaskStatus: (status: string) => {
      taskStatus = status;
    },
    setIdentity: (update: Partial<CurrentUserData>) => {
      if (auth.status !== 'authenticated') throw new Error('identity');
      auth = {
        status: 'authenticated',
        identity: { ...auth.identity, ...update },
      };
      for (const listener of listeners) listener();
    },
    setOwner: (id: string) => {
      if (auth.status !== 'authenticated') throw new Error('identity');
      auth = {
        status: 'authenticated',
        identity: { ...auth.identity, user: { ...auth.identity.user, id } },
      };
      for (const listener of listeners) listener();
    },
    remount: () => {
      view.unmount();
      view = render(element());
    },
    unmount: () => view.unmount(),
    rerender: () => view.rerender(element()),
  };
}
async function selectGroup(name = group.name) {
  fireEvent.click(
    (
      await screen.findAllByRole('checkbox', {
        name: `选择变体组 ${name}，ID ${JSON.stringify(
          name === group.name ? group.id : second.id,
        )}`,
      })
    )[0],
  );
}
async function submitBatch() {
  await selectGroup();
  fireEvent.click(screen.getByRole('button', { name: '检查所选组' }));
  fireEvent.click(
    within(screen.getByRole('region', { name: '确认检查' })).getByRole(
      'button',
      { name: '确认提交检查' },
    ),
  );
}
async function openDetails() {
  fireEvent.click(
    (await screen.findAllByRole('button', { name: '查看 ASIN' }))[0],
  );
  await screen.findAllByRole('button', { name: '立即检查' });
}
describe('mounted existing Neo manual check endpoints with actual transport', () => {
  it('shares desktop/mobile selection, confirms the raw targets and submits one normalized async primary batch', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-07T00:00:00Z'));
    const f = fixture();
    await selectGroup();
    await selectGroup(second.name);
    expect(
      screen
        .getAllByRole('checkbox', {
          name: `选择变体组 ${group.name}，ID ${JSON.stringify(group.id)}`,
        })
        .every((input) => (input as HTMLInputElement).checked),
    ).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: '强制刷新' }));
    fireEvent.click(screen.getByRole('button', { name: '检查所选组' }));
    expect(f.checkCalls()).toHaveLength(0);
    const confirm = within(screen.getByRole('region', { name: '确认检查' }));
    expect(confirm.getByText(JSON.stringify(rawId))).toBeTruthy();
    expect(confirm.getByText(/允许使用缓存/)).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: '确认提交检查' }));
    await screen.findByText('job-1');
    expect(
      screen.getByText('提交时间（北京时间）：2026-10-07 08:00:00'),
    ).toBeTruthy();
    expect(f.checkCalls()).toHaveLength(1);
    expect(String(f.checkCalls()[0][0])).toBe(
      'https://api.test/api/v1/variant-groups/batch-check',
    );
    expect(JSON.parse(String(f.checkCalls()[0][1]?.body))).toEqual({
      groupIds: [rawId, second.id],
      forceRefresh: false,
      useAsync: true,
    });
    expect(
      screen.getByRole('link', { name: '任务中心' }).getAttribute('href'),
    ).toBe('/tasks');
    expect(
      (screen.getByRole('button', { name: '检查所选组' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      JSON.parse(
        window.localStorage.getItem(catalogSafetyKey('operator', 'asin'))!,
      ),
    ).toMatchObject({ phase: 'check', check: { taskId: 'job-1' } });
  });
  it.each([
    ['group', 0, 'competitor-variant-group-check', 'variant-groups', group.id],
    ['asin', 1, 'competitor-asin-check', 'asins', group.children[0].id],
  ] as const)(
    'confirms and dispatches only the existing competitor %s endpoint with asin:read',
    async (_kind, index, taskType, collection, id) => {
      const f = fixture('competitor');
      f.setCheck(async () =>
        envelope({ taskId: 'job-1', status: 'pending', taskType }),
      );
      await openDetails();
      expect(screen.queryByRole('button', { name: '检查所选组' })).toBeNull();
      fireEvent.click(
        screen.getAllByRole('button', { name: '立即检查' })[index],
      );
      expect(f.checkCalls()).toHaveLength(0);
      fireEvent.click(
        within(screen.getByRole('region', { name: '确认检查' })).getByRole(
          'button',
          { name: '确认提交检查' },
        ),
      );
      await screen.findByText('job-1');
      expect(f.checkCalls()).toHaveLength(1);
      expect(String(f.checkCalls()[0][0])).toBe(
        `https://api.test/api/v1/competitor/${collection}/${encodeURIComponent(
          id,
        )}/check`,
      );
      expect(JSON.parse(String(f.checkCalls()[0][1]?.body))).toEqual({
        useAsync: true,
        forceRefresh: true,
      });
    },
  );
  it('clears selections and confirmation when applied query changes', async () => {
    const f = fixture();
    await selectGroup();
    fireEvent.click(screen.getByRole('button', { name: '检查所选组' }));
    fireEvent.click(screen.getByRole('button', { name: '异常' }));
    expect(screen.queryByRole('region', { name: '确认检查' })).toBeNull();
    expect(screen.getByText('已选 0 组')).toBeTruthy();
    expect(f.checkCalls()).toHaveLength(0);
  });
  it.each(['owner', 'session', 'read-permission', 'password'] as const)(
    'does not dispatch a queued confirmation after %s changes',
    async (boundary) => {
      const queued = deferred<void>();
      const locks = vi.fn(async (_key: string, callback: () => unknown) => {
        await queued.promise;
        return callback();
      });
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: locks },
      });
      const f = fixture();
      await submitBatch();
      await waitFor(() => expect(locks).toHaveBeenCalledTimes(1));
      act(() => {
        if (boundary === 'owner') f.setOwner('other');
        if (boundary === 'session') {
          f.runtime.session.refreshHints();
          f.setIdentity({ sessionId: 'session-2' });
        }
        if (boundary === 'read-permission') f.setIdentity({ permissions: [] });
        if (boundary === 'password')
          f.setIdentity({ mustChangePassword: true });
      });
      await act(async () => queued.resolve());
      expect(f.checkCalls()).toHaveLength(0);
      expect(
        window.localStorage.getItem(catalogCheckGateKey('asin', 'operator')),
      ).toBeNull();
    },
  );
  it('keeps a late ACK under its old owner without exposing the task to a new owner', async () => {
    const accepted = deferred<Response>();
    const f = fixture();
    f.setCheck(() => accepted.promise);
    await submitBatch();
    await waitFor(() => expect(f.checkCalls()).toHaveLength(1));
    act(() => f.setOwner('other'));
    await act(async () =>
      accepted.resolve(
        envelope({
          taskId: 'job-1',
          status: 'pending',
          taskType: 'variant-group',
        }),
      ),
    );
    expect(screen.queryByText('job-1')).toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem(catalogCheckGateKey('asin', 'operator'))!,
      ).target.groupIds,
    ).toEqual([rawId]);
    expect(
      window.localStorage.getItem(catalogCheckGateKey('asin', 'other')),
    ).toBeNull();
    expect(
      (screen.getByRole('button', { name: '检查所选组' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it.each(['lost', 'malformed', 'unknown'] as const)(
    'preserves %s ACK recovery after remount and performs no duplicate POST',
    async (mode) => {
      const f = fixture();
      f.setCheck(async () => {
        if (mode === 'lost') throw new TypeError('connection lost');
        return mode === 'unknown'
          ? jsonResponse(
              {
                success: false,
                data: {
                  taskId: 'job-1',
                  status: 'unknown',
                  taskType: 'variant-group',
                },
              },
              500,
            )
          : envelope({ taskId: 'wrong', status: 'completed' });
      });
      await submitBatch();
      await waitFor(() =>
        expect(
          window.localStorage.getItem(catalogCheckGateKey('asin', 'operator')),
        ).not.toBeNull(),
      );
      await waitFor(() =>
        expect(screen.queryByText('正在提交检查任务…')).toBeNull(),
      );
      f.remount();
      await screen.findByRole('link', { name: '任务中心' });
      expect(
        (
          screen.getByRole('button', {
            name: '检查所选组',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(f.checkCalls()).toHaveLength(1);
    },
  );
  it('prevents a same-tab CRUD action and a second tab check while a shared check is active', async () => {
    const f = fixture('asin', ['asin:read', 'asin:write', 'asin:delete']);
    await submitBatch();
    await screen.findByText('job-1');
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    f.remount();
    await screen.findByText('job-1');
    await selectGroup();
    expect(
      (screen.getByRole('button', { name: '检查所选组' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(f.checkCalls()).toHaveLength(1);
  });
  it('retains the shared gate after terminal catalog read failure, then clears it only after successful reread', async () => {
    const f = fixture();
    await submitBatch();
    await screen.findByText('job-1');
    f.setTaskStatus('completed');
    f.setListFailure(true);
    await act(async () =>
      f.runtime.queryClient.invalidateQueries({
        queryKey: ['tasks', 'detail', 'job-1'],
      }),
    );
    await screen.findByRole('button', { name: '已核实原任务，恢复检查' });
    expect(
      window.localStorage.getItem(catalogSafetyKey('operator', 'asin')),
    ).not.toBeNull();
    f.setListFailure(false);
    fireEvent.click(
      screen.getByRole('button', { name: '已核实原任务，恢复检查' }),
    );
    await waitFor(() =>
      expect(
        window.localStorage.getItem(catalogSafetyKey('operator', 'asin')),
      ).toBeNull(),
    );
    expect(
      window.localStorage.getItem(catalogCheckGateKey('asin', 'operator')),
    ).toBeNull();
    expect(f.checkCalls()).toHaveLength(1);
  });
  it('honors a cross-tab CRUD gate without claiming a batch or sending a request', async () => {
    const key = catalogSafetyKey('operator', 'asin');
    window.localStorage.setItem(
      key,
      JSON.stringify({ phase: 'inspection', operationId: 'other-write' }),
    );
    const f = fixture();
    await screen.findByText('已选 0 组');
    expect(
      (screen.getByRole('button', { name: '检查所选组' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(f.checkCalls()).toHaveLength(0);
  });
});
