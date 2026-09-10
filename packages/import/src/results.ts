import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { ImportResult } from './flow';
import { ImportParseError } from './rows';
import { isAsinImportTaskData, type AsinImportTaskData } from './task';

// The semantic input budget is 32 Mi characters; JSON escaping may expand each
// character to six bytes, in addition to per-error messages and structure.
export const IMPORT_MAX_RESULT_BYTES = 256 * 1024 * 1024;
const PREVIEW_BYTES = 100 * 1024;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
export interface ImportReportReference {
  taskId: string;
  inputSha256: string;
  sha256: string;
  bytes: number;
}
export interface ImportTaskResult extends ImportResult {
  originalFilename: string;
  taskSubType: 'asin';
  summary: string;
  warnings: string[];
}
export function normalizeImportTaskResult(
  result: ImportResult,
  filename: string,
): ImportTaskResult {
  const processedCount =
    Number(result.processedCount) || result.successCount + result.failedCount;
  const total = Math.max(
    Number(result.total) || processedCount,
    processedCount,
  );
  const missingCount = Math.max(
    Number(result.missingCount) || total - processedCount,
    0,
  );
  return {
    ...result,
    originalFilename: filename,
    taskSubType: 'asin',
    total,
    processedCount,
    missingCount,
    summary: `总计 ${total} 条，成功 ${result.successCount} 条，失败 ${result.failedCount} 条`,
    warnings: missingCount > 0 ? [`仍有 ${missingCount} 条记录未归类`] : [],
  };
}
export function isImportReportReference(
  value: unknown,
): value is ImportReportReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.taskId === 'string' &&
    uuid.test(ref.taskId) &&
    typeof ref.inputSha256 === 'string' &&
    digest.test(ref.inputSha256) &&
    typeof ref.sha256 === 'string' &&
    digest.test(ref.sha256) &&
    typeof ref.bytes === 'number' &&
    Number.isSafeInteger(ref.bytes) &&
    ref.bytes > 0 &&
    ref.bytes <= IMPORT_MAX_RESULT_BYTES
  );
}
function isResult(value: unknown): value is ImportTaskResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    [
      'total',
      'processedCount',
      'successCount',
      'failedCount',
      'missingCount',
    ].every(
      (key) =>
        typeof result[key] === 'number' &&
        Number.isSafeInteger(result[key]) &&
        result[key] >= 0 &&
        result[key] <= 100_000,
    ) &&
    typeof result.verificationPassed === 'boolean' &&
    typeof result.originalFilename === 'string' &&
    result.originalFilename.length <= 255 &&
    result.taskSubType === 'asin' &&
    typeof result.summary === 'string' &&
    result.summary.length <= 1000 &&
    Array.isArray(result.warnings) &&
    result.warnings.length <= 10 &&
    result.warnings.every(
      (warning) => typeof warning === 'string' && warning.length <= 1000,
    ) &&
    (result.errors === undefined ||
      (Array.isArray(result.errors) &&
        result.errors.length <= 100_000 &&
        result.errors.every((error: unknown) => {
          if (!error || typeof error !== 'object') return false;
          const row = error as Record<string, unknown>;
          return (
            typeof row.row === 'number' &&
            Number.isSafeInteger(row.row) &&
            row.row >= 0 &&
            row.row <= 1_048_576 &&
            typeof row.message === 'string'
          );
        })))
  );
}

/** Metadata remains below the Redis registry limit. The complete JSON result is
 * downloadable; truncation is explicit and counts always cover the entire file. */
