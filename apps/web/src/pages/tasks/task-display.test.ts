import type { TaskInfo } from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import {
  canCancelTask,
  hasTaskDownload,
  taskErrorOverflowMessage,
  taskErrors,
  taskProgress,
  taskSummary,
  taskWarnings,
} from './task-display';

function task(override: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId: 'task-1',
    taskType: 'import',
    taskSubType: 'asin',
    title: '导入 ASIN',
    status: 'processing',
    progress: 35,
    message: '处理中',
    error: null,
    createdAt: null,
    updatedAt: null,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    canCancel: true,
    filename: null,
    downloadUrl: null,
    result: null,
    ...override,
  };
}
const importId = '123e4567-e89b-42d3-a456-426614174000';
const report = {
  taskId: importId,
  inputSha256: 'a'.repeat(64),
  sha256: 'b'.repeat(64),
  bytes: 2048,
};

describe('task center display boundaries', () => {
  it('shows cancel only for active supported jobs and downloads only from supported completed results', () => {
    expect(canCancelTask(task())).toBe(true);
    expect(canCancelTask(task({ taskType: 'variant-check' }))).toBe(false);
    expect(canCancelTask(task({ status: 'cancelling' }))).toBe(false);
    expect(canCancelTask(task({ canCancel: false }))).toBe(false);
    expect(
      hasTaskDownload(
        task({
          taskId: importId,
          status: 'completed',
          downloadUrl: '/api/v1/tasks/task-1/download',
          result: { taskSubType: 'asin', report },
        }),
      ),
    ).toBe(true);
    expect(
      hasTaskDownload(
        task({
          taskId: importId,
          status: 'completed',
          downloadUrl: '/api/v1/tasks/task-1/download',
          result: {
            taskSubType: 'asin',
            report: { ...report, taskId: 'other' },
          },
        }),
      ),
    ).toBe(false);
    expect(
      hasTaskDownload(
        task({
          taskId: importId,
          status: 'completed',
          downloadUrl: '/api/v1/tasks/task-1/download',
          result: { taskSubType: 'competitor-asin', report },
        }),
      ),
    ).toBe(false);
    expect(
      hasTaskDownload(
        task({
          status: 'completed',
          downloadUrl: '/api/v1/tasks/task-1/download',
        }),
      ),
    ).toBe(false);
    expect(
      hasTaskDownload(
        task({
          status: 'completed',
          taskType: 'export',
          downloadUrl: '/api/v1/tasks/task-1/download',
        }),
      ),
    ).toBe(false);
    expect(
      hasTaskDownload(
        task({
          status: 'completed',
          taskType: 'import',
          taskSubType: 'other',
          downloadUrl: '/api/v1/tasks/task-1/download',
        }),
      ),
    ).toBe(false);
    expect(
      hasTaskDownload(
        task({
          status: 'processing',
          downloadUrl: '/api/v1/tasks/task-1/download',
        }),
      ),
    ).toBe(false);
    expect(
      hasTaskDownload(
        task({
          status: 'completed',
          taskType: 'variant-check',
          filename: 'check-result-task-1.json',
          downloadUrl: '/api/v1/tasks/task-1/download',
          result: { errors: [] },
        }),
      ),
    ).toBe(true);
    const batchDelete = task({
      taskType: 'batch-delete',
      status: 'completed',
      downloadUrl: '/api/v1/tasks/task-1/download',
      result: {
        failedSamples: [...Array(30)].map(() => ({ message: 'failed' })),
      },
    });
    expect(hasTaskDownload(batchDelete)).toBe(false);
    expect(taskErrorOverflowMessage(batchDelete)).toContain(
      '暂无完整结果下载入口',
    );
  });

  it('uses a bounded structured summary without dumping arbitrary result payloads', () => {
    const result = task({
      status: 'completed',
      result: {
        total: 10,
        successCount: 8,
        failedCount: 2,
        privateToken: 'must-not-render',
        warnings: [...Array(30)].map((_, index) => `warning-${index}`),
        errors: [...Array(30)].map((_, index) => ({
          row: index + 1,
          message: `bad-${index}`,
        })),
      },
    });
    expect(taskSummary(result)).toBe('总计 10，成功 8，失败 2');
    expect(taskWarnings(result)).toHaveLength(20);
    expect(taskErrors(result)).toHaveLength(20);
    expect(taskErrors(result)[0]).toEqual({
      label: '第 1 行',
      message: 'bad-0',
    });
    expect(taskSummary(result)).not.toContain('must-not-render');
    expect(taskProgress(result)).toBe(100);
    expect(taskProgress(task({ progress: 140 }))).toBe(100);
    expect(taskProgress(task({ progress: -5 }))).toBe(0);
  });
});
