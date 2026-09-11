import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type Dir } from 'node:fs';
import { link, lstat, mkdir, opendir, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, win32 } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { IMPORT_MAX_FILE_BYTES } from './csv';
import { ImportParseError } from './rows';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const filePattern = /^import-([0-9a-f-]{36})\.(csv|xlsx)(\.part)?$/;
const resultPattern =
  /^import-([0-9a-f-]{36})\.[0-9a-f]{64}\.result\.json(\.part)?$/;
const mimeTypes = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv',
  'text/x-csv',
  'text/comma-separated-values',
]);
export interface ImportFileReference {
  taskId: string;
  extension: 'csv' | 'xlsx';
  originalFilename: string;
  sha256: string;
  bytes: number;
}
export function importFileType(originalFilename: string, mimeType: string) {
  const filename = basename(win32.basename(originalFilename)).replace(
    /[\x00-\x1f\x7f]/g,
    '',
  );
  const extension = extname(filename).slice(1).toLowerCase();
  if (
    !filename ||
    filename.length > 255 ||
    !['csv', 'xlsx'].includes(extension) ||
    !mimeTypes.has(mimeType)
  )
    throw new ImportParseError('invalid', '只支持 XLSX 或 CSV 文件');
  return { originalFilename: filename, extension: extension as 'csv' | 'xlsx' };
}
export function isImportFileReference(
  value: unknown,
): value is ImportFileReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.taskId === 'string' &&
    uuid.test(file.taskId) &&
    (file.extension === 'csv' || file.extension === 'xlsx') &&
    typeof file.originalFilename === 'string' &&
    file.originalFilename.length > 0 &&
    file.originalFilename.length <= 255 &&
    typeof file.sha256 === 'string' &&
    sha256.test(file.sha256) &&
    typeof file.bytes === 'number' &&
    Number.isSafeInteger(file.bytes) &&
    file.bytes >= 0 &&
    file.bytes <= IMPORT_MAX_FILE_BYTES
  );
}
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** A private shared directory: filenames are server UUIDs, never client paths.
 * Complete files become visible atomically; Redis holds only this small reference. */
