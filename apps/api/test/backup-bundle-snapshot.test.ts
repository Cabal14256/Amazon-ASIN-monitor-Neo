import {
  backupArtifactMetadataSchema,
  type BackupArtifactMetadata,
} from '@asin-monitor/contracts';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { backupBundle } from '../src/backup/backup-bundle';

const filename = 'backup_20261011-020000-abcdef01-primary.dump';
const dump = Buffer.concat([
  Buffer.from('PGDMP'),
  Buffer.alloc(256 * 1024, 65),
]);
const replacement = Buffer.concat([
  Buffer.from('PGDMP'),
  Buffer.alloc(256 * 1024, 66),
]);
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

function metadata(
  version: 3 | 4,
  bytes = dump,
): Extract<BackupArtifactMetadata, { version: 3 | 4 }> {
  const common = {
    filename,
    target: 'primary',
    archiveSha256: digest(bytes),
    databaseSettings: {
      encoding: 'UTF8',
      lcCollate: 'C.UTF-8',
      lcCtype: 'C.UTF-8',
      localeProvider: 'libc',
    },
  };
  const parsed = backupArtifactMetadataSchema.parse(
    version === 3
      ? { ...common, version, sourceEngine: 'postgresql', scope: 'full' }
      : {
          ...common,
          version,
          sourceEngine: 'timescaledb',
          timescale: {
            extensionVersion: '2.29.2',
            hypertables: ['public.monitor_history'],
            continuousAggregates: ['public.monitor_hourly'],
          },
        },
  );
  if (parsed.version !== 3 && parsed.version !== 4)
    throw new Error('fixture digest metadata');
  return parsed;
}

async function consume(stream: Readable, mutate?: () => Promise<void>) {
  const chunks: Buffer[] = [];
  let dumpPartSeen = false;
  for await (const value of stream) {
    chunks.push(Buffer.from(value));
    if (!dumpPartSeen && chunks.length >= 2) {
      dumpPartSeen = true;
      await mutate?.();
    }
  }
  return Buffer.concat(chunks);
}

async function overwriteSameInode(path: string) {
  const before = await lstat(path);
  const handle = await open(path, 'r+');
  try {
    let offset = 0;
    while (offset < replacement.length) {
      const result = await handle.write(
        replacement,
        offset,
        replacement.length - offset,
        offset,
      );
      if (!result.bytesWritten)
        throw new Error('fixture write made no progress');
      offset += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(path);
  expect(after.ino).toBe(before.ino);
  expect(after.dev).toBe(before.dev);
  expect(after.size).toBe(before.size);
}

async function cleanup(stream: Readable | undefined, directory: string) {
  if (stream && !stream.closed) {
    const closed = new Promise<void>((resolve) =>
      stream.once('close', resolve),
    );
    stream.destroy();
    await closed;
  }
  await rm(directory, { recursive: true, force: true });
}

describe('download bytes remain bound to the validated task-owned snapshot', () => {
  it.each([3, 4] as const)(
    'keeps original v%s bytes when the public inode is overwritten after bundle creation',
    async (version) => {
      const directory = await mkdtemp(join(tmpdir(), 'neo-download-inode-'));
      const path = join(directory, filename);
      let stream: Readable | undefined;
      try {
        await writeFile(path, dump);
        stream = await backupBundle(path, filename, metadata(version));
        await overwriteSameInode(path);
        const tar = await consume(stream);
        expect(tar.subarray(512, 512 + dump.length).length).toBe(dump.length);
        expect(digest(tar.subarray(512, 512 + dump.length))).toBe(digest(dump));
        expect(digest(tar.subarray(512, 512 + dump.length))).toBe(
          metadata(version).archiveSha256,
        );
      } finally {
        await cleanup(stream, directory);
      }
    },
  );

  it.each([3, 4] as const)(
    'keeps one verified v%s dump when the shared inode changes between response reads',
    async (version) => {
      const directory = await mkdtemp(
        join(tmpdir(), 'neo-download-midstream-'),
      );
      const path = join(directory, filename);
      let stream: Readable | undefined;
      let mutations = 0;
      try {
        await writeFile(path, dump);
        stream = await backupBundle(path, filename, metadata(version));
        const tar = await consume(stream, async () => {
          mutations++;
          await overwriteSameInode(path);
        });
        expect(mutations).toBe(1);
        expect(tar.subarray(512, 512 + dump.length).length).toBe(dump.length);
        expect(digest(tar.subarray(512, 512 + dump.length))).toBe(digest(dump));
        expect(digest(tar.subarray(512, 512 + dump.length))).toBe(
          metadata(version).archiveSha256,
        );
      } finally {
        await cleanup(stream, directory);
      }
    },
  );

  it('rejects a pre-existing same-size dump whose actual bytes disagree with the sidecar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-download-digest-'));
    let stream: Readable | undefined;
    try {
      const path = join(directory, filename);
      await writeFile(path, replacement);
      const outcome = await backupBundle(path, filename, metadata(3)).then(
        (value) => {
          stream = value;
          return value;
        },
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('BACKUP_BUNDLE_INVALID');
    } finally {
      await cleanup(stream, directory);
    }
  });

  it('preserves stable valid v4 contents and its original metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-download-stable-'));
    let stream: Readable | undefined;
    try {
      const path = join(directory, filename);
      await writeFile(path, dump);
      const sidecar = metadata(4);
      stream = await backupBundle(path, filename, sidecar);
      const tar = await consume(stream);
      expect(tar.subarray(512, 512 + dump.length).length).toBe(dump.length);
      expect(digest(tar.subarray(512, 512 + dump.length))).toBe(digest(dump));
      expect(tar.includes(Buffer.from(JSON.stringify(sidecar)))).toBe(true);
      expect(tar.subarray(-1024)).toEqual(Buffer.alloc(1024));
    } finally {
      await cleanup(stream, directory);
    }
  });

  it('retains the existing historical sidecar format without inventing a digest field', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-download-historical-'));
    let stream: Readable | undefined;
    try {
      const path = join(directory, filename);
      const sidecar = backupArtifactMetadataSchema.parse({
        version: 2,
        filename,
        target: 'primary',
        sourceEngine: 'postgresql',
      });
      await writeFile(path, dump);
      stream = await backupBundle(path, filename, sidecar);
      const tar = await consume(stream);
      expect(tar.subarray(512, 512 + dump.length).length).toBe(dump.length);
      expect(digest(tar.subarray(512, 512 + dump.length))).toBe(digest(dump));
      expect(tar.includes(Buffer.from(JSON.stringify(sidecar)))).toBe(true);
      expect('archiveSha256' in sidecar).toBe(false);
    } finally {
      await cleanup(stream, directory);
    }
  });
});
