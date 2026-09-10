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
export function isAsinImportTaskData(
  value: unknown,
): value is AsinImportTaskData {
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
    data.taskSubType !== 'asin' ||
    data.title !== 'ASIN导入' ||
    typeof data.createdAt !== 'string'
  )
    return false;
  const timestamp = new Date(data.createdAt);
  return (
    Number.isFinite(timestamp.getTime()) &&
    timestamp.toISOString() === data.createdAt
  );
}
