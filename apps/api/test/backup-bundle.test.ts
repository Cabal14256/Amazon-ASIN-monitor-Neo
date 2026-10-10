import { backupArtifactMetadataSchema } from '@asin-monitor/contracts';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, fstatSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupBundle } from '../src/backup/backup-bundle';

const opened = vi.hoisted(() => ({ handles: [] as FileHandle[] }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      vi.spyOn(handle, 'close');
      opened.handles.push(handle);
      return handle;
    },
  };
});

afterEach(async () => {
  for (const handle of opened.handles.splice(0)) {
    if (handle.fd !== -1) await handle.close();
  }
  vi.restoreAllMocks();
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

describe('backup download bundle', () => {
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
