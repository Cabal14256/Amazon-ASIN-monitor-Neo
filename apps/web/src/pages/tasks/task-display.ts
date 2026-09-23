import type { TaskInfo } from '@asin-monitor/contracts';
import { formatBeijing } from '../../lib/beijingTime';

type Badge =
  | 'pending'
  | 'running'
  | 'warning'
  | 'success'
  | 'danger'
  | 'unknown';

const STATUSES: Record<string, { label: string; badge: Badge }> = {
  pending: { label: '等待中', badge: 'pending' },
  processing: { label: '执行中', badge: 'running' },
  cancelling: { label: '取消中', badge: 'warning' },
  completed: { label: '已完成', badge: 'success' },
  failed: { label: '失败', badge: 'danger' },
  cancelled: { label: '已取消', badge: 'warning' },
};
const CANCELLABLE_TYPES = new Set([
  'export',
  'import',
  'batch-check',
  'batch-delete',
  'backup',
]);

export function taskStatus(status: string) {
  return STATUSES[status] ?? { label: '状态未知', badge: 'unknown' as const };
}

export function taskProgress(task: TaskInfo): number | undefined {
  if (task.status === 'completed') return 100;
  return Number.isFinite(task.progress)
    ? Math.min(100, Math.max(0, task.progress))
    : undefined;
}

export function taskDate(value: string | null): string {
  if (!value) return '未记录';
  const formatted = formatBeijing(value, 'YYYY-MM-DD HH:mm');
  return formatted === 'Invalid Date' ? '时间未知' : formatted;
}

export function taskResult(task: TaskInfo): Record<string, unknown> | null {
  return task.result &&
    typeof task.result === 'object' &&
    !Array.isArray(task.result)
    ? (task.result as Record<string, unknown>)
    : null;
}

function shortText(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

export function taskSummary(task: TaskInfo): string {
  if (task.status === 'failed')
    return shortText(task.error) ?? shortText(task.message) ?? '任务失败';
  if (task.status === 'cancelled' || task.status === 'cancelling')
    return shortText(task.message) ?? '等待安全停止';
  const result = taskResult(task);
  if (task.status === 'completed') {
    const summary = shortText(result?.summary);
    if (summary) return summary;
    if (task.taskType === 'import') {
      const total = result?.total;
      const success = result?.successCount;
      const failed = result?.failedCount;
      if (
        [total, success, failed].every(
          (value) =>
            typeof value === 'number' && Number.isInteger(value) && value >= 0,
        )
      )
        return `总计 ${total}，成功 ${success}，失败 ${failed}`;
    }
    if (task.filename) return shortText(task.filename) ?? '文件已生成';
    return shortText(task.message) ?? '任务已完成';
  }
  return shortText(task.message) ?? '等待任务更新';
}

export function taskWarnings(task: TaskInfo): string[] {
  const warnings = taskResult(task)?.warnings;
  return Array.isArray(warnings)
    ? warnings.slice(0, 20).flatMap((value) => {
        const text = shortText(value);
        return text ? [text] : [];
      })
    : [];
}

export function taskErrors(
  task: TaskInfo,
): { label: string; message: string }[] {
  const result = taskResult(task);
  const raw = Array.isArray(result?.errors)
    ? result.errors
    : Array.isArray(result?.failedSamples)
    ? result.failedSamples
    : [];
  return raw.slice(0, 20).flatMap((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const message = shortText(item.message) ?? shortText(item.error);
    if (!message) return [];
    const label =
      typeof item.row === 'number' && Number.isInteger(item.row) && item.row > 0
        ? `第 ${item.row} 行`
        : shortText(item.groupId, 100) ?? `问题 ${index + 1}`;
    return [{ label, message }];
  });
}

export function canCancelTask(task: TaskInfo): boolean {
  return (
    task.canCancel &&
    ['pending', 'processing'].includes(task.status) &&
    CANCELLABLE_TYPES.has(task.taskType)
  );
}

export function hasTaskDownload(task: TaskInfo): boolean {
  if (task.status !== 'completed' || !task.downloadUrl) return false;
  if (task.taskType === 'import') {
    const result = taskResult(task);
    const report = result?.report;
    if (!report || typeof report !== 'object' || Array.isArray(report))
      return false;
    const ref = report as Record<string, unknown>;
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const sha = /^[0-9a-f]{64}$/;
    return (
      ['asin', 'competitor-asin'].includes(task.taskSubType ?? '') &&
      result?.taskSubType === task.taskSubType &&
      ref.taskId === task.taskId &&
      typeof ref.taskId === 'string' &&
      uuid.test(ref.taskId) &&
      typeof ref.inputSha256 === 'string' &&
      sha.test(ref.inputSha256) &&
      typeof ref.sha256 === 'string' &&
      sha.test(ref.sha256) &&
      typeof ref.bytes === 'number' &&
      Number.isSafeInteger(ref.bytes) &&
      ref.bytes > 0 &&
      ref.bytes <= 256 * 1024 * 1024
    );
  }
  return (
    ['variant-check', 'batch-check'].includes(task.taskType) &&
    task.result !== null &&
    task.filename === `check-result-${task.taskId}.json`
  );
}

export function taskErrorOverflowMessage(task: TaskInfo): string {
  return hasTaskDownload(task)
    ? '仅展示前 20 项，完整结果请下载报告。'
    : '仅展示前 20 项；此类任务暂无完整结果下载入口。';
}
