import type { BackupArtifactMetadata } from '@asin-monitor/contracts';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

const BLOCK_SIZE = 512;
const READ_SIZE = 64 * 1024;

function tarHeader(name: string, size: number, modifiedAt: Date): Buffer {
  if (
    !/^[a-zA-Z0-9_.-]+$/.test(name) ||
    Buffer.byteLength(name) > 100 ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw new Error('BACKUP_BUNDLE_ENTRY_INVALID');
  const header = Buffer.alloc(BLOCK_SIZE);
  const writeText = (value: string, offset: number, length: number) => {
    header.write(
      value,
      offset,
      Math.min(length, Buffer.byteLength(value)),
      'ascii',
    );
  };
  const writeOctal = (value: number, offset: number, length: number) => {
    const octal = value.toString(8);
    if (octal.length > length - 1) {
      // POSIX octal size fields top out at 8 GiB. GNU base-256 keeps large
      // configured backup limits streamable without buffering the archive.
      let remaining = BigInt(value);
      for (let index = offset + length - 1; index > offset; index--) {
        header[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
      }
      if (remaining > 0x3fn) throw new Error('BACKUP_BUNDLE_SIZE_INVALID');
      header[offset] = 0x80 | Number(remaining);
      return;
    }
    writeText(octal.padStart(length - 1, '0') + '\0', offset, length);
  };
  writeText(name, 0, 100);
  writeOctal(0o600, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(size, 124, 12);
  writeOctal(Math.floor(modifiedAt.getTime() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  writeText('0', 156, 1);
  writeText('ustar\0', 257, 6);
  writeText('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

function padding(size: number): Buffer | undefined {
  const remainder = size % BLOCK_SIZE;
  return remainder ? Buffer.alloc(BLOCK_SIZE - remainder) : undefined;
}

/** Stream the validated dump and its validated sidecar in one portable tar. */
export async function backupBundle(
  path: string,
  filename: string,
  metadata: BackupArtifactMetadata,
  options: { maxBytes?: number; deadline?: number } = {},
): Promise<Readable> {
  if (metadata.filename !== filename) throw new Error('BACKUP_BUNDLE_INVALID');
  let file: FileHandle | undefined;
  let snapshot: FileHandle | undefined;
  let snapshotDirectory: string | undefined;
  let snapshotPath: string | undefined;
  let closing: Promise<void> | undefined;
  const checkDeadline = () => {
    if (options.deadline !== undefined && Date.now() >= options.deadline)
      throw new Error('BACKUP_BUNDLE_INVALID');
  };
  const closeFile = () =>
    (closing ??= (async () => {
      // Try every owned cleanup even if a previous operation fails. _destroy
      // reports cleanup failures but still closes the stream and its lease.
      const errors: unknown[] = [];
      for (const cleanup of [
        () => snapshot?.close(),
        () => (snapshotPath ? unlink(snapshotPath) : undefined),
        () => (snapshotDirectory ? rmdir(snapshotDirectory) : undefined),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw errors[0];
    })());
  try {
    checkDeadline();
    // Freeze the directory entry as well: Windows has no O_NOFOLLOW, so fstat
    // must reject a changed inode before any bytes are read from the handle.
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error('BACKUP_BUNDLE_INVALID');
    file = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const details = await file.stat();
    if (
      !details.isFile() ||
      details.size < 5 ||
      details.size > (options.maxBytes ?? 1_099_511_627_776) ||
      entry.dev !== details.dev ||
      entry.ino !== details.ino
    )
      throw new Error('BACKUP_BUNDLE_INVALID');
    const header = Buffer.alloc(5);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString('ascii') !== 'PGDMP')
      throw new Error('BACKUP_BUNDLE_INVALID');
    // A public inode can be overwritten through another descriptor. Copy it
    // into a private, exclusively created file before validating any response.
    // The artifact parent is the configured persistent backup volume. Keep
    // download copies on that capacity-managed mount, not the host temp disk.
    snapshotDirectory = await mkdtemp(
      join(dirname(path), 'neo-backup-download-'),
    );
    await chmod(snapshotDirectory, 0o700);
    snapshotPath = join(snapshotDirectory, 'archive.dump');
    snapshot = await open(snapshotPath, 'wx+', 0o600);
    for (let offset = 0; offset < details.size; ) {
      checkDeadline();
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_SIZE, details.size - offset),
      );
      const read = await file.read(chunk, 0, chunk.length, offset);
      if (!read.bytesRead) throw new Error('BACKUP_BUNDLE_INVALID');
      for (let written = 0; written < read.bytesRead; ) {
        checkDeadline();
        const result = await snapshot.write(
          chunk,
          written,
          read.bytesRead - written,
          offset + written,
        );
        if (!result.bytesWritten) throw new Error('BACKUP_BUNDLE_INVALID');
        written += result.bytesWritten;
      }
      offset += read.bytesRead;
    }
    await file.close();
    file = undefined;
    const handle = snapshot;
    const hash = createHash('sha256');
    // Read back the private descriptor: the digest must describe the exact
    // copied bytes subsequently streamed, including writes racing the copy.
    for (let offset = 0; offset < details.size; ) {
      checkDeadline();
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_SIZE, details.size - offset),
      );
      const read = await handle.read(chunk, 0, chunk.length, offset);
      if (!read.bytesRead) throw new Error('BACKUP_BUNDLE_INVALID');
      if (offset === 0 && chunk.subarray(0, 5).toString('ascii') !== 'PGDMP')
        throw new Error('BACKUP_BUNDLE_INVALID');
      hash.update(chunk.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    if (
      'archiveSha256' in metadata &&
      hash.digest('hex') !== metadata.archiveSha256
    )
      throw new Error('BACKUP_BUNDLE_INVALID');
    const sidecar = Buffer.from(JSON.stringify(metadata), 'utf8');
    const sidecarName = `${filename}.meta.json`;
    async function* entries(): AsyncGenerator<Buffer> {
      try {
        yield tarHeader(filename, details.size, details.mtime);
        for (let offset = 0; offset < details.size; ) {
          checkDeadline();
          const chunk = Buffer.allocUnsafe(
            Math.min(READ_SIZE, details.size - offset),
          );
          const { bytesRead } = await handle.read(
            chunk,
            0,
            chunk.length,
            offset,
          );
          if (!bytesRead) throw new Error('BACKUP_BUNDLE_INVALID');
          offset += bytesRead;
          yield chunk.subarray(0, bytesRead);
        }
        const dumpPadding = padding(details.size);
        if (dumpPadding) yield dumpPadding;
        yield tarHeader(sidecarName, sidecar.length, details.mtime);
        yield sidecar;
        const sidecarPadding = padding(sidecar.length);
        if (sidecarPadding) yield sidecarPadding;
        yield Buffer.alloc(BLOCK_SIZE * 2);
      } finally {
        await closeFile();
      }
    }
    const stream = Readable.from(entries());
    const destroy = stream._destroy.bind(stream);
    stream._destroy = (error, callback) => {
      // Returning an unstarted generator does not run its finally block. Close
      // the handle here as well, and keep close emission after actual cleanup.
      destroy(error, (destroyError) => {
        void closeFile().then(
          () => callback(destroyError),
          (closeError: Error) => callback(destroyError ?? closeError),
        );
      });
    };
    return stream;
  } catch (error) {
    await file?.close().catch(() => undefined);
    await closeFile().catch(() => undefined);
    if (error instanceof Error && error.message === 'BACKUP_BUNDLE_INVALID')
      throw error;
    throw new Error('BACKUP_BUNDLE_INVALID');
  }
}
