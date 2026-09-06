import type {
  CreateExportTaskRequest,
  TaskListQuery,
} from '@asin-monitor/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { createTransportRuntime } from '../services/runtime';
import {
  subscribeTaskInvalidation,
  taskDetailOptions,
  taskKeys,
  taskListOptions,
} from '../services/task-queries';

type TaskRuntime = Pick<
  ReturnType<typeof createTransportRuntime>,
  'tasks' | 'ws' | 'queryClient' | 'session'
>;

function useTaskEvents(
  runtime: TaskRuntime,
  enabled: boolean,
  taskId?: string,
) {
  // Runtime resets clear WS subscriptions; a new authenticated revision must resubscribe.
  const revision = runtime.session.revision;
  useEffect(() => {
    if (!enabled) return;
    return subscribeTaskInvalidation(runtime.ws, runtime.queryClient, taskId);
  }, [enabled, taskId, revision, runtime.ws, runtime.queryClient]);
}

/** enabled must follow verified auth/route state, not just a browser session hint. */
export function useTaskQuery(
  runtime: TaskRuntime,
  taskId: string | undefined,
  enabled: boolean,
) {
  useTaskEvents(runtime, enabled && Boolean(taskId), taskId);
  return useQuery(
    taskDetailOptions(runtime.tasks, taskId, enabled),
    runtime.queryClient,
  );
}

export function useTaskListQuery(
  runtime: TaskRuntime,
  filters: TaskListQuery,
  enabled: boolean,
) {
  useTaskEvents(runtime, enabled);
  return useQuery(
    taskListOptions(runtime.tasks, filters, enabled),
    runtime.queryClient,
  );
}

export function useCreateExportTask(runtime: TaskRuntime) {
  return useMutation(
    {
      mutationFn: (body: CreateExportTaskRequest) =>
        runtime.tasks.createExport(body),
      retry: false,
      onSuccess: () =>
        runtime.queryClient.invalidateQueries({ queryKey: taskKeys.lists }),
    },
    runtime.queryClient,
  );
}

export function useCancelTask(runtime: TaskRuntime) {
  return useMutation(
    {
      mutationFn: (taskId: string) => runtime.tasks.cancel(taskId),
      retry: false,
      // Refetch rather than overwriting cache with a possibly older cancellation response.
      onSuccess: async (task) => {
        await Promise.all([
          runtime.queryClient.invalidateQueries({
            queryKey: taskKeys.detail(task.taskId),
            exact: true,
          }),
          runtime.queryClient.invalidateQueries({ queryKey: taskKeys.lists }),
        ]);
      },
    },
    runtime.queryClient,
  );
}
