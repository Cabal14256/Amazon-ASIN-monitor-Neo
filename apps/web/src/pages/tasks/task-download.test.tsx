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
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import TaskCenterPage from './index';

// Keep the page, Query, TaskApi and HttpClient real; replace shell/motion only.
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../components/ui/motion', () => ({
  MotionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Entrance: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const id = '123e4567-e89b-42d3-a456-426614174000';
const mime =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const exported = (): TaskInfo => ({
  taskId: id,
  taskType: 'export',
  taskSubType: 'asin',
  title: 'ASIN导出',
  status: 'completed',
  progress: 100,
  message: '导出完成',
  error: null,
  createdAt: null,
  updatedAt: null,
  startedAt: null,
  completedAt: null,
  cancelRequestedAt: null,
  cancelledAt: null,
  canCancel: false,
  filename: 'ASIN数据_2026-10-07.xlsx',
  downloadUrl: `/api/v1/tasks/${id}/download`,
  result: {
    exportType: 'asin',
    filename: 'ASIN数据_2026-10-07.xlsx',
    mimeType: mime,
    fileSizeBytes: 4,
    artifact: {
      taskId: id,
      key: `export-${id}.xlsx`,
      bytes: 4,
      sha256: 'a'.repeat(64),
    },
  },
});
const user = (): CurrentUserData => ({
  user: {
    id: 'operator',
    username: 'operator',
    status: 'ACTIVE',
    force_password_change: false,
  },
  roles: [],
  permissions: ['asin:read'],
  sessionId: 'session-a',
  mustChangePassword: false,
  passwordExpired: false,
});
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
function fixture(
  options: {
    task?: TaskInfo;
    identity?: CurrentUserData;
    download?: (init: RequestInit) => Promise<Response>;
  } = {},
) {
  let state = {
    status: 'authenticated' as const,
    identity: options.identity ?? user(),
  };
  const subscribers = new Set<() => void>();
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  } as unknown as IdentityStore;
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/download'))
      return (
        options.download?.(init) ??
        new Response(new Uint8Array([80, 75, 3, 4]), {
          headers: { 'content-type': mime },
        })
      );
    return jsonResponse({
      success: true,
      errorCode: 0,
      data: url.includes(`/tasks/${id}`)
        ? options.task ?? exported()
        : [options.task ?? exported()],
    });
  });
  const runtime = createTransportRuntime({
    baseURL: 'https://app.test/api/',
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  runtimes.push(runtime);
  const objectURL = vi.fn(() => 'blob:fixture');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: objectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  const filenames: string[] = [];
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      filenames.push(this.download);
    });
  const view = render(
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <TaskCenterPage />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return {
    runtime,
    fetcher,
    objectURL,
    filenames,
    click,
    unmount: view.unmount,
    change: (next: CurrentUserData) =>
      act(() => {
        state = { ...state, identity: next };
        for (const listener of subscribers) listener();
      }),
    files: () =>
      fetcher.mock.calls.filter(([input]) =>
        String(input).endsWith('/download'),
      ),
  };
}
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  Reflect.deleteProperty(window, 'isSecureContext');
  vi.restoreAllMocks();
});

