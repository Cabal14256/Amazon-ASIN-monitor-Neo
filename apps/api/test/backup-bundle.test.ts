import { backupArtifactMetadataSchema } from '@asin-monitor/contracts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, fstatSync } from 'node:fs';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupBundle } from '../src/backup/backup-bundle';

const opened = vi.hoisted(() => ({
  handles: [] as FileHandle[],
  paths: new Map<FileHandle, string>(),
  failSnapshotWrite: false,
  failSystemTempSnapshot: false,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      const prefix = String(args[0]);
      if (
        opened.failSystemTempSnapshot &&
        prefix === join(tmpdir(), 'neo-backup-download-')
      )
        throw Object.assign(new Error('fixture system temporary disk full'), {
          code: 'ENOSPC',
        });
      return fs.mkdtemp(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      vi.spyOn(handle, 'close');
      opened.handles.push(handle);
      opened.paths.set(handle, String(args[0]));
      if (args[1] === 'wx+' && opened.failSnapshotWrite)
        vi.spyOn(handle, 'write').mockRejectedValueOnce(
          new Error('fixture copy write failed'),
        );
      return handle;
    },
  };
});

afterEach(async () => {
  for (const handle of opened.handles.splice(0)) {
    if (handle.fd !== -1) await handle.close();
  }
  vi.restoreAllMocks();
  opened.paths.clear();
  opened.failSnapshotWrite = false;
  opened.failSystemTempSnapshot = false;
});

const filename = 'backup_20260927-020000-abcdef01-primary.dump';
const metadata = backupArtifactMetadataSchema.parse({
  version: 2,
  filename,
  target: 'primary',
  sourceEngine: 'postgresql',
  description: 'nightly backup',
});

