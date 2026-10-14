import {
  backupCreationReceiptSchema,
  type BackupJobData,
} from '@asin-monitor/contracts';
import {
  backupCreationIdentity,
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import type { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupProcessor } from '../src/backup-processor';

const dependencies = vi.hoisted(() => ({ pool: vi.fn(), spawn: vi.fn() }));
vi.mock('@asin-monitor/db', async (original) => ({
  ...(await original<typeof import('@asin-monitor/db')>()),
  createPgPool: dependencies.pool,
}));
vi.mock('node:child_process', () => ({ spawn: dependencies.spawn }));
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.resetAllMocks();
});

describe('replay published midnight backups from the original h24 deployment', () => {
  it.each([
    { target: 'primary', conflictingCanonical: false, changedIdentity: false },
    {
      target: 'competitor',
      conflictingCanonical: false,
      changedIdentity: false,
    },
    { target: 'primary', conflictingCanonical: true, changedIdentity: false },
    { target: 'primary', conflictingCanonical: false, changedIdentity: true },
  ] as const)(
    'recovers or fails closed without a second dump (%j)',
    async ({ target, conflictingCanonical, changedIdentity }) => {
      directory = await mkdtemp(join(tmpdir(), 'neo-backup-midnight-test-'));
      const data: BackupJobData = {
        taskId: '10000000-0000-4000-8000-000000000171',
        taskType: 'backup',
        taskSubType: 'create',
        operation: 'create',
        target,
        userId: 'midnight-fixture-owner',
        createdAt: '2026-09-26T16:12:34.000Z',
        params: { description: 'previous midnight publication' },
      };
      const legacy = `backup_20260927-241234-${data.taskId.replaceAll(
        '-',
        '',
      )}-${target}.dump`;
      const canonical = legacy.replace('-241234-', '-001234-');
      const archive = Buffer.from('PGDMPpublished-original');
      const archiveSha256 = createHash('sha256').update(archive).digest('hex');
      const metadata = JSON.stringify({
        version: 3,
        filename: legacy,
        target,
        sourceEngine: 'postgresql',
        scope: 'full',
        creationIdentity: changedIdentity
          ? '0'.repeat(64)
          : backupCreationIdentity(data),
        archiveSha256,
        description: data.params.description,
        databaseSettings: {
          encoding: 'UTF8',
          lcCollate: 'C',
          lcCtype: 'C',
          localeProvider: 'libc',
          timeZone: 'Asia/Shanghai',
        },
      });
      await writeFile(join(directory, legacy), archive);
      await writeFile(join(directory, `${legacy}.meta.json`), metadata);
      if (conflictingCanonical)
        await writeFile(join(directory, canonical), archive);
      const files = (await readdir(directory)).sort();
      let state: TaskState = {
        taskId: data.taskId,
        taskType: 'backup',
        taskSubType: 'create',
        userId: data.userId,
        createdAt: data.createdAt,
        updatedAt: data.createdAt,
        title: 'midnight replay',
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
      dependencies.pool.mockImplementation(() => {
        throw new Error('Published replay must not start database work');
      });
      const publicationSync = {
        syncFile: vi.fn(async () => undefined),
        // Directory fsync is unavailable on Windows; native Linux suites use
        // the existing real publication sync boundary without this adapter.
        syncDirectory: vi.fn(async () => undefined),
      };
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
          shutdownSignal: new AbortController().signal,
          isClosing: () => false,
          assertJobLock: async () => undefined,
          updateProgress: async () => undefined,
          publicationSync,
        },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      );
      const execution = processor(
        {
          id: data.taskId,
          name: 'create',
          data,
          attemptsMade: 1,
          opts: { attempts: 2 },
        } as Job,
        'lock',
      );
      if (conflictingCanonical || changedIdentity) {
        await expect(execution).rejects.toThrow('备份任务失败');
        expect(state.status).toBe('failed');
        expect(state.result).toBeNull();
        expect(publicationSync.syncFile).not.toHaveBeenCalled();
      } else {
        const result = backupCreationReceiptSchema.parse(await execution);
        expect(result).toMatchObject({
          filename: legacy,
          createdAt: data.createdAt,
          timeSource: 'filename',
          target,
          backupCreationCommit: {
            taskId: data.taskId,
            userId: data.userId,
            taskCreatedAt: data.createdAt,
            creationIdentity: backupCreationIdentity(data),
            archiveSha256,
          },
        });
        expect(state.status).toBe('completed');
        expect(publicationSync.syncFile.mock.calls).toEqual([
          [join(directory, legacy)],
          [join(directory, `${legacy}.meta.json`)],
        ]);
      }
      expect(dependencies.pool).not.toHaveBeenCalled();
      expect(dependencies.spawn).not.toHaveBeenCalled();
      expect((await readdir(directory)).sort()).toEqual(files);
      expect(await readFile(join(directory, legacy))).toEqual(archive);
      expect(
        await readFile(join(directory, `${legacy}.meta.json`), 'utf8'),
      ).toBe(metadata);
    },
  );
});
