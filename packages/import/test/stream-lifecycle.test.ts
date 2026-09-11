import { randomUUID } from 'node:crypto';
import type * as fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_MAX_FILE_BYTES } from '../src/csv';
import { ImportFileStore } from '../src/files';
import { ImportResultStore, normalizeImportTaskResult } from '../src/results';
import type { AsinImportTaskData } from '../src/task';

const lifecycle = vi.hoisted(() => ({
  beforeOpen: undefined as (() => void) | undefined,
  opened: 0,
  closed: 0,
  pending: [] as Promise<void>[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    createWriteStream: (
      path: fs.PathLike,
      options: Exclude<Parameters<typeof actual.createWriteStream>[1], string>,
    ) => {
      const stream = actual.createWriteStream(path, {
        ...options,
        fs: {
          open: (name, flags, mode, callback) => {
            lifecycle.beforeOpen?.();
            // Force the ordering seen on Linux: pipeline abort/error before open's
            // callback. The actual filesystem still creates and closes the file.
            setTimeout(
              () =>
                actual.open(name, flags, mode, (error, fd) => {
                  if (!error) lifecycle.opened++;
                  callback(error, fd);
                }),
              30,
            );
          },
          write: actual.write,
          writev: actual.writev,
          close: actual.close,
        },
      });
      lifecycle.pending.push(
        new Promise<void>((resolve) =>
          stream.once('close', () => {
            lifecycle.closed++;
            resolve();
          }),
        ),
      );
      return stream;
    },
  };
});
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(lifecycle.pending.splice(0));
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  lifecycle.beforeOpen = undefined;
  lifecycle.opened = 0;
  lifecycle.closed = 0;
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'neo-delayed-open-'));
  directories.push(path);
  return path;
}

describe('file cleanup after an error while the descriptor is still opening', () => {
  it.each(['capacity', 'input-error', 'cancel'] as const)(
    'awaits the late open and close before cleaning an upload: %s',
    async (failure) => {
      const path = await directory(),
        store = new ImportFileStore(path),
        controller = new AbortController();
      if (failure === 'cancel') lifecycle.beforeOpen = () => controller.abort();
      const input =
        failure === 'capacity'
          ? Readable.from([Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1)])
          : failure === 'input-error'
          ? Readable.from(
              (async function* () {
                yield 'partial';
                throw new Error('fixture input interrupted');
              })(),
            )
          : Readable.from(['file']);
      try {
        await expect(
          store.save(
            input,
            randomUUID(),
            'fixture.csv',
            'text/csv',
            controller.signal,
          ),
        ).rejects.toThrow();
        expect(lifecycle.opened).toBe(1);
        expect(lifecycle.closed).toBe(1);
        expect(await readdir(path)).toEqual([]);
      } finally {
        await store.close();
      }
    },
  );
  it('also waits before deleting an aborted complete-result file', async () => {
    const path = await directory(),
      store = new ImportResultStore(path),
      controller = new AbortController(),
      taskId = randomUUID();
    const data: AsinImportTaskData = {
      taskId,
      userId: 'fixture-owner',
      taskType: 'import',
      taskSubType: 'asin',
      title: 'ASIN导入',
      createdAt: '2026-09-01T00:00:00.000Z',
      file: {
        taskId,
        extension: 'csv',
        originalFilename: 'fixture.csv',
        sha256: 'a'.repeat(64),
        bytes: 1,
      },
    };
    lifecycle.beforeOpen = () => controller.abort();
    await expect(
      store.save(
        data,
        normalizeImportTaskResult(
          {
            total: 0,
            processedCount: 0,
            successCount: 0,
            failedCount: 0,
            missingCount: 0,
            verificationPassed: true,
          },
          'fixture.csv',
        ),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(lifecycle.opened).toBe(1);
    expect(lifecycle.closed).toBe(1);
    expect(await readdir(path)).toEqual([]);
  });
});