export class ImportFileStore {
  private scan?: Dir;
  private cleaning = false;
  private cleanupDone?: Promise<void>;
  private closed = false;
  constructor(readonly directory: string) {
    if (!isAbsolute(directory) || directory.includes('\0'))
      throw new Error('IMPORT_STORAGE_DIRECTORY_INVALID');
  }
  private ensureOpen() {
    if (this.closed) throw new Error('IMPORT_FILE_STORE_CLOSED');
  }
  private path(taskId: string, extension: string) {
    if (!uuid.test(taskId) || !['csv', 'xlsx'].includes(extension))
      throw new ImportParseError('invalid', '导入文件引用无效');
    return join(this.directory, `import-${taskId}.${extension}`);
  }
  async save(
    input: Readable,
    taskId: string,
    filename: string,
    mime: string,
    signal: AbortSignal,
  ): Promise<ImportFileReference> {
    this.ensureOpen();
    signal.throwIfAborted();
    const type = importFileType(filename, mime);
    const path = this.path(taskId, type.extension);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.ensureOpen();
    signal.throwIfAborted();
    // Multipart limits may close an already-yielded stream while mkdir awaits.
    // Attaching pipeline after that close can otherwise wait forever for end.
    if (input.destroyed && !input.readableEnded)
      throw new ImportParseError('invalid', '上传文件流已中断');
    const temporary = `${path}.part`;
    const hash = createHash('sha256');
    let bytes = 0;
    let created = false;
    const destination = createWriteStream(temporary, {
      flags: 'wx',
      mode: 0o600,
    });
    const closed = new Promise<void>((resolve) =>
      destination.once('close', resolve),
    );
    destination.once('open', () => {
      created = true;
    });
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > IMPORT_MAX_FILE_BYTES)
          return callback(
            new ImportParseError('capacity', '导入文件超过 10 MiB 限制'),
          );
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(input, digest, destination, { signal });
      this.ensureOpen();
      signal.throwIfAborted();
      // link is atomic and never overwrites an existing UUID; unlike rename it
      // also rejects collisions on POSIX. Both names are on the same volume.
      await link(temporary, path);
      return { taskId, ...type, sha256: hash.digest('hex'), bytes };
    } finally {
      // pipeline can reject before fs.open completes. Wait for the actual
      // descriptor close before checking ownership and unlinking the part file.
      destination.destroy();
      await closed;
      if (created)
        await unlink(temporary).catch((error: unknown) => {
          if (!missing(error)) throw error;
        });
    }
  }
  async verifiedPath(
    file: ImportFileReference,
    signal: AbortSignal,
  ): Promise<string> {
    this.ensureOpen();
    if (!isImportFileReference(file))
      throw new ImportParseError('invalid', '导入文件引用无效');
    const path = this.path(file.taskId, file.extension);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes)
      throw new ImportParseError('invalid', '导入文件内容已改变');
    const hash = createHash('sha256');
    let bytes = 0;
    const input = createReadStream(path, { signal });
    const completion = finished(input).catch(() => undefined);
    try {
      for await (const chunk of input) {
        signal.throwIfAborted();
        bytes += (chunk as Buffer).length;
        if (bytes > file.bytes)
          throw new ImportParseError('invalid', '导入文件内容已改变');
        hash.update(chunk as Buffer);
      }
    } finally {
      input.destroy();
      await completion;
    }
    signal.throwIfAborted();
    if (bytes !== file.bytes || hash.digest('hex') !== file.sha256)
      throw new ImportParseError('invalid', '导入文件内容已改变');
    return path;
  }
  async remove(file: Pick<ImportFileReference, 'taskId' | 'extension'>) {
    await unlink(this.path(file.taskId, file.extension)).catch(
      (error: unknown) => {
        if (!missing(error)) throw error;
      },
    );
  }
  /** Retains the directory cursor across bounded scans, so retained early files
   * cannot starve cleanup of later orphan files. A task-state check protects
   * pending/processing jobs; unconfirmed submissions are retained until expiry. */
  async cleanup(options: {
    olderThan: number;
    mayRemove(taskId: string, kind: 'upload' | 'result'): Promise<boolean>;
    limit?: number;
  }) {
    this.ensureOpen();
    if (this.cleaning) return { scanned: 0, removed: 0 };
    this.cleaning = true;
    let finishCleanup!: () => void;
    this.cleanupDone = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let scanned = 0,
      removed = 0;
    try {
      this.scan ??= await opendir(this.directory).catch((error: unknown) => {
        if (!missing(error)) throw error;
        return undefined;
      });
      if (!this.scan) return { scanned, removed };
      const limit = Math.min(
        1000,
        Math.max(1, Math.floor(options.limit ?? 100)),
      );
      while (scanned < limit && !this.closed) {
        const entry = await this.scan.read();
        if (!entry) {
          await this.scan.close();
          this.scan = undefined;
          break;
        }
        scanned++;
        const report = resultPattern.exec(entry.name);
        const match = report || filePattern.exec(entry.name);
        if (!match || !uuid.test(match[1]) || !entry.isFile()) continue;
        const path = join(this.directory, entry.name);
        const info = await lstat(path).catch((error: unknown) => {
          if (!missing(error)) throw error;
          return undefined;
        });
        if (
          !info?.isFile() ||
          info.mtimeMs >= options.olderThan ||
          !(await options.mayRemove(match[1], report ? 'result' : 'upload'))
        )
          continue;
        await unlink(path).catch((error: unknown) => {
          if (!missing(error)) throw error;
        });
        removed++;
      }
      return { scanned, removed };
    } finally {
      this.cleaning = false;
      finishCleanup();
    }
  }
  async close() {
    this.closed = true;
    await this.cleanupDone;
    if (this.scan) {
      await this.scan.close();
      this.scan = undefined;
    }
  }
}
