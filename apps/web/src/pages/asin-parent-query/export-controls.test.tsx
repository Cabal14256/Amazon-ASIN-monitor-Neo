// @vitest-environment jsdom
import {
  parentAsinExportTaskRequestSchema,
  type CurrentUserData,
} from '@asin-monitor/contracts';
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
import AsinParentQueryPage from './index';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: import('react').ReactNode }) => (
    <main>{children}</main>
  ),
}));
const taskId = '10000000-0000-4000-8000-000000000231';
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
function fixture() {
  const base: CurrentUserData = {
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
  };
  let state: RouteAuthState = { status: 'authenticated', identity: base };
  const listeners = new Set<() => void>();
  const change = (patch: Partial<CurrentUserData>) => {
    if (state.status !== 'authenticated') throw new Error();
    state = {
      status: 'authenticated',
      identity: { ...state.identity, ...patch },
    };
    listeners.forEach((listener) => listener());
  };
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => state),
  } as unknown as IdentityStore;
  const post = vi.fn(async () =>
    jsonResponse({
      success: true,
      data: { taskId, exportType: 'parent-asin-query', status: 'pending' },
    }),
  );
  const query = vi.fn(async () =>
    jsonResponse({
      success: true,
      data: [
        {
          asin: 'B000000001',
          hasParentAsin: false,
          parentAsin: null,
          parentTitle: '',
          title: 'Original private result',
          brand: null,
          hasVariants: false,
          variantCount: 0,
          error: null,
        },
      ],
    }),
  );
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    if (String(input).endsWith('/tasks/export')) return post();
    if (String(input).includes('/variant-check/')) return query();
    if (options?.method === 'GET')
      return jsonResponse({
        success: true,
        data: taskFixture({
          taskId,
          taskType: 'export',
          taskSubType: 'parent-asin-query',
          status: 'completed',
          canCancel: false,
        }),
      });
    throw new Error('Unexpected fixture request');
  });
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    baseURL: '/api/',
    fetch: fetcher,
  });
  runtimes.push(runtime);
  const announce = vi.fn();
  const page = () => (
    <AuthContext.Provider value={{ identity, runtime, announce }}>
      <AsinParentQueryPage />
    </AuthContext.Provider>
  );
  const view = render(page());
  const input = (text = 'B000000001') =>
    fireEvent.change(screen.getByLabelText('ASIN 列表'), {
      target: { value: text },
    });
  const submit = () =>
    fireEvent.click(
      screen.getByRole('button', { name: '后台查询并导出 XLSX' }),
    );
  return {
    view,
    page,
    input,
    submit,
    post,
    query,
    fetcher,
    change,
    announce,
    runtime,
  };
}
describe('full parent query page and real TaskApi/HttpClient export boundaries', () => {
  it('submits current input through the normalized endpoint and preserves duplicate Legacy positions', async () => {
    const f = fixture();
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
    expect(
      screen
        .getByRole('button', { name: '后台查询并导出 XLSX' })
        .hasAttribute('disabled'),
    ).toBe(true);
    f.input(' b000000001 B000000001，invalid\nB000000002');
    fireEvent.change(screen.getByLabelText('国家/站点'), {
      target: { value: 'UK' },
    });
    f.submit();
    await screen.findByText(`导出任务已提交：${taskId}`);
    expect(f.fetcher.mock.calls[0]?.[0]).toBe(
      'https://app.test/api/v1/tasks/export',
    );
    const request = parentAsinExportTaskRequestSchema.parse(
      JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body)),
    );
    expect(request.params).toEqual({
      asins: ['B000000001', 'B000000001', 'B000000002'],
      country: 'UK',
    });
    expect(f.query).not.toHaveBeenCalled();
  });
  it('remounts with the known task and reconciles by GET without a second POST', async () => {
    const f = fixture();
    f.input();
    f.submit();
    await screen.findByText(`导出任务已提交：${taskId}`);
    f.view.unmount();
    render(f.page());
    await screen.findByText(`原导出任务：${taskId}`);
    fireEvent.click(screen.getByRole('button', { name: '只查询原任务' }));
    await screen.findByText(`${taskId} · completed · 35%`);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls.at(-1)?.[1]?.method).toBe('GET');
  });
  it('retains unknown submission across remount and blocks duplicate POST until explicitly verified', async () => {
    const f = fixture();
    f.input();
    f.post.mockRejectedValueOnce(new TypeError('lost connection'));
    f.submit();
    await screen.findByText('网络请求失败');
    f.view.unmount();
    render(f.page());
    f.input();
    f.submit();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole('button', { name: '已核实，恢复导出' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
  it('isolates late accepted results and prior query data after session change or permission loss', async () => {
    const f = fixture(),
      pending = deferred<Response>();
    f.input();
    fireEvent.click(screen.getByRole('button', { name: '查询父体' }));
    await screen.findByText('Original private result');
    f.post.mockReturnValueOnce(pending.promise);
    f.submit();
    await waitFor(() => expect(f.post).toHaveBeenCalledTimes(1));
    act(() => f.change({ sessionId: 'replacement' }));
    expect(screen.queryByText('Original private result')).toBeNull();
    await act(async () =>
      pending.resolve(
        jsonResponse({
          success: true,
          data: { taskId, exportType: 'parent-asin-query', status: 'pending' },
        }),
      ),
    );
    expect(screen.queryByText(`导出任务已提交：${taskId}`)).toBeNull();
    expect(f.announce).not.toHaveBeenCalled();
    act(() => f.change({ permissions: [] }));
    expect(
      screen.queryByRole('button', { name: '后台查询并导出 XLSX' }),
    ).toBeNull();
  });
  it('does not POST when the submission guard cannot be persisted', async () => {
    const f = fixture();
    f.input();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    f.submit();
    await screen.findByText('本地存储不可用，导出结果需在任务中心核实');
    expect(f.post).not.toHaveBeenCalled();
  });
});