async function consume(stream: Awaited<ReturnType<typeof backupBundle>>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('review5 capacity-managed download snapshots', () => {
  it('retries an actual snapshot close and retains the stream until the descriptor closes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-bundle-close-retry-'));
    let stream: Awaited<ReturnType<typeof backupBundle>> | undefined;
    try {
      const path = join(directory, filename);
      await writeFile(path, 'PGDMPclose-retry');
      stream = await backupBundle(path, filename, metadata);
      const snapshot = opened.handles.at(-1)!;
      vi.mocked(snapshot.close).mockRejectedValueOnce(
        new Error('fixture transient close'),
      );
      stream.on('error', () => undefined);
      const closed = new Promise<void>((resolve) =>
        stream!.once('close', resolve),
      );
      stream.destroy();
      await closed;
      expect(snapshot.fd).toBe(-1);
      expect(snapshot.close).toHaveBeenCalledTimes(2);
      await expect(access(opened.paths.get(snapshot)!)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('downloads a valid backup-volume archive while system temporary snapshots have no capacity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-bundle-volume-'));
    try {
      const path = join(directory, filename);
      const dump = Buffer.from('PGDMPbackup-volume');
      await writeFile(path, dump);
      opened.failSystemTempSnapshot = true;
      const tar = await consume(await backupBundle(path, filename, metadata));
      expect(tar.subarray(512, 512 + dump.length)).toEqual(dump);
      expect(opened.handles.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains a private snapshot on the archive volume until its actual descriptor closes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-bundle-placement-'));
    let stream: Awaited<ReturnType<typeof backupBundle>> | undefined;
    try {
      const path = join(directory, filename);
      await writeFile(path, 'PGDMPbackup-volume');
      stream = await backupBundle(path, filename, metadata);
      const snapshot = opened.handles.at(-1)!;
      const snapshotPath = opened.paths.get(snapshot)!;
      expect(dirname(dirname(snapshotPath))).toBe(directory);
      expect((await snapshot.stat()).dev).toBe((await lstat(path)).dev);
      expect(snapshot.fd).not.toBe(-1);
      if (process.platform !== 'win32') {
        expect((await lstat(dirname(snapshotPath))).mode & 0o777).toBe(0o700);
        expect((await snapshot.stat()).mode & 0o777).toBe(0o600);
      }
      await consume(stream);
      expect(snapshot.fd).toBe(-1);
      await expect(access(snapshotPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(dirname(snapshotPath))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(path, 'utf8')).toBe('PGDMPbackup-volume');
    } finally {
      if (stream && !stream.closed) {
        const closed = new Promise<void>((resolve) =>
          stream!.once('close', resolve),
        );
        stream.destroy();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('healthy control streams the original archive and sidecar when both volumes have capacity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-bundle-control-'));
    try {
      const path = join(directory, filename);
      const dump = Buffer.from('PGDMPhealthy');
      await writeFile(path, dump);
      const tar = await consume(await backupBundle(path, filename, metadata));
      expect(tar.subarray(512, 512 + dump.length)).toEqual(dump);
      expect(tar.includes(Buffer.from(JSON.stringify(metadata)))).toBe(true);
      expect(opened.handles.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('backup download bundle', () => {
  it('closes both actual descriptors and removes a constructor snapshot on digest rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-bundle-constructor-'));
    try {
      const dump = Buffer.from('PGDMPactual');
      const path = join(directory, filename);
      await writeFile(path, dump);
      const sidecar = backupArtifactMetadataSchema.parse({
        ...metadata,
        version: 3,
        scope: 'full',
        archiveSha256: createHash('sha256')
          .update('PGDMPdifferent')
          .digest('hex'),
        databaseSettings: {
          encoding: 'UTF8',
          lcCollate: 'C.UTF-8',
          lcCtype: 'C.UTF-8',
          localeProvider: 'libc',
        },
      });
      await expect(backupBundle(path, filename, sidecar)).rejects.toThrow(
        'BACKUP_BUNDLE_INVALID',
      );
      expect(opened.handles).toHaveLength(2);
      expect(opened.handles.every((handle) => handle.fd === -1)).toBe(true);
      const privatePath = opened.paths.get(opened.handles[1])!;
      await expect(access(privatePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(dirname(privatePath))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(path)).toEqual(dump);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('closes actual constructor descriptors and removes its partial snapshot after copy write failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-bundle-copy-failure-'));
    try {
      const path = join(directory, filename);
      await writeFile(path, 'PGDMPactual');
      opened.failSnapshotWrite = true;
      await expect(backupBundle(path, filename, metadata)).rejects.toThrow(
        'BACKUP_BUNDLE_INVALID',
      );
      expect(opened.handles).toHaveLength(2);
      expect(opened.handles.every((handle) => handle.fd === -1)).toBe(true);
      const privatePath = opened.paths.get(opened.handles[1])!;
      await expect(access(privatePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(dirname(privatePath))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(path, 'utf8')).toBe('PGDMPactual');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for a real deferred snapshot read to settle before close and cleanup', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'neo-bundle-deferred-read-'),
    );
    let stream: Awaited<ReturnType<typeof backupBundle>> | undefined;
    let release: (() => void) | undefined;
    try {
      const path = join(directory, filename);
      await writeFile(path, 'PGDMPactual');
      stream = await backupBundle(path, filename, metadata);
      const handle = opened.handles.at(-1)!;
      const descriptor = handle.fd;
      const privatePath = opened.paths.get(handle)!;
      const read = handle.read.bind(handle);
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: (() => void) | undefined;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args) => {
        entered!();
        await gate;
        return Reflect.apply(read, handle, args);
      });
      stream.on('error', () => undefined);
      stream.resume();
      await reading;
      const closed = once(stream, 'close');
      stream.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stream.closed).toBe(false);
      expect(fstatSync(descriptor).isFile()).toBe(true);
      await expect(access(privatePath)).resolves.toBeUndefined();
      release!();
      await closed;
      expect(handle.close).toHaveBeenCalledOnce();
      expect(() => fstatSync(descriptor)).toThrow(
        expect.objectContaining({ code: 'EBADF' }),
      );
      await expect(access(dirname(privatePath))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      release?.();
      if (stream && !stream.closed) {
        const closed = new Promise<void>((resolve) =>
          stream!.once('close', resolve),
        );
        stream.destroy();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('is a standard tar with the dump and restore sidecar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-bundle-'));
    try {
      const dump = Buffer.from('PGDMPfixture');
      const path = join(directory, filename);
      const archive = join(directory, 'download.tar');
      await writeFile(path, dump);
      await pipeline(
        await backupBundle(path, filename, metadata),
        createWriteStream(archive),
      );
      const entries = execFileSync('tar', ['-tf', archive], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\r?\n/);
      expect(entries).toEqual([filename, `${filename}.meta.json`]);
      expect(execFileSync('tar', ['-xOf', archive, filename])).toEqual(dump);
      const sidecar = execFileSync('tar', [
        '-xOf',
        archive,
        `${filename}.meta.json`,
      ]);
      expect(JSON.parse(sidecar.toString('utf8'))).toEqual(metadata);
      expect((await readFile(archive)).length % 512).toBe(0);
      expect(opened.handles.at(-1)?.close).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('streams the validated inode after its public path is replaced before consumption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-bundle-'));
    const path = join(directory, filename);
    const original = Buffer.from('PGDMPoriginal');
    const replacement = Buffer.from('PGDMPdifferent');
    let stream: Awaited<ReturnType<typeof backupBundle>> | undefined;
    try {
      await writeFile(path, original);
      stream = await backupBundle(path, filename, metadata);
      await rename(path, join(directory, 'original.dump'));
      await writeFile(path, replacement);
      const tar = await consume(stream);
      expect(tar.subarray(512, 512 + original.length)).toEqual(original);
      expect(await readFile(path)).toEqual(replacement);
      expect(opened.handles.at(-1)?.close).toHaveBeenCalledOnce();
    } finally {
      if (stream && !stream.destroyed) {
        const closed = once(stream, 'close');
        stream.destroy();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a later symlink to an outside dump out of the bundle', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-bundle-'));
    const outside = await mkdtemp(join(tmpdir(), 'neo-backup-bundle-outside-'));
    const path = join(directory, filename);
    const original = Buffer.from('PGDMPoriginal');
    const outsideDump = Buffer.from('PGDMPoutside-secret');
    let stream: Awaited<ReturnType<typeof backupBundle>> | undefined;
    try {
      await writeFile(path, original);
      const target = join(outside, 'outside.dump');
      await writeFile(target, outsideDump);
      stream = await backupBundle(path, filename, metadata);
      await rename(path, join(directory, 'original.dump'));
      try {
        await symlink(target, path, 'file');
      } catch (error) {
        if (
          process.platform === 'win32' &&
          ['EPERM', 'EACCES', 'ENOTSUP'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        ) {
          context.skip(
            'Windows does not permit creating a file symlink in this environment',
          );
          return;
        }
        throw error;
      }
      const tar = await consume(stream);
      expect(tar.subarray(512, 512 + original.length)).toEqual(original);
      expect(tar.includes(outsideDump)).toBe(false);
      await expect(backupBundle(path, filename, metadata)).rejects.toThrow(
        'BACKUP_BUNDLE_INVALID',
      );
      expect(await readFile(target)).toEqual(outsideDump);
    } finally {
      if (stream && !stream.destroyed) {
        const closed = once(stream, 'close');
        stream.destroy();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('closes its opened descriptor once when destroyed before the first read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-bundle-'));
    try {
      const path = join(directory, filename);
      await writeFile(path, 'PGDMPfixture');
      const stream = await backupBundle(path, filename, metadata);
      const handle = opened.handles.at(-1)!;
      const descriptor = handle.fd;
      expect(fstatSync(descriptor).isFile()).toBe(true);
      const closed = once(stream, 'close');
      stream.destroy();
      stream.destroy();
      await closed;
      expect(handle.close).toHaveBeenCalledOnce();
      expect(() => fstatSync(descriptor)).toThrow(
        expect.objectContaining({ code: 'EBADF' }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('closes its descriptor when the opened file is not a custom dump', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-bundle-'));
    try {
      const path = join(directory, filename);
      await writeFile(path, 'invalid archive');
      await expect(backupBundle(path, filename, metadata)).rejects.toThrow(
        'BACKUP_BUNDLE_INVALID',
      );
      const handle = opened.handles.at(-1)!;
      expect(handle.fd).toBe(-1);
      expect(handle.close).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
