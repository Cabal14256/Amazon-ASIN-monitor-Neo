import type { BackupJobData } from '@asin-monitor/contracts';
import {
  backupJobDataSchema,
  backupTaskResultDataSchema,
} from '@asin-monitor/contracts';
import {
  createPgPool,
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  acquireBackupTargetLock,
  createBackupProcessor,
} from '../src/backup-processor';

/** Runs only against the disposable Timescale CI cluster. The scratch database
 * has no Timescale extension, so it exercises the supported plain-PG path. */
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'real PostgreSQL backup and restore commands',
  () => {
    const sourceUrl = process.env.DATABASE_URL ?? '';
    const scratchName = `neo_backup_ci_${randomUUID()
      .replaceAll('-', '')
      .slice(0, 12)}`;
    const tableA = `backup_restore_a_${scratchName.slice(-12)}`;
    const tableB = `backup_restore_b_${scratchName.slice(-12)}`;
    const blocker = `backup_restore_blocker_${scratchName.slice(-12)}`;
    const states = new Map<string, TaskState>();
    let adminPool: ReturnType<typeof createPgPool>;
    let scratchPool: ReturnType<typeof createPgPool>;
    let directory: string;
    let scratchCreated = false;
    let scratchUrl: string;

    function env(databaseUrl: string) {
      return {
        DATABASE_URL: databaseUrl,
        COMPETITOR_DATABASE_URL: process.env.COMPETITOR_DATABASE_URL,
        BACKUP_STORAGE_DIRECTORY: directory,
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: 2000,
        BACKUP_COMMAND_TIMEOUT_MS: 30000,
        BACKUP_MAX_BYTES: 10_000_000,
        PG_DUMP_PATH: 'pg_dump',
        PG_RESTORE_PATH: 'pg_restore',
      } as never;
    }

    async function runJob(
      databaseUrl: string,
      operation: 'create' | 'restore',
      params: { tables?: string[]; filename?: string },
    ) {
      const taskId = randomUUID();
      const createdAt = new Date().toISOString();
      const data = backupJobDataSchema.parse({
        taskId,
        taskType: 'backup',
        taskSubType: operation,
        operation,
        target: 'primary',
        userId: 'backup-integration',
        createdAt,
        params,
      }) as BackupJobData;
      states.set(taskId, {
        taskId,
        taskType: 'backup',
        taskSubType: operation,
        userId: data.userId,
        createdAt,
        updatedAt: createdAt,
        title: 'backup integration',
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
      });
      const store = {
        read: vi.fn(async (id: string) => states.get(id) ?? null),
        mutate: vi.fn(async (id: string, change: TaskMutation) => {
          const current = states.get(id);
          if (!current) return null;
          const next = transitionTask(current, change, new Date());
          states.set(id, next);
          return next;
        }),
      };
      const processor = createBackupProcessor(
        store,
        {
          env: env(databaseUrl),
          shutdownSignal: new AbortController().signal,
          isClosing: () => false,
          assertJobLock: vi.fn(async () => undefined),
          updateProgress: vi.fn(async () => undefined),
        },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      );
      const result = await processor(
        { id: taskId, name: operation, data } as Job,
        'fixture-lock',
      );
      return { result, state: states.get(taskId)! };
    }

    beforeAll(async () => {
      if (
        process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
          'amazon_asin_monitor_ci' ||
        new URL(sourceUrl).pathname !== '/amazon_asin_monitor_ci'
      )
        throw new Error(
          'Backup integration requires the disposable CI database',
        );
      directory = await mkdtemp(join(tmpdir(), 'neo-backup-integration-'));
      adminPool = createPgPool(sourceUrl, { max: 1 });
      await adminPool.query(`CREATE DATABASE ${scratchName}`);
      scratchCreated = true;
      const target = new URL(sourceUrl);
      target.pathname = `/${scratchName}`;
      scratchUrl = target.toString();
      scratchPool = createPgPool(scratchUrl, { max: 1 });
      await scratchPool.query(
        `CREATE TABLE public.${tableA} (id integer PRIMARY KEY, note text NOT NULL)`,
      );
      await scratchPool.query(
        `CREATE TABLE public.${tableB} (id integer PRIMARY KEY, note text NOT NULL)`,
      );
      await scratchPool.query(
        `INSERT INTO public.${tableA} VALUES (1, 'original-a')`,
      );
      await scratchPool.query(
        `INSERT INTO public.${tableB} VALUES (1, 'original-b')`,
      );
    }, 30000);

    afterAll(async () => {
      await scratchPool?.end();
      if (scratchCreated) {
        await adminPool.query(`DROP DATABASE ${scratchName} WITH (FORCE)`);
      }
      await adminPool?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    }, 30000);

    it('serializes sessions, restores real data, and rolls back a failed restore', async () => {
      const first = await acquireBackupTargetLock(env(scratchUrl), 'primary');
      try {
        await expect(
          acquireBackupTargetLock(env(scratchUrl), 'primary'),
        ).rejects.toThrow('BACKUP_TARGET_BUSY');
        await expect(
          runJob(scratchUrl, 'create', { tables: [`public.${tableA}`] }),
        ).rejects.toThrow('目标数据库正在执行备份或恢复');
        await expect(
          runJob(scratchUrl, 'restore', {
            filename: 'backup_20260927-020000-abcdef01-primary.dump',
          }),
        ).rejects.toThrow('目标数据库正在执行备份或恢复');
      } finally {
        await first.release();
      }
      const created = await runJob(scratchUrl, 'create', {
        tables: [`public.${tableA}`, `public.${tableB}`],
      });
      const artifact = backupTaskResultDataSchema.parse(created.result);
      expect(artifact).toMatchObject({
        operation: 'create',
        restoreSupported: true,
      });
      if (!artifact.filename)
        throw new Error('No backup artifact was returned');

      await scratchPool.query(`UPDATE public.${tableA} SET note = 'mutated-a'`);
      await scratchPool.query(`UPDATE public.${tableB} SET note = 'mutated-b'`);
      const restored = await runJob(scratchUrl, 'restore', {
        filename: artifact.filename,
      });
      expect(restored.state.status).toBe('completed');
      expect(
        (await scratchPool.query(`SELECT note FROM public.${tableA}`)).rows[0]
          .note,
      ).toBe('original-a');
      expect(
        (await scratchPool.query(`SELECT note FROM public.${tableB}`)).rows[0]
          .note,
      ).toBe('original-b');

      await scratchPool.query(
        `UPDATE public.${tableA} SET note = 'after-failure-a'`,
      );
      await scratchPool.query(
        `UPDATE public.${tableB} SET note = 'after-failure-b'`,
      );
      await scratchPool.query(
        `CREATE TABLE public.${blocker} (id integer REFERENCES public.${tableA}(id))`,
      );
      await expect(
        runJob(scratchUrl, 'restore', { filename: artifact.filename }),
      ).rejects.toThrow();
      expect(
        (await scratchPool.query(`SELECT note FROM public.${tableA}`)).rows[0]
          .note,
      ).toBe('after-failure-a');
      expect(
        (await scratchPool.query(`SELECT note FROM public.${tableB}`)).rows[0]
          .note,
      ).toBe('after-failure-b');

      await writeFile(
        join(directory, `${artifact.filename}.meta.json`),
        JSON.stringify({
          version: 1,
          filename: artifact.filename,
          target: 'primary',
          sourceEngine: 'timescaledb',
        }),
      );
      await expect(
        runJob(scratchUrl, 'restore', { filename: artifact.filename }),
      ).rejects.toThrow('TimescaleDB 不支持');
    }, 120000);

    it('refuses in-place Timescale restore and selective table dumps', async () => {
      const sourcePool = adminPool;
      const extension = await sourcePool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS enabled",
      );
      expect(extension.rows[0]?.enabled).toBe(true);
      await expect(
        runJob(sourceUrl, 'create', { tables: ['public.monitor_history'] }),
      ).rejects.toThrow();
      await expect(
        runJob(sourceUrl, 'restore', {
          filename: 'backup_20260927-020000-abcdef01-primary.dump',
        }),
      ).rejects.toThrow();
      const failures = [...states.values()].filter(
        (state) =>
          state.status === 'failed' && state.message.startsWith('TimescaleDB'),
      );
      expect(failures).toHaveLength(2);
    }, 30000);
  },
);
