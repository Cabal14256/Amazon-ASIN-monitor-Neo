import { backupRestoreReceiptSchema } from '@asin-monitor/contracts';
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

describe('committed restore recovery when the registry connection fails', () => {
  it.each([
    { scope: 'selective', cancel: false, expires: false },
    { scope: 'selective', cancel: true, expires: false },
    { scope: 'full', cancel: false, expires: false },
    { scope: 'full', cancel: true, expires: false },
    { scope: 'selective', cancel: false, expires: true },
    {
      scope: 'full',
      cancel: false,
      expires: false,
      sessionUser: 'Session "Odd"\\Role',
    },
    {
      scope: 'full',
      cancel: false,
      expires: false,
      sessionUser: 'Session "Odd"\\Role',
      sourceEngine: 'timescaledb',
    },
    {
      scope: 'full',
      cancel: false,
      expires: false,
      unconfirmedStage: 'session',
    },
    { scope: 'full', cancel: false, expires: false, unconfirmedStage: 'role' },
    {
      scope: 'full',
      cancel: false,
      expires: false,
      unconfirmedStage: 'authorization-error',
    },
  ] as const)(
    'preserves a committed receipt or fails closed on unconfirmed staging identity (%j)',
    async (input) => {
      const { scope, cancel, expires } = input;
      const sessionUser =
        'sessionUser' in input ? input.sessionUser ?? 'fixture' : 'fixture';
      const unconfirmedStage =
        'unconfirmedStage' in input ? input.unconfirmedStage : undefined;
      const timescale =
        'sourceEngine' in input && input.sourceEngine === 'timescaledb';
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
          version: timescale ? 4 : 3,
          filename,
          target: 'primary',
          ...(timescale
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
          archiveSha256: createHash('sha256').update(archive).digest('hex'),
          databaseSettings: settings,
        }),
      );
      let stagingBound = false;
      let restoring = false;
      const query = vi.fn(async (input: string | { text: string }) => {
        const sql = typeof input === 'string' ? input : input.text;
        if (sql.startsWith('SET SESSION AUTHORIZATION')) {
          stagingBound = true;
          if (unconfirmedStage === 'authorization-error')
            throw new Error('unconfirmed authorization');
        }
        if (sql === 'SELECT timescaledb_pre_restore()') restoring = true;
        if (sql === 'SELECT timescaledb_post_restore()') restoring = false;
        return {
          rows: sql.includes('backup_selective_restore_dependencies')
            ? [{ blocked: false }]
            : sql.includes('pg_try_advisory_lock')
            ? [{ acquired: true }]
            : sql.includes('current_user AS role')
            ? [
                {
                  role:
                    stagingBound && unconfirmedStage === 'role'
                      ? 'unexpected-login'
                      : 'restricted Backup"Role',
                  sessionUser:
                    stagingBound && unconfirmedStage === 'session'
                      ? 'unexpected-login'
                      : sessionUser,
                },
              ]
            : sql.includes('SELECT EXISTS')
            ? [{ enabled: timescale }]
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
      const release = vi.fn();
      const end = vi.fn();
      const clientQueries: (typeof query)[] = [];
      const pooledQuery = vi.fn(async () => {
        throw new Error('Backup must keep the explicitly leased session');
      });
      dependencies.pool.mockImplementation(() => ({
        query: pooledQuery,
        connect: async () => {
          const clientQuery = vi.fn(query);
          clientQueries.push(clientQuery);
          return { query: clientQuery, release };
        },
        end,
      }));
      dependencies.spawn.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          exitCode: null as number | null,
          signalCode: null,
          stderr: { resume: vi.fn() },
          kill: vi.fn(),
        });
        const committed = () => {
          child.exitCode = 0;
          child.emit('close', 0, null);
        };
        // A zero exit is the irreversible database commit even if the
        // deadline signal races with its close callback.
        if (expires) setTimeout(committed, 100);
        else queueMicrotask(committed);
        return child;
      });
      const createdAt = new Date(
        Date.now() - (expires ? 6 * 86400000 - 50 : 0),
      ).toISOString();
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
            DATABASE_URL: `postgresql://${encodeURIComponent(
              sessionUser,
            )}@localhost/source`,
            COMPETITOR_DATABASE_URL: `postgresql://${encodeURIComponent(
              sessionUser,
            )}@localhost/competitor`,
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
        log,
      );
      const execution = processor(
        { id: taskId, name: 'restore', data } as Job,
        'lock',
      );
      if (unconfirmedStage) {
        await expect(execution).rejects.toThrow(
          '备份任务失败，请核实数据库状态和备份文件',
        );
        expect(state.status).toBe('failed');
        expect(state.result).toBeNull();
        expect(dependencies.spawn).toHaveBeenCalledOnce();
        expect(
          query.mock.calls.some(
            ([sql]) =>
              typeof sql === 'string' && sql.startsWith('DROP DATABASE'),
          ),
        ).toBe(true);
        expect(release).toHaveBeenCalledTimes(2);
        expect(end).toHaveBeenCalledTimes(2);
        return;
      }
      const result = backupRestoreReceiptSchema.parse(await execution);
      expect(result).toMatchObject({
        filename,
        targetDatabaseChanged: scope === 'selective',
        verification: 'unconfirmed',
      });
      if (scope === 'full') {
        expect(query).toHaveBeenCalledWith(
          'SET SESSION AUTHORIZATION "' +
            sessionUser.replaceAll('"', '""') +
            '"',
        );
        expect(query).toHaveBeenCalledWith(
          'SET ROLE "restricted Backup""Role"',
        );
        expect(result).toMatchObject({
          restoreMode: 'isolated',
          restoredDatabase: stagingDatabaseName(taskId, 'primary'),
        });
        expect(
          query.mock.calls.some(
            ([sql]) =>
              typeof sql === 'string' && sql.startsWith('DROP DATABASE'),
          ),
        ).toBe(false);
      }
      expect(pooledQuery).not.toHaveBeenCalled();
      if (timescale) {
        expect(clientQueries).toHaveLength(4);
        expect(release).toHaveBeenCalledTimes(4);
        expect(end).toHaveBeenCalledTimes(4);
        for (const clientQuery of clientQueries.slice(1)) {
          expect(clientQuery.mock.calls.slice(0, 3)).toEqual([
            ['SET SESSION AUTHORIZATION "Session ""Odd""\\Role"'],
            ['SET ROLE "restricted Backup""Role"'],
            ['SELECT current_user AS role, session_user AS "sessionUser"'],
          ]);
        }
        expect(clientQueries[2]?.mock.calls.map(([sql]) => sql)).toEqual(
          expect.arrayContaining([
            'BEGIN',
            'SELECT timescaledb_post_restore()',
            'SELECT public.alter_job(id::integer, scheduled => false) FROM _timescaledb_config.bgw_job WHERE id >= 1000',
            'COMMIT',
          ]),
        );
        expect(clientQueries[1]?.mock.calls).not.toContainEqual(['BEGIN']);
        expect(clientQueries[3]?.mock.calls).not.toContainEqual(['BEGIN']);
      }
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
      expect(dependencies.spawn).toHaveBeenCalledOnce();
      expect(dependencies.spawn.mock.calls[0]?.[1]).toContain(
        '--role=restricted Backup"Role',
      );
      expect(dependencies.spawn.mock.calls[0]?.[2].env.PGUSER).toBe(
        sessionUser,
      );
      expect(
        dependencies.spawn.mock.calls[0]?.[2].env.PGOPTIONS,
      ).toBeUndefined();
      if (timescale) {
        // Timescale uses its existing pre/CLI/post phases; the final local
        // transaction above does not turn the CLI into PostgreSQL's mode.
        expect(dependencies.spawn.mock.calls[0]?.[1]).not.toContain(
          '--single-transaction',
        );
        expect(dependencies.spawn.mock.calls[0]?.[1]).toContain(
          '--exit-on-error',
        );
      } else {
        expect(dependencies.spawn.mock.calls[0]?.[1]).toContain(
          '--single-transaction',
        );
      }
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
