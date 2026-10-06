// @vitest-environment jsdom
import type { CurrentUserData } from '@asin-monitor/contracts';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import type { RouteAuthState } from '../../auth/navigation';
import { deferred, jsonResponse } from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { taskFixture } from '../../services/task-fixtures';
import { TaskDetails } from '../tasks';
import { BackupPanel } from './backup-panel';
import { backupGateKey } from './backup-recovery';

const taskId = '10000000-0000-4000-8000-000000000221';
const file = {
  filename: 'backup_20261007-080000-01234567-primary.dump',
  format: 'custom',
  target: 'primary',
  size: 17,
  createdAt: '2026-10-07T00:00:00.000Z',
  timeSource: 'filename',
  restoreSupported: true,
  restoreMode: 'isolated',
  sourceEngine: 'postgresql',
  scope: 'full',
};
const config = {
  id: 1,
  enabled: false,
  scheduleType: 'daily',
  scheduleValue: null,
  backupTime: '02:00',
};
const user = (patch: Partial<CurrentUserData> = {}) =>
  ({
    user: { id: 'operator', username: 'operator', status: 'ACTIVE' },
    roles: [],
    permissions: ['settings:read', 'settings:write'],
    ...patch,
  } as CurrentUserData);
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
function installLocks() {
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn(async <T,>(key: string, work: () => T | Promise<T>) => {
    const before = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    tails.set(
      key,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await before;
    try {
      return await work();
    } finally {
      release();
    }
  });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request },
  });
}
function fixture(principal = user()) {
  let state: RouteAuthState = { status: 'authenticated', identity: principal };
  const listeners = new Set<() => void>();
  const change = (next: CurrentUserData) => {
    state = { status: 'authenticated', identity: next };
    for (const listener of listeners) listener();
  };
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => {
      change(user({ permissions: ['settings:read'] }));
      return state;
    }),
  } as unknown as IdentityStore;
  let listed = [file];
  let savedConfig = config;
  const write = vi.fn(async () =>
    jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
  );
  const list = vi.fn(async () => jsonResponse({ success: true, data: listed }));
  const task = vi.fn(async () =>
    jsonResponse({
      success: true,
      data: taskFixture({
        taskId,
        taskType: 'backup',
        taskSubType: 'create',
        status: 'completed',
        canCancel: false,
      }),
    }),
  );
  const scheduled = vi.fn(async () =>
    jsonResponse({ success: true, data: [] }),
  );
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith('/api/v1/tasks/')) return task();
    if (path.endsWith('/scheduled-tasks')) return scheduled();
    if (path.endsWith('/config')) {
      if (options?.method === 'POST')
        savedConfig = { ...config, ...JSON.parse(String(options.body)) };
      return jsonResponse({ success: true, data: savedConfig });
    }
    if (options?.method === 'POST') return write();
    if (options?.method === 'DELETE') {
      listed = [];
      return jsonResponse({ success: true, data: { message: '删除成功' } });
    }
    return list();
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
      <BackupPanel />
    </AuthContext.Provider>
  );
  const view = render(page());
  return {
    runtime,
    identity,
    change,
    write,
    list,
    task,
    scheduled,
    fetcher,
    announce,
    view,
    page,
  };
}
beforeEach(installLocks);
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  localStorage.clear();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  Reflect.deleteProperty(window, 'isSecureContext');
  vi.restoreAllMocks();
});
const ready = () =>
  waitFor(() =>
    expect(
      screen.getByRole('button', { name: '隔离恢复' }).hasAttribute('disabled'),
    ).toBe(false),
  );

