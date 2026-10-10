import type { BackupConfig, TaskInfo } from '@asin-monitor/contracts';
import { ApiError } from '../lib/http';

export type BackupTarget = 'primary' | 'competitor';
export type BackupRestoreMode = 'in-place' | 'isolated';
export const BACKUP_BLOB_MAX_BYTES = 256 * 1024 * 1024;
export const BACKUP_DUMP_MAX_BYTES = 1024 ** 4;
export const BACKUP_METADATA_MAX_BYTES = 16 * 1024 * 1024;
export const BACKUP_TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
export const BACKUP_FILENAME =
  /^backup_[0-9]{8}-[0-9]{6}-(?:[a-f0-9]{8}|[a-f0-9]{32})-(?:primary|competitor)\.dump$/;
const TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BackupFile {
  filename: string;
  format: 'custom';
  target: BackupTarget;
  size: number;
  createdAt: string;
  timeSource: 'dump-start' | 'filename' | 'mtime' | 'unavailable';
  execution?: {
    timeSource: 'dump-start';
    dumpStartedAt: string;
    dumpCompletedAt: string;
    publicationStartedAt: string;
  };
  restoreSupported: boolean;
  restoreMode?: BackupRestoreMode;
  sourceEngine?: 'postgresql' | 'timescaledb';
  scope?: 'full' | 'selective';
  description?: string;
}
export interface BackupSubmission {
  taskId: string;
  status: 'pending' | 'unknown';
  restoreMode?: BackupRestoreMode;
}
export interface BackupOperation {
  operation: 'create' | 'restore';
  target: BackupTarget;
  description?: string;
  filename?: string;
  restoreMode?: BackupRestoreMode;
}

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const invalid = (message: string): never => {
  throw new ApiError('INVALID_RESPONSE', message);
};
const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));

export function backupFilenameTarget(filename: string): BackupTarget {
  if (!BACKUP_FILENAME.test(filename))
    throw new ApiError(
      'INVALID_INPUT',
      '只支持本系统的 PostgreSQL custom 备份',
    );
  return filename.endsWith('-competitor.dump') ? 'competitor' : 'primary';
}

/** Validate the Neo artifact fields even while the frozen v1 schema permits SQL. */
export function parseBackupFile(raw: unknown): BackupFile {
  const value = object(raw);
  if (
    !value ||
    typeof value.filename !== 'string' ||
    !BACKUP_FILENAME.test(value.filename) ||
    value.format !== 'custom' ||
    !['primary', 'competitor'].includes(String(value.target)) ||
    backupFilenameTarget(value.filename) !== value.target ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 5 ||
    value.size > BACKUP_DUMP_MAX_BYTES ||
    typeof value.createdAt !== 'string' ||
    !instant(value.createdAt) ||
    (value.restoreSupported !== undefined &&
      typeof value.restoreSupported !== 'boolean') ||
    (value.restoreMode !== undefined &&
      !['in-place', 'isolated'].includes(String(value.restoreMode))) ||
    (value.sourceEngine !== undefined &&
      !['postgresql', 'timescaledb'].includes(String(value.sourceEngine))) ||
    (value.scope !== undefined &&
      !['full', 'selective'].includes(String(value.scope))) ||
    (value.description !== undefined &&
      (typeof value.description !== 'string' || value.description.length > 500))
  )
    return invalid('备份列表包含无效的 Neo 归档');
  const execution = object(value.execution);
  if (
    value.execution !== undefined &&
    (!execution ||
      execution.timeSource !== 'dump-start' ||
      !instant(execution.dumpStartedAt) ||
      !instant(execution.dumpCompletedAt) ||
      !instant(execution.publicationStartedAt) ||
      Date.parse(execution.dumpStartedAt) >
        Date.parse(execution.dumpCompletedAt) ||
      Date.parse(execution.dumpCompletedAt) >
        Date.parse(execution.publicationStartedAt))
  )
    return invalid('备份执行时间凭据无效');
  const timeSource = value.timeSource ?? 'unavailable';
  if (
    !['dump-start', 'filename', 'mtime', 'unavailable'].includes(
      String(timeSource),
    ) ||
    (execution && timeSource !== 'dump-start') ||
    (timeSource === 'dump-start' &&
      (!execution || value.createdAt !== execution.dumpStartedAt))
  )
    return invalid('备份时间来源无效');
  const supported = value.restoreSupported === true;
  if (supported && (!value.restoreMode || !value.sourceEngine))
    return invalid('备份恢复能力缺少模式');
  if (
    supported &&
    ((value.restoreMode === 'in-place' &&
      (value.scope !== 'selective' || value.sourceEngine !== 'postgresql')) ||
      (value.restoreMode === 'isolated' &&
        value.scope === 'selective' &&
        value.sourceEngine === 'postgresql'))
  )
    return invalid('备份恢复模式与归档范围不一致');
  return {
    filename: value.filename,
    format: 'custom',
    target: value.target as BackupTarget,
    size: value.size,
    createdAt: value.createdAt,
    timeSource: timeSource as BackupFile['timeSource'],
    execution: execution
      ? {
          timeSource: 'dump-start',
          dumpStartedAt: execution.dumpStartedAt as string,
          dumpCompletedAt: execution.dumpCompletedAt as string,
          publicationStartedAt: execution.publicationStartedAt as string,
        }
      : undefined,
    restoreSupported: supported,
    restoreMode: supported
      ? (value.restoreMode as BackupRestoreMode)
      : undefined,
    sourceEngine: value.sourceEngine as BackupFile['sourceEngine'],
    scope: value.scope as BackupFile['scope'],
    description: value.description as string | undefined,
  };
}

