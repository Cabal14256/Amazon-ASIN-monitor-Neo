// @vitest-environment jsdom
import type { CurrentUserData, TaskInfo } from '@asin-monitor/contracts';
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
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { taskKeys } from '../../services/task-queries';
import {
  importGateKey,
  readImportGate,
  writeImportGate,
} from '../asin/asin-import-gate';
import { AsinImportPanel } from '../asin/asin-import-panel';
import { catalogSafetyKey } from '../catalog/catalog-safety-gate';
import CompetitorAsinCatalogPage from './index';

// Only replace layout; the catalog, import panel, Query, TaskApi and HttpClient are real.
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const primaryId = 'b2b5894c-5802-4c9f-a1bd-9a20263d270a';
const competitorId = '123e4567-e89b-42d3-a456-426614174000';
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
const user = (overrides: Partial<CurrentUserData> = {}): CurrentUserData => ({
  user: {
    id: 'operator',
    username: 'operator',
    status: 'ACTIVE',
    force_password_change: false,
  },
  roles: [],
  permissions: ['asin:read', 'asin:write'],
  sessionId: 'session-a',
  mustChangePassword: false,
  passwordExpired: false,
  ...overrides,
});
const envelope = (data: unknown) =>
  jsonResponse({ success: true, errorCode: 0, data });
function task(taskId: string, status = 'processing'): TaskInfo {
  return {
    taskId,
    taskType: 'import',
    taskSubType: taskId === competitorId ? 'competitor-asin' : 'asin',
    title: 'Fixture import',
    status,
    progress: status === 'completed' ? 100 : 50,
    message: '',
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
  };
}
function installLocks() {
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn(
    async <T,>(name: string, action: () => T | Promise<T>): Promise<T> => {
      const before = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      tails.set(
        name,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      await before;
      try {
        return await action();
      } finally {
        release();
      }
    },
  );
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request },
  });
  return request;
}
function fixture(
  options: {
    content?: ReactElement;
    identity?: CurrentUserData;
    upload?: (url: string, init: RequestInit) => Promise<Response>;
    taskRead?: (id: string, init: RequestInit) => Promise<Response>;
  } = {},
) {
  installLocks();
  let state = {
    status: 'authenticated' as const,
    identity: options.identity ?? user(),
  };
  const listeners = new Set<() => void>();
  const change = (identity: CurrentUserData) => {
    state = { ...state, identity };
    for (const listener of listeners) listener();
  };
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => {
      change(user({ permissions: ['asin:read'] }));
      return state;
    }),
  } as unknown as IdentityStore;
  const snapshots = new Map<string, TaskInfo>();
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    if (init.method === 'POST')
      return (
        options.upload?.(url, init) ??
        envelope({
          taskId: url.includes('/competitor/') ? competitorId : primaryId,
          status: 'pending',
        })
      );
    const id = url.split('/tasks/')[1];
    if (id)
      return (
        options.taskRead?.(id, init) ?? envelope(snapshots.get(id) ?? task(id))
      );
    if (url.includes('/competitor/variant-groups'))
      return envelope({
        list: [],
        total: 0,
        totalASINs: 0,
        current: 1,
        pageSize: 10,
      });
    throw new Error(`Unexpected fixture request ${url}`);
  });
  const runtime = createTransportRuntime({
    baseURL: 'https://app.test/api/',
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  runtimes.push(runtime);
  const invalidate = vi.spyOn(runtime.queryClient, 'invalidateQueries');
  const content = options.content ?? <AsinImportPanel domain="competitor" />;
  const page = () => (
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        {content}
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  let view = render(page());
  return {
    runtime,
    identity,
    fetcher,
    snapshots,
    invalidate,
    change: (next: CurrentUserData) => act(() => change(next)),
    unmount: () => view.unmount(),
    remount: () => {
      view = render(page());
    },
    posts: () =>
      fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
    refetch: (id: string) =>
      act(async () => {
        await runtime.queryClient.invalidateQueries({
          queryKey: taskKeys.detail(id),
          exact: true,
        });
      }),
  };
}
function panel(domain: 'asin' | 'competitor' = 'competitor') {
  return within(
    screen.getByRole('region', {
      name: `${domain === 'asin' ? '主营' : '竞品'} ASIN 导入`,
    }),
  );
}
function choose(
  domain: 'asin' | 'competitor' = 'competitor',
  name = 'rivals.csv',
) {
  const region = panel(domain);
  fireEvent.click(region.getByRole('button', { name: '导入 CSV / XLSX' }));
  const file = new File(
    ['变体组名称,国家,品牌,ASIN,ASIN类型\r\nRival,DE,Brand,B00RIVAL00,1'],
    name,
  );
  fireEvent.change(region.getByLabelText('选择文件'), {
    target: { files: { 0: file, length: 1, item: () => file } },
  });
  return region;
}
function submit(region: ReturnType<typeof within>) {
  fireEvent.click(region.getByRole('button', { name: '上传并创建导入任务' }));
}
function abortable(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) =>
    init.signal?.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    ),
  );
}
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  localStorage.clear();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.restoreAllMocks();
});

