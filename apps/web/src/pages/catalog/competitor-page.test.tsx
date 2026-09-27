// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import { ApiError } from '../../lib/http';
import type { createTransportRuntime } from '../../services/runtime';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import type { CatalogConfig } from './catalog-types';
import { CatalogPage } from './index';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const original = {
  id: 'group-1',
  name: 'Original rival',
  country: 'DE',
  brand: 'Rival',
  children: [],
};
const updated = { ...original, name: 'Current rival' };
const listData = (group: typeof original) => ({
  list: [group],
  total: 1,
  totalASINs: 0,
  current: 1,
  pageSize: 10,
});

afterEach(() => cleanup());

function fixture(
  list: ReturnType<typeof vi.fn>,
  createGroup: ReturnType<typeof vi.fn>,
  deleteGroup?: ReturnType<typeof vi.fn>,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let state = {
    status: 'authenticated' as const,
    identity: {
      user: {
        id: 'operator',
        username: 'operator',
        status: 'ACTIVE' as const,
      },
      roles: [],
      permissions: ['asin:read', 'asin:write', 'asin:delete'],
    },
  };
  const listeners = new Set<() => void>();
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => {
      state = {
        ...state,
        identity: { ...state.identity, permissions: ['asin:read'] },
      };
      for (const listener of listeners) listener();
      return state;
    }),
  } as unknown as IdentityStore;
  const clearUserWork = vi.fn(() => queryClient.clear());
  const runtime = {
    http: { request: vi.fn() },
    queryClient,
    clearUserWork,
  } as unknown as ReturnType<typeof createTransportRuntime>;
  const detail = vi.fn(async () => original);
  const config = {
    ...COMPETITOR_CATALOG,
    list,
    detail,
    writes: {
      ...COMPETITOR_CATALOG.writes!,
      createGroup,
      deleteGroup: deleteGroup ?? COMPETITOR_CATALOG.writes!.deleteGroup,
    },
  } as CatalogConfig;
  const announce = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(
    <AuthContext.Provider value={{ runtime, identity, announce }}>
      <QueryClientProvider client={queryClient}>
        <CatalogPage config={config} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return {
    list,
    createGroup,
    detail,
    queryClient,
    identity,
    clearUserWork,
    announce,
  };
}

async function create() {
  fireEvent.click(screen.getByRole('button', { name: '新建变体组' }));
  const panel = within(screen.getByRole('region', { name: '新建变体组' }));
  fireEvent.change(panel.getByLabelText(/^变体组名称/), {
    target: { value: 'New rival' },
  });
  fireEvent.change(panel.getByLabelText(/^国家代码/), {
    target: { value: 'DE' },
  });
  fireEvent.change(panel.getByLabelText(/^品牌/), {
    target: { value: 'Rival' },
  });
  fireEvent.click(panel.getByRole('button', { name: '保存' }));
}

describe('competitor catalog refresh and authority transitions', () => {
  it('hides old catalog data after a committed write when refresh fails', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(listData(updated));
    const createGroup = vi.fn(async () => original);
    const f = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    await create();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('旧数据已隐藏'),
    );
    expect(screen.queryByText('Original rival')).toBeNull();
    expect(screen.queryByText('新建变体组已完成。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await screen.findAllByText('Current rival');
    expect(screen.getByRole('status').textContent).toContain(
      '新建变体组已完成',
    );
    expect(f.announce).toHaveBeenCalledWith('新建变体组已完成。');
    f.queryClient.clear();
  });

  it('clears the old writable snapshot when the write is rejected after revocation', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockResolvedValueOnce(listData(updated));
    const createGroup = vi.fn(async () => {
      throw new ApiError('HTTP', 'private payload', 403);
    });
    const f = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    await create();
    await waitFor(() => expect(f.clearUserWork).toHaveBeenCalledOnce());
    await screen.findAllByText('Current rival');
    expect(screen.queryByText('Original rival')).toBeNull();
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    expect(screen.queryByText('新建变体组已完成。')).toBeNull();
    expect(f.identity.refresh).toHaveBeenCalledOnce();
    expect(f.announce).not.toHaveBeenCalled();
    f.queryClient.clear();
  });

  it('hides old data and avoids a success notice when the write outcome is uncertain', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockResolvedValueOnce(listData(updated));
    const createGroup = vi.fn(async () => {
      throw new ApiError('HTTP', '写入结果未确认，请刷新数据后再操作', 503);
    });
    const f = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    await create();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认'),
    );
    expect(screen.queryByText('Original rival')).toBeNull();
    expect(screen.queryByText('新建变体组已完成。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await screen.findAllByText('Current rival');
    expect(f.announce).not.toHaveBeenCalled();
    f.queryClient.clear();
  });

  it('can refresh after an uncertain group delete even if the group disappeared', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockResolvedValueOnce({ ...listData(original), list: [], total: 0 });
    const deleteGroup = vi.fn(async () => {
      throw new ApiError('HTTP', '写入结果未确认，请刷新数据后再操作', 503);
    });
    const f = fixture(list, vi.fn(), deleteGroup);
    await screen.findAllByText('Original rival');
    fireEvent.click(screen.getAllByRole('button', { name: '查看' })[0]);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: '删除变体组' }))[0],
    );
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认'),
    );
    const detailCalls = f.detail.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(f.detail).toHaveBeenCalledTimes(detailCalls);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Original rival')).toBeNull();
    expect(f.announce).not.toHaveBeenCalled();
    f.queryClient.clear();
  });
});
