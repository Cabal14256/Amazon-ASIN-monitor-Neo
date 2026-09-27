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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  acquireBackupTargetLock,
  createBackupProcessor,
  stagingDatabaseName,
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
    const partitioned = `backup_partition_${scratchName.slice(-12)}`;
    const partition = `${partitioned}_small`;
    const states = new Map<string, TaskState>();
    let adminPool: ReturnType<typeof createPgPool>;
    let scratchPool: ReturnType<typeof createPgPool>;
    let directory: string;
    let scratchCreated = false;
    let scratchUrl: string;

    function env(databaseUrl: string) {
      return {
        DATABASE_URL: databaseUrl,
        COMPETITOR_DATABASE_URL: databaseUrl,
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
      params: { tables?: string[]; filename?: string; description?: string },
      options: {
        taskId?: string;
        target?: 'primary' | 'competitor';
        cancelAtProgress?: number;
        onProgress?: (value: number, taskId: string) => Promise<void>;
        failConfirmation?: boolean;
      } = {},
    ) {
      const taskId = options.taskId ?? randomUUID();
      const createdAt = new Date().toISOString();
      const shutdown = new AbortController();
      const data = backupJobDataSchema.parse({
        taskId,
        taskType: 'backup',
        taskSubType: operation,
        operation,
        target: options.target ?? 'primary',
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
          if (options.failConfirmation && change.kind === 'restore-confirmed')
            throw new Error('simulated confirmation failure');
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
          shutdownSignal: shutdown.signal,
          isClosing: () => false,
          assertJobLock: vi.fn(async () => undefined),
          updateProgress: vi.fn(async (_job: Job, value: number) => {
            await options.onProgress?.(value, taskId);
            if (value !== options.cancelAtProgress) return;
            states.set(
              taskId,
              transitionTask(
                states.get(taskId)!,
                { kind: 'cancel-request' },
                new Date(),
              ),
            );
            shutdown.abort();
          }),
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
      await adminPool.query(
        `CREATE DATABASE ${scratchName} TEMPLATE template0`,
      );
      scratchCreated = true;
      const target = new URL(sourceUrl);
      target.pathname = `/${scratchName}`;
      scratchUrl = target.toString();
      scratchPool = createPgPool(scratchUrl, { max: 1 });
      const extension = await scratchPool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS enabled",
      );
      expect(extension.rows[0]?.enabled).toBe(false);
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
      await scratchPool.query(
        `CREATE TABLE public.${partitioned} (id integer, note text NOT NULL) PARTITION BY RANGE (id)`,
      );
      await scratchPool.query(
        `CREATE TABLE public.${partition} PARTITION OF public.${partitioned} FOR VALUES FROM (0) TO (100)`,
      );
      await scratchPool.query(
        `INSERT INTO public.${partitioned} VALUES (1, 'partition-original')`,
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
        const independent = await acquireBackupTargetLock(
          {
            ...env(scratchUrl),
            COMPETITOR_DATABASE_URL: sourceUrl,
          },
          'competitor',
        );
        await independent.release();
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
        description: 'plain PostgreSQL recovery point',
      });
      const artifact = backupTaskResultDataSchema.parse(created.result);
      expect(artifact).toMatchObject({
        operation: 'create',
        restoreSupported: true,
        description: 'plain PostgreSQL recovery point',
      });
      if (!artifact.filename)
        throw new Error('No backup artifact was returned');
      expect(
        JSON.parse(
          await readFile(
            join(directory, `${artifact.filename}.meta.json`),
            'utf8',
          ),
        ),
      ).toMatchObject({
        version: 3,
        scope: 'selective',
        description: 'plain PostgreSQL recovery point',
      });

      await scratchPool.query(`UPDATE public.${tableA} SET note = 'mutated-a'`);
      await scratchPool.query(`UPDATE public.${tableB} SET note = 'mutated-b'`);
      const restored = await runJob(scratchUrl, 'restore', {
        filename: artifact.filename,
      });
      expect(restored.state.status).toBe('completed');
      expect(restored.result).toMatchObject({
        targetDatabaseChanged: true,
        verification: 'confirmed',
      });
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

      await scratchPool.query(`DROP TABLE public.${blocker}`);
      const uncertain = await runJob(
        scratchUrl,
        'restore',
        { filename: artifact.filename },
        { failConfirmation: true },
      );
      expect(uncertain.state).toMatchObject({
        status: 'completed',
        result: {
          targetDatabaseChanged: true,
          verification: 'unconfirmed',
        },
      });
      expect(
        (await scratchPool.query(`SELECT note FROM public.${tableA}`)).rows[0]
          .note,
      ).toBe('original-a');

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
      ).rejects.toThrow('备份文件来源数据库类型与恢复目标不一致');
    }, 120000);

    it('includes partition descendants and their rows in selective archives', async () => {
      const created = await runJob(scratchUrl, 'create', {
        tables: [`public.${partitioned}`],
      });
      const artifact = backupTaskResultDataSchema.parse(created.result);
      if (!artifact.filename) throw new Error('No partition backup artifact');
      await scratchPool.query(
        `UPDATE public.${partitioned} SET note = 'partition-mutated'`,
      );
      const restored = await runJob(scratchUrl, 'restore', {
        filename: artifact.filename,
      });
      expect(restored.state.status).toBe('completed');
      expect(
        (await scratchPool.query(`SELECT note FROM public.${partitioned}`))
          .rows[0].note,
      ).toBe('partition-original');
      expect(
        (await scratchPool.query(`SELECT note FROM public.${partition}`))
          .rows[0].note,
      ).toBe('partition-original');
      const metadataPath = join(directory, `${artifact.filename}.meta.json`);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      await writeFile(
        metadataPath,
        JSON.stringify({
          ...metadata,
          databaseSettings: {
            ...metadata.databaseSettings,
            lcCollate: `${metadata.databaseSettings.lcCollate}-different`,
          },
        }),
      );
      await scratchPool.query(
        `UPDATE public.${partitioned} SET note = 'partition-newer'`,
      );
      await expect(
        runJob(scratchUrl, 'restore', { filename: artifact.filename }),
      ).rejects.toThrow('恢复目标数据库的字符集或排序规则与备份不一致');
      expect(
        (await scratchPool.query(`SELECT note FROM public.${partitioned}`))
          .rows[0].note,
      ).toBe('partition-newer');
    }, 120000);

    it('restores a full plain-PG archive into a clean isolated database', async () => {
      const created = await runJob(scratchUrl, 'create', {});
      const artifact = backupTaskResultDataSchema.parse(created.result);
      if (!artifact.filename) throw new Error('No full backup artifact');
      const metadata = JSON.parse(
        await readFile(
          join(directory, `${artifact.filename}.meta.json`),
          'utf8',
        ),
      );
      expect(metadata).toMatchObject({ version: 3, scope: 'full' });
      expect(metadata.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      const original = (
        await scratchPool.query(`SELECT note FROM public.${tableA}`)
      ).rows[0].note;
      await scratchPool.query(
        `UPDATE public.${tableA} SET note='online-newer'`,
      );
      await scratchPool.query(`CREATE TABLE public.${blocker} (id integer)`);
      let restoredDatabase: string | undefined;
      try {
        // The online connection uses a query-level database override, while
        // the staging connection must use the newly created database name.
        const overriddenUrl = new URL(scratchUrl);
        overriddenUrl.searchParams.set('database', scratchName);
        const restored = await runJob(overriddenUrl.toString(), 'restore', {
          filename: artifact.filename,
        });
        expect(restored.state.status).toBe('completed');
        expect(restored.result).toMatchObject({
          restoreMode: 'isolated',
          targetDatabaseChanged: false,
        });
        restoredDatabase = (restored.result as { restoredDatabase?: string })
          .restoredDatabase;
        if (!restoredDatabase) throw new Error('No isolated database');
        const stagedUrl = new URL(scratchUrl);
        stagedUrl.pathname = `/${restoredDatabase}`;
        const stagedPool = createPgPool(stagedUrl.toString(), { max: 1 });
        try {
          const databaseSettingsSql =
            'SELECT encoding, datcollate, datctype, datlocprovider, daticulocale, daticurules FROM pg_database WHERE datname = current_database()';
          expect((await stagedPool.query(databaseSettingsSql)).rows[0]).toEqual(
            (await scratchPool.query(databaseSettingsSql)).rows[0],
          );
          expect(
            (await stagedPool.query('SELECT current_database() AS name'))
              .rows[0].name,
          ).toBe(restoredDatabase);
          expect(
            (await stagedPool.query(`SELECT note FROM public.${tableA}`))
              .rows[0].note,
          ).toBe(original);
          expect(
            (
              await stagedPool.query('SELECT to_regclass($1) AS extra', [
                `public.${blocker}`,
              ])
            ).rows[0].extra,
          ).toBeNull();
        } finally {
          await stagedPool.end();
        }
        expect(
          (await scratchPool.query(`SELECT note FROM public.${tableA}`)).rows[0]
            .note,
        ).toBe('online-newer');
        expect(
          (
            await scratchPool.query('SELECT to_regclass($1) AS extra', [
              `public.${blocker}`,
            ])
          ).rows[0].extra,
        ).not.toBeNull();

        // A syntactically valid selective sidecar for a different archive
        // cannot make a full dump run --clean against the online database.
        await writeFile(
          join(directory, `${artifact.filename}.meta.json`),
          JSON.stringify({
            ...metadata,
            scope: 'selective',
            tables: [`public.${tableA}`],
            archiveSha256: '0'.repeat(64),
          }),
        );
        await expect(
          runJob(scratchUrl, 'restore', { filename: artifact.filename }),
        ).rejects.toThrow('备份文件与元数据不匹配');
        expect(
          (await scratchPool.query(`SELECT note FROM public.${tableA}`)).rows[0]
            .note,
        ).toBe('online-newer');
      } finally {
        if (restoredDatabase)
          await adminPool.query(
            `DROP DATABASE ${restoredDatabase} WITH (FORCE)`,
          );
        await scratchPool.query(`DROP TABLE IF EXISTS public.${blocker}`);
      }
    }, 120000);

    it('rejects selective Timescale table dumps', async () => {
      const sourcePool = adminPool;
      const extension = await sourcePool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS enabled",
      );
      expect(extension.rows[0]?.enabled).toBe(true);
      await expect(
        runJob(sourceUrl, 'create', { tables: ['public.monitor_history'] }),
      ).rejects.toThrow();
      const failures = [...states.values()].filter(
        (state) =>
          state.status === 'failed' && state.message.startsWith('TimescaleDB'),
      );
      expect(failures).toHaveLength(1);
    }, 30000);

    it('restores Timescale hypertables and aggregates to isolated databases, cleaning failed and cancelled attempts', async () => {
      const sourceName = `neo_backup_ts_ci_${randomUUID()
        .replaceAll('-', '')
        .slice(0, 12)}`;
      const suffix = sourceName.slice(-12);
      const hypertable = `backup_metric_${suffix}`;
      const cagg = `backup_hourly_${suffix}`;
      const source = new URL(sourceUrl);
      source.pathname = `/${sourceName}`;
      const timescaleUrl = source.toString();
      const retained: string[] = [];
      let timescalePool: ReturnType<typeof createPgPool> | undefined;
      let sourceCreated = false;
      try {
        await adminPool.query(
          `CREATE DATABASE ${sourceName} TEMPLATE template0`,
        );
        sourceCreated = true;
        timescalePool = createPgPool(timescaleUrl, { max: 1 });
        await timescalePool.query('CREATE EXTENSION timescaledb');
        await timescalePool.query(
          `CREATE TABLE public.${hypertable} (ts timestamptz NOT NULL, value integer NOT NULL)`,
        );
        await timescalePool.query(
          `SELECT create_hypertable('public.${hypertable}', 'ts')`,
        );
        await timescalePool.query(
          `CREATE MATERIALIZED VIEW public.${cagg} WITH (timescaledb.continuous) AS
           SELECT time_bucket('1 hour', ts) AS bucket, count(*)::bigint AS samples
           FROM public.${hypertable} GROUP BY 1 WITH NO DATA`,
        );
        await timescalePool.query(
          `INSERT INTO public.${hypertable} VALUES ('2026-01-01T00:15:00Z', 7)`,
        );
        await timescalePool.query(
          `CALL refresh_continuous_aggregate('public.${cagg}', '2026-01-01T00:00:00Z'::timestamptz, '2026-01-01T01:00:00Z'::timestamptz)`,
        );
        await timescalePool.query(
          `SELECT add_retention_policy('public.${hypertable}', INTERVAL '100 years', schedule_interval => INTERVAL '1 day')`,
        );
        expect(
          (
            await timescalePool.query(
              'SELECT id FROM _timescaledb_config.bgw_job WHERE id >= 1000 AND scheduled = true',
            )
          ).rows.length,
        ).toBeGreaterThan(0);
        const created = await runJob(timescaleUrl, 'create', {});
        const artifact = backupTaskResultDataSchema.parse(created.result);
        expect(artifact).toMatchObject({
          sourceEngine: 'timescaledb',
          restoreSupported: true,
        });
        if (!artifact.filename) throw new Error('Missing Timescale archive');
        const metadata = JSON.parse(
          await readFile(
            join(directory, `${artifact.filename}.meta.json`),
            'utf8',
          ),
        );
        expect(metadata).toMatchObject({
          version: 2,
          timescale: {
            hypertables: expect.arrayContaining([`public.${hypertable}`]),
            continuousAggregates: expect.arrayContaining([`public.${cagg}`]),
          },
        });
        await timescalePool.query(`UPDATE public.${hypertable} SET value = 99`);
        const restored = await runJob(timescaleUrl, 'restore', {
          filename: artifact.filename,
        });
        const result = backupTaskResultDataSchema.parse(restored.result);
        expect(result).toMatchObject({
          restoreMode: 'isolated',
          targetDatabaseChanged: false,
        });
        if (!result.restoredDatabase)
          throw new Error('Missing isolated database');
        retained.push(result.restoredDatabase);
        const restoredUrl = new URL(timescaleUrl);
        restoredUrl.pathname = `/${result.restoredDatabase}`;
        const restoredPool = createPgPool(restoredUrl.toString(), { max: 1 });
        try {
          expect(
            (await restoredPool.query(`SELECT value FROM public.${hypertable}`))
              .rows[0]?.value,
          ).toBe(7);
          expect(
            (await restoredPool.query(`SELECT samples FROM public.${cagg}`))
              .rows[0]?.samples,
          ).toBe('1');
          expect(
            (
              await restoredPool.query(
                "SELECT current_setting('timescaledb.restoring', true) AS enabled",
              )
            ).rows[0]?.enabled,
          ).not.toBe('on');
          const restoredJobs = await restoredPool.query(
            'SELECT id, scheduled FROM _timescaledb_config.bgw_job WHERE id >= 1000',
          );
          expect(restoredJobs.rows.length).toBeGreaterThan(0);
          expect(
            restoredJobs.rows.every((job) => job.scheduled === false),
          ).toBe(true);
        } finally {
          await restoredPool.end();
        }
        expect(
          (await timescalePool.query(`SELECT value FROM public.${hypertable}`))
            .rows[0]?.value,
        ).toBe(99);

        const failedTaskId = randomUUID();
        await expect(
          runJob(
            timescaleUrl,
            'restore',
            { filename: artifact.filename },
            {
              taskId: failedTaskId,
              onProgress: async (value) => {
                if (value !== 50) return;
                const blockedUrl = new URL(timescaleUrl);
                blockedUrl.pathname = `/${stagingDatabaseName(
                  failedTaskId,
                  'primary',
                )}`;
                const blockedPool = createPgPool(blockedUrl.toString(), {
                  max: 1,
                });
                try {
                  await blockedPool.query(
                    `CREATE TABLE public.${hypertable} (id integer)`,
                  );
                } finally {
                  await blockedPool.end();
                }
              },
            },
          ),
        ).rejects.toThrow();
        expect(
          (
            await adminPool.query(
              'SELECT 1 FROM pg_database WHERE datname = $1',
              [stagingDatabaseName(failedTaskId, 'primary')],
            )
          ).rows,
        ).toHaveLength(0);

        const cancelledTaskId = randomUUID();
        const cancelled = await runJob(
          timescaleUrl,
          'restore',
          { filename: artifact.filename },
          { taskId: cancelledTaskId, cancelAtProgress: 50 },
        );
        expect(cancelled.state.status).toBe('cancelled');
        expect(
          (
            await adminPool.query(
              'SELECT 1 FROM pg_database WHERE datname = $1',
              [stagingDatabaseName(cancelledTaskId, 'primary')],
            )
          ).rows,
        ).toHaveLength(0);

        const held = await acquireBackupTargetLock(
          env(timescaleUrl),
          'primary',
        );
        const contendedTaskId = randomUUID();
        try {
          await expect(
            runJob(
              timescaleUrl,
              'restore',
              { filename: artifact.filename },
              { taskId: contendedTaskId },
            ),
          ).rejects.toThrow('目标数据库正在执行备份或恢复');
        } finally {
          await held.release();
        }
        expect(
          (
            await adminPool.query(
              'SELECT 1 FROM pg_database WHERE datname = $1',
              [stagingDatabaseName(contendedTaskId, 'primary')],
            )
          ).rows,
        ).toHaveLength(0);

        const competitor = await runJob(
          timescaleUrl,
          'create',
          {},
          { target: 'competitor' },
        );
        const competitorArtifact = backupTaskResultDataSchema.parse(
          competitor.result,
        );
        if (!competitorArtifact.filename)
          throw new Error('Missing competitor archive');
        const competitorRestore = await runJob(
          timescaleUrl,
          'restore',
          { filename: competitorArtifact.filename },
          { target: 'competitor' },
        );
        const competitorResult = backupTaskResultDataSchema.parse(
          competitorRestore.result,
        );
        expect(competitorResult).toMatchObject({
          target: 'competitor',
          restoreMode: 'isolated',
        });
        if (!competitorResult.restoredDatabase)
          throw new Error('Missing competitor isolated database');
        retained.push(competitorResult.restoredDatabase);
        const competitorUrl = new URL(timescaleUrl);
        competitorUrl.pathname = `/${competitorResult.restoredDatabase}`;
        const competitorPool = createPgPool(competitorUrl.toString(), {
          max: 1,
        });
        try {
          expect(
            (
              await competitorPool.query(
                `SELECT value FROM public.${hypertable}`,
              )
            ).rows[0]?.value,
          ).toBe(99);
        } finally {
          await competitorPool.end();
        }
      } finally {
        await timescalePool?.end();
        for (const database of retained)
          await adminPool.query(`DROP DATABASE ${database} WITH (FORCE)`);
        if (sourceCreated)
          await adminPool.query(`DROP DATABASE ${sourceName} WITH (FORCE)`);
      }
    }, 180000);
  },
);
