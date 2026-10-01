import { backupInPlaceRestoreResultSchema } from '@asin-monitor/contracts';
import {
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import type { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('committed restore recovery when the registry connection fails', () => {
  it.each([false, true])(
    'returns a bounded BullMQ receipt after both commit writes fail (late cancellation %s)',
    async (cancel) => {
      directory = await mkdtemp(join(tmpdir(), 'neo-backup-commit-'));
      const taskId = '10000000-0000-4000-8000-000000000161';
      const filename = 'backup_20260927-020000-abcdef01-primary.dump';
      const archive = Buffer.from('PGDMPfixture');
      const settings = {
        encoding: 'UTF8',
        lcCollate: 'C',
        lcCtype: 'C',
        localeProvider: 'libc',
        timeZone: 'Asia/Shanghai',
      };
      await writeFile(join(directory, filename), archive);
      await writeFile(
        join(directory, `${filename}.meta.json`),
        JSON.stringify({
          version: 3,
          filename,
          target: 'primary',
          sourceEngine: 'postgresql',
          scope: 'selective',
          tables: ['public.asins'],
          archiveSha256: createHash('sha256').update(archive).digest('hex'),
          databaseSettings: settings,
        }),
      );
      const query = vi.fn(async (sql: string) => ({
        rows: sql.includes('pg_try_advisory_lock')
          ? [{ acquired: true }]
          : sql.includes('SELECT EXISTS')
          ? [{ enabled: false }]
          : sql.includes('pg_encoding_to_char')
          ? [{ ...settings, localeProvider: 'c' }]
          : sql.includes('AS timezone')
          ? [{ timezone: 'Asia/Shanghai' }]
          : [],
      }));
      dependencies.pool.mockImplementation(() => ({
        query,
        connect: async () => ({ query, release: vi.fn() }),
        end: vi.fn(),
      }));
      dependencies.spawn.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          exitCode: null as number | null,
          signalCode: null,
          stderr: { resume: vi.fn() },
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit('close', 0, null);
        });
        return child;
      });
      const createdAt = new Date().toISOString();
      const data = {
        taskId,
        taskType: 'backup',
        taskSubType: 'restore',
        operation: 'restore',
        target: 'primary',
        userId: 'backup-owner',
        createdAt,
        params: { filename },
      };
      let state: TaskState = {
        taskId,
        taskType: 'backup',
        taskSubType: 'restore',
        userId: 'backup-owner',
        createdAt,
        updatedAt: createdAt,
        title: 'restore',
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
      const store = {
        read: vi.fn(async () => state),
        mutate: vi.fn(async (_id: string, change: TaskMutation) => {
          if (change.kind === 'restore-committed') {
            if (cancel)
              state = transitionTask(
                state,
                { kind: 'cancel-request' },
                new Date(),
              );
            throw new Error('registry unavailable');
          }
          state = transitionTask(state, change, new Date());
          return state;
        }),
      };
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const processor = createBackupProcessor(
        store,
        {
          env: {
            DATABASE_URL: 'postgresql://fixture@localhost/source',
            COMPETITOR_DATABASE_URL:
              'postgresql://fixture@localhost/competitor',
            BACKUP_STORAGE_DIRECTORY: directory,
            DATABASE_POOL_CONNECTION_TIMEOUT_MS: 2000,
            BACKUP_COMMAND_TIMEOUT_MS: 2000,
            BACKUP_MAX_BYTES: 1024,
          } as never,
          shutdownSignal: new AbortController().signal,
          isClosing: () => false,
          assertJobLock: async () => undefined,
          updateProgress: async () => undefined,
        },
        log,
      );
      const result = backupInPlaceRestoreResultSchema.parse(
        await processor({ id: taskId, name: 'restore', data } as Job, 'lock'),
      );
      expect(result).toMatchObject({
        filename,
        targetDatabaseChanged: true,
        verification: 'unconfirmed',
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
      expect(dependencies.spawn).toHaveBeenCalledOnce();
      expect(dependencies.spawn.mock.calls[0]?.[1]).toContain(
        '--single-transaction',
      );
      expect(
        store.mutate.mock.calls.filter(
          ([, change]) => change.kind === 'restore-committed',
        ),
      ).toHaveLength(2);
      expect(
        store.mutate.mock.calls.some(([, change]) =>
          ['failed', 'cancelled'].includes(change.kind),
        ),
      ).toBe(false);
      expect(state.status).toBe(cancel ? 'cancelling' : 'processing');
      expect(log.warn).toHaveBeenCalledWith('已提交恢复任务状态写入未确认', {
        reason: 'backup_restore_commit_status_unconfirmed',
      });
    },
  );
});
