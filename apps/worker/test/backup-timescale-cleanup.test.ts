import { type BackupJobData } from '@asin-monitor/contracts';
import {
  isBackupUncommittedFailure,
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBackupProcessor,
  stagingDatabaseName,
} from '../src/backup-processor';

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

describe('isolated Timescale cancellation confirms every cleanup operation', () => {
  it.each([true, false])(
    'retains a pool close failure even when the staging database is dropped (close-fails=%s)',
    async (closeFails) => {
      directory = await mkdtemp(join(tmpdir(), 'neo-timescale-cleanup-'));
      const taskId = '10000000-0000-4000-8000-000000000161';
      const filename = 'backup_20260927-020000-abcdef01-primary.dump';
      const archive = Buffer.from('PGDMPverified-fixture');
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
          version: 4,
          filename,
          target: 'primary',
          sourceEngine: 'timescaledb',
          timescale: {
            extensionVersion: '2.22.0',
            hypertables: ['public.metrics'],
            continuousAggregates: [],
          },
          archiveSha256: createHash('sha256').update(archive).digest('hex'),
          databaseSettings: settings,
        }),
      );
      const createdAt = new Date().toISOString();
      const data: BackupJobData = {
        taskId,
        taskType: 'backup',
        taskSubType: 'restore',
        operation: 'restore',
        target: 'primary',
        userId: 'timescale-cleanup-fixture-owner',
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
        title: 'isolated Timescale restore',
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
      const mutations: TaskMutation[] = [];
      const lifecycle: string[] = [];
      const queryFor = (staging: boolean) =>
        vi.fn(async (input: string | { text: string }) => {
          const sql = typeof input === 'string' ? input : input.text;
          lifecycle.push(sql);
          if (staging && sql.includes('SELECT extversion')) {
            // Cancel after the isolated database and its pool exist, before
            // any restore can commit. The worker must close and drop both.
            state = transitionTask(
              state,
              { kind: 'cancel-request' },
              new Date(),
            );
          }
          return {
            rows: sql.includes('pg_try_advisory_lock')
              ? [{ acquired: true }]
              : sql.includes('current_user AS role')
              ? [{ role: 'fixture', sessionUser: 'fixture' }]
              : sql.includes('SELECT EXISTS')
              ? [{ enabled: true }]
              : sql.includes('SELECT extversion')
              ? [{ extversion: '2.22.0' }]
              : sql.includes('timescaledb_information.hypertables')
              ? [{ relation: 'public.metrics' }]
              : sql.includes('pg_get_userbyid')
              ? [{ owned: true }]
              : [],
          };
        });
      const targetQuery = queryFor(false);
      const stagingQuery = queryFor(true);
      const targetEnd = vi.fn(async () => undefined);
      const targetRelease = vi.fn();
      const stagingRelease = vi.fn();
      const stagingEnd = vi.fn(async () => {
        lifecycle.push('staging-pool-end');
        if (closeFails) throw new Error('fixture pool close failure');
      });
      dependencies.pool.mockImplementation((url: string) => {
        const staging = new URL(url).pathname !== '/source';
        return {
          query: vi.fn(async () => {
            throw new Error('Restore must use the explicitly leased session');
          }),
          connect: async () => ({
            query: staging ? stagingQuery : targetQuery,
            release: staging ? stagingRelease : targetRelease,
          }),
          end: staging ? stagingEnd : targetEnd,
        };
      });
      const processor = createBackupProcessor(
        {
          read: async () => state,
          mutate: async (_id: string, change: TaskMutation) => {
            mutations.push(change);
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
        },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      );
      const execution = processor(
        { id: taskId, name: 'restore', data } as Job,
        'lock',
      );
      if (closeFails) {
        const failure = await execution.catch((error: Error) => error);
        expect(failure).toBeInstanceOf(UnrecoverableError);
        expect((failure as Error).message).toContain('清理未确认');
        expect(
          isBackupUncommittedFailure(data, (failure as Error).message),
        ).toBe(false);
        expect(state.status).toBe('failed');
        expect(state.result).toBeNull();
        expect(mutations.some(({ kind }) => kind === 'failed')).toBe(true);
        expect(
          mutations.some(({ kind }) =>
            [
              'cancelled',
              'backup-uncommitted-failed',
              'restore-committed',
            ].includes(kind),
          ),
        ).toBe(false);
      } else {
        expect(await execution).toEqual({
          cancelled: true,
          message: '备份任务已取消',
        });
        expect(state.status).toBe('cancelled');
        expect(mutations.some(({ kind }) => kind === 'cancelled')).toBe(true);
        expect(
          mutations.some(({ kind }) =>
            [
              'failed',
              'backup-uncommitted-failed',
              'restore-committed',
            ].includes(kind),
          ),
        ).toBe(false);
      }
      const drop = `DROP DATABASE "${stagingDatabaseName(
        taskId,
        'primary',
      )}" WITH (FORCE)`;
      expect(targetQuery).toHaveBeenCalledWith(drop);
      expect(lifecycle.indexOf('staging-pool-end')).toBeLessThan(
        lifecycle.indexOf(drop),
      );
      expect(stagingEnd).toHaveBeenCalledOnce();
      expect(stagingRelease).toHaveBeenCalledOnce();
      expect(targetEnd).toHaveBeenCalledOnce();
      expect(targetRelease).toHaveBeenCalledOnce();
      expect(dependencies.pool).toHaveBeenCalledTimes(2);
      expect(dependencies.spawn).not.toHaveBeenCalled();
    },
  );
});
