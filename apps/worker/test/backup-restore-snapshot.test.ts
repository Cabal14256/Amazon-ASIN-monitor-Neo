import {
  backupRestoreReceiptSchema,
  type BackupJobData,
} from '@asin-monitor/contracts';
import {
  isBackupUncommittedFailure,
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBackupProcessor,
  stagingDatabaseName,
} from '../src/backup-processor';

const dependencies = vi.hoisted(() => ({
  pool: vi.fn(),
  spawn: vi.fn(),
  beforeSnapshotWrite: undefined as (() => Promise<void>) | undefined,
  beforeSnapshotRead: undefined as (() => Promise<void>) | undefined,
  snapshotPath: undefined as string | undefined,
  failSnapshotCleanup: false,
  closeFailureStage: undefined as
    | 'source-copy'
    | 'snapshot-write'
    | 'snapshot-header'
    | 'digest'
    | undefined,
  sourceReads: 0,
  snapshotReads: 0,
  closeAttempts: 0,
  failedHandle: undefined as import('node:fs/promises').FileHandle | undefined,
  releaseFailedHandle: undefined as (() => Promise<void>) | undefined,
  cancelAtClose: undefined as (() => void) | undefined,
}));
vi.mock('@asin-monitor/db', async (original) => ({
  ...(await original<typeof import('@asin-monitor/db')>()),
  createPgPool: dependencies.pool,
}));
vi.mock('node:child_process', () => ({ spawn: dependencies.spawn }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      if (String(args[0]).includes('neo-backup-restore-') && args[1] === 'wx') {
        dependencies.snapshotPath = String(args[0]);
        const write = file.write.bind(file);
        Object.assign(file, {
          write: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) => {
            await dependencies.beforeSnapshotWrite?.();
            return write(buffer, offset, length, position);
          },
        });
      }
      if (String(args[0]).includes('neo-backup-restore-') && args[1] === 'r') {
        const read = file.read.bind(file);
        Object.assign(file, {
          read: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) => {
            // Header reads remain real; block only the snapshot digest read.
            if (length > 5) await dependencies.beforeSnapshotRead?.();
            return read(buffer, offset, length, position);
          },
        });
      }
      const isSnapshot = String(args[0]).includes('neo-backup-restore-');
      const sourceRead =
        String(args[0]).includes('neo-backup-snapshot-test-') && args[1] === 'r'
          ? ++dependencies.sourceReads
          : 0;
      const snapshotRead =
        isSnapshot && args[1] === 'r' ? ++dependencies.snapshotReads : 0;
      const stage =
        sourceRead === 2
          ? 'source-copy'
          : isSnapshot && args[1] === 'wx'
          ? 'snapshot-write'
          : snapshotRead === 1
          ? 'snapshot-header'
          : snapshotRead === 2
          ? 'digest'
          : undefined;
      if (stage && stage === dependencies.closeFailureStage) {
        const close = file.close.bind(file);
        dependencies.failedHandle = file;
        dependencies.releaseFailedHandle = close;
        Object.assign(file, {
          close: async () => {
            dependencies.closeAttempts += 1;
            if (dependencies.closeAttempts === 1) {
              dependencies.cancelAtClose?.();
              // Fail before releasing the real descriptor. No injected stat,
              // read, write, or hash result replaces its actual filesystem IO.
              throw new Error('authorization=Bearer raw-close-secret');
            }
            return close();
          },
        });
      }
      return file;
    },
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      if (
        dependencies.failSnapshotCleanup &&
        String(args[0]).includes('neo-backup-restore-')
      )
        throw Object.assign(new Error('fixture cleanup failure'), {
          code: 'EBUSY',
        });
      return fs.unlink(...args);
    },
  };
});

let directory: string | undefined;
afterEach(async () => {
  await dependencies.releaseFailedHandle?.().catch(() => undefined);
  dependencies.closeFailureStage = undefined;
  dependencies.sourceReads = 0;
  dependencies.snapshotReads = 0;
  dependencies.closeAttempts = 0;
  dependencies.failedHandle = undefined;
  dependencies.releaseFailedHandle = undefined;
  dependencies.cancelAtClose = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  if (dependencies.snapshotPath)
    await rm(dirname(dependencies.snapshotPath), {
      recursive: true,
      force: true,
    });
  dependencies.snapshotPath = undefined;
  dependencies.beforeSnapshotWrite = undefined;
  dependencies.beforeSnapshotRead = undefined;
  dependencies.failSnapshotCleanup = false;
  vi.resetAllMocks();
});

