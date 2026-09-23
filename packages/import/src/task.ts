import { isImportFileReference, type ImportFileReference } from './files';

export interface AsinImportTaskData {
  taskId: string;
  userId: string;
  createdAt: string;
  taskType: 'import';
  taskSubType: 'asin';
  title: 'ASIN导入';
  file: ImportFileReference;
}
export interface CompetitorImportTaskData {
  taskId: string;
  userId: string;
  createdAt: string;
  taskType: 'import';
  taskSubType: 'competitor-asin';
  title: '竞品ASIN导入';
  domain: 'competitor';
  file: ImportFileReference;
}
export type ImportTaskData = AsinImportTaskData | CompetitorImportTaskData;

function isImportTaskCore(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (
    !isImportFileReference(data.file) ||
    data.taskId !== data.file.taskId ||
    typeof data.userId !== 'string' ||
    !data.userId ||
    data.userId.length > 200 ||
    /[\x00-\x1f\x7f]/.test(data.userId) ||
    data.taskType !== 'import' ||
    typeof data.createdAt !== 'string'
  )
    return false;
  const timestamp = new Date(data.createdAt);
  return (
    Number.isFinite(timestamp.getTime()) &&
    timestamp.toISOString() === data.createdAt
  );
}
export function isAsinImportTaskData(
  value: unknown,
): value is AsinImportTaskData {
  return (
    isImportTaskCore(value) &&
    value.taskSubType === 'asin' &&
    value.title === 'ASIN导入'
  );
}
export function isCompetitorImportTaskData(
  value: unknown,
): value is CompetitorImportTaskData {
  return (
    isImportTaskCore(value) &&
    value.taskSubType === 'competitor-asin' &&
    value.title === '竞品ASIN导入' &&
    value.domain === 'competitor'
  );
}
export function isImportTaskData(value: unknown): value is ImportTaskData {
  return isAsinImportTaskData(value) || isCompetitorImportTaskData(value);
}
