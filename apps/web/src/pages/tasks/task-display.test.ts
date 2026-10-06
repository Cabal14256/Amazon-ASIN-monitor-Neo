import type { TaskInfo } from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import {
  canCancelTask,
  canOpenTaskDetail,
  hasMoreTaskErrors,
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
  it('offers only a task-bound completed ASIN XLSX artifact with current read permission', () => {
    const result = {
      exportType: 'asin',
      filename: 'ASIN数据_2026-10-07.xlsx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileSizeBytes: 4,
      artifact: {
        taskId: importId,
        key: `export-${importId}.xlsx`,
        bytes: 4,
        sha256: 'a'.repeat(64),
      },
    };
    const exported = task({
      taskId: importId,
      taskType: 'export',
      taskSubType: 'asin',
      status: 'completed',
      filename: result.filename,
      downloadUrl: `/api/v1/tasks/${importId}/download`,
      result,
    });
    expect(hasTaskDownload(exported, true)).toBe(true);
    expect(hasTaskDownload(exported, false)).toBe(false);
    for (const patch of [
      { status: 'processing' },
      { status: 'failed' },
      { status: 'cancelled' },
      { taskSubType: 'monitor-history' },
      { filename: 'other.xlsx' },
      {
        downloadUrl: `https://untrusted.test/api/v1/tasks/${importId}/download`,
      },
      {
        result: {
          ...result,
          artifact: {
            ...result.artifact,
            taskId: '123e4567-e89b-42d3-a456-426614174001',
          },
        },
      },
      {
        result: {
          ...result,
          artifact: { ...result.artifact, key: '../outside.xlsx' },
        },
      },
      {
        result: {
          ...result,
          artifact: { ...result.artifact, sha256: 'invalid' },
        },
      },
      { result: { ...result, fileSizeBytes: 5 } },
      { result: { ...result, filename: '../ASIN数据_2026-10-07.xlsx' } },
      { result: { ...result, mimeType: 'application/json' } },
      { result: null },
    ])
      expect(hasTaskDownload({ ...exported, ...patch }, true)).toBe(false);
  });

  it.each(['pending', 'processing'] as const)(
    'allows the owned %s monitor task cancellation advertised by the API',
    (status) => {
      const monitor = task({
        taskType: 'monitor',
        taskSubType: 'primary',
        status,
      });
      expect(canCancelTask(monitor)).toBe(true);
      expect(canCancelTask({ ...monitor, canCancel: false })).toBe(false);
    },
  );
  it.each(['cancelling', 'cancelled', 'completed', 'failed'] as const)(
    'does not offer cancellation for a %s monitor task',
    (status) => {
      expect(canCancelTask(task({ taskType: 'monitor', status }))).toBe(false);
    },
  );
  it('shows cancel only for active supported jobs and downloads only from supported completed results', () => {
    expect(canCancelTask(task())).toBe(true);
    expect(canCancelTask(task({ taskType: 'unsupported' }))).toBe(false);
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
    const completedCheck = task({
      status: 'completed',
      taskType: 'batch-check',
      filename: 'check-result-task-1.json',
      downloadUrl: '/api/v1/tasks/task-1/download',
      result: {
        failedCount: 25,
        failedSamples: Array.from({ length: 20 }, () => ({ error: 'failed' })),
      },
    });
    expect(canOpenTaskDetail(completedCheck, false)).toBe(false);
    expect(hasTaskDownload(completedCheck, false)).toBe(false);
    expect(canOpenTaskDetail(completedCheck, true)).toBe(true);
    expect(hasTaskDownload(completedCheck, true)).toBe(true);
    for (const taskType of ['variant-check', 'batch-check'] as const) {
      const failedCheck = task({ taskType, status: 'failed' });
      expect(canOpenTaskDetail(failedCheck, false)).toBe(false);
      expect(canOpenTaskDetail(failedCheck, true)).toBe(true);
      expect(
        canOpenTaskDetail(task({ taskType, status: 'cancelled' }), false),
      ).toBe(true);
    }
    expect(hasMoreTaskErrors(completedCheck, 20)).toBe(true);
    expect(taskErrorOverflowMessage(completedCheck, true)).toContain(
      '完整结果',
    );
    expect(canOpenTaskDetail(task(), false)).toBe(true);
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

  it.each(['competitor-asin-check', 'competitor-variant-group-check'])(
    'allows cancellation of active %s tasks only when the API permits it',
    (taskSubType) => {
      for (const status of ['pending', 'processing'] as const) {
        const active = task({ taskType: 'variant-check', taskSubType, status });
        expect(canCancelTask(active)).toBe(true);
        expect(canCancelTask({ ...active, canCancel: false })).toBe(false);
      }
      for (const status of [
        'cancelling',
        'completed',
        'failed',
        'cancelled',
      ] as const) {
        expect(
          canCancelTask(
            task({ taskType: 'variant-check', taskSubType, status }),
          ),
        ).toBe(false);
      }
    },
  );

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
