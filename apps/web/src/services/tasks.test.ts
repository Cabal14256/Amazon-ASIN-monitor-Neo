import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import { createTransportRuntime } from './runtime';
import {
  completedMessage,
  taskFixture,
  TaskMessageFixture,
} from './task-fixtures';
import { TaskApi, TaskCompletionError } from './tasks';

const cleanups: Array<() => void> = [];
function setup(baseURL = 'https://api.test/gateway/api/') {
  const session = sessionFixture();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      jsonResponse({ success: true, data: taskFixture() }),
    );
  const http = new HttpClient({
    pageOrigin: 'https://app.test',
    baseURL,
    session: session.store,
    fetch: fetcher,
  });
  const ws = new TaskMessageFixture();
  const tasks = new TaskApi(http, ws);
  cleanups.push(() => {
    tasks.cancelWaits();
    http.close();
  });
  return { ...session, http, fetcher, ws, tasks };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

describe('task API boundary', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const exportTask = () =>
    taskFixture({
      taskId: id,
      status: 'completed',
      filename: 'ASIN数据_2026-10-07.xlsx',
      downloadUrl: `/api/v1/tasks/${id}/download`,
      result: {
        exportType: 'asin',
        filename: 'ASIN数据_2026-10-07.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSizeBytes: 4,
        artifact: {
          taskId: id,
          key: `export-${id}.xlsx`,
          bytes: 4,
          sha256: 'a'.repeat(64),
        },
      },
    });
  const workbook = () =>
    new Response(new Uint8Array([80, 75, 3, 4]), {
      headers: {
        'content-type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    });
  it.each(['/api/', 'https://api.test/api/'])(
    'downloads the validated ASIN workbook with normalized %s and the actual XLSX filename',
    async (baseURL) => {
      const f = setup(baseURL);
      f.local.set('token', 'fixture-legacy');
      f.fetcher.mockResolvedValueOnce(workbook());
      const downloaded = await f.tasks.downloadAsinExport(exportTask());
      expect(downloaded.filename).toBe('ASIN数据_2026-10-07.xlsx');
      expect(downloaded.blob.size).toBe(4);
      expect(String(f.fetcher.mock.calls[0][0])).toBe(
        `${
          baseURL.startsWith('https') ? 'https://api.test' : 'https://app.test'
        }/api/v1/tasks/${id}/download`,
      );
      expect(f.fetcher.mock.calls[0][1]?.credentials).toBe('include');
      expect(
        new Headers(f.fetcher.mock.calls[0][1]?.headers).get('authorization'),
      ).toBe('Bearer fixture-legacy');
      expect(String(f.fetcher.mock.calls[0][0])).not.toContain('/api/api/');
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );
  it('rejects absent or mismatched export receipts before downloading', async () => {
    const f = setup();
    for (const invalid of [
      { ...exportTask(), filename: '../unsafe.xlsx' },
      { ...exportTask(), result: null },
    ])
      await expect(f.tasks.downloadAsinExport(invalid)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    new Response('{}', { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([80, 75]), {
      headers: {
        'content-type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    }),
  ])(
    'rejects a successful HTTP body that is not the advertised workbook',
    async (response) => {
      const f = setup();
      f.fetcher.mockResolvedValueOnce(response);
      await expect(
        f.tasks.downloadAsinExport(exportTask()),
      ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    },
  );
  it.each([403, 404])(
    'reports the server %s permission/expired-artifact rejection without replay',
    async (status) => {
      const f = setup();
      f.fetcher.mockResolvedValueOnce(
        jsonResponse({ success: false, errorMessage: '文件不可用' }, status),
      );
      await expect(
        f.tasks.downloadAsinExport(exportTask()),
      ).rejects.toMatchObject({ kind: 'HTTP', status });
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );
  it('cancels a workbook transfer when the caller aborts', async () => {
    const f = setup();
    const controller = new AbortController();
    f.fetcher.mockImplementationOnce(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    const cancelled = expect(
      f.tasks.downloadAsinExport(exportTask(), controller.signal),
    ).rejects.toMatchObject({ kind: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await cancelled;
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('finishes a valid ASIN workbook body after the old 125 second cutoff', async () => {
    const f = setup();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([80]));
        setTimeout(() => {
          controller.enqueue(new Uint8Array([75, 3, 4]));
          controller.close();
        }, 126_000);
      },
    });
    f.fetcher.mockResolvedValueOnce(
      new Response(stream, {
        headers: { 'content-type': workbook().headers.get('content-type')! },
      }),
    );
    let settled = false;
    const transfer = f.tasks.downloadAsinExport(exportTask()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(125_001);
    expect(settled).toBe(false);
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    const file = await transfer;
    expect(file.blob.size).toBe(4);
    expect(file.filename).toBe('ASIN数据_2026-10-07.xlsx');
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('aborts an unfinished ASIN export at the bounded 30 minute deadline', async () => {
    const f = setup();
    f.fetcher.mockImplementationOnce(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    const timedOut = expect(
      f.tasks.downloadAsinExport(exportTask()),
    ).rejects.toMatchObject({ kind: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('keeps the existing 125 second deadline for ordinary task downloads', async () => {
    const f = setup();
    f.fetcher.mockImplementationOnce(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    const timedOut = expect(f.tasks.download('job-1')).rejects.toMatchObject({
      kind: 'TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(124_999);
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('still cancels a slow ASIN transfer immediately when the runtime session resets', async () => {
    const f = setup();
    f.fetcher.mockImplementationOnce(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    const runtime = createTransportRuntime({
      pageOrigin: 'https://app.test',
      baseURL: '/api/',
      session: f.store,
      fetch: f.fetcher,
    });
    cleanups.push(runtime.dispose);
    const cancelled = expect(
      runtime.tasks.downloadAsinExport(exportTask()),
    ).rejects.toMatchObject({ kind: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(126_000);
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    runtime.reset();
    await cancelled;
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('uses one normalized request/download origin and keeps Cookie authentication', async () => {
    const f = setup();
    await f.tasks.get('job-1');
    expect(f.fetcher.mock.calls[0][0]).toBe(
      'https://api.test/gateway/api/v1/tasks/job-1',
    );
    expect(f.fetcher.mock.calls[0][1]?.credentials).toBe('include');
    expect(f.tasks.downloadURL('job-1')).toBe(
      'https://api.test/gateway/api/v1/tasks/job-1/download',
    );
    expect(f.tasks.downloadURL('job-1')).not.toContain('token');
  });

  it('downloads task results with the same credential mode as task detail', async () => {
    const f = setup();
    f.local.set('token', 'fixture-legacy');
    f.fetcher.mockResolvedValueOnce(new Response('{"ok":true}'));
    const file = await f.tasks.download('job-1');
    expect(await file.text()).toBe('{"ok":true}');
    expect(f.fetcher.mock.calls[0][0]).toBe(
      'https://api.test/gateway/api/v1/tasks/job-1/download',
    );
    expect(f.fetcher.mock.calls[0][1]?.credentials).toBe('include');
    expect(
      new Headers(f.fetcher.mock.calls[0][1]?.headers).get('authorization'),
    ).toBe('Bearer fixture-legacy');
  });

  it('reads valid large check details and aggregate task lists beyond the generic 8 MiB limit', async () => {
    const f = setup();
    const detail = taskFixture({
      taskType: 'batch-check',
      status: 'completed',
      result: { payload: 'x'.repeat(9 * 1024 * 1024) },
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: detail }),
    );
    expect((await f.tasks.get('job-1')).result).toEqual(detail.result);
    const preview = 'x'.repeat(190 * 1024);
    const list = Array.from({ length: 50 }, (_, index) =>
      taskFixture({ taskId: `job-${index + 1}`, result: { preview } }),
    );
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: list }),
    );
    expect(await f.tasks.list({ limit: 100 })).toHaveLength(50);
  });

  it('creates, lists and cancels using shared envelopes and the correct methods', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { taskId: 'job-1', exportType: 'asin', status: 'pending' },
      }),
    );
    await expect(
      f.tasks.createExport({ exportType: 'asin', params: { country: 'US' } }),
    ).resolves.toMatchObject({ taskId: 'job-1' });
    expect(f.fetcher.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual({
      exportType: 'asin',
      params: { country: 'US' },
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [taskFixture()] }),
    );
    expect(
      await f.tasks.list({ status: 'processing', limit: 20 }),
    ).toHaveLength(1);
    expect(f.fetcher.mock.calls[1][0]).toBe(
      'https://api.test/gateway/api/v1/tasks?status=processing&limit=20',
    );
    await f.tasks.cancel('job-1');
    expect(f.fetcher.mock.calls[2][0]).toBe(
      'https://api.test/gateway/api/v1/tasks/job-1/cancel',
    );
    expect(f.fetcher.mock.calls[2][1]?.method).toBe('POST');
  });

  it.each([
    '',
    '.',
    '..',
    '../roles',
    'a/b',
    'a\\b',
    '%2e%2e',
    'a?x=1',
    'a#hash',
    'a b',
    'a\n',
    '\ud800',
  ])(
    'rejects invalid task identifier %j before sending a request',
    async (id) => {
      const f = setup();
      await expect(f.tasks.get(id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
      expect(() => f.tasks.downloadURL(id)).toThrow();
      await expect(f.tasks.download(id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { success: true },
    { data: taskFixture() },
    { success: true, data: taskFixture({ taskId: 'other-job' }) },
  ])(
    'does not accept missing data/success or a snapshot for another task',
    async (response) => {
      const f = setup();
      f.fetcher.mockResolvedValueOnce(jsonResponse(response));
      await expect(f.tasks.get('job-1')).rejects.toMatchObject({
        kind: 'INVALID_RESPONSE',
      });
    },
  );

  it('rejects invalid filters and export parameters without sending work', async () => {
    const f = setup();
    await expect(f.tasks.list({ limit: 201 })).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(
      f.tasks.createExport({ exportType: 'unknown' as 'asin' }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('bounded task completion lifecycle', () => {
  it('resolves from a WS terminal hint using the full HTTP result without later reporting timeout', async () => {
    const f = setup();
    const progress = vi.fn();
    const waiting = f.tasks.wait('job-1', {
      timeoutMs: 10000,
      onProgress: progress,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledOnce();
    const completed = taskFixture({
      status: 'completed',
      progress: 100,
      result: { rows: 7 },
      filename: 'actual.xlsx',
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: completed }),
    );
    f.ws.emit(completedMessage());
    await expect(waiting).resolves.toEqual(completed);
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.ws.handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces terminal hints arriving during the initial request and refreshes after the stale snapshot', async () => {
    const f = setup();
    const first = deferred<Response>();
    f.fetcher.mockReturnValueOnce(first.promise).mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: taskFixture({ status: 'completed' }),
      }),
    );
    const waiting = f.tasks.wait('job-1');
    f.ws.emit(completedMessage());
    f.ws.emit(completedMessage());
    expect(f.fetcher).toHaveBeenCalledOnce();
    first.resolve(jsonResponse({ success: true, data: taskFixture() }));
    await expect(waiting).resolves.toMatchObject({ status: 'completed' });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('polls without a socket and reports unchanged progress only once', async () => {
    const f = setup();
    const progress = vi.fn();
    const waiting = f.tasks.wait('job-1', { onProgress: progress });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenCalledOnce();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: taskFixture({ status: 'completed' }),
      }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    await expect(waiting).resolves.toMatchObject({ status: 'completed' });
  });

  it.each(['failed', 'cancelled'])(
    'rejects the server terminal state %s with its task snapshot',
    async (status) => {
      const f = setup();
      f.fetcher.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: taskFixture({ status, error: 'fixture failure' }),
        }),
      );
      await expect(f.tasks.wait('job-1')).rejects.toMatchObject({
        name: 'TaskCompletionError',
        message: 'fixture failure',
        task: { status },
      });
      expect(f.ws.handlers.size).toBe(0);
      expect(new TaskCompletionError(taskFixture({ status }))).toBeInstanceOf(
        Error,
      );
    },
  );

  it('keeps cancelling active until the server confirms cancellation', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: taskFixture({ status: 'cancelling' }),
      }),
    );
    const waiting = f.tasks.wait('job-1');
    const rejected = expect(waiting).rejects.toMatchObject({
      task: { status: 'cancelled' },
    });
    await vi.advanceTimersByTimeAsync(0);
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: taskFixture({ status: 'cancelled' }),
      }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
  });

  it('ignores unrelated task hints and refuses an unknown state instead of inventing pending', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: taskFixture({ status: 'future-state' }),
      }),
    );
    const rejected = expect(f.tasks.wait('job-1')).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    f.ws.emit(completedMessage('other-task'));
    await rejected;
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('enforces a deadline even if fetch ignores cancellation, then ignores late completion', async () => {
    const f = setup();
    const late = deferred<Response>();
    f.fetcher.mockReturnValueOnce(late.promise);
    const progress = vi.fn();
    const rejected = expect(
      f.tasks.wait('job-1', { timeoutMs: 500, onProgress: progress }),
    ).rejects.toMatchObject({ kind: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(f.ws.handlers.size).toBe(0);
    late.resolve(
      jsonResponse({
        success: true,
        data: taskFixture({ status: 'completed' }),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a wait between polls without cancelling the server task', async () => {
    const f = setup();
    const controller = new AbortController();
    const rejected = expect(
      f.tasks.wait('job-1', { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0][1]?.method).toBe('GET');
    expect(f.ws.handlers.size).toBe(0);
  });

  it('never starts an already-aborted wait and rejects invalid timer settings', async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.tasks.wait('job-1', { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'CANCELLED' });
    await expect(
      f.tasks.wait('job-1', { intervalMs: 0 }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.ws.onMessage).not.toHaveBeenCalled();
  });

  it('cleans up when a progress consumer throws', async () => {
    const f = setup();
    await expect(
      f.tasks.wait('job-1', {
        onProgress: () => {
          throw new Error('consumer failed');
        },
      }),
    ).rejects.toThrow('consumer failed');
    expect(f.ws.handlers.size).toBe(0);
  });

  it.each(['reset', 'refreshSession', 'dispose'] as const)(
    'cancels waiting and listeners on runtime %s even between polls',
    async (operation) => {
      const session = sessionFixture();
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse({ success: true, data: taskFixture() }),
      );
      const runtime = createTransportRuntime({
        pageOrigin: 'https://app.test',
        session: session.store,
        fetch: fetcher,
      });
      cleanups.push(runtime.dispose);
      const rejected = expect(
        runtime.tasks.wait('job-1'),
      ).rejects.toMatchObject({ kind: 'CANCELLED' });
      await vi.advanceTimersByTimeAsync(0);
      runtime[operation]();
      await rejected;
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
