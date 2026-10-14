import { backupArtifactMetadataSchema } from '@asin-monitor/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  rm,
  rmdir,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupController } from '../src/backup/backup.controller';
import { BackupService } from '../src/backup/backup.service';

const snapshotCleanup = vi.hoisted(() => ({
  files: [] as { path: string; handle: FileHandle }[],
  failUnlink: '',
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[1] === 'wx+')
        snapshotCleanup.files.push({ path: String(args[0]), handle });
      return handle;
    },
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      if (String(args[0]) === snapshotCleanup.failUnlink)
        throw Object.assign(new Error('fixture snapshot unlink failed'), {
          code: 'EIO',
        });
      return fs.unlink(...args);
    },
  };
});
afterEach(() => {
  snapshotCleanup.files.splice(0);
  snapshotCleanup.failUnlink = '';
});

const filename = 'backup_20261011-020000-abcdef01-primary.dump';
const dump = Buffer.concat([
  Buffer.from('PGDMP'),
  Buffer.alloc(256 * 1024, 65),
]);
const principal = {
  userId: 'backup-download-owner',
  sessionId: 'backup-download-session',
} as never;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-backup-download-lease-'));
  const unit = {
    lockOperator: vi.fn(async () => ({
      status: 'ACTIVE' as const,
      lockedUntil: null,
      forcePasswordChange: false,
      passwordExpiresAt: null,
    })),
    lockSession: vi.fn(async () => ({
      status: 'ACTIVE' as const,
      expiresAt: null,
    })),
    operatorPermissionCodes: vi.fn(async () => ['settings:write']),
  };
  const repository = {
    transaction: async (operation: (value: typeof unit) => unknown) =>
      operation(unit),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new BackupService(
    {
      AUTH_DATA_AUTHORITY: 'postgresql',
      BACKUP_STORAGE_DIRECTORY: directory,
      BACKUP_MAX_BYTES: 1024 * 1024,
      TASK_META_TTL_SECONDS: 604800,
    } as never,
    repository as never,
    {} as never,
    {} as never,
    logger as never,
  );
  const controller = new BackupController(service);
  const metadata = backupArtifactMetadataSchema.parse({
    version: 3,
    filename,
    target: 'primary',
    sourceEngine: 'postgresql',
    scope: 'full',
    archiveSha256: createHash('sha256').update(dump).digest('hex'),
    databaseSettings: {
      encoding: 'UTF8',
      lcCollate: 'C.UTF-8',
      lcCtype: 'C.UTF-8',
      localeProvider: 'libc',
    },
  });
  await writeFile(join(directory, filename), dump);
  await writeFile(
    join(directory, `${filename}.meta.json`),
    JSON.stringify(metadata),
  );
  const streams: Readable[] = [];
  const download = async () => {
    const file = await controller.download(
      { auth: principal } as unknown as FastifyRequest,
      filename,
      { header: vi.fn() } as unknown as FastifyReply,
    );
    const stream = file.getStream();
    // Keep every accepted descriptor tracked even when a capacity assertion fails.
    stream.on('error', () => undefined);
    streams.push(stream);
    return stream;
  };
  const close = async (stream: Readable, error?: Error) => {
    if (stream.closed) return;
    const closed = new Promise<void>((resolve) =>
      stream.once('close', resolve),
    );
    stream.destroy(error);
    await closed;
  };
  const cleanup = async () => {
    for (const stream of streams) await close(stream);
    await service.onModuleDestroy();
    await rm(directory, { recursive: true, force: true });
  };
  return {
    directory,
    service,
    unit,
    logger,
    streams,
    download,
    close,
    cleanup,
    metadata,
    controller,
  };
}

async function outcome(download: () => Promise<Readable>) {
  return download().then(
    (value) => value,
    (error: unknown) => error,
  );
}