export function importTaskPreview(
  result: ImportTaskResult,
  report: ImportReportReference,
) {
  const errors: NonNullable<ImportResult['errors']> = [];
  let bytes = 0;
  for (const error of result.errors || []) {
    const size = Buffer.byteLength(JSON.stringify(error)) + 1;
    if (errors.length >= 100 || bytes + size > PREVIEW_BYTES) break;
    errors.push(error);
    bytes += size;
  }
  const truncated = errors.length < (result.errors?.length ?? 0);
  const { errors: _allErrors, ...base } = result;
  return {
    ...base,
    ...(errors.length ? { errors } : {}),
    ...(truncated
      ? { errorsTruncated: true, errorCount: result.errors!.length }
      : {}),
    warnings: [
      ...result.warnings,
      ...(truncated
        ? [`错误记录较多，仅展示前 ${errors.length} 条，请下载完整导入结果`]
        : []),
    ],
    filename: `import-result-${report.taskId}.json`,
    mimeType: 'application/json; charset=utf-8',
    fileSizeBytes: report.bytes,
    downloadUrl: `/api/v1/tasks/${report.taskId}/download`,
    report,
  };
}
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export class ImportResultStore {
  constructor(readonly directory: string) {
    if (!isAbsolute(directory) || directory.includes('\0'))
      throw new Error('IMPORT_STORAGE_DIRECTORY_INVALID');
  }
  private path(taskId: string, inputSha256: string) {
    if (!uuid.test(taskId) || !digest.test(inputSha256))
      throw new ImportParseError('invalid', '导入结果引用无效');
    return join(this.directory, `import-${taskId}.${inputSha256}.result.json`);
  }
  async save(
    data: AsinImportTaskData,
    result: ImportTaskResult,
    signal: AbortSignal,
  ): Promise<ImportReportReference> {
    signal.throwIfAborted();
    if (
      !isAsinImportTaskData(data) ||
      !isResult(result) ||
      result.originalFilename !== data.file.originalFilename
    )
      throw new ImportParseError('invalid', '导入结果无效');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    const path = this.path(data.taskId, data.file.sha256);
    const temporary = `${path}.part`;
    const { errors, ...summary } = result;
    function* chunks() {
      const json = JSON.stringify(summary);
      yield json.slice(0, -1);
      if (errors) {
        yield ',"errors":[';
        for (let index = 0; index < errors.length; index++)
          yield `${index ? ',' : ''}${JSON.stringify(errors[index])}`;
        yield ']';
      }
      yield '}';
    }
    const hash = createHash('sha256');
    let bytes = 0;
    let created = false;
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    output.once('open', () => {
      created = true;
    });
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > IMPORT_MAX_RESULT_BYTES)
          return callback(
            new ImportParseError('capacity', '导入结果超过存储限制'),
          );
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.from(chunks()), limit, output, { signal });
      signal.throwIfAborted();
      await link(temporary, path);
      return {
        taskId: data.taskId,
        inputSha256: data.file.sha256,
        sha256: hash.digest('hex'),
        bytes,
      };
    } finally {
      if (created)
        await unlink(temporary).catch((error: unknown) => {
          if (!missing(error)) throw error;
        });
    }
  }
  /** A published final result is also a completion marker for a lost Redis ACK.
   * Binding the filename to task ID + source hash prevents resuming other input. */
  async read(
    data: AsinImportTaskData,
    signal: AbortSignal,
  ): Promise<{
    result: ImportTaskResult;
    report: ImportReportReference;
  } | null> {
    signal.throwIfAborted();
    if (!isAsinImportTaskData(data))
      throw new ImportParseError('invalid', '导入任务数据无效');
    const path = this.path(data.taskId, data.file.sha256);
    const info = await lstat(path).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return undefined;
    });
    if (!info) return null;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size <= 0 ||
      info.size > IMPORT_MAX_RESULT_BYTES
    )
      throw new ImportParseError('invalid', '导入结果文件无效');
    const bytes = await readFile(path, { signal });
    if (bytes.length !== info.size)
      throw new ImportParseError('invalid', '导入结果内容已改变');
    let result: unknown;
    try {
      result = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ImportParseError('invalid', '导入结果内容无效');
    }
    if (
      !isResult(result) ||
      result.originalFilename !== data.file.originalFilename
    )
      throw new ImportParseError('invalid', '导入结果内容无效');
    return {
      result,
      report: {
        taskId: data.taskId,
        inputSha256: data.file.sha256,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      },
    };
  }
  async verifiedPath(
    report: ImportReportReference,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    if (!isImportReportReference(report))
      throw new ImportParseError('invalid', '导入结果引用无效');
    const path = this.path(report.taskId, report.inputSha256);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== report.bytes)
      throw new ImportParseError('invalid', '导入结果内容已改变');
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(path, { signal });
    const completion = finished(stream).catch(() => undefined);
    try {
      for await (const chunk of stream) {
        bytes += (chunk as Buffer).length;
        if (bytes > report.bytes)
          throw new ImportParseError('invalid', '导入结果内容已改变');
        hash.update(chunk as Buffer);
      }
    } finally {
      stream.destroy();
      await completion;
    }
    signal.throwIfAborted();
    if (bytes !== report.bytes || hash.digest('hex') !== report.sha256)
      throw new ImportParseError('invalid', '导入结果内容已改变');
    return path;
  }
}