describe('competitor CSV/XLSX import mounted transport', () => {
  it('exposes the real competitor catalog entry, accepts one multipart file and refreshes only its catalog after completion', async () => {
    writeImportGate(localStorage, 'asin', 'operator', {
      phase: 'uncertain',
      taskId: null,
      savedAt: 1,
    });
    const f = fixture({ content: <CompetitorAsinCatalogPage /> });
    await screen.findByText('竞品变体组与 ASIN');
    submit(choose());
    await screen.findByText(`任务编号：${competitorId}`);
    await screen.findByRole('progressbar', { name: '导入任务进度' });
    const [url, init] = f.posts()[0];
    expect(url).toBe(
      'https://app.test/api/v1/competitor/variant-groups/import-excel',
    );
    const form = init?.body as FormData;
    expect(form.getAll('file')).toHaveLength(1);
    expect((form.get('file') as File).type).toBe('text/csv');
    expect(form.get('useAsync')).toBe('true');
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
    expect(readImportGate(localStorage, 'competitor', 'operator')?.phase).toBe(
      'accepted',
    );
    f.snapshots.set(competitorId, task(competitorId, 'completed'));
    await f.refetch(competitorId);
    await screen.findByText(
      '导入任务已完成，请核对任务中心的成功、失败行与报告。',
    );
    expect(readImportGate(localStorage, 'competitor', 'operator')).toBeNull();
    expect(readImportGate(localStorage, 'asin', 'operator')?.savedAt).toBe(1);
    expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ['competitor'] });
    expect(f.invalidate).not.toHaveBeenCalledWith({ queryKey: ['asin'] });
    expect(f.posts()).toHaveLength(1);
  });

  it('uses independent locks and receipts while a primary upload is still in flight', async () => {
    const pending = deferred<Response>();
    const f = fixture({
      content: (
        <>
          <AsinImportPanel />
          <AsinImportPanel domain="competitor" />
        </>
      ),
      upload: async (url) =>
        url.includes('/competitor/')
          ? envelope({ taskId: competitorId, status: 'pending' })
          : pending.promise,
    });
    submit(choose('asin'));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    submit(choose('competitor', 'rival.xlsx'));
    await screen.findByText(`任务编号：${competitorId}`);
    expect(readImportGate(localStorage, 'asin', 'operator')?.taskId).toBeNull();
    expect(readImportGate(localStorage, 'competitor', 'operator')?.taskId).toBe(
      competitorId,
    );
    expect(navigator.locks.request).toHaveBeenCalledWith(
      catalogSafetyKey('operator', 'asin'),
      expect.any(Function),
    );
    expect(navigator.locks.request).toHaveBeenCalledWith(
      catalogSafetyKey('operator', 'competitor'),
      expect.any(Function),
    );
    await act(async () =>
      pending.resolve(envelope({ taskId: primaryId, status: 'pending' })),
    );
    await screen.findByText(`任务编号：${primaryId}`);
    expect(f.posts()).toHaveLength(2);
    expect(
      panel('competitor').queryByText(`任务编号：${primaryId}`),
    ).toBeNull();
  });

  it('downloads the separate competitor CSV template without changing the primary template', async () => {
    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        blobs.push(blob);
        return 'blob:fixture';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    fixture({
      content: (
        <>
          <AsinImportPanel />
          <AsinImportPanel domain="competitor" />
        </>
      ),
    });
    choose('asin');
    choose('competitor');
    vi.useFakeTimers();
    fireEvent.click(
      panel('asin').getByRole('button', { name: '下载 CSV 模板' }),
    );
    fireEvent.click(
      panel('competitor').getByRole('button', { name: '下载 CSV 模板' }),
    );
    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();
    const texts = await Promise.all(
      blobs.map(
        (blob) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsText(blob);
          }),
      ),
    );
    expect(names).toEqual(['ASIN导入模板.csv', '竞品ASIN导入模板.csv']);
    expect(texts[0]).toContain(
      '变体组名称,国家,站点,品牌,ASIN,ASIN类型,ASIN名称',
    );
    expect(texts[1]).toContain('变体组名称,国家,品牌,ASIN,ASIN类型,ASIN名称');
    expect(texts[1]).not.toContain('站点');
  });

  it.each([undefined, competitorId])(
    'retains an unknown submission receipt %s across refresh without replay',
    async (id) => {
      const f = fixture({
        upload: async () =>
          jsonResponse(
            {
              success: false,
              errorCode: 500,
              errorMessage: '任务提交结果未确认',
              data: { status: 'unknown', ...(id ? { taskId: id } : {}) },
            },
            500,
          ),
      });
      submit(choose());
      await screen.findByText('提交结果不确定，请先核实任务状态。');
      expect(
        readImportGate(localStorage, 'competitor', 'operator')?.taskId,
      ).toBe(id ?? null);
      f.unmount();
      f.remount();
      await screen.findByText('提交结果不确定，请先核实任务状态。');
      expect(f.posts()).toHaveLength(1);
      expect(
        (panel().getByLabelText('选择文件') as HTMLInputElement).disabled,
      ).toBe(true);
      if (!id) {
        fireEvent.click(
          panel().getByRole('button', { name: '已核实原任务，允许重新导入' }),
        );
        await screen.findByText('请确认原任务不会继续写入后再重新导入。');
      } else {
        await screen.findByRole('progressbar');
        expect(
          panel().queryByRole('button', { name: '已核实原任务，允许重新导入' }),
        ).toBeNull();
      }
    },
  );

  it('cancels local upload and preserves an uncertain gate because cancellation cannot undo server writes', async () => {
    const f = fixture({ upload: (_url, init) => abortable(init) });
    submit(choose());
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    fireEvent.click(panel().getByRole('button', { name: '取消本地上传' }));
    await screen.findByText('提交结果不确定，请先核实任务状态。');
    expect(f.posts()[0][1]?.signal?.aborted).toBe(true);
    expect(readImportGate(localStorage, 'competitor', 'operator')?.phase).toBe(
      'uncertain',
    );
    expect(f.posts()).toHaveLength(1);
  });

  it('recovers a session fallback when the receipt write failed and settles only the competitor namespace', async () => {
    const original = Storage.prototype.setItem;
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key, value) {
        if (
          this === localStorage &&
          key === importGateKey('competitor', 'operator') &&
          JSON.parse(value).phase === 'accepted'
        )
          throw new Error('quota');
        original.call(this, key, value);
      });
    writeImportGate(sessionStorage, 'asin', 'operator', {
      phase: 'uncertain',
      taskId: primaryId,
      savedAt: 1,
    });
    const f = fixture();
    submit(choose());
    await screen.findByText(`任务编号：${competitorId}`);
    expect(
      readImportGate(localStorage, 'competitor', 'operator')?.taskId,
    ).toBeNull();
    expect(
      readImportGate(sessionStorage, 'competitor', 'operator')?.taskId,
    ).toBe(competitorId);
    f.unmount();
    spy.mockRestore();
    f.remount();
    await screen.findByText(`任务编号：${competitorId}`);
    f.snapshots.set(competitorId, task(competitorId, 'cancelled'));
    await f.refetch(competitorId);
    await screen.findByText(
      '导入任务已取消，可能已有部分行提交；请核对后再决定是否重试。',
    );
    expect(readImportGate(localStorage, 'competitor', 'operator')?.phase).toBe(
      'settled',
    );
    expect(readImportGate(sessionStorage, 'competitor', 'operator')).toBeNull();
    expect(readImportGate(sessionStorage, 'asin', 'operator')?.taskId).toBe(
      primaryId,
    );
    fireEvent.click(
      panel().getByRole('button', { name: '已核实原任务，允许重新导入' }),
    );
    await screen.findByText('请确认原任务不会继续写入后再重新导入。');
    expect(f.posts()).toHaveLength(1);
  });

  it.each([
    user({ permissions: ['asin:read'] }),
    user({ mustChangePassword: true }),
    user({
      user: {
        id: 'operator',
        username: 'operator',
        status: 'INACTIVE',
        force_password_change: false,
      },
    }),
  ])(
    'does not upload or recover task data without verified write authority',
    async (identity) => {
      writeImportGate(localStorage, 'competitor', 'operator', {
        phase: 'accepted',
        taskId: competitorId,
        savedAt: 1,
      });
      const f = fixture({ identity });
      expect(
        screen.queryByRole('button', { name: '导入 CSV / XLSX' }),
      ).toBeNull();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it('revokes authority during upload, aborts work and leaves the original owner gate for reconciliation', async () => {
    const f = fixture({ upload: (_url, init) => abortable(init) });
    submit(choose());
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    f.change(user({ permissions: ['asin:read'] }));
    await waitFor(() => expect(f.posts()[0][1]?.signal?.aborted).toBe(true));
    expect(screen.queryByRole('region', { name: '竞品 ASIN 导入' })).toBeNull();
    await waitFor(() =>
      expect(
        readImportGate(localStorage, 'competitor', 'operator')?.phase,
      ).toBe('uncertain'),
    );
    expect(f.posts()).toHaveLength(1);
  });

  it('does not claim a queued competitor upload after permission is revoked', async () => {
    const f = fixture();
    const ready = deferred<void>();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async <T,>(_name: string, callback: () => T) => {
          await ready.promise;
          return callback();
        },
      },
    });
    submit(choose());
    f.change(user({ permissions: ['asin:read'] }));
    await act(async () => ready.resolve());
    expect(f.posts()).toHaveLength(0);
    expect(readImportGate(localStorage, 'competitor', 'operator')).toBeNull();
  });

  it('does not read task data without asin:read and requires explicit reconciliation', () => {
    writeImportGate(localStorage, 'competitor', 'operator', {
      phase: 'accepted',
      taskId: competitorId,
      savedAt: 1,
    });
    const f = fixture({ identity: user({ permissions: ['asin:write'] }) });
    expect(screen.getByText(`任务编号：${competitorId}`)).toBeDefined();
    expect(
      panel().getByRole('button', { name: '已核实原任务，允许重新导入' }),
    ).toBeDefined();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(['owner', 'session'])(
    'remounts on %s changes and cancels an old task read before showing new state',
    async (kind) => {
      let signal: AbortSignal | null | undefined;
      const f = fixture({
        taskRead: (_id, init) => {
          signal = init.signal;
          return abortable(init);
        },
      });
      submit(choose());
      await screen.findByText(`任务编号：${competitorId}`);
      await waitFor(() => expect(signal).toBeDefined());
      const before = signal;
      f.change(
        kind === 'owner'
          ? user({
              user: {
                id: 'other',
                username: 'other',
                status: 'ACTIVE',
                force_password_change: false,
              },
            })
          : user({ sessionId: 'session-b' }),
      );
      await waitFor(() => expect(before?.aborted).toBe(true));
      expect(f.posts()).toHaveLength(1);
      if (kind === 'owner') {
        expect(screen.queryByText(`任务编号：${competitorId}`)).toBeNull();
        expect(
          readImportGate(localStorage, 'competitor', 'operator')?.taskId,
        ).toBe(competitorId);
        expect(readImportGate(localStorage, 'competitor', 'other')).toBeNull();
      } else {
        await screen.findByText(`任务编号：${competitorId}`);
        expect(
          (panel().getByLabelText('选择文件') as HTMLInputElement).value,
        ).toBe('');
      }
    },
  );

  it('clears a definite forbidden competitor upload and refreshes authority without replay', async () => {
    const f = fixture({
      upload: async () =>
        jsonResponse(
          { success: false, errorCode: 403, errorMessage: '权限不足' },
          403,
        ),
    });
    submit(choose());
    await waitFor(() => expect(f.identity.refresh).toHaveBeenCalledOnce());
    expect(readImportGate(localStorage, 'competitor', 'operator')).toBeNull();
    expect(
      screen.queryByRole('button', { name: '导入 CSV / XLSX' }),
    ).toBeNull();
    expect(f.posts()).toHaveLength(1);
  });

  it('ignores primary and another owner storage events while recovering a competitor event', async () => {
    const f = fixture();
    writeImportGate(localStorage, 'asin', 'operator', {
      phase: 'accepted',
      taskId: primaryId,
      savedAt: 1,
    });
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: importGateKey('asin', 'operator'),
        storageArea: localStorage,
      }),
    );
    writeImportGate(localStorage, 'competitor', 'other', {
      phase: 'accepted',
      taskId: primaryId,
      savedAt: 1,
    });
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: importGateKey('competitor', 'other'),
        storageArea: localStorage,
      }),
    );
    expect(f.fetcher).not.toHaveBeenCalled();
    writeImportGate(localStorage, 'competitor', 'operator', {
      phase: 'accepted',
      taskId: competitorId,
      savedAt: 2,
    });
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: importGateKey('competitor', 'operator'),
        storageArea: localStorage,
      }),
    );
    await screen.findByText(`任务编号：${competitorId}`);
    expect(f.posts()).toHaveLength(0);
  });
});
