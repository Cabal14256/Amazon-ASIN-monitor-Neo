import type { TaskInfo, TaskListQuery } from '@asin-monitor/contracts';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { shouldRetryQuery } from '../lib/http';
import type { RealtimeClient } from '../lib/realtime';
import { isActiveTask, isTaskMessage, type TaskApi } from './tasks';

export const taskKeys = {
  lists: ['tasks', 'list'] as const,
  list: (filters: TaskListQuery) =>
    [
      'tasks',
      'list',
      { status: filters.status || 'all', limit: filters.limit ?? 50 },
    ] as const,
  detail: (taskId: string | undefined) =>
    ['tasks', 'detail', taskId ?? ''] as const,
};

export function taskRefreshInterval(
  task?: TaskInfo,
  error?: unknown,
): number | false {
  if (task && !isActiveTask(task.status)) return false;
  if (error) return shouldRetryQuery(0, error) ? 10000 : false;
  return 1500;
}

export function taskDetailOptions(
  api: TaskApi,
  taskId: string | undefined,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: taskKeys.detail(taskId),
    queryFn: ({ signal }) => api.get(taskId ?? '', signal),
    enabled: enabled && Boolean(taskId),
    staleTime: 0,
    retry: shouldRetryQuery,
    refetchInterval: (query) =>
      taskRefreshInterval(query.state.data, query.state.error),
  });
}

export function taskListOptions(
  api: TaskApi,
  filters: TaskListQuery,
  enabled: boolean,
) {
  const normalized = {
    status: filters.status || 'all',
    limit: filters.limit ?? 50,
  };
  return queryOptions({
    queryKey: taskKeys.list(normalized),
    queryFn: ({ signal }) => api.list(normalized, signal),
    enabled,
    staleTime: 5000,
    retry: shouldRetryQuery,
    refetchInterval: (query) =>
      query.state.error && !shouldRetryQuery(0, query.state.error)
        ? false
        : 15000,
  });
}

/** No partial WS snapshot is cached; progress bursts coalesce, terminal hints refresh now. */
export function subscribeTaskInvalidation(
  realtime: Pick<RealtimeClient, 'onMessage'>,
  client: QueryClient,
  taskId?: string,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let invalidating = false;
  let again = false;
  const filters = {
    queryKey: taskId === undefined ? taskKeys.lists : taskKeys.detail(taskId),
    exact: taskId !== undefined,
  };
  const invalidate = () => {
    timer = undefined;
    if (stopped) return;
    if (invalidating) {
      again = true;
      return;
    }
    invalidating = true;
    const joinedExisting =
      client.isFetching({ ...filters, type: 'active' }) > 0;
    void client
      .invalidateQueries(filters, { cancelRefetch: false })
      .then(() => {
        // A response already in flight may predate the hint. Read once more after it.
        if (joinedExisting) again = true;
      })
      .finally(() => {
        invalidating = false;
        if (!stopped && again) {
          again = false;
          invalidate();
        }
      });
  };
  const unsubscribe = realtime.onMessage((message) => {
    if (
      !isTaskMessage(message) ||
      !('taskId' in message) ||
      (taskId !== undefined && message.taskId !== taskId)
    )
      return;
    if (message.type === 'task_progress') {
      timer ??= setTimeout(invalidate, 300);
    } else {
      clearTimeout(timer);
      invalidate();
    }
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
}
