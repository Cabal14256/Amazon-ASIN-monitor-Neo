import { importExcelResultSchema } from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAsinImportFile(file: File): void {
  if (!file.name || file.name.length > 200 || !/\.(csv|xlsx)$/i.test(file.name))
    throw new ApiError('INVALID_INPUT', '请选择 CSV 或 XLSX 文件');
  if (!Number.isSafeInteger(file.size) || file.size < 1)
    throw new ApiError('INVALID_INPUT', '导入文件不能为空');
  if (file.size > MAX_IMPORT_BYTES)
    throw new ApiError('INVALID_INPUT', '导入文件不能超过 10 MiB');
}

export async function submitAsinImport(
  http: HttpClient,
  file: File,
  signal?: AbortSignal,
) {
  validateAsinImportFile(file);
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('useAsync', 'true');
  const response = await http.request(
    '/api/v1/variant-groups/import-excel',
    {
      method: 'POST',
      body: form,
      signal,
      timeoutMs: 130_000,
      maxResponseBytes: 1024 * 1024,
    },
    importExcelResultSchema,
  );
  if (response.success !== true || !response.data)
    throw new ApiError('INVALID_RESPONSE', '导入响应缺少结果');
  if (!('taskId' in response.data) || !TASK_ID.test(response.data.taskId))
    throw new ApiError('INVALID_RESPONSE', '导入任务响应无效');
  return response.data;
}

/** A 500 after task creation carries a lookup ID, never a safe retry signal. */
export function uncertainAsinImportTaskId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 500) return null;
  const data = error.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  return record.status === 'unknown' &&
    typeof record.taskId === 'string' &&
    TASK_ID.test(record.taskId)
    ? record.taskId
    : null;
}
