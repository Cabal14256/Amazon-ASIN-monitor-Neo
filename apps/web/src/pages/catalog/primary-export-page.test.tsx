// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
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
import type { createTransportRuntime } from '../../services/runtime';
import { ASIN_CATALOG } from '../asin/config';
import type { CatalogGroup } from './catalog-types';
import { CatalogPage } from './index';

const exportHook = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
}));

vi.mock('../../hooks/tasks', () => ({
  useTaskQuery: () => ({ data: undefined, isError: false, refetch: vi.fn() }),
  useCreateExportTask: () => exportHook,
}));
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const group: CatalogGroup = {
  id: 'group-1',
  name: 'Primary group',
  country: 'US',
  brand: 'Brand',
  children: [],
};
const listData = {
  list: [group],
  total: 1,
  totalASINs: 0,
  current: 1,
  pageSize: 10,
};
const clients: QueryClient[] = [];

function fixture({
  permissions = ['asin:read'],
  mustChangePassword = false,
}: {
  permissions?: string[];
  mustChangePassword?: boolean;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(queryClient);
  const auth = {
    status: 'authenticated' as const,
    identity: {
      user: {
        id: 'operator',
        username: 'operator',
        status: 'ACTIVE' as const,
      },
      roles: [],
      permissions,
      mustChangePassword,
    },
  };
  const identity = {
    getSnapshot: () => auth,
    subscribe: () => () => undefined,
    refresh: vi.fn(async () => auth),
  } as unknown as IdentityStore;
  const list = vi.fn(async () => listData);
  const runtime = {
    http: { request: vi.fn() },
    queryClient,
    tasks: { createExport: vi.fn() },
    clearUserWork: vi.fn(),
  } as unknown as ReturnType<typeof createTransportRuntime>;
  const config = { ...ASIN_CATALOG, list };
  render(
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={queryClient}>
        <CatalogPage config={config} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return { list, queryClient };
}

beforeEach(() => {
  exportHook.mutateAsync.mockReset();
  exportHook.mutateAsync.mockResolvedValue({
    taskId: 'task-variant-group',
    status: 'pending',
  });
  exportHook.isPending = false;
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('primary catalog variant-group export', () => {
  it('submits the applied directory filters and reports the queued task', async () => {
    const { list } = fixture();
    await screen.findAllByText('Primary group');

    fireEvent.change(screen.getByLabelText('关键词'), {
      target: { value: ' Brand ' },
    });
    fireEvent.change(screen.getByLabelText('国家代码'), {
      target: { value: ' us ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ keyword: 'Brand', country: 'US' }),
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '异常' }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          keyword: 'Brand',
          country: 'US',
          variantStatus: 'BROKEN',
        }),
        expect.anything(),
      ),
    );

    fireEvent.change(screen.getByLabelText('关键词'), {
      target: { value: 'Draft keyword' },
    });
    fireEvent.change(screen.getByLabelText('国家代码'), {
      target: { value: 'ca' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导出变体组' }));

    await waitFor(() =>
      expect(exportHook.mutateAsync).toHaveBeenCalledWith({
        exportType: 'variant-group',
        params: {
          keyword: 'Brand',
          country: 'US',
          variantStatus: 'BROKEN',
        },
      }),
    );
    expect(
      await screen.findByText('变体组导出任务已提交：task-variant-group'),
    ).toBeTruthy();
  });

  it.each([
    { permissions: [], mustChangePassword: false },
    { permissions: ['asin:read'], mustChangePassword: true },
  ])(
    'hides export when read access or password policy blocks it',
    async ({ permissions, mustChangePassword }) => {
      fixture({ permissions, mustChangePassword });
      await screen.findAllByText('Primary group');
      expect(screen.queryByRole('button', { name: '导出变体组' })).toBeNull();
      expect(exportHook.mutateAsync).not.toHaveBeenCalled();
    },
  );
});