describe('backup download capacity includes the live response stream', () => {
  it('retains admission until failed snapshot cleanup succeeds after the actual descriptor closes', async () => {
    const f = await fixture();
    let residual: string | undefined;
    try {
      for (let index = 0; index < 8; index++) await f.download();
      const owned = snapshotCleanup.files[0];
      residual = owned.path;
      snapshotCleanup.failUnlink = owned.path;
      const closing = f.close(f.streams[0]);
      await vi.waitFor(() => expect(owned.handle.fd).toBe(-1));
      expect(f.streams[0].closed).toBe(false);
      expect(await outcome(f.download)).toMatchObject({ status: 429 });
      snapshotCleanup.failUnlink = '';
      await closing;
      expect(owned.handle.fd).toBe(-1);
      expect(f.logger.warn).toHaveBeenCalledWith(
        '备份下载流未完成',
        'BackupService',
        { reason: 'backup_download_stream_failed' },
      );
      expect((await f.download()).closed).toBe(false);
      expect(await outcome(f.download)).toMatchObject({ status: 429 });
    } finally {
      snapshotCleanup.failUnlink = '';
      try {
        // Reclaim the exact owned residual before removing its backup-volume
        // parent. The fixture's recursive cleanup would otherwise remove it.
        if (residual) {
          await unlink(residual).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          await rmdir(dirname(residual)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            },
          );
        }
      } finally {
        await f.cleanup();
      }
    }
  });
  it('cleans up live unread responses before shutdown completes', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 8; index++) await f.download();
      await f.service.onModuleDestroy();
      expect(f.streams.every((stream) => stream.closed)).toBe(true);
      expect(await outcome(f.download)).toMatchObject({ status: 503 });
    } finally {
      await f.cleanup();
    }
  });

  it('bounds an unread response by the existing 30 minute download budget', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const stream = await f.download();
      const closed = new Promise<void>((resolve) =>
        stream.once('close', resolve),
      );
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await closed;
      expect(stream.closed).toBe(true);
      expect((await f.download()).closed).toBe(false);
    } finally {
      vi.useRealTimers();
      await f.cleanup();
    }
  });

  it('cleans up when the transport closes before it consumes the stream', async () => {
    const f = await fixture();
    try {
      const raw = new EventEmitter();
      const file = await f.controller.download(
        { auth: principal } as unknown as FastifyRequest,
        filename,
        { header: vi.fn(), raw } as unknown as FastifyReply,
      );
      const stream = file.getStream();
      f.streams.push(stream);
      const closed = new Promise<void>((resolve) =>
        stream.once('close', resolve),
      );
      raw.emit('close');
      await closed;
      expect(stream.closed).toBe(true);
      expect(raw.listenerCount('close')).toBe(0);
      for (let index = 0; index < 8; index++) await f.download();
      expect(await outcome(f.download)).toMatchObject({ status: 429 });
    } finally {
      await f.cleanup();
    }
  });

  it('releases the snapshot lease when response construction fails', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 9; index++)
        await expect(
          f.controller.download(
            { auth: principal } as unknown as FastifyRequest,
            filename,
            {
              header: () => {
                throw new Error('fixture response failed');
              },
            } as unknown as FastifyReply,
          ),
        ).rejects.toThrow('fixture response failed');
      for (let index = 0; index < 8; index++) await f.download();
      expect(await outcome(f.download)).toMatchObject({ status: 429 });
    } finally {
      await f.cleanup();
    }
  });

  it('releases admission after private snapshot verification fails', async () => {
    const f = await fixture();
    try {
      await writeFile(
        join(f.directory, filename),
        Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(256 * 1024, 66)]),
      );
      for (let index = 0; index < 9; index++)
        expect(await outcome(f.download)).toMatchObject({ status: 500 });
      await writeFile(join(f.directory, filename), dump);
      for (let index = 0; index < 8; index++) await f.download();
      expect(await outcome(f.download)).toMatchObject({ status: 429 });
    } finally {
      await f.cleanup();
    }
  });
  it('refuses the ninth response while eight real archive streams remain unconsumed', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 8; index++) await f.download();
      const ninth = await outcome(f.download);
      expect(ninth).toMatchObject({ status: 429 });
      expect(f.streams).toHaveLength(8);
      expect(f.streams.every((stream) => !stream.closed)).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('releases exactly one slot on an unstarted response close and does not double-release it', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 8; index++) await f.download();
      await f.close(f.streams[0]);
      f.streams[0].destroy();
      const replacement = await f.download();
      expect(replacement.closed).toBe(false);
      expect(await outcome(f.download)).toMatchObject({ status: 429 });
    } finally {
      await f.cleanup();
    }
  });

  it('releases an errored response after cleanup and still bounds the other seven', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 8; index++) await f.download();
      await f.close(f.streams[0], new Error('fixture client disconnected'));
      expect((await f.download()).closed).toBe(false);
      expect(await outcome(f.download)).toMatchObject({ status: 429 });
    } finally {
      await f.cleanup();
    }
  });

  it('preserves successful two-member bytes and admits a new response after complete consumption', async () => {
    const f = await fixture();
    try {
      const stream = await f.download();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const tar = Buffer.concat(chunks);
      expect(tar.subarray(512, 512 + dump.length)).toEqual(dump);
      expect(tar.includes(Buffer.from(JSON.stringify(f.metadata)))).toBe(true);
      expect(tar.subarray(-1024)).toEqual(Buffer.alloc(1024));
      expect((await f.download()).closed).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it('does not leak slots on failed current authorization or missing metadata', async () => {
    const f = await fixture();
    try {
      f.unit.operatorPermissionCodes.mockResolvedValue([]);
      for (let index = 0; index < 9; index++)
        expect(await outcome(f.download)).toMatchObject({ status: 403 });
      expect(f.streams).toHaveLength(0);
      f.unit.operatorPermissionCodes.mockResolvedValue(['settings:write']);
      await rm(join(f.directory, `${filename}.meta.json`));
      for (let index = 0; index < 9; index++)
        expect(await outcome(f.download)).toMatchObject({ status: 409 });
      expect(f.streams).toHaveLength(0);
      await writeFile(
        join(f.directory, `${filename}.meta.json`),
        JSON.stringify(f.metadata),
      );
      expect((await f.download()).closed).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it('retains service shutdown admission instead of accepting a new archive', async () => {
    const f = await fixture();
    try {
      await f.service.onModuleDestroy();
      expect(await outcome(f.download)).toMatchObject({ status: 503 });
      expect(f.streams).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });
});