describe('task center ASIN export fallback download', () => {
  it('uses the same direct file stream from the actual mounted task detail download action', async () => {
    const sink = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const picker = vi.fn(async () => ({ createWritable: async () => sink }));
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });
    const f = fixture();
    fireEvent.click(await screen.findByRole('button', { name: '详情' }));
    const detail = await screen.findByLabelText('任务详情');
    fireEvent.click(
      await within(detail).findByRole('button', { name: '下载结果' }),
    );
    await waitFor(() => expect(sink.close).toHaveBeenCalledOnce());
    expect(picker).toHaveBeenCalledOnce();
    expect(f.files()).toHaveLength(1);
    expect(f.objectURL).not.toHaveBeenCalled();
  });
  it.each(['owner', 'session', 'permission', 'password'] as const)(
    'aborts the native file stream on %s changes while disk write is pending and never closes it',
    async (kind) => {
      const writing = deferred<void>();
      const sink = {
        write: vi.fn(() => writing.promise),
        close: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      };
      Object.defineProperty(window, 'isSecureContext', {
        configurable: true,
        value: true,
      });
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: async () => ({ createWritable: async () => sink }),
      });
      const f = fixture();
      fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
      await waitFor(() => expect(sink.write).toHaveBeenCalledOnce());
      const next = user();
      if (kind === 'owner') next.user = { ...next.user, id: 'other' };
      if (kind === 'session') next.sessionId = 'session-b';
      if (kind === 'permission') next.permissions = [];
      if (kind === 'password') next.mustChangePassword = true;
      f.change(next);
      await waitFor(() => expect(sink.abort).toHaveBeenCalledOnce());
      expect(f.files()[0][1]?.signal?.aborted).toBe(true);
      await act(async () => {
        writing.resolve();
      });
      expect(sink.close).not.toHaveBeenCalled();
      expect(f.objectURL).not.toHaveBeenCalled();
    },
  );
  it('lets the user cancel an active file stream without reporting a business failure', async () => {
    const writing = deferred<void>();
    const sink = {
      write: vi.fn(() => writing.promise),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({ createWritable: async () => sink }),
    });
    const f = fixture();
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    await waitFor(() => expect(sink.write).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '取消文件下载' }));
    await waitFor(() => expect(sink.abort).toHaveBeenCalledOnce());
    expect(f.files()[0][1]?.signal?.aborted).toBe(true);
    await act(async () => {
      writing.resolve();
    });
    expect(sink.close).not.toHaveBeenCalled();
    expect(screen.queryByText(/下载失败/)).toBeNull();
  });
  it('waits for final close before completing the save action', async () => {
    const closing = deferred<void>();
    const sink = {
      write: vi.fn(async () => undefined),
      close: vi.fn(() => closing.promise),
      abort: vi.fn(async () => undefined),
    };
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({ createWritable: async () => sink }),
    });
    const f = fixture();
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    await waitFor(() => expect(sink.close).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '下载结果' })).toHaveProperty(
      'disabled',
      true,
    );
    await act(async () => {
      closing.resolve();
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '下载结果' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(f.files()).toHaveLength(1);
    expect(f.objectURL).not.toHaveBeenCalled();
  });
  it('rejects a late picker result after same-owner session revision changes before opening any writable', async () => {
    const chosen = deferred<{ createWritable: () => Promise<never> }>();
    const createWritable = vi.fn(async () => {
      throw new Error('must not run');
    });
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: () => chosen.promise,
    });
    const f = fixture();
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    act(() => f.runtime.refreshSession());
    await act(async () => {
      chosen.resolve({ createWritable });
    });
    expect(createWritable).not.toHaveBeenCalled();
    expect(f.files()).toHaveLength(0);
  });
  it('opens the native save picker in the click gesture and streams the file without any Blob URL', async () => {
    const chosen = deferred<{
      createWritable: () => Promise<{
        write: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        abort: ReturnType<typeof vi.fn>;
      }>;
    }>();
    const sink = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const createWritable = vi.fn(async () => sink);
    const picker = vi.fn(() => chosen.promise);
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });
    const f = fixture();
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    expect(picker).toHaveBeenCalledOnce();
    expect(createWritable).not.toHaveBeenCalled();
    expect(f.files()).toHaveLength(0);
    await act(async () => {
      chosen.resolve({ createWritable });
    });
    await waitFor(() => expect(sink.close).toHaveBeenCalledOnce());
    expect(sink.write).toHaveBeenCalledOnce();
    expect(sink.abort).not.toHaveBeenCalled();
    expect(f.objectURL).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
    expect(f.files()).toHaveLength(1);
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'ASIN数据_2026-10-07.xlsx' }),
    );
  });
  it('does not start a large workbook GET without native file-save support and explains the smaller memory cap', async () => {
    const large = exported();
    const result = large.result as Record<string, unknown>;
    large.result = {
      ...result,
      fileSizeBytes: 256 * 1024 * 1024,
      artifact: { ...(result.artifact as object), bytes: 256 * 1024 * 1024 },
    };
    const f = fixture({ task: large });
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    await screen.findByText(/32 MiB.*Chrome.*Edge/);
    expect(f.files()).toHaveLength(0);
    expect(f.objectURL).not.toHaveBeenCalled();
  });
  it('treats user save-picker cancellation as cancellation and never sends a file request', async () => {
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    const picker = vi.fn(async () => {
      throw new DOMException('user cancelled', 'AbortError');
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });
    const f = fixture();
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    await act(async () => undefined);
    expect(picker).toHaveBeenCalledOnce();
    expect(f.files()).toHaveLength(0);
    expect(screen.queryByText(/下载失败/)).toBeNull();
  });
  it('ignores a late picker after leaving the page, without acquiring a writable or sending GET', async () => {
    const chosen = deferred<{ createWritable: () => Promise<never> }>();
    const createWritable = vi.fn(async () => {
      throw new Error('must not run');
    });
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: () => chosen.promise,
    });
    const f = fixture();
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    f.unmount();
    await act(async () => {
      chosen.resolve({ createWritable });
    });
    expect(createWritable).not.toHaveBeenCalled();
    expect(f.files()).toHaveLength(0);
  });
  it('downloads a completed background export using the actual XLSX filename and normalized authenticated endpoint', async () => {
    const f = fixture();
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    await waitFor(() => expect(f.click).toHaveBeenCalledOnce());
    expect(f.filenames).toEqual(['ASIN数据_2026-10-07.xlsx']);
    expect(f.objectURL).toHaveBeenCalledOnce();
    const [url, init] = f.files()[0];
    expect(url).toBe(`https://app.test/api/v1/tasks/${id}/download`);
    expect(String(url)).not.toContain('/api/api/');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });
  it.each([
    { task: { ...exported(), result: null } },
    { task: { ...exported(), filename: '../outside.xlsx' } },
    { task: { ...exported(), status: 'cancelled' } },
    { identity: { ...user(), permissions: [] } },
    { identity: { ...user(), mustChangePassword: true } },
  ])(
    'does not expose a workbook action for unsupported or unauthorized snapshots',
    async (options) => {
      const f = fixture(options);
      await screen.findByText('ASIN导出');
      expect(screen.queryByRole('button', { name: '下载结果' })).toBeNull();
      expect(f.files()).toHaveLength(0);
    },
  );
  it.each(['owner', 'session', 'permission', 'password'] as const)(
    'aborts an in-flight workbook on %s changes and never clicks a late response',
    async (kind) => {
      const pending = deferred<Response>();
      const f = fixture({ download: () => pending.promise });
      fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
      await waitFor(() => expect(f.files()).toHaveLength(1));
      const next = user();
      if (kind === 'owner') next.user = { ...next.user, id: 'other' };
      if (kind === 'session') next.sessionId = 'session-b';
      if (kind === 'permission') next.permissions = [];
      if (kind === 'password') next.mustChangePassword = true;
      f.change(next);
      await waitFor(() => expect(f.files()[0][1]?.signal?.aborted).toBe(true));
      await act(async () =>
        pending.resolve(
          new Response(new Uint8Array([80, 75, 3, 4]), {
            headers: { 'content-type': mime },
          }),
        ),
      );
      expect(f.objectURL).not.toHaveBeenCalled();
      expect(f.click).not.toHaveBeenCalled();
    },
  );
  it('does not create an object URL for an expired artifact and permits a deliberate retry', async () => {
    const f = fixture({
      download: async () =>
        jsonResponse(
          { success: false, errorMessage: '任务结果文件不存在或已过期' },
          404,
        ),
    });
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    await screen.findByText('下载失败：任务结果文件不存在或已过期');
    expect(f.objectURL).not.toHaveBeenCalled();
    expect(f.files()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '下载结果' }));
    await waitFor(() => expect(f.files()).toHaveLength(2));
  });
  it('aborts the transfer when leaving the task center', async () => {
    const pending = deferred<Response>();
    const f = fixture({ download: () => pending.promise });
    fireEvent.click(await screen.findByRole('button', { name: '下载结果' }));
    await waitFor(() => expect(f.files()).toHaveLength(1));
    f.unmount();
    expect(f.files()[0][1]?.signal?.aborted).toBe(true);
    await act(async () =>
      pending.resolve(
        new Response(new Uint8Array([80, 75, 3, 4]), {
          headers: { 'content-type': mime },
        }),
      ),
    );
    expect(f.click).not.toHaveBeenCalled();
  });
});
