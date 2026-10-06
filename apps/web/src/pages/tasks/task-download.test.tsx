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
  vi.restoreAllMocks();
});

describe('task center ASIN export fallback download', () => {
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