describe('restore consumes the verified archive snapshot', () => {
  it.each([
    ...(['selective', 'full', 'timescale'] as const).flatMap((scope) =>
      (['pathname-replacement', 'same-inode-write'] as const).map((attack) => ({
        scope,
        attack,
        cleanupFails: false,
        holdWrite: false,
        holdRead: false,
      })),
    ),
    {
      scope: 'selective',
      attack: 'pathname-replacement',
      cleanupFails: true,
      holdWrite: false,
      holdRead: false,
    },
    {
      scope: 'selective',
      attack: 'same-inode-write',
      cleanupFails: false,
      holdWrite: true,
      holdRead: false,
    },
    {
      scope: 'selective',
      attack: 'same-inode-write',
      cleanupFails: false,
      holdWrite: false,
      holdRead: true,
    },
    {
      scope: 'selective',
      attack: 'same-inode-write',
      cleanupFails: true,
      holdWrite: false,
      holdRead: false,
      cancelBeforeRestore: true,
    },
    {
      scope: 'selective',
      attack: 'same-inode-write',
      cleanupFails: false,
      holdWrite: false,
      holdRead: false,
      cancelBeforeRestore: true,
    },
    ...(
      ['source-copy', 'snapshot-write', 'snapshot-header', 'digest'] as const
    ).map((closeFailure) => ({
      scope: 'selective',
      attack: 'same-inode-write',
      cleanupFails: false,
      holdWrite: false,
      holdRead: false,
      closeFailure,
    })),
  ] as const)(
    'keeps verified bytes for $scope after $attack (cleanup=$cleanupFails, held-write=$holdWrite, held-read=$holdRead, before-cli=$cancelBeforeRestore, close=$closeFailure)',
    async (inputCase) => {
      const { scope, attack, cleanupFails, holdWrite, holdRead } = inputCase;
      const cancelBeforeRestore =
        'cancelBeforeRestore' in inputCase && inputCase.cancelBeforeRestore;
      const closeFailure =
        'closeFailure' in inputCase ? inputCase.closeFailure : undefined;
      directory = await mkdtemp(join(tmpdir(), 'neo-backup-snapshot-test-'));
      const taskId = '10000000-0000-4000-8000-000000000171';
      const filename = 'backup_20260927-020000-abcdef01-primary.dump';
      const input = join(directory, filename);
      const original = Buffer.from('PGDMPverified-original');
      const unchecked = Buffer.from('PGDMPunchecked-change');
      const settings = {
        encoding: 'UTF8',
        lcCollate: 'C',
        lcCtype: 'C',
        localeProvider: 'libc',
        timeZone: 'Asia/Shanghai',
      };
      await writeFile(input, original);
      await writeFile(
        `${input}.meta.json`,
        JSON.stringify({
          version: scope === 'timescale' ? 4 : 3,
          filename,
          target: 'primary',
          ...(scope === 'timescale'
            ? {
                sourceEngine: 'timescaledb',
                timescale: {
                  extensionVersion: '2.22.0',
                  hypertables: ['public.metrics'],
                  continuousAggregates: [],
                },
              }
            : {
                sourceEngine: 'postgresql',
                scope,
                ...(scope === 'selective' ? { tables: ['public.asins'] } : {}),
              }),
          archiveSha256: createHash('sha256').update(original).digest('hex'),
          databaseSettings: settings,
        }),
      );
      let restoring = false;
      const query = vi.fn(async (input: string | { text: string }) => {
        const sql = typeof input === 'string' ? input : input.text;
        if (sql === 'SELECT timescaledb_pre_restore()') restoring = true;
        if (sql === 'SELECT timescaledb_post_restore()') restoring = false;
        return {
          rows: sql.includes('backup_selective_restore_dependencies')
            ? [{ blocked: false }]
            : sql.includes('pg_try_advisory_lock')
            ? [{ acquired: true }]
            : sql.includes('current_user AS role')
            ? [{ role: 'fixture', sessionUser: 'fixture' }]
            : sql.includes('SELECT EXISTS')
            ? [{ enabled: scope === 'timescale' }]
            : sql.includes('SELECT extversion')
            ? [{ extversion: '2.22.0' }]
            : sql.includes('timescaledb_information.hypertables')
            ? [{ relation: 'public.metrics' }]
            : sql.includes("current_setting('timescaledb.restoring'")
            ? [{ enabled: restoring ? 'on' : 'off' }]
            : sql.includes('pg_encoding_to_char')
            ? [{ ...settings, localeProvider: 'c' }]
            : sql.includes('AS timezone')
            ? [{ timezone: 'Asia/Shanghai' }]
            : sql.includes('pg_get_userbyid')
            ? [{ owned: true }]
            : sql.includes('SELECT current_database()')
            ? [{ database: stagingDatabaseName(taskId, 'primary') }]
            : [],
        };
      });
      dependencies.pool.mockImplementation(() => ({
        query: vi.fn(async () => ({ rows: [{ database: 'source' }] })),
        connect: async () => ({ query, release: vi.fn() }),
        end: vi.fn(),
      }));
      let consumed: Buffer | undefined;
      let restoreInput: string | undefined;
      dependencies.spawn.mockImplementation(
        (_command: string, args: string[]) => {
          restoreInput = args.at(-1);
          const child = Object.assign(new EventEmitter(), {
            exitCode: null as number | null,
            signalCode: null,
            stderr: { resume: vi.fn() },
            kill: vi.fn(),
          });
          // Exercise the actual path supplied to the CLI. Both attacks are valid
          // filesystem mutations, rather than mocked stat/hash answers.
          void readFile(restoreInput!).then(
            (bytes) => {
              consumed = bytes;
              child.exitCode = 0;
              child.emit('close', 0, null);
            },
            (error) => child.emit('error', error),
          );
          return child;
        },
      );
      const createdAt = new Date().toISOString();
      const data = {
        taskId,
        taskType: 'backup',
        taskSubType: 'restore',
        operation: 'restore',
        target: 'primary',
        userId: 'snapshot-fixture-owner',
        createdAt,
        params: { filename },
      };
      let state: TaskState = {
        taskId,
        taskType: 'backup',
        taskSubType: 'restore',
        userId: data.userId,
        createdAt,
        updatedAt: createdAt,
        title: 'snapshot restore',
        status: 'pending',
        progress: 0,
        message: '',
        error: null,
        result: null,
        startedAt: null,
        completedAt: null,
        cancelRequestedAt: null,
        cancelledAt: null,
        revision: 0,
      };
      let attacked = false;
      const shutdown = new AbortController();
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      let signalWriteStarted: (() => void) | undefined;
      let releaseWrite: (() => void) | undefined;
      const writeStarted = new Promise<void>((resolve) => {
        signalWriteStarted = resolve;
      });
      const writeReleased = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      if (holdWrite)
        dependencies.beforeSnapshotWrite = async () => {
          signalWriteStarted?.();
          await writeReleased;
        };
      if (holdRead)
        dependencies.beforeSnapshotRead = async () => {
          signalWriteStarted?.();
          await writeReleased;
        };
      dependencies.failSnapshotCleanup = cleanupFails;
      dependencies.closeFailureStage = closeFailure;
      dependencies.cancelAtClose = () => {
        state = transitionTask(state, { kind: 'cancel-request' }, new Date());
      };
      // Keep a writer FD open before verification to prove that chmod on the
      // shared archive, or retaining its reader FD, cannot protect its bytes.
      const writer = await open(input, 'r+');
      let execution: Promise<unknown> | undefined;
      try {
        const processor = createBackupProcessor(
          {
            read: async () => state,
            mutate: async (_id: string, change: TaskMutation) => {
              state = transitionTask(state, change, new Date());
              return state;
            },
          },
          {
            env: {
              DATABASE_URL: 'postgresql://fixture@localhost/source',
              COMPETITOR_DATABASE_URL:
                'postgresql://fixture@localhost/competitor',
              BACKUP_STORAGE_DIRECTORY: directory,
              DATABASE_POOL_CONNECTION_TIMEOUT_MS: 2000,
              BACKUP_COMMAND_TIMEOUT_MS: 2000,
              BACKUP_MAX_BYTES: 1024,
              TASK_META_TTL_SECONDS: 604800,
            } as never,
            shutdownSignal: shutdown.signal,
            isClosing: () => false,
            assertJobLock: async () => undefined,
            updateProgress: async (_job, value) => {
              if (value !== 5 || attacked) return;
              attacked = true;
              if (cancelBeforeRestore) {
                state = transitionTask(
                  state,
                  { kind: 'cancel-request' },
                  new Date(),
                );
                return;
              }
              if (attack === 'pathname-replacement') {
                await rename(input, `${input}.replaced`);
                await writeFile(input, unchecked);
              } else {
                const before = await writer.stat();
                await writer.truncate(0);
                await writer.writeFile(unchecked);
                expect((await stat(input)).ino).toBe(before.ino);
              }
            },
          },
          log,
        );
        execution = processor(
          { id: taskId, name: 'restore', data } as Job,
          'lock',
        );
        const observed = execution.then(
          () => undefined,
          () => undefined,
        );
        if (closeFailure) {
          const failure = await execution.catch((error: Error) => error);
          expect(failure).toBeInstanceOf(UnrecoverableError);
          expect(
            isBackupUncommittedFailure(
              data as BackupJobData,
              (failure as Error).message,
            ),
          ).toBe(false);
          expect(state.status).toBe('failed');
          expect(state.message).toContain('文件关闭结果未确认');
          expect(dependencies.spawn).not.toHaveBeenCalled();
          expect(dependencies.closeAttempts).toBe(2);
          await expect(dependencies.failedHandle!.stat()).rejects.toMatchObject(
            {
              code: 'EBADF',
            },
          );
          expect(log.error).toHaveBeenCalledWith('PostgreSQL 备份任务失败', {
            target: 'primary',
            reason: 'BACKUP_RESTORE_SNAPSHOT_CLOSE_UNCONFIRMED',
          });
          const emitted = JSON.stringify({
            state,
            error: (failure as Error).message,
            logs: [
              ...log.info.mock.calls,
              ...log.warn.mock.calls,
              ...log.error.mock.calls,
            ],
          });
          expect(emitted).not.toContain('raw-close-secret');
          expect(emitted).not.toContain('Bearer');
          await expect(stat(dependencies.snapshotPath!)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          await expect(
            stat(dirname(dependencies.snapshotPath!)),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          return;
        }
        if (cancelBeforeRestore) {
          if (!cleanupFails) {
            await expect(execution).resolves.toMatchObject({
              cancelled: true,
            });
            expect(state.status).toBe('cancelled');
            expect(dependencies.spawn).not.toHaveBeenCalled();
            await expect(
              stat(dependencies.snapshotPath!),
            ).rejects.toMatchObject({
              code: 'ENOENT',
            });
            await expect(
              stat(dirname(dependencies.snapshotPath!)),
            ).rejects.toMatchObject({ code: 'ENOENT' });
            return;
          }
          const failure = await execution.catch((error: Error) => error);
          expect(failure).toBeInstanceOf(UnrecoverableError);
          expect(
            isBackupUncommittedFailure(
              data as BackupJobData,
              (failure as Error).message,
            ),
          ).toBe(false);
          expect(state.status).toBe('failed');
          expect(state.message).toContain('清理未确认');
          expect(dependencies.spawn).not.toHaveBeenCalled();
          expect((await stat(dependencies.snapshotPath!)).isFile()).toBe(true);
          return;
        }
        if (holdWrite || holdRead) {
          let settled = false;
          const settlement = execution.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          let startDeadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              writeStarted,
              observed.then(() => {
                throw new Error(
                  'Processor settled before owned snapshot write',
                );
              }),
              new Promise<never>((_resolve, reject) => {
                startDeadline = setTimeout(
                  () => reject(new Error('Owned snapshot write did not start')),
                  1000,
                );
              }),
            ]);
          } finally {
            if (startDeadline) clearTimeout(startDeadline);
          }
          shutdown.abort();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(false);
          expect((await stat(dependencies.snapshotPath!)).isFile()).toBe(true);
          expect(dependencies.spawn).not.toHaveBeenCalled();
          releaseWrite?.();
          await expect(execution).rejects.toThrow('备份任务失败');
          await settlement;
          expect(dependencies.spawn).not.toHaveBeenCalled();
          await expect(stat(dependencies.snapshotPath!)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          await expect(
            stat(dirname(dependencies.snapshotPath!)),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          return;
        }
        const result = backupRestoreReceiptSchema.parse(await execution);
        expect(attacked).toBe(true);
        expect(await readFile(input)).toEqual(unchecked);
        expect(consumed).toEqual(original);
        expect(restoreInput).not.toBe(input);
        expect(result.verification).toBe('confirmed');
        expect(result.restoreMode).toBe(
          scope === 'selective' ? 'in-place' : 'isolated',
        );
        if (cleanupFails) {
          expect((await stat(restoreInput!)).isFile()).toBe(true);
          expect(state.status).toBe('completed');
          expect(log.warn).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
              reason: 'backup_restore_snapshot_cleanup_failed',
              code: 'EBUSY',
            }),
          );
        } else {
          await expect(stat(restoreInput!)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          await expect(stat(dirname(restoreInput!))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
      } finally {
        releaseWrite?.();
        if (execution) await Promise.allSettled([execution]);
        await writer.close();
      }
    },
  );
});
