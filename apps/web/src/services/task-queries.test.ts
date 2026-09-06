import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, HttpClient } from '../lib/http';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import {
  completedMessage,
  taskFixture,
  TaskMessageFixture,
} from './task-fixtures';
import {
  subscribeTaskInvalidation,
  taskDetailOptions,
  taskKeys,
  taskListOptions,
  taskRefreshInterval,
} from './task-queries';
import { TaskApi } from './tasks';

const cleanups: Array<() => void> = [];
function setup() {
  const session = sessionFixture();
  const fetcher = vi.fn<typeof fetch>(async () =>
    jsonResponse({ success: true, data: taskFixture() }),
  );
  const http = new HttpClient({
    pageOrigin: 'https://app.test',
    session: session.store,
    fetch: fetcher,
  });
  const ws = new TaskMessageFixture();
  const tasks = new TaskApi(http, ws);
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  cleanups.push(() => {
    tasks.cancelWaits();
    http.close();
    client.clear();
  });
  return { tasks, ws, client, fetcher };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
});

describe('query policy', () => {
  it.each(['completed', 'failed', 'cancelled', 'future-state'])(
    'does not poll settled/unknown status %s even after a background error',
    (status) => {
      expect(taskRefreshInterval(taskFixture({ status }))).toBe(false);
      expect(
        taskRefreshInterval(
          taskFixture({ status }),
          new ApiError('NETWORK', 'offline'),
        ),
      ).toBe(false);
    },
  );
  it.each(['pending', 'processing', 'cancelling'])(
    'keeps %s active with bounded transient retry spacing',
    (status) => {
      expect(taskRefreshInterval(taskFixture({ status }))).toBe(1500);
      expect(
        taskRefreshInterval(
          taskFixture({ status }),
          new ApiError('NETWORK', 'offline'),
        ),
      ).toBe(10000);
      expect(
        taskRefreshInterval(
          taskFixture({ status }),
          new ApiError('HTTP', 'limited', 429),
        ),
      ).toBe(false);
      expect(
        taskRefreshInterval(
          taskFixture({ status }),
          new ApiError('AUTH', 'expired', 401),
        ),
      ).toBe(false);
    },
  );
  it('requires explicit auth enablement and canonicalizes default list filters', () => {
    const f = setup();
    expect(taskDetailOptions(f.tasks, 'job-1', false).enabled).toBe(false);
    expect(taskDetailOptions(f.tasks, undefined, true).enabled).toBe(false);
    expect(taskListOptions(f.tasks, {}, false).enabled).toBe(false);
    expect(taskListOptions(f.tasks, {}, true).queryKey).toEqual(
      taskKeys.list({ status: 'all', limit: 50 }),
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('WS invalidation through actual Query observers', () => {
  it('fetches the complete authoritative snapshot and leaves other task caches alone', async () => {
    const f = setup();
    const observer = new QueryObserver(
      f.client,
      taskDetailOptions(f.tasks, 'job-1', true),
    );
    cleanups.push(observer.subscribe(() => {}));
    cleanups.push(subscribeTaskInvalidation(f.ws, f.client, 'job-1'));
    f.client.setQueryData(
      taskKeys.detail('other'),
      taskFixture({ taskId: 'other' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const completed = taskFixture({
      status: 'completed',
      result: { rows: 12 },
      filename: 'from-http.xlsx',
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: completed }),
    );
    f.ws.emit(completedMessage());
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toEqual(completed);
    expect(JSON.stringify(observer.getCurrentResult().data)).not.toContain(
      'untrusted.test',
    );
    expect(
      f.client.getQueryState(taskKeys.detail('other'))?.isInvalidated,
    ).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('performs one follow-up fetch when terminal hints race the initial HTTP snapshot', async () => {
    const f = setup();
    const first = deferred<Response>();
    f.fetcher.mockReturnValueOnce(first.promise).mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: taskFixture({ status: 'completed' }),
      }),
    );
    const observer = new QueryObserver(
      f.client,
      taskDetailOptions(f.tasks, 'job-1', true),
    );
    cleanups.push(observer.subscribe(() => {}));
    cleanups.push(subscribeTaskInvalidation(f.ws, f.client, 'job-1'));
    f.ws.emit(completedMessage());
    f.ws.emit(completedMessage());
    first.resolve(jsonResponse({ success: true, data: taskFixture() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data?.status).toBe('completed');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces progress bursts and cancels delayed invalidation on unmount', async () => {
    const f = setup();
    const observer = new QueryObserver(
      f.client,
      taskDetailOptions(f.tasks, 'job-1', true),
    );
    cleanups.push(observer.subscribe(() => {}));
    const stop = subscribeTaskInvalidation(f.ws, f.client, 'job-1');
    cleanups.push(stop);
    await vi.advanceTimersByTimeAsync(0);
    for (let progress = 0; progress < 100; progress++)
      f.ws.emit({
        type: 'task_progress',
        taskId: 'job-1',
        progress,
        message: 'fixture',
        timestamp: '2026-09-06T00:00:00Z',
      });
    await vi.advanceTimersByTimeAsync(299);
    expect(f.fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.ws.emit({
      type: 'task_progress',
      taskId: 'job-1',
      progress: 100,
      message: 'fixture',
      timestamp: '2026-09-06T00:00:00Z',
    });
    stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.ws.handlers.size).toBe(0);
  });

  it('invalidates every list filter without synthesizing task data from WS', async () => {
    const f = setup();
    const all = taskKeys.list({});
    const active = taskKeys.list({ status: 'processing' });
    f.client.setQueryData(all, []);
    f.client.setQueryData(active, [taskFixture()]);
    cleanups.push(subscribeTaskInvalidation(f.ws, f.client));
    f.ws.emit(completedMessage());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.getQueryState(all)?.isInvalidated).toBe(true);
    expect(f.client.getQueryState(active)?.isInvalidated).toBe(true);
    expect(f.client.getQueryData(all)).toEqual([]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('consumes the query AbortSignal so the last observer unmount aborts HTTP and discards late data', async () => {
    const f = setup();
    const late = deferred<Response>();
    f.fetcher.mockReturnValueOnce(late.promise);
    const observer = new QueryObserver(
      f.client,
      taskDetailOptions(f.tasks, 'job-1', true),
    );
    const stop = observer.subscribe(() => {});
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    stop();
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    late.resolve(jsonResponse({ success: true, data: taskFixture() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.getQueryData(taskKeys.detail('job-1'))).toBeUndefined();
  });
});
