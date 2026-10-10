import {
  backupConfigResultSchema,
  saveBackupConfigRequestSchema,
  taskInfoSchema,
  type BackupConfig,
  type SaveBackupConfigRequest,
  type TaskInfo,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';
import {
  backupFilenameTarget,
  object,
  parseBackupFile,
  parseBackupSubmission,
  type BackupFile,
  type BackupOperation,
} from './backup-model';

const BASE = '/api/v1/backup';
const OPTIONS = { timeoutMs: 30_000, maxResponseBytes: 8 * 1024 * 1024 };

function data(raw: unknown): unknown {
  const value = object(raw);
  if (value?.success !== true || value.data === undefined)
    throw new ApiError('INVALID_RESPONSE', '备份接口未返回有效结果');
  return value.data;
}

export class BackupApi {
  constructor(private readonly http: Pick<HttpClient, 'request' | 'url'>) {}

  async list(signal?: AbortSignal): Promise<BackupFile[]> {
    const rows = data(await this.http.request(BASE, { signal, ...OPTIONS }));
    if (!Array.isArray(rows) || rows.length > 10_000)
      throw new ApiError(
        'INVALID_RESPONSE',
        '备份列表超过有界展示范围，请联系运维整理归档',
      );
    const files = rows.map(parseBackupFile);
    if (new Set(files.map((file) => file.filename)).size !== files.length)
      throw new ApiError(
        'INVALID_RESPONSE',
        '备份列表含重复文件身份，请重新读取',
      );
    return files;
  }

  async config(signal?: AbortSignal): Promise<BackupConfig> {
    const response = await this.http.request(
      `${BASE}/config`,
      { signal, ...OPTIONS },
      backupConfigResultSchema,
    );
    return data(response) as BackupConfig;
  }

  async saveConfig(
    input: SaveBackupConfigRequest,
    signal?: AbortSignal,
  ): Promise<BackupConfig> {
    const parsed = saveBackupConfigRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new ApiError('INVALID_INPUT', '自动备份计划参数无效');
    const response = await this.http.request(
      `${BASE}/config`,
      {
        signal,
        ...OPTIONS,
        method: 'POST',
        json: parsed.data,
      },
      backupConfigResultSchema,
    );
    return data(response) as BackupConfig;
  }

  async scheduled(signal?: AbortSignal): Promise<TaskInfo[]> {
    const rows = data(
      await this.http.request(`${BASE}/scheduled-tasks`, {
        signal,
        ...OPTIONS,
      }),
    );
    if (!Array.isArray(rows) || rows.length > 50)
      throw new ApiError('INVALID_RESPONSE', '计划备份执行记录响应无效');
    return rows.map((raw) => {
      const result = taskInfoSchema.safeParse(raw);
      // The authenticated admin endpoint enforces the system owner; public
      // TaskInfo deliberately excludes userId. Never infer cancellation rights.
      if (
        !result.success ||
        result.data.taskType !== 'backup' ||
        result.data.taskSubType !== 'create' ||
        result.data.canCancel ||
        result.data.downloadUrl !== null
      )
        throw new ApiError('INVALID_RESPONSE', '计划备份任务身份或能力无效');
      return result.data;
    });
  }

  async submit(input: BackupOperation, signal?: AbortSignal) {
    if (!['primary', 'competitor'].includes(input.target))
      throw new ApiError('INVALID_INPUT', '请选择备份数据库');
    if (input.operation === 'create') {
      if ((input.description?.length ?? 0) > 500)
        throw new ApiError('INVALID_INPUT', '备份描述不能超过500字');
    } else if (
      input.operation !== 'restore' ||
      !input.filename ||
      backupFilenameTarget(input.filename) !== input.target
    )
      throw new ApiError('INVALID_INPUT', '恢复文件与目标数据库不一致');
    const response = await this.http.request(
      input.operation === 'create' ? BASE : `${BASE}/restore`,
      {
        signal,
        ...OPTIONS,
        method: 'POST',
        json:
          input.operation === 'create'
            ? {
                target: input.target,
                description: input.description,
                useAsync: true,
              }
            : {
                filename: input.filename,
                target: input.target,
                useAsync: true,
              },
      },
    );
    return parseBackupSubmission(data(response));
  }

  async remove(filename: string, signal?: AbortSignal): Promise<void> {
    backupFilenameTarget(filename);
    const result = data(
      await this.http.request(`${BASE}/${encodeURIComponent(filename)}`, {
        signal,
        ...OPTIONS,
        method: 'DELETE',
      }),
    );
    if (typeof object(result)?.message !== 'string')
      throw new ApiError(
        'INVALID_RESPONSE',
        '删除备份结果未确认，请刷新列表核实',
      );
  }

  downloadPath(filename: string): string {
    backupFilenameTarget(filename);
    return `${BASE}/${encodeURIComponent(filename)}/download`;
  }
  downloadURL(filename: string): string {
    return this.http.url(this.downloadPath(filename));
  }
}