export function parseBackupSubmission(raw: unknown): BackupSubmission {
  const value = object(raw);
  if (
    !value ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    !['pending', 'unknown'].includes(String(value.status)) ||
    (value.restoreMode !== undefined &&
      !['isolated', 'in-place'].includes(String(value.restoreMode)))
  )
    return invalid('备份响应缺少有效异步任务');
  return {
    taskId: value.taskId,
    status: value.status as BackupSubmission['status'],
    ...(value.restoreMode === undefined
      ? {}
      : { restoreMode: value.restoreMode as BackupRestoreMode }),
  };
}

export function uncertainBackupSubmission(
  error: unknown,
): BackupSubmission | null {
  if (!(error instanceof ApiError) || error.status !== 500) return null;
  try {
    const value = parseBackupSubmission(error.data);
    return value.status === 'unknown' ? value : null;
  } catch {
    return null;
  }
}

/** Two headers, bounded metadata, padding and the tar end marker. */
export function backupArchiveMaxBytes(file: Pick<BackupFile, 'size'>): number {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 5 ||
    file.size > BACKUP_DUMP_MAX_BYTES
  )
    throw new ApiError('INVALID_INPUT', '备份归档大小无效');
  return Math.ceil(file.size / 512) * 512 + BACKUP_METADATA_MAX_BYTES + 2048;
}

export function backupRestoreWarning(file: BackupFile): string {
  return file.restoreMode === 'isolated'
    ? `将为 ${
        file.target === 'primary' ? '主营' : '竞品'
      } 创建隔离恢复数据库，在线数据库不会切换。完成后核对结果中的数据库名称。`
    : `将原位覆盖 ${
        file.target === 'primary' ? '主营' : '竞品'
      } 数据库的备份表。提交后即使验证未确认，在线数据也可能已经变更；请确认停写安排和独立回滚备份。`;
}

export function backupConfigDraft(config: BackupConfig) {
  return {
    enabled: config.enabled,
    scheduleType: config.scheduleType,
    scheduleValue:
      config.scheduleType === 'daily' ? null : config.scheduleValue ?? 1,
    backupTime: config.backupTime ?? '02:00',
  };
}

/** A completed queue state alone must not imply that a live DB was switched. */
export function backupTaskOutcome(task: TaskInfo): string[] {
  if (task.taskType !== 'backup') return [];
  const result = object(task.result);
  if (!result) return [];
  if (result.operation !== 'restore') return [];
  if (
    result.restoreMode === 'isolated' &&
    result.targetDatabaseChanged === false &&
    typeof result.restoredDatabase === 'string' &&
    /^neo_restore_(?:primary|competitor)_[a-f0-9]{16}$/.test(
      result.restoredDatabase,
    )
  )
    return [
      `隔离数据库：${result.restoredDatabase}；在线目标数据库未切换。`,
      result.verification === 'confirmed'
        ? '隔离恢复验证已确认，生产切换仍需另行安排。'
        : '恢复验证尚未确认，请核对隔离库，勿通过新恢复任务补偿。',
    ];
  if (
    result.restoreMode === 'in-place' &&
    result.targetDatabaseChanged === true
  )
    return [
      '原位恢复已经提交，在线目标数据库已变更。',
      result.verification === 'confirmed'
        ? '后台验证已确认，仍请核对业务记录。'
        : '提交后的验证尚未确认，请人工核对，勿直接重新恢复。',
    ];
  return ['当前结果未提供可确认的恢复回执，请核对任务与数据库后再操作。'];
}
