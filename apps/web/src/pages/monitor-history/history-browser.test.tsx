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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import { ApiError } from '../../lib/http';
import { HistoryBrowser } from './history-browser';
import { HISTORY_SOURCES } from './history-sources';

vi.mock('@tanstack/react-router', () => ({ useRouterState: () => '' }));
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

function fixture() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const data = (name: string) => ({
    list: [{ id: 107, asinName: name, checkType: 'ASIN' }],
    total: 1,
    current: 1,
    pageSize: 10,
  });
  const getList = vi.fn(async () => data('original history'));
  const getIntervals = vi.fn(async () => ({
    coverage: 'complete' as const,
    current: 1,
    pageSize: 50,
    total: 0,
    list: [],
  }));
  const source = {
    ...HISTORY_SOURCES.primary,
    getList,
    getIntervals,
    getStatistics: undefined,
    getPeakHours: undefined,
  };
  const state = {
    status: 'authenticated',
    identity: {
      user: { id: 'history-reader', status: 'ACTIVE' },
      sessionId: 'history-session',
      permissions: ['monitor:read'],
      roles: [],
    },
  };
  render(
    <AuthContext.Provider
      value={{
        identity: {
          getSnapshot: () => state,
          subscribe: () => () => undefined,
        } as never,
        announce: vi.fn(),
        runtime: { queryClient: client, http: { url: vi.fn() } } as never,
      }}
    >
      <QueryClientProvider client={client}>
        <HistoryBrowser source={source} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return { client, getList, getIntervals, data };
}

describe('history authority recovery with a timed interval window', () => {
  it.each([
    { message: '状态区间读取已关闭，请联系管理员启用后再试', recover: true },
    { message: '数据库暂不可用', recover: false },
    { message: '状态区间读取已关闭：服务繁忙', recover: false },
  ])(
    'recovers fresh history only for a deliberate disabled timeline: $message',
    async ({ message, recover }) => {
      const f = fixture();
      await waitFor(() =>
        expect(screen.getAllByText('original history')).toHaveLength(2),
      );
      fireEvent.change(screen.getByLabelText('开始时间（上海）'), {
        target: { value: '2026-09-01T00:00' },
      });
      fireEvent.change(screen.getByLabelText('结束时间（上海）'), {
        target: { value: '2026-09-02T00:00' },
      });
      fireEvent.click(screen.getByRole('button', { name: '查询' }));
      await waitFor(() => expect(f.getIntervals).toHaveBeenCalledOnce());
      f.getList.mockRejectedValueOnce(new ApiError('HTTP', 'Forbidden', 403));
      await act(async () => {
        await f.client.invalidateQueries({
          queryKey: ['monitor-history', 'list'],
        });
      });
      await screen.findByRole('heading', { name: '读取权限需要重新确认' });
      expect(screen.queryByText('original history')).toBeNull();
      f.getList.mockResolvedValue(f.data('restored history'));
      f.getIntervals.mockRejectedValue(new ApiError('HTTP', message, 503));
      fireEvent.click(screen.getByRole('button', { name: '重新验证并读取' }));
      if (recover) {
        await waitFor(() =>
          expect(screen.getAllByText('restored history')).toHaveLength(2),
        );
        expect(
          screen.queryByRole('heading', { name: '读取权限需要重新确认' }),
        ).toBeNull();
        await screen.findByText(message);
        expect(screen.queryByText('original history')).toBeNull();
      } else {
        await screen.findByText(
          '重新验证或读取未完成，旧数据继续隐藏，请稍后重试。',
        );
        expect(
          screen.getByRole('heading', { name: '读取权限需要重新确认' }),
        ).toBeTruthy();
        expect(screen.queryByText('restored history')).toBeNull();
        expect(screen.queryByText('original history')).toBeNull();
      }
    },
  );
});
