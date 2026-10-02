import {
  asinExportArtifactSchema,
  type AsinExportArtifact,
} from '@asin-monitor/contracts';
import { createHash, randomUUID } from 'node:crypto';
import {
  close,
  createReadStream,
  createWriteStream,
  open,
  write,
  writev,
  type WriteStream,
} from 'node:fs';
import { link, lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const MAX_EXPORT_BYTES = 268_435_456;
const taskIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const partialPattern = /^export-([0-9a-f-]{36})\.([0-9a-f-]{36})\.part$/;
const finalPattern = /^export-([0-9a-f-]{36})\.xlsx$/;
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export class ExportArtifactError extends Error {
  constructor(readonly reason: 'invalid' | 'too-large' | 'missing') {
    super(`Export artifact ${reason}`);
  }
}

/** Only deterministic task-owned names cross the API/Worker boundary. */
export class ExportArtifactStore {
  readonly directory: string;
  constructor(directory: string, private readonly maxBytes = MAX_EXPORT_BYTES) {
    if (
      !isAbsolute(directory) ||
      directory.includes('\0') ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 4 ||
      maxBytes > MAX_EXPORT_BYTES
    )
      throw new ExportArtifactError('invalid');
    this.directory = resolve(directory);
  }
  private path(taskId: string): string {
    if (!taskIdPattern.test(taskId)) throw new ExportArtifactError('invalid');
    return join(this.directory, `export-${taskId}.xlsx`);
  }
  private partialPath(taskId: string): string {
    this.path(taskId);
    return join(this.directory, `export-${taskId}.${randomUUID()}.part`);
  }
  async temporary(
    taskId: string,
  ): Promise<{ path: string; stream: WriteStream }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.partialPath(taskId);
    let written = 0;
    const exceedsLimit = (bytes: number) => bytes > this.maxBytes - written;
    return {
      path,
      stream: createWriteStream(path, {
        flags: 'wx',
        mode: 0o600,
        // Enforce the limit at the filesystem write boundary, including corked
        // batches. Normal WriteStream backpressure/open/close semantics remain.
        fs: {
          open,
          close,
          write(
            fd: number,
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | null,
            callback: (
              error: NodeJS.ErrnoException | null,
              bytes: number,
              buffer: Buffer,
            ) => void,
          ) {
            if (exceedsLimit(length)) {
              callback(new ExportArtifactError('too-large'), 0, buffer);
              return;
            }
            write(
              fd,
              buffer,
              offset,
              length,
              position,
              (error, bytes, value) => {
                if (!error) written += bytes;
                callback(error, bytes, value);
              },
            );
          },
          writev(
            fd: number,
            buffers: Buffer[],
            position: number | null,
            callback: (
              error: NodeJS.ErrnoException | null,
              bytes: number,
              buffers: Buffer[],
            ) => void,
          ) {
            if (
              exceedsLimit(
                buffers.reduce((sum, buffer) => sum + buffer.length, 0),
              )
            ) {
              callback(new ExportArtifactError('too-large'), 0, buffers);
              return;
            }
            writev(fd, buffers, position, (error, bytes, value) => {
              if (!error) written += bytes;
              callback(error, bytes, value);
            });
          },
        },
      }),
    };
  }
  async discard(path: string): Promise<void> {
    const target = resolve(path);
    if (
      !target.startsWith(`${this.directory}${sep}`) ||
      !partialPattern.test(target.slice(this.directory.length + 1))
    )
      throw new ExportArtifactError('invalid');
    await unlink(target).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
  async discardFinal(taskId: string): Promise<void> {
    await unlink(this.path(taskId)).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
  private async inspectFile(
    path: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<AsinExportArtifact | null> {
    signal?.throwIfAborted();
    const details = await lstat(path).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return undefined;
    });
    if (!details) return null;
    if (!details.isFile() || details.isSymbolicLink())
      throw new ExportArtifactError('invalid');
    if (details.size < 4 || details.size > this.maxBytes)
      throw new ExportArtifactError('too-large');
    const hash = createHash('sha256');
    let bytes = 0;
    let magic = Buffer.alloc(0);
    for await (const chunk of createReadStream(path, { signal })) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > this.maxBytes) throw new ExportArtifactError('too-large');
      if (magic.length < 4)
        magic = Buffer.concat([magic, buffer]).subarray(0, 4);
      hash.update(buffer);
    }
    signal?.throwIfAborted();
    if (
      bytes !== details.size ||
      !magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    )
      throw new ExportArtifactError('invalid');
    return asinExportArtifactSchema.parse({
      taskId,
      key: `export-${taskId}.xlsx`,
      bytes,
      sha256: hash.digest('hex'),
    });
  }
  async read(taskId: string, signal?: AbortSignal) {
    return this.inspectFile(this.path(taskId), taskId, signal);
  }
  async publish(taskId: string, partial: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const target = resolve(partial);
    if (
      !target.startsWith(`${this.directory}${sep}`) ||
      !partialPattern.test(target.slice(this.directory.length + 1)) ||
      !target.slice(this.directory.length + 1).startsWith(`export-${taskId}.`)
    )
      throw new ExportArtifactError('invalid');
    // Validate the complete private file before exposing its final name.
    const candidate = await this.inspectFile(target, taskId, signal);
    if (!candidate) throw new ExportArtifactError('missing');
    signal.throwIfAborted();
    // A hard link publishes atomically without replacing a result from a prior
    // attempt. A crashed writer can leave .part, never a downloadable artifact.
    try {
      await link(target, this.path(taskId));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
    const result = await this.read(taskId, signal);
    if (!result) throw new ExportArtifactError('missing');
    return result;
  }
  async verifiedPath(reference: unknown, signal: AbortSignal): Promise<string> {
    const parsed = asinExportArtifactSchema.safeParse(reference);
    if (!parsed.success) throw new ExportArtifactError('invalid');
    const actual = await this.read(parsed.data.taskId, signal);
    if (
      !actual ||
      actual.bytes !== parsed.data.bytes ||
      actual.sha256 !== parsed.data.sha256 ||
      actual.key !== parsed.data.key
    )
      throw new ExportArtifactError('invalid');
    return this.path(parsed.data.taskId);
  }
  async cleanup(
    olderThan: number,
    limit: number,
    mayRemove: (taskId: string, kind: 'partial' | 'final') => Promise<boolean>,
  ): Promise<number> {
    if (
      !Number.isFinite(olderThan) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new ExportArtifactError('invalid');
    const entries = await readdir(this.directory, {
      withFileTypes: true,
    }).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return [];
    });
    let removed = 0;
    for (const entry of entries) {
      if (removed >= limit || !entry.isFile()) continue;
      const part = partialPattern.exec(entry.name);
      const final = finalPattern.exec(entry.name);
      if (!part && !final) continue;
      const taskId = (part ?? final)![1];
      if (!taskIdPattern.test(taskId)) continue;
      const path = join(this.directory, entry.name);
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.mtimeMs >= olderThan)
        continue;
      if (!(await mayRemove(taskId, part ? 'partial' : 'final'))) continue;
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
      removed++;
    }
    return removed;
  }
}
