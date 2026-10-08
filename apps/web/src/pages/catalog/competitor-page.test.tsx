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
import { sessionFixture } from '../../lib/transport-fixtures';
import type {
  createTransportRuntime,
  SessionEvent,
} from '../../services/runtime';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { catalogSafetyKey } from './catalog-safety-gate';
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  Reflect.deleteProperty(window.navigator, 'locks');
});

function fixture(
  list: ReturnType<typeof vi.fn>,
  createGroup: ReturnType<typeof vi.fn>,
  deleteGroup?: ReturnType<typeof vi.fn>,
  createAsin?: ReturnType<typeof vi.fn>,
  permissions = ['asin:read', 'asin:write', 'asin:delete'],
) {
  const tails = new Map<string, Promise<void>>();
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: {
      request: async <T,>(
        _name: string,
        callback: () => Promise<T> | T,
      ): Promise<T> => {
        const before = tails.get(_name) ?? Promise.resolve();
        let release!: () => void;
        tails.set(
          _name,
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        await before;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    },
  });
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
      permissions,
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
  const sessionListeners = new Set<(event: SessionEvent) => void>();
  const runtime = {
    http: { request: vi.fn() },
    queryClient,
    session: sessionFixture().store,
    tasks: { get: vi.fn() },
    ws: { onMessage: vi.fn(() => () => undefined) },
    clearUserWork,
    subscribeSession: (listener: (event: SessionEvent) => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
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
      createAsin: createAsin ?? COMPETITOR_CATALOG.writes!.createAsin,
    },
  } as CatalogConfig;
  const announce = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const renderPage = () =>
    render(
      <AuthContext.Provider value={{ runtime, identity, announce }}>
        <QueryClientProvider client={queryClient}>
          <CatalogPage config={config} />
        </QueryClientProvider>
      </AuthContext.Provider>,
    );
  let view = renderPage();
  return {
    list,
    createGroup,
    detail,
    queryClient,
    identity,
    clearUserWork,
    announce,
    unmount: () => view.unmount(),
    remount: () => {
      view = renderPage();
    },
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
  it.each([
    { permissions: ['asin:read', 'asin:write'], deletes: true },
    { permissions: ['asin:read', 'asin:delete'], deletes: false },
    { permissions: ['asin:read'], deletes: false },
  ])(
    'retains Legacy single-delete permissions for $permissions',
    async ({ permissions, deletes }) => {
      const list = vi.fn(async () => listData(original));
      const f = fixture(list, vi.fn(), undefined, undefined, permissions);
      await screen.findAllByText('Original rival');
      fireEvent.click(screen.getAllByRole('button', { name: '查看' })[0]);
      await screen.findAllByText('上次检查');
      await waitFor(() =>
        expect(
          screen.queryAllByRole('button', { name: '删除变体组' }).length > 0,
        ).toBe(deletes),
      );
      f.queryClient.clear();
    },
  );
  it('shows storage failure independently and recovers without claiming any prior mutation', async () => {
    const storageFailure = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('Storage disabled');
      });
    const list = vi.fn().mockResolvedValue(listData(original));
    const createGroup = vi.fn();
    const f = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    expect(screen.getByRole('alert').textContent).toContain('本地存储不可用');
    expect(screen.queryByText(/新建操作的结果仍未确认/)).toBeNull();
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '检查存储并恢复' }));
    await screen.findByText('本地存储仍不可用，请允许此站点保存数据后重试。');
    expect(createGroup).not.toHaveBeenCalled();
    storageFailure.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: '检查存储并恢复' }));
    await screen.findByRole('button', { name: '新建变体组' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(createGroup).not.toHaveBeenCalled();
    f.queryClient.clear();
  });

  it('ignores peer storage probes in both catalog tabs while synchronizing real safety events', async () => {
    const first = fixture(
      vi.fn().mockResolvedValue(listData(original)),
      vi.fn(),
    );
    const second = fixture(
      vi.fn().mockResolvedValue(listData(original)),
      vi.fn(),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: '新建变体组' }),
      ).toHaveLength(2),
    );
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const removals = vi.spyOn(Storage.prototype, 'removeItem');
    // Browser probe set/remove broadcasts reach the other catalog tab. Each
    // mounted listener must ignore them without generating another broadcast.
    for (const newValue of ['1', null])
      fireEvent(
        window,
        new StorageEvent('storage', {
          key: 'neo:catalog-write-safety-probe',
          storageArea: window.localStorage,
          newValue,
        }),
      );
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: '新建变体组' })).toHaveLength(
      2,
    );
    const key = catalogSafetyKey('operator', 'competitor');
    const gate = {
      phase: 'refresh',
      message: null,
      detailId: null,
      createUncertain: true,
      operationId: 'peer-create',
    };
    window.localStorage.setItem(key, JSON.stringify(gate));
    fireEvent(
      window,
      new StorageEvent('storage', { key, storageArea: window.localStorage }),
    );
    await waitFor(() => {
      expect(
        screen.queryAllByRole('button', { name: '新建变体组' }),
      ).toHaveLength(0);
      for (const tab of [first, second])
        expect(
          tab.queryClient.getQueryData([
            'catalog-write-safety',
            'operator',
            'competitor',
          ]),
        ).toEqual(gate);
    });
    first.queryClient.clear();
    second.queryClient.clear();
  });

  it('restores an actual outstanding mutation after storage recovery instead of unlocking it', async () => {
    window.localStorage.setItem(
      catalogSafetyKey('operator', 'competitor'),
      JSON.stringify({
        phase: 'refresh',
        message: null,
        detailId: null,
        createUncertain: true,
      }),
    );
    const storageFailure = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('Storage disabled');
      });
    const createGroup = vi.fn();
    const f = fixture(
      vi.fn().mockResolvedValue(listData(original)),
      createGroup,
    );
    await screen.findAllByText('Original rival');
    storageFailure.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: '检查存储并恢复' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认'),
    );
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    expect(createGroup).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(catalogSafetyKey('operator', 'competitor')),
    ).toContain('createUncertain');
    f.queryClient.clear();
  });

  it('persists a provisional create gate before dispatch and restores it after a page reload', async () => {
    const list = vi.fn().mockResolvedValue(listData(original));
    const createGroup = vi.fn(
      () => new Promise<typeof original>(() => undefined),
    );
    const first = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    await create();
    await waitFor(() => expect(createGroup).toHaveBeenCalledOnce());
    expect(
      window.localStorage.getItem(catalogSafetyKey('operator', 'competitor')),
    ).toContain('createUncertain');
    first.unmount();
    first.queryClient.clear();
    const second = fixture(list, createGroup);
    expect(screen.getByRole('alert').textContent).toContain('写入结果未确认');
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    second.queryClient.clear();
  });

  it('does not clear another tab uncertain create when an earlier write settles', async () => {
    let finishWrite!: (value: typeof original) => void;
    const createGroup = vi.fn(
      () =>
        new Promise<typeof original>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const list = vi.fn().mockResolvedValue(listData(original));
    const f = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    await create();
    await waitFor(() => expect(createGroup).toHaveBeenCalledOnce());
    const otherGate = {
      phase: 'refresh',
      message: null,
      detailId: null,
      createUncertain: true,
      operationId: 'other-tab',
    };
    window.localStorage.setItem(
      catalogSafetyKey('operator', 'competitor'),
      JSON.stringify(otherGate),
    );
    finishWrite(original);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认'),
    );
    expect(
      window.localStorage.getItem(catalogSafetyKey('operator', 'competitor')),
    ).toBe(JSON.stringify(otherGate));
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    f.queryClient.clear();
  });
  it.each(['refresh', 'inspection'] as const)(
    'restores an off-page %s gate despite a cached null and requires reconciliation before writing',
    async (phase) => {
      const list = vi.fn().mockResolvedValue(listData(original));
      const createGroup = vi.fn().mockResolvedValue(updated);
      const f = fixture(list, createGroup);
      await screen.findAllByText('Original rival');
      await screen.findByRole('button', { name: '新建变体组' });
      expect(
        f.queryClient.getQueryData([
          'catalog-write-safety',
          'operator',
          'competitor',
        ]),
      ).toBeNull();
      f.unmount();
      const key = catalogSafetyKey('operator', 'competitor');
      window.localStorage.setItem(
        key,
        JSON.stringify({
          phase,
          message: null,
          detailId: null,
          createUncertain: true,
          operationId: 'off-page-create',
        }),
      );
      // No storage listener is mounted while the other tab saves this record.
      f.remount();
      expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
      expect(createGroup).not.toHaveBeenCalled();
      if (phase === 'refresh') {
        expect(screen.getByRole('alert').textContent).toContain(
          '写入结果未确认',
        );
        fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
      }
      await screen.findByText(/新建操作的结果仍未确认/);
      expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
      fireEvent.click(
        screen.getByRole('button', {
          name: '已核实原操作，重读目录并恢复写入',
        }),
      );
      await screen.findByRole('button', { name: '新建变体组' });
      expect(window.localStorage.getItem(key)).toBeNull();
      expect(createGroup).not.toHaveBeenCalled();
      await create();
      await waitFor(() => expect(createGroup).toHaveBeenCalledOnce());
      f.queryClient.clear();
    },
  );
  it('rereads the catalog before unlocking a cached gate cleared while the page was unmounted', async () => {
    const key = catalogSafetyKey('operator', 'competitor');
    window.localStorage.setItem(
      key,
      JSON.stringify({
        phase: 'refresh',
        message: null,
        detailId: null,
        createUncertain: true,
        operationId: 'off-page-create',
      }),
    );
    let finishRead!: (value: ReturnType<typeof listData>) => void;
    const list = vi.fn(
      () =>
        new Promise<ReturnType<typeof listData>>((resolve) => {
          finishRead = resolve;
        }),
    );
    const f = fixture(list, vi.fn());
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    f.unmount();
    window.localStorage.removeItem(key);
    f.remount();
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    finishRead(listData(updated));
    await screen.findAllByText('Current rival');
    await screen.findByRole('button', { name: '新建变体组' });
    f.queryClient.clear();
  });
  it('clears stale state on a cross-tab gate and only unlocks after a successful reread', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(listData(updated));
    const f = fixture(list, vi.fn());
    await screen.findAllByText('Original rival');
    fireEvent.click(screen.getByRole('button', { name: '新建变体组' }));
    f.queryClient.setQueryData(['competitor', 'group', original.id], original);
    const key = catalogSafetyKey('operator', 'competitor');
    const refresh = {
      phase: 'refresh',
      message: null,
      detailId: null,
      createUncertain: false,
    };
    window.localStorage.setItem(key, JSON.stringify(refresh));
    fireEvent(
      window,
      new StorageEvent('storage', { key, storageArea: window.localStorage }),
    );
    await waitFor(() => {
      expect(screen.queryByText('Original rival')).toBeNull();
      expect(screen.queryByRole('region', { name: '新建变体组' })).toBeNull();
      expect(
        f.queryClient.getQueryData(['competitor', 'group', original.id]),
      ).toBeUndefined();
    });
    window.localStorage.removeItem(key);
    fireEvent(
      window,
      new StorageEvent('storage', { key, storageArea: window.localStorage }),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await screen.findAllByText('Current rival');
    expect(screen.getByRole('button', { name: '新建变体组' })).toBeTruthy();
    f.queryClient.clear();
  });
  it('unlocks an inspection gate cleared in another tab only after rereading', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(listData(updated));
    const f = fixture(list, vi.fn());
    await screen.findAllByText('Original rival');
    const key = catalogSafetyKey('operator', 'competitor');
    window.localStorage.setItem(
      key,
      JSON.stringify({ phase: 'inspection', operationId: 'other-tab' }),
    );
    fireEvent(
      window,
      new StorageEvent('storage', { key, storageArea: window.localStorage }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull(),
    );

    window.localStorage.removeItem(key);
    fireEvent(
      window,
      new StorageEvent('storage', { key, storageArea: window.localStorage }),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: '已核实原操作，重读目录并恢复写入',
      }),
    );
    await screen.findAllByText('Current rival');
    expect(screen.getByRole('button', { name: '新建变体组' })).toBeTruthy();
    f.queryClient.clear();
  });

  it('corrects the last page after a group is deleted in another tab', async () => {
    const pageOne = { ...listData(original), total: 11 };
    const pageTwo = { ...listData(updated), current: 2, total: 11 };
    const removedPage = { ...pageTwo, list: [], total: 10 };
    const correctedPage = { ...pageOne, total: 10 };
    const list = vi
      .fn()
      .mockResolvedValueOnce(pageOne)
      .mockResolvedValueOnce(pageTwo)
      .mockResolvedValueOnce(removedPage)
      .mockResolvedValue(correctedPage);
    const f = fixture(list, vi.fn());
    await screen.findAllByText('Original rival');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findAllByText('Current rival');
    const key = catalogSafetyKey('operator', 'competitor');
    window.localStorage.setItem(
      key,
      JSON.stringify({
        phase: 'refresh',
        message: null,
        detailId: null,
        createUncertain: false,
        operationId: 'other-tab',
      }),
    );
    fireEvent(
      window,
      new StorageEvent('storage', { key, storageArea: window.localStorage }),
    );
    window.localStorage.removeItem(key);
    fireEvent(
      window,
      new StorageEvent('storage', { key, storageArea: window.localStorage }),
    );
    await screen.findByText('第 1 / 1 页 · 共 10 组');
    expect(
      screen.getByRole('heading', { name: 'Original rival' }),
    ).toBeTruthy();
    expect(list).toHaveBeenNthCalledWith(3, expect.anything(), {
      current: 2,
      pageSize: 10,
    });
    expect(list).toHaveBeenNthCalledWith(4, expect.anything(), {
      current: 1,
      pageSize: 10,
    });
    expect(screen.getByRole('button', { name: '新建变体组' })).toBeTruthy();
    f.queryClient.clear();
  });

  it('hides old catalog data after a committed write when refresh fails', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(listData(updated));
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
      .mockResolvedValue(listData(updated));
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

  it.each([401, 403])(
    'collapses a revoked group detail after a %s response',
    async (status) => {
      const list = vi
        .fn()
        .mockResolvedValueOnce(listData(original))
        .mockResolvedValueOnce(listData(updated));
      const f = fixture(list, vi.fn());
      f.detail.mockRejectedValueOnce(new ApiError('HTTP', 'private', status));
      await screen.findAllByText('Original rival');
      fireEvent.click(screen.getAllByRole('button', { name: '查看' })[0]);
      await waitFor(() => expect(f.clearUserWork).toHaveBeenCalledOnce());
      await screen.findAllByText('Current rival');
      expect(screen.queryByRole('button', { name: '收起' })).toBeNull();
      expect(screen.queryByText('Original rival')).toBeNull();
      expect(f.identity.refresh).toHaveBeenCalledOnce();
      f.queryClient.clear();
    },
  );

  it('hides old data and avoids a success notice when the write outcome is uncertain', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockResolvedValue(listData(updated));
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
    expect(screen.getByRole('alert').textContent).toContain('结果仍未确认');
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    expect(createGroup).toHaveBeenCalledOnce();
    expect(f.announce).not.toHaveBeenCalled();
    f.queryClient.clear();
  });

  it.each([
    new ApiError('HTTP', '写入结果未确认，请刷新数据后再操作', 503),
    new ApiError('CANCELLED', '请求已取消'),
  ])(
    'keeps the uncertain write gate after $kind and clears caches across a route remount',
    async (error) => {
      const list = vi.fn().mockResolvedValueOnce(listData(original));
      const createGroup = vi.fn(async () => {
        throw error;
      });
      const f = fixture(list, createGroup);
      await screen.findAllByText('Original rival');
      f.queryClient.setQueryData(
        ['competitor', 'group', original.id],
        original,
      );
      await create();
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain(
          '写入结果未确认',
        ),
      );
      expect(
        f.queryClient.getQueryData([
          'competitor',
          'groups',
          { current: 1, pageSize: 10 },
        ]),
      ).toBeUndefined();
      expect(
        f.queryClient.getQueryData(['competitor', 'group', original.id]),
      ).toBeUndefined();
      f.unmount();
      f.remount();
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认');
      expect(screen.queryByText('Original rival')).toBeNull();
      expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
      expect(createGroup).toHaveBeenCalledOnce();
      f.queryClient.clear();
    },
  );

  it('restores an uncertain create after a full app reload until explicit reread and reconciliation', async () => {
    const list = vi.fn().mockResolvedValue(listData(original));
    const createGroup = vi.fn(async () => {
      throw new ApiError('HTTP', '写入结果未确认，请刷新数据后再操作', 503);
    });
    const first = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    await create();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认'),
    );
    first.unmount();
    first.queryClient.clear();

    const second = fixture(list, createGroup);
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('写入结果未确认');
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('结果仍未确认'),
    );
    second.unmount();
    second.queryClient.clear();

    const third = fixture(list, createGroup);
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: '已核实原操作，重读目录并恢复写入',
      }),
    );
    await screen.findByRole('button', { name: '新建变体组' });
    expect(createGroup).toHaveBeenCalledOnce();
    third.queryClient.clear();
  });

  it('does not unlock an uncertain create from an unrelated filtered reread', async () => {
    const empty = { ...listData(original), list: [], total: 0 };
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockResolvedValue(empty);
    const createGroup = vi.fn(async () => {
      throw new ApiError('HTTP', '写入结果未确认，请刷新数据后再操作', 503);
    });
    const f = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    fireEvent.change(screen.getByLabelText('国家代码'), {
      target: { value: 'US' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText('未找到变体组');
    await create();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认'),
    );
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await screen.findByText('未找到变体组');
    expect(screen.getByRole('alert').textContent).toContain('结果仍未确认');
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    f.unmount();
    f.remount();
    expect(screen.getByRole('alert').textContent).toContain('结果仍未确认');
    expect(screen.getByRole('button', { name: '查询' })).toBeTruthy();
    expect(createGroup).toHaveBeenCalledOnce();
    f.queryClient.clear();
  });

  it('keeps an uncertain child creation read-only after rereading its parent detail', async () => {
    const list = vi.fn().mockResolvedValue(listData(original));
    const createAsin = vi.fn(async () => {
      throw new ApiError('HTTP', '写入结果未确认，请刷新数据后再操作', 503);
    });
    const f = fixture(list, vi.fn(), undefined, createAsin);
    await screen.findAllByText('Original rival');
    fireEvent.click(screen.getAllByRole('button', { name: '查看' })[0]);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: '添加 ASIN' }))[0],
    );
    const panel = within(
      await screen.findByRole('region', { name: '添加组内 ASIN' }),
    );
    fireEvent.change(panel.getByRole('textbox', { name: /^ASIN/ }), {
      target: { value: 'B000000001' },
    });
    fireEvent.click(panel.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认'),
    );
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('结果仍未确认'),
    );
    expect(screen.getAllByText('Original rival').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '添加 ASIN' })).toBeNull();
    expect(createAsin).toHaveBeenCalledOnce();
    f.queryClient.clear();
  });

  it("retains the same user's uncertainty gate through 403 read recovery", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockRejectedValueOnce(new ApiError('HTTP', 'private', 403))
      .mockResolvedValue(listData(original));
    const createGroup = vi.fn(async () => {
      throw new ApiError('HTTP', '写入结果未确认，请刷新数据后再操作', 503);
    });
    const f = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    await create();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认'),
    );
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await waitFor(() => expect(f.clearUserWork).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('写入结果未确认'),
    );
    f.unmount();
    f.remount();
    expect(screen.getByRole('alert').textContent).toContain('写入结果未确认');
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('结果仍未确认'),
    );
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
    f.queryClient.clear();
  });

  it('keeps the catalog visible when the API definitively rejects a write before commit', async () => {
    const list = vi.fn().mockResolvedValue(listData(original));
    const createGroup = vi.fn(async () => {
      throw new ApiError('HTTP', '鉴权权威源尚未切换，请使用现有竞品入口', 503);
    });
    const f = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    await create();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        '写入服务尚未开放',
      ),
    );
    expect(screen.getAllByText('Original rival').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '重新读取目录' })).toBeNull();
    expect(f.announce).not.toHaveBeenCalled();
    f.queryClient.clear();
  });

  it('finishes refresh when a concurrent delete removes the selected group', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockResolvedValue({ ...listData(original), list: [], total: 0 });
    const f = fixture(
      list,
      vi.fn(async () => updated),
    );
    await screen.findAllByText('Original rival');
    fireEvent.click(screen.getAllByRole('button', { name: '查看' })[0]);
    await waitFor(() => expect(f.detail).toHaveBeenCalled());
    f.detail.mockRejectedValueOnce(new ApiError('HTTP', 'gone', 404));
    await create();
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        '新建变体组已完成',
      ),
    );
    expect(screen.queryByText('Original rival')).toBeNull();
    expect(screen.queryByRole('button', { name: '收起' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    f.queryClient.clear();
  });

  it('keeps the catalog selection and filters fixed during a write', async () => {
    let finishWrite: ((value: typeof original) => void) | undefined;
    const createGroup = vi.fn(
      () =>
        new Promise<typeof original>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockResolvedValue(listData(updated));
    const f = fixture(list, createGroup);
    await screen.findAllByText('Original rival');
    await create();
    await waitFor(() => expect(createGroup).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '查询' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: '异常' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('combobox', { name: '每页数量' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getAllByRole('button', { name: '查看' })[0]).toHaveProperty(
      'disabled',
      true,
    );
    finishWrite?.(original);
    await screen.findAllByText('Current rival');
    expect(f.announce).toHaveBeenCalledWith('新建变体组已完成。');
    f.queryClient.clear();
  });

  it('can refresh after an uncertain group delete even if the group disappeared', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(listData(original))
      .mockResolvedValue({ ...listData(original), list: [], total: 0 });
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
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(f.detail).toHaveBeenCalledTimes(detailCalls);
    expect(screen.queryByText('Original rival')).toBeNull();
    expect(f.announce).not.toHaveBeenCalled();
    f.queryClient.clear();
  });
  it('returns to the last valid page after deleting the sole group on page two', async () => {
    const lastGroup = { ...original, id: 'group-2', name: 'Last rival' };
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ...listData(original), total: 11 })
      .mockResolvedValueOnce({
        ...listData(lastGroup),
        total: 11,
        current: 2,
      })
      .mockResolvedValueOnce({
        ...listData(lastGroup),
        list: [],
        total: 10,
        current: 2,
      })
      .mockResolvedValue({ ...listData(original), total: 10 });
    const deleteGroup = vi.fn(async () => undefined);
    const f = fixture(list, vi.fn(), deleteGroup);
    f.detail.mockResolvedValue(lastGroup);
    await screen.findAllByText('Original rival');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findAllByText('Last rival');
    fireEvent.click(screen.getAllByRole('button', { name: '查看' })[0]);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: '删除变体组' }))[0],
    );
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await screen.findAllByText('Original rival');
    expect(screen.getByText(/第 1 \/ 1 页/)).toBeTruthy();
    expect(deleteGroup).toHaveBeenCalledOnce();
    f.queryClient.clear();
  });
});
