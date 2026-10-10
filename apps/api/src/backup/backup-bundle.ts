import type { BackupArtifactMetadata } from '@asin-monitor/contracts';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
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
): Promise<Readable> {
  if (metadata.filename !== filename) throw new Error('BACKUP_BUNDLE_INVALID');
  let file: FileHandle | undefined;
  try {
    // Freeze the directory entry as well: Windows has no O_NOFOLLOW, so fstat
    // must reject a changed inode before any bytes are read from the handle.
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error('BACKUP_BUNDLE_INVALID');
    file = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const handle = file;
    const details = await file.stat();
    if (
      !details.isFile() ||
      details.size < 5 ||
      entry.dev !== details.dev ||
      entry.ino !== details.ino
    )
      throw new Error('BACKUP_BUNDLE_INVALID');
    const header = Buffer.alloc(5);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString('ascii') !== 'PGDMP')
      throw new Error('BACKUP_BUNDLE_INVALID');
    const sidecar = Buffer.from(JSON.stringify(metadata), 'utf8');
    let closing: Promise<void> | undefined;
    const closeFile = () => (closing ??= handle.close());
    const sidecarName = `${filename}.meta.json`;
    async function* entries(): AsyncGenerator<Buffer> {
      try {
        yield tarHeader(filename, details.size, details.mtime);
        for (let offset = 0; offset < details.size; ) {
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
    if (error instanceof Error && error.message === 'BACKUP_BUNDLE_INVALID')
      throw error;
    throw new Error('BACKUP_BUNDLE_INVALID');
  }
}
