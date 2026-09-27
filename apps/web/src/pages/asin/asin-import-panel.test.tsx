// @vitest-environment jsdom
import type { TaskInfo } from '@asin-monitor/contracts';
import { QueryClient } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import { ApiError } from '../../lib/http';
import type { createTransportRuntime } from '../../services/runtime';
import { asinImportGateKey, writeAsinImportGate } from './asin-import-gate';
import { AsinImportPanel } from './asin-import-panel';

const taskSnapshot = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../../hooks/tasks', () => ({
  useTaskQuery: () => ({ data: taskSnapshot.current, isError: false }),
}));

const taskId = 'b2b5894c-5802-4c9f-a1bd-9a20263d270a';
const accepted = {
  success: true,
  errorCode: 0,
  data: { taskId, status: 'pending' },
};

function task(status: string): TaskInfo {
  return {
    taskId,
    taskType: 'import',
    taskSubType: 'asin-import',
    title: '主营 ASIN 导入',
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

function fixture(
  request: ReturnType<typeof vi.fn> = vi.fn(async () => accepted),
  permissions = ['asin:read', 'asin:write'],
) {
  let state = {
    status: 'authenticated' as const,
    identity: {
      user: { id: 'operator', username: 'operator', status: 'ACTIVE' as const },
      roles: [],
      permissions,
    },
  };
  const subscribers = new Set<() => void>();
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    refresh: vi.fn(async () => {
      state = {
        ...state,
        identity: { ...state.identity, permissions: ['asin:read'] },
      };
      for (const listener of subscribers) listener();
      return state;
    }),
  } as unknown as IdentityStore;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const runtime = {
    http: { request },
    queryClient,
  } as unknown as ReturnType<typeof createTransportRuntime>;
  const announce = vi.fn();
  const page = () => (
    <AuthContext.Provider value={{ identity, runtime, announce }}>
      <AsinImportPanel />
    </AuthContext.Provider>
  );
  const view = render(page());
  return {
    request,
    identity,
    invalidate,
    announce,
    rerender: () => view.rerender(page()),
  };
}

function installLocks() {
  let prior = Promise.resolve();
  const request = vi.fn(
    async <T,>(_name: string, callback: () => Promise<T> | T) => {
      const before = prior;
      let release!: () => void;
      prior = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      try {
        return await callback();
      } finally {
        release();
      }
    },
  );
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: { request },
  });
  return request;
}

function chooseFile() {
  fireEvent.click(screen.getByRole('button', { name: '导入 CSV / XLSX' }));
  const input = screen.getByLabelText('选择文件');
  const file = new File(['变体组名称,国家\nGroup,US'], 'items.csv');
  fireEvent.change(input, {
    target: {
      files: {
        0: file,
        length: 1,
        item: (index: number) => (index ? null : file),
      },
    },
  });
  fireEvent.click(screen.getByRole('button', { name: '上传并创建导入任务' }));
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Reflect.deleteProperty(window.navigator, 'locks');
  taskSnapshot.current = undefined;
});

describe('primary ASIN import page', () => {
  it('shows no upload entry without the write permission', () => {
    installLocks();
    fixture(undefined, ['asin:read']);
    expect(
      screen.queryByRole('button', { name: '导入 CSV / XLSX' }),
    ).toBeNull();
  });

  it('accepts a task, then unlocks and refreshes the catalog only after completion', async () => {
    installLocks();
    const f = fixture();
    chooseFile();
    await screen.findByText('文件已受理为异步任务，等待任务中心确认处理结果。');
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toContain('accepted');
    taskSnapshot.current = task('completed');
    f.rerender();
    await screen.findByText(
      '导入任务已完成，请核对任务中心的成功、失败行与报告。',
    );
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toBeNull();
    expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ['asin'] });
  });

  it('keeps an uncertain lock after local cancellation and does not repeat the upload', async () => {
    installLocks();
    const request = vi.fn(
      (_path: string, options: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new ApiError('CANCELLED', '已停止本地请求')),
          );
        }),
    );
    fixture(request);
    chooseFile();
    fireEvent.click(
      await screen.findByRole('button', { name: '取消本地上传' }),
    );
    await screen.findByText(
      '提交状态未确认，请按提交时间和文件到任务中心核实，避免重复导入。',
    );
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toContain('uncertain');
    expect(request).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: '上传并创建导入任务' }),
    ).toHaveProperty('disabled', true);
  });

  it('removes a definitively rejected upload after 403 and hides the entry', async () => {
    installLocks();
    const request = vi.fn(async () => {
      throw new ApiError('HTTP', '已撤销权限', 403);
    });
    const f = fixture(request);
    chooseFile();
    await waitFor(() => expect(f.identity.refresh).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: '导入 CSV / XLSX' }),
      ).toBeNull(),
    );
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toBeNull();
    expect(f.announce).not.toHaveBeenCalled();
  });

  it('syncs a task accepted in another tab and retains failed tasks for reconciliation', async () => {
    installLocks();
    const f = fixture();
    writeAsinImportGate(window.localStorage, 'operator', {
      phase: 'accepted',
      taskId,
      savedAt: Date.now(),
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: asinImportGateKey('operator'),
        storageArea: window.localStorage,
      }),
    );
    await screen.findByText(`任务编号：${taskId}`);
    taskSnapshot.current = task('failed');
    f.rerender();
    await screen.findByText(
      '导入任务失败，可能已有部分行提交；请核对后再决定是否重试。',
    );
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toContain('uncertain');
    expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ['asin'] });
  });

  it('refreshes the catalog when another tab clears a finished import', async () => {
    installLocks();
    const f = fixture();
    const key = asinImportGateKey('operator');
    writeAsinImportGate(window.localStorage, 'operator', {
      phase: 'accepted',
      taskId,
      savedAt: Date.now(),
    });
    window.dispatchEvent(
      new StorageEvent('storage', { key, storageArea: window.localStorage }),
    );
    await screen.findByText(`任务编号：${taskId}`);

    window.localStorage.removeItem(key);
    window.dispatchEvent(
      new StorageEvent('storage', { key, storageArea: window.localStorage }),
    );
    await screen.findByText(/上次任务编号/);
    expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ['asin'] });
    expect(screen.queryByText(`任务编号：${taskId}`)).toBeNull();
  });

  it.each(['completed', 'failed'])(
    'does not let a stale %s result overwrite another tab upload',
    async (status) => {
      let release!: () => void;
      const requested = vi.fn(
        async <T,>(_name: string, callback: () => Promise<T> | T) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return callback();
        },
      );
      Object.defineProperty(window.navigator, 'locks', {
        configurable: true,
        value: { request: requested },
      });
      const f = fixture();
      writeAsinImportGate(window.localStorage, 'operator', {
        phase: 'accepted',
        taskId,
        savedAt: Date.now(),
      });
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: asinImportGateKey('operator'),
          storageArea: window.localStorage,
        }),
      );
      await screen.findByText(`任务编号：${taskId}`);
      taskSnapshot.current = task(status);
      f.rerender();
      await waitFor(() => expect(requested).toHaveBeenCalledOnce());
      const nextTaskId = 'a161cbe4-e935-4613-9af9-f90c3ef3d313';
      writeAsinImportGate(window.localStorage, 'operator', {
        phase: 'accepted',
        taskId: nextTaskId,
        savedAt: Date.now(),
      });
      release();
      await screen.findByText(`任务编号：${nextTaskId}`);
      expect(
        window.localStorage.getItem(asinImportGateKey('operator')),
      ).toContain(nextTaskId);
    },
  );
});
