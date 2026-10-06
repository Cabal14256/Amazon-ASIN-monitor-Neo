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

const taskSnapshot = vi.hoisted(() => ({
  current: undefined as unknown,
  error: false,
}));
vi.mock('../../hooks/tasks', () => ({
  useTaskQuery: () => ({
    data: taskSnapshot.current,
    isError: taskSnapshot.error,
  }),
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
  window.sessionStorage.clear();
  Reflect.deleteProperty(window.navigator, 'locks');
  taskSnapshot.current = undefined;
  taskSnapshot.error = false;
  vi.restoreAllMocks();
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

  it.each(['completed', 'failed', 'cancelled'])(
    'retries a failed %s gate write in place after storage recovers',
    async (status) => {
      installLocks();
      const f = fixture();
      chooseFile();
      await screen.findByText(
        '文件已受理为异步任务，等待任务中心确认处理结果。',
      );
      const setItem = Storage.prototype.setItem;
      const removeItem = Storage.prototype.removeItem;
      let unavailable = true;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key,
        value,
      ) {
        if (unavailable && this === window.localStorage)
          throw new Error('temporary');
        setItem.call(this, key, value);
      });
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
        this: Storage,
        key,
      ) {
        if (unavailable && this === window.localStorage)
          throw new Error('temporary');
        removeItem.call(this, key);
      });
      taskSnapshot.current = task(status);
      f.rerender();
      const retry = await screen.findByRole('button', {
        name: '重试保存任务状态',
      });
      expect(
        window.localStorage.getItem(asinImportGateKey('operator')),
      ).toContain('accepted');
      expect(
        screen.queryByRole('button', { name: '已核实原任务，允许重新导入' }),
      ).toBeNull();
      unavailable = false;
      fireEvent.click(retry);
      await waitFor(() => expect(f.invalidate).toHaveBeenCalledOnce());
      expect(f.request).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole('button', { name: '重试保存任务状态' }),
      ).toBeNull();
      if (status === 'completed') {
        expect(
          window.localStorage.getItem(asinImportGateKey('operator')),
        ).toBeNull();
        expect(screen.getByLabelText('选择文件')).toHaveProperty(
          'disabled',
          false,
        );
      } else {
        expect(
          window.localStorage.getItem(asinImportGateKey('operator')),
        ).toContain('settled');
        expect(
          screen.getByRole('button', { name: '已核实原任务，允许重新导入' }),
        ).toBeTruthy();
        cleanup();
        const reloaded = fixture();
        await screen.findByText(
          '任务已结束，可能已有部分行提交；请核对结果后再解锁。',
        );
        expect(reloaded.invalidate).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ['unknown', 'completed'],
    ['unknown', 'failed'],
    ['unknown', 'cancelled'],
    ['session', 'completed'],
    ['session', 'failed'],
    ['session', 'cancelled'],
  ])(
    'settles a %s task after reload when it becomes %s',
    async (source, status) => {
      installLocks();
      const setItem = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key,
        value,
      ) {
        if (
          source === 'session' &&
          this === window.localStorage &&
          value.includes('"phase":"accepted"')
        )
          throw new Error('quota');
        setItem.call(this, key, value);
      });
      const request = vi.fn(async () => {
        if (source === 'unknown')
          throw new ApiError('HTTP', 'unknown', 500, 500, {
            taskId,
            status: 'unknown',
          });
        return accepted;
      });
      fixture(request);
      chooseFile();
      await screen.findByText(`任务编号：${taskId}`);
      cleanup();
      const reloaded = fixture();
      await screen.findByText(`任务编号：${taskId}`);
      taskSnapshot.current = task(status);
      reloaded.rerender();
      await waitFor(() => expect(reloaded.invalidate).toHaveBeenCalledOnce());
      expect(
        window.sessionStorage.getItem(asinImportGateKey('operator')),
      ).toBeNull();
      expect(request).toHaveBeenCalledOnce();
      expect(reloaded.request).not.toHaveBeenCalled();
      if (status === 'completed') {
        expect(
          window.localStorage.getItem(asinImportGateKey('operator')),
        ).toBeNull();
        await screen.findByText(
          '导入任务已完成，请核对任务中心的成功、失败行与报告。',
        );
      } else {
        expect(
          window.localStorage.getItem(asinImportGateKey('operator')),
        ).toContain('settled');
        expect(
          screen.getByRole('button', { name: '已核实原任务，允许重新导入' }),
        ).toBeTruthy();
      }
    },
  );

  it('settles the known in-memory task after both task ID stores fail', async () => {
    installLocks();
    const setItem = Storage.prototype.setItem;
    let unavailable = true;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (
        unavailable &&
        (value.includes('"phase":"accepted"') ||
          value.includes('"phase":"uncertain"'))
      )
        throw new Error('quota');
      setItem.call(this, key, value);
    });
    const f = fixture();
    chooseFile();
    await screen.findByText(`任务编号：${taskId}`);
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toContain('sending');
    expect(
      window.sessionStorage.getItem(asinImportGateKey('operator')),
    ).toBeNull();
    unavailable = false;
    taskSnapshot.current = task('failed');
    f.rerender();
    await waitFor(() => expect(f.invalidate).toHaveBeenCalledOnce());
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toContain('settled');
    expect(f.request).toHaveBeenCalledOnce();
  });

  it('retries clearing a session fallback after the completed local gate was removed', async () => {
    installLocks();
    writeAsinImportGate(window.localStorage, 'operator', {
      phase: 'sending',
      taskId: null,
      savedAt: 10,
    });
    writeAsinImportGate(window.sessionStorage, 'operator', {
      phase: 'uncertain',
      taskId,
      savedAt: 10,
    });
    const removeItem = Storage.prototype.removeItem;
    let unavailable = true;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key,
    ) {
      if (unavailable && this === window.sessionStorage)
        throw new Error('temporary');
      removeItem.call(this, key);
    });
    taskSnapshot.current = task('completed');
    const f = fixture();
    const retry = await screen.findByRole('button', {
      name: '重试保存任务状态',
    });
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem(asinImportGateKey('operator')),
    ).toContain(taskId);
    unavailable = false;
    fireEvent.click(retry);
    await waitFor(() => expect(f.invalidate).toHaveBeenCalledOnce());
    expect(
      window.sessionStorage.getItem(asinImportGateKey('operator')),
    ).toBeNull();
    expect(screen.getByLabelText('选择文件')).toHaveProperty('disabled', false);
  });

  it.each(['pending', 'processing', 'cancelling'])(
    'keeps known uncertain %s tasks locked even if the latest read fails',
    async (status) => {
      installLocks();
      writeAsinImportGate(window.localStorage, 'operator', {
        phase: 'uncertain',
        taskId,
        savedAt: 10,
      });
      const f = fixture();
      await screen.findByText(`任务编号：${taskId}`);
      expect(
        screen.queryByRole('button', { name: '已核实原任务，允许重新导入' }),
      ).toBeNull();
      taskSnapshot.current = task(status);
      taskSnapshot.error = true;
      f.rerender();
      expect(
        screen.queryByRole('button', { name: '已核实原任务，允许重新导入' }),
      ).toBeNull();
      expect(screen.getByLabelText('选择文件')).toHaveProperty(
        'disabled',
        true,
      );
      expect(
        window.localStorage.getItem(asinImportGateKey('operator')),
      ).toContain(taskId);
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it('rechecks an active task after waiting for the reconciliation lock', async () => {
    let release!: () => void;
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request: async <T,>(_name: string, callback: () => T) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return callback();
        },
      },
    });
    writeAsinImportGate(window.localStorage, 'operator', {
      phase: 'uncertain',
      taskId,
      savedAt: 10,
    });
    taskSnapshot.error = true;
    const f = fixture();
    fireEvent.click(
      await screen.findByRole('button', { name: '已核实原任务，允许重新导入' }),
    );
    taskSnapshot.current = task('processing');
    f.rerender();
    release();
    await screen.findByText('原导入任务仍在运行，结束前不能解锁或重新导入。');
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toContain(taskId);
    expect(screen.getByLabelText('选择文件')).toHaveProperty('disabled', true);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('shows the confirmed task ID and warns when saving the accepted gate fails', async () => {
    installLocks();
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (value.includes('"phase":"accepted"'))
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    });
    const f = fixture();
    chooseFile();
    await screen.findByText(
      '任务已受理，但浏览器未能保存任务编号。请立即记录下方编号并到任务中心核实；刷新页面后编号可能丢失。',
    );
    expect(screen.getByText(`任务编号：${taskId}`)).toBeTruthy();
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toContain('sending');
    expect(
      window.sessionStorage.getItem(asinImportGateKey('operator')),
    ).toContain(taskId);
    expect(
      screen.getByRole('button', { name: '上传并创建导入任务' }),
    ).toHaveProperty('disabled', true);
    expect(f.request).toHaveBeenCalledOnce();
    cleanup();
    fixture();
    await screen.findByText(`任务编号：${taskId}`);
    window.localStorage.removeItem(asinImportGateKey('operator'));
    cleanup();
    taskSnapshot.error = true;
    fixture();
    await screen.findByText(`任务编号：${taskId}`);
    const originalRemoveItem = Storage.prototype.removeItem;
    const remove = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(function (this: Storage, key) {
        if (this === window.sessionStorage)
          throw new DOMException('Storage unavailable', 'SecurityError');
        originalRemoveItem.call(this, key);
      });
    fireEvent.click(
      screen.getByRole('button', {
        name: '已核实原任务，允许重新导入',
      }),
    );
    await screen.findByText('无法清除导入锁，请检查浏览器会话存储权限。');
    expect(screen.getByText(`任务编号：${taskId}`)).toBeTruthy();
    remove.mockRestore();
    fireEvent.click(
      screen.getByRole('button', {
        name: '已核实原任务，允许重新导入',
      }),
    );
    await screen.findByText('请确认原任务不会继续写入后再重新导入。');
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toBeNull();
    expect(
      window.sessionStorage.getItem(asinImportGateKey('operator')),
    ).toBeNull();
  });

  it('restores an unknown 500 task ID after its local gate write fails', async () => {
    installLocks();
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (this === window.localStorage && value.includes('"phase":"uncertain"'))
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    });
    const request = vi.fn(async () => {
      throw new ApiError('HTTP', '任务提交结果未确认', 500, 500, {
        taskId,
        status: 'unknown',
      });
    });
    fixture(request);
    chooseFile();
    await screen.findByText(
      '提交状态未确认，浏览器未能保存任务编号。请立即记录下方编号并到任务中心核实；刷新页面后编号可能丢失。',
    );
    expect(
      window.localStorage.getItem(asinImportGateKey('operator')),
    ).toContain('sending');
    expect(
      window.sessionStorage.getItem(asinImportGateKey('operator')),
    ).toContain(taskId);
    cleanup();
    fixture();
    await screen.findByText(`任务编号：${taskId}`);
    expect(request).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: '上传并创建导入任务' }),
    ).toHaveProperty('disabled', true);
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
    ).toContain('settled');
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

  it('refreshes partial results when another tab settles a failed import', async () => {
    installLocks();
    writeAsinImportGate(window.localStorage, 'operator', {
      phase: 'accepted',
      taskId,
      savedAt: 10,
    });
    const f = fixture();
    await screen.findByText(`任务编号：${taskId}`);
    writeAsinImportGate(window.localStorage, 'operator', {
      phase: 'settled',
      taskId,
      savedAt: 10,
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: asinImportGateKey('operator'),
        storageArea: window.localStorage,
      }),
    );
    await screen.findByText(
      '任务已结束，可能已有部分行提交；请核对结果后再解锁。',
    );
    expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ['asin'] });
    expect(
      screen.getByRole('button', { name: '已核实原任务，允许重新导入' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('选择文件')).toHaveProperty('disabled', true);
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
      expect(f.invalidate).toHaveBeenCalledWith({ queryKey: ['asin'] });
    },
  );
});