describe('actual Neo backup panel security and task continuation', () => {
  it('does not send even read requests for settings:read-only users', () => {
    const f = fixture(user({ permissions: ['settings:read'] }));
    expect(screen.getByText(/都需要当前有效的 settings:write/)).toBeTruthy();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { mustChangePassword: true },
    { passwordExpired: true },
    { user: { ...user().user, force_password_change: true } },
  ])(
    'does not request backup data before mandatory password repair: %j',
    (patch) => {
      const f = fixture(user(patch));
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('button', { name: '创建异步备份任务' }),
      ).toBeNull();
    },
  );
  it.each(['primary', 'competitor'])(
    'creates one real asynchronous %s request and keeps its receipt across remount',
    async (target) => {
      const f = fixture();
      await ready();
      fireEvent.change(screen.getByLabelText('目标数据库'), {
        target: { value: target },
      });
      fireEvent.click(screen.getByRole('button', { name: '创建异步备份任务' }));
      await waitFor(() => expect(f.write).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(screen.getByText(new RegExp(taskId))).toBeTruthy(),
      );
      const call = f.fetcher.mock.calls.find(
        ([, options]) => options?.method === 'POST',
      )!;
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({
        target,
        useAsync: true,
      });
      expect(
        screen
          .getByRole('button', { name: '创建异步备份任务' })
          .hasAttribute('disabled'),
      ).toBe(true);
      f.view.unmount();
      render(f.page());
      await waitFor(() =>
        expect(screen.getByText(new RegExp(taskId))).toBeTruthy(),
      );
      expect(f.write).toHaveBeenCalledOnce();
    },
  );
  it('keeps an unknown 500 ACK, uses only GET to query, and requires verification plus fresh GET to clear', async () => {
    const f = fixture();
    await ready();
    f.write.mockResolvedValueOnce(
      jsonResponse(
        { success: false, errorCode: 500, data: { taskId, status: 'unknown' } },
        500,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '创建异步备份任务' }));
    await waitFor(() =>
      expect(screen.getByText(new RegExp(taskId))).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: '查询原任务' }));
    await waitFor(() => expect(f.task).toHaveBeenCalledOnce());
    expect(localStorage.getItem(backupGateKey('operator'))).toContain(taskId);
    fireEvent.click(screen.getByRole('checkbox', { name: /已核实原任务/ }));
    fireEvent.click(
      screen.getByRole('button', { name: '已核实，重读列表并解除保护' }),
    );
    await waitFor(() =>
      expect(localStorage.getItem(backupGateKey('operator'))).toBeNull(),
    );
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.list.mock.calls.length).toBeGreaterThan(1);
  });
  it('keeps a lost network outcome guarded without inventing a lookup ID', async () => {
    const f = fixture();
    await ready();
    f.write.mockRejectedValueOnce(new TypeError('network lost'));
    fireEvent.click(screen.getByRole('button', { name: '创建异步备份任务' }));
    await waitFor(() => expect(screen.getByText(/编号未确认/)).toBeTruthy());
    expect(
      screen
        .getByRole('button', { name: '查询原任务' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(localStorage.getItem(backupGateKey('operator'))).not.toBeNull();
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('re-reads selected restore capability and does not POST when it changed after confirmation', async () => {
    const f = fixture();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '隔离恢复' }));
    expect(
      screen.getByRole('alertdialog', { name: '确认恢复备份' }).textContent,
    ).toContain('在线数据库不会切换');
    expect(f.write).not.toHaveBeenCalled();
    f.list.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [{ ...file, restoreMode: 'in-place', scope: 'selective' }],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }));
    await waitFor(() =>
      expect(screen.getByText(/归档或恢复能力已改变/)).toBeTruthy(),
    );
    expect(f.write).not.toHaveBeenCalled();
    expect(localStorage.getItem(backupGateKey('operator'))).toBeNull();
  });
  it('sends a real async restore only after fresh capability and explicit confirmation', async () => {
    const f = fixture();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '隔离恢复' }));
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }));
    await waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    const call = f.fetcher.mock.calls.find(
      ([, options]) => options?.method === 'POST',
    )!;
    expect(String(call[0])).toContain('/api/v1/backup/restore');
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      filename: file.filename,
      target: 'primary',
      useAsync: true,
    });
    expect(f.list.mock.calls.length).toBeGreaterThan(1);
  });
  it('confirms deletion and refreshes list through the real DELETE endpoint', async () => {
    const f = fixture();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '删除归档' }));
    expect(
      f.fetcher.mock.calls.some(([, options]) => options?.method === 'DELETE'),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() =>
      expect(screen.getByText('暂无经过验证的 Neo 备份归档。')).toBeTruthy(),
    );
    const call = f.fetcher.mock.calls.find(
      ([, options]) => options?.method === 'DELETE',
    )!;
    expect(String(call[0]).endsWith(`/api/v1/backup/${file.filename}`)).toBe(
      true,
    );
  });
  it('saves complete Shanghai plan fields without borrowing current-user cancellation rights', async () => {
    const f = fixture();
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: '启用自动备份' }));
    fireEvent.change(screen.getByLabelText('计划频率'), {
      target: { value: 'monthly' },
    });
    fireEvent.change(screen.getByLabelText('日期'), {
      target: { value: '31' },
    });
    fireEvent.change(screen.getByLabelText('上海执行时间'), {
      target: { value: '00:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存自动备份计划' }));
    await waitFor(() => expect(f.announce).toHaveBeenCalled());
    const call = f.fetcher.mock.calls.find(
      ([input, options]) =>
        String(input).endsWith('/config') && options?.method === 'POST',
    )!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      enabled: true,
      scheduleType: 'monthly',
      scheduleValue: 31,
      backupTime: '00:00',
    });
    expect(screen.queryByRole('button', { name: /取消任务/ })).toBeNull();
  });
  it('retains peer-cleared protection after failed GET and exposes a GET-only retry', async () => {
    localStorage.setItem(
      backupGateKey('operator'),
      JSON.stringify({
        operation: 'create',
        target: 'primary',
        requestId: 'request-old',
        submittedAt: 1000,
        state: 'unknown',
      }),
    );
    const f = fixture();
    await waitFor(() => expect(screen.getByText(file.filename)).toBeTruthy());
    f.list.mockResolvedValueOnce(
      jsonResponse({ success: false, errorCode: 500 }, 500),
    );
    localStorage.removeItem(backupGateKey('operator'));
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: backupGateKey('operator'),
          newValue: null,
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: '创建异步备份任务' })
          .hasAttribute('disabled'),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByText(/其他窗口已解除原保护/)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: '仅重读备份列表' }));
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: '创建异步备份任务' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    expect(f.write).not.toHaveBeenCalled();
  });
  it('isolates a late owner-A submission from owner B and aborts the old request', async () => {
    const f = fixture();
    await ready();
    const pending = deferred<Response>();
    f.write.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '创建异步备份任务' }));
    await waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    const call = f.fetcher.mock.calls.find(
      ([, options]) => options?.method === 'POST',
    )!;
    act(() => f.change(user({ user: { ...user().user, id: 'another' } })));
    expect(call[1]?.signal?.aborted).toBe(true);
    pending.resolve(
      jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
    );
    await ready();
    expect(screen.queryByText(new RegExp(taskId))).toBeNull();
    expect(localStorage.getItem(backupGateKey('operator'))).not.toBeNull();
    expect(localStorage.getItem(backupGateKey('another'))).toBeNull();
  });
  it('aborts outstanding reads and removes sensitive backup context on permission revocation', async () => {
    const pending = deferred<Response>();
    const f = fixture();
    await ready();
    f.list.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '刷新备份列表' }));
    const call = f.fetcher.mock.calls.at(-1)!;
    act(() => f.change(user({ permissions: ['settings:read'] })));
    expect(call[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByText(file.filename)).toBeNull();
    pending.resolve(jsonResponse({ success: true, data: [file] }));
    await act(async () => undefined);
    expect(screen.queryByText(file.filename)).toBeNull();
  });
  it('aborts owner-stable session changes and never attaches the old late ACK to the new session', async () => {
    const f = fixture();
    await ready();
    const pending = deferred<Response>();
    f.write.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '创建异步备份任务' }));
    await waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    const call = f.fetcher.mock.calls.find(
      ([, options]) => options?.method === 'POST',
    )!;
    act(() => f.runtime.refreshSession());
    expect(call[1]?.signal?.aborted).toBe(true);
    pending.resolve(
      jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
    );
    await act(async () => undefined);
    expect(screen.queryByText(new RegExp(taskId))).toBeNull();
    expect(localStorage.getItem(backupGateKey('operator'))).not.toBeNull();
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('cancels superseded list reads so an old response cannot replace the latest artifact scope', async () => {
    const f = fixture();
    await ready();
    const pending = deferred<Response>();
    f.list.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '刷新备份列表' }));
    const oldCall = f.fetcher.mock.calls.at(-1)!;
    const next = {
      ...file,
      target: 'competitor',
      filename: file.filename.replace('-primary.dump', '-competitor.dump'),
    };
    f.list.mockResolvedValueOnce(jsonResponse({ success: true, data: [next] }));
    fireEvent.click(screen.getByRole('button', { name: '刷新备份列表' }));
    await waitFor(() => expect(screen.getByText(next.filename)).toBeTruthy());
    expect(oldCall[1]?.signal?.aborted).toBe(true);
    pending.resolve(jsonResponse({ success: true, data: [file] }));
    await act(async () => undefined);
    expect(screen.queryByText(file.filename)).toBeNull();
    expect(screen.getByText(next.filename)).toBeTruthy();
  });
  it('discards a late original-task lookup after a peer replaces the reservation', async () => {
    const oldGate = {
      operation: 'create',
      target: 'primary',
      requestId: 'request-old',
      submittedAt: 1000,
      state: 'task',
      taskId,
    };
    localStorage.setItem(backupGateKey('operator'), JSON.stringify(oldGate));
    const f = fixture();
    await waitFor(() => expect(screen.getByText(file.filename)).toBeTruthy());
    const pending = deferred<Response>();
    f.task.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '查询原任务' }));
    await waitFor(() => expect(f.task).toHaveBeenCalledOnce());
    const replacement = JSON.stringify({
      ...oldGate,
      requestId: 'request-new',
      taskId: '20000000-0000-4000-8000-000000000221',
    });
    localStorage.setItem(backupGateKey('operator'), replacement);
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: backupGateKey('operator'),
          newValue: replacement,
        }),
      ),
    );
    pending.resolve(
      jsonResponse({
        success: true,
        data: taskFixture({
          taskId,
          taskType: 'backup',
          taskSubType: 'create',
          status: 'completed',
          message: 'OLD_BACKUP_RESULT',
        }),
      }),
    );
    await act(async () => undefined);
    expect(screen.queryByText(/OLD_BACKUP_RESULT/)).toBeNull();
    expect(
      screen.getByText(/20000000-0000-4000-8000-000000000221/),
    ).toBeTruthy();
  });
  it('stops a pending user picker on leaving the page before writable or GET acquisition', async () => {
    const f = fixture();
    await ready();
    const pending = deferred<{ createWritable: () => Promise<never> }>();
    const createWritable = vi.fn(async () => {
      throw new Error('must not run');
    });
    const picker = vi.fn(() => pending.promise);
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });
    fireEvent.click(screen.getByRole('button', { name: '下载归档' }));
    expect(picker).toHaveBeenCalledOnce();
    const count = f.fetcher.mock.calls.length;
    f.view.unmount();
    pending.resolve({ createWritable });
    await act(async () => undefined);
    expect(createWritable).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledTimes(count);
  });
  it('renders committed unconfirmed restoration in the actual task detail component even for failed registry state', () => {
    render(
      <TaskDetails
        task={taskFixture({
          taskType: 'backup',
          taskSubType: 'restore',
          status: 'failed',
          result: {
            operation: 'restore',
            restoreMode: 'in-place',
            targetDatabaseChanged: true,
            verification: 'unconfirmed',
          },
        })}
        canReadASIN={false}
      />,
    );
    expect(
      screen.getByRole('region', { name: '备份恢复回执' }).textContent,
    ).toContain('在线目标数据库已变更');
    expect(screen.getByText(/提交后的验证尚未确认/)).toBeTruthy();
  });
});
