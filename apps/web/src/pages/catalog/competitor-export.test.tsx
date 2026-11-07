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
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import type { RouteAuthState } from '../../auth/navigation';
import { deferred, jsonResponse } from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { taskFixture } from '../../services/task-fixtures';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { CompetitorExportControls } from './competitor-export';
import { CatalogPage } from './index';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: import('react').ReactNode }) => (
    <main>{children}</main>
  ),
}));

const taskId = '10000000-0000-4000-8000-000000000230';
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
afterEach(() => {
  cleanup();
  for (const value of runtimes.splice(0)) value.dispose();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
function fixture(catalog = false) {
  let state: RouteAuthState = {
    status: 'authenticated',
    identity: {
      user: {
        id: 'owner',
        username: 'fixture',
        status: 'ACTIVE',
        force_password_change: false,
      },
      roles: [],
      permissions: ['asin:read'],
      sessionId: 'session',
      mustChangePassword: false,
      passwordExpired: false,
    } as CurrentUserData,
  };
  const listeners = new Set<() => void>();
  const change = (patch: Partial<CurrentUserData>) => {
    if (state.status !== 'authenticated') throw new Error();
    state = {
      status: 'authenticated',
      identity: { ...state.identity, ...patch },
    };
    listeners.forEach((fn) => fn());
  };
  const identity = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refresh: vi.fn(async () => state),
  } as unknown as IdentityStore;
  const post = vi.fn(async () =>
    jsonResponse({
      success: true,
      data: { taskId, exportType: 'competitor-asin', status: 'pending' },
    }),
  );
  const fetcher = vi.fn<typeof fetch>(async (_input, options) =>
    options?.method === 'POST'
      ? post()
      : jsonResponse({
          success: true,
          data: taskFixture({
            taskId,
            taskType: 'export',
            taskSubType: 'competitor-asin',
            status: 'completed',
            canCancel: false,
          }),
        }),
  );
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    baseURL: '/api/',
    fetch: fetcher,
  });
  runtimes.push(runtime);
  const announce = vi.fn();
  const list = vi.fn(async () => ({
    list: [],
    total: 0,
    totalASINs: 0,
    current: 1,
    pageSize: 10,
  }));
  const page = () => (
    <AuthContext.Provider value={{ identity, runtime, announce }}>
      {catalog ? (
        <QueryClientProvider client={runtime.queryClient}>
          <CatalogPage config={{ ...COMPETITOR_CATALOG, list }} />
        </QueryClientProvider>
      ) : (
        <CompetitorExportControls
          query={{
            keyword: 'Applied',
            country: 'US',
            variantStatus: 'BROKEN',
            current: 1,
            pageSize: 10,
          }}
          disabled={false}
        />
      )}
    </AuthContext.Provider>
  );
  const view = render(page());
  return {
    view,
    page,
    runtime,
    fetcher,
    post,
    change,
    announce,
    identity,
    list,
  };
}
describe('competitor export real HTTP boundary', () => {
  it('wires the full catalog entry to applied filters rather than unsubmitted drafts', async () => {
    const f = fixture(true);
    await waitFor(() => expect(f.list).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('关键词'), {
      target: { value: ' Applied ' },
    });
    fireEvent.change(screen.getByLabelText('国家代码'), {
      target: { value: ' us ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() =>
      expect(f.list).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ keyword: 'Applied', country: 'US' }),
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '异常' }));
    await waitFor(() =>
      expect(f.list).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ variantStatus: 'BROKEN' }),
        expect.anything(),
      ),
    );
    fireEvent.change(screen.getByLabelText('关键词'), {
      target: { value: 'Draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导出竞品 ASIN' }));
    await screen.findByText(`导出任务已提交：${taskId}`);
    expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      exportType: 'competitor-asin',
      params: { keyword: 'Applied', country: 'US', variantStatus: 'BROKEN' },
    });
  });
  it('submits applied filters through normalized API and remount only queries the original receipt', async () => {
    const f = fixture();
    fireEvent.click(screen.getByRole('button', { name: '导出竞品 ASIN' }));
    await screen.findByText(`导出任务已提交：${taskId}`);
    expect(f.fetcher.mock.calls[0]?.[0]).toBe(
      'https://app.test/api/v1/tasks/export',
    );
    expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      exportType: 'competitor-asin',
      params: { keyword: 'Applied', country: 'US', variantStatus: 'BROKEN' },
    });
    f.view.unmount();
    render(f.page());
    expect(
      screen
        .getByRole('button', { name: '导出竞品 ASIN' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '只查询原任务' }));
    await screen.findByText(`${taskId} · completed · 35%`);
    expect(f.post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '已核实，恢复导出' }));
    expect(
      screen
        .getByRole('button', { name: '导出竞品 ASIN' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
  it('retains a lost response and prevents a second POST until explicitly verified', async () => {
    const f = fixture();
    f.post.mockRejectedValueOnce(new TypeError('connection lost'));
    fireEvent.click(screen.getByRole('button', { name: '导出竞品 ASIN' }));
    await screen.findByText('网络请求失败');
    expect(
      screen
        .getByRole('button', { name: '导出竞品变体组' })
        .hasAttribute('disabled'),
    ).toBe(true);
    f.view.unmount();
    render(f.page());
    expect(
      screen
        .getByRole('button', { name: '已核实，恢复导出' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(f.post).toHaveBeenCalledTimes(1);
  });
  it('does not publish a late old-session result into the new scope', async () => {
    const f = fixture(),
      pending = deferred<Response>();
    f.post.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '导出竞品 ASIN' }));
    await waitFor(() => expect(f.post).toHaveBeenCalledOnce());
    act(() => f.change({ sessionId: 'replacement' }));
    await act(async () => {
      pending.resolve(
        jsonResponse({
          success: true,
          data: { taskId, status: 'pending', exportType: 'competitor-asin' },
        }),
      );
    });
    expect(screen.queryByText(`导出任务已提交：${taskId}`)).toBeNull();
    expect(f.announce).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole('button', { name: '导出竞品 ASIN' })
        .hasAttribute('disabled'),
    ).toBe(false);
    act(() => f.change({ permissions: [] }));
    expect(screen.queryByRole('button', { name: '导出竞品 ASIN' })).toBeNull();
  });
});
