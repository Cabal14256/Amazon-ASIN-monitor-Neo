import type { Env } from '@asin-monitor/config';
import type { BackupJobData } from '@asin-monitor/contracts';
import {
  backupJobDataSchema,
  backupQualifiedTableName,
  backupTaskResultDataSchema,
} from '@asin-monitor/contracts';
import {
  backupSelectiveRestoreQuery,
  backupTableSelectionQuery,
  createPgPool,
  resolveBackupTableSelection,
  selectiveBackupRestoreBlocked,
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  acquireBackupTargetLock,
  commandEnvironment,
  createBackupProcessor,
  processCommand,
  restoreCommandArgs,
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
        TASK_META_TTL_SECONDS: 604800,
        PG_DUMP_PATH: 'pg_dump',
        PG_RESTORE_PATH: 'pg_restore',
      } as Env;
    }

    async function runJob(
      databaseUrl: string,
      operation: 'create' | 'restore',
      params: { tables?: string[]; filename?: string; description?: string },
      options: {
        createdAt?: string;
        taskId?: string;
        target?: 'primary' | 'competitor';
        cancelAtProgress?: number;
        onProgress?: (value: number, taskId: string) => Promise<void>;
        onDigestCheckpoint?: (taskId: string) => Promise<void>;
        failConfirmation?: boolean;
        failCommitWrites?: boolean;
      } = {},
    ) {
      const taskId = options.taskId ?? randomUUID();
      const createdAt = options.createdAt ?? new Date().toISOString();
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
          if (options.failCommitWrites && change.kind === 'restore-committed')
            throw new Error(
              'simulated registry connection failure after commit',
            );
          if (options.failConfirmation && change.kind === 'restore-confirmed')
            throw new Error('simulated confirmation failure');
          const current = states.get(id);
          if (!current) return null;
          const next = transitionTask(current, change, new Date());
          states.set(id, next);
          return next;
        }),
      };
      let digestStarted = false;
      let digestObserved = false;
      const processor = createBackupProcessor(
        store,
        {
          env: env(databaseUrl),
          shutdownSignal: shutdown.signal,
          isClosing: () => false,
          assertJobLock: vi.fn(async () => {
            if (digestStarted && !digestObserved) {
              digestObserved = true;
              await options.onDigestCheckpoint?.(taskId);
            }
          }),
          updateProgress: vi.fn(async (_job: Job, value: number) => {
            await options.onProgress?.(value, taskId);
            if (value === 96) digestStarted = true;
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
      await adminPool.query(
        `ALTER DATABASE ${scratchName} SET TimeZone TO 'Asia/Shanghai'`,
      );
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

    it.each(['ssl=true', 'ssl=1', 'sslmode=no-verify'])(
      'rejects a plaintext-only CI server for actual driver, pg_dump and pg_restore %s',
      async (query) => {
        // The dedicated service uses stock ssl=off. Prove the command cannot
        // silently use libpq prefer and produce an archive over plaintext.
        expect((await scratchPool.query('SHOW ssl')).rows[0].ssl).toBe('off');
        const url = new URL(scratchUrl);
        for (const [key, value] of new URLSearchParams(query))
          url.searchParams.set(key, value);
        const secured = url.toString();
        const applicationPool = createPgPool(secured, {
          max: 1,
          connectionTimeoutMillis: 2000,
        });
        try {
          await expect(applicationPool.query('SELECT 1')).rejects.toThrow(
            /SSL|TLS/,
          );
        } finally {
          await applicationPool.end();
        }
        const output = join(directory, `tls-required-${randomUUID()}.partial`);
        await expect(
          processCommand(
            'pg_dump',
            ['--format=custom', '--schema-only', `--file=${output}`],
            commandEnvironment(secured),
            {
              timeoutMs: 5000,
              maxBytes: 10_000_000,
              signal: new AbortController().signal,
              checkpoint: async () => undefined,
              onProgress: async () => undefined,
            },
          ),
        ).rejects.toThrow('BACKUP_COMMAND_FAILED');
        const bytes = await readFile(output).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return Buffer.alloc(0);
            throw error;
          },
        );
        expect(bytes.length).toBe(0);

        const validInput = join(directory, `tls-source-${randomUUID()}.dump`);
        const plain = new URL(scratchUrl);
        plain.searchParams.set('sslmode', 'disable');
        const options = {
          timeoutMs: 5000,
          maxBytes: 10_000_000,
          signal: new AbortController().signal,
          checkpoint: async () => undefined,
          onProgress: async () => undefined,
        };
        await processCommand(
          'pg_dump',
          [
            '--format=custom',
            '--schema-only',
            `--table=public.${tableA}`,
            `--file=${validInput}`,
          ],
          commandEnvironment(plain.toString()),
          options,
        );
        // An intentionally absent TOC table makes even a regressed plaintext
        // connection harmless to the scratch data while testing actual restore
        // connection negotiation (not the offline --list mode).
        await expect(
          processCommand(
            'pg_restore',
            [
              `--dbname=${scratchName}`,
              '--data-only',
              '--table=never_in_tls_fixture_toc',
              validInput,
            ],
            commandEnvironment(secured),
            options,
          ),
        ).rejects.toThrow('BACKUP_COMMAND_FAILED');
      },
      20000,
    );

    it('backs up and restores only the literal mixed-case table using the real pg_dump parser', async () => {
      const mixed = `BackupMixed_${scratchName.slice(-12)}`;
      const folded = mixed.toLowerCase();
      await scratchPool.query(
        `CREATE TABLE public."${mixed}" (id integer PRIMARY KEY, note text NOT NULL)`,
      );
      await scratchPool.query(
        `CREATE TABLE public.${folded} (id integer PRIMARY KEY, note text NOT NULL)`,
      );
      await scratchPool.query(
        `INSERT INTO public."${mixed}" VALUES (1, 'mixed-original')`,
      );
      await scratchPool.query(
        `INSERT INTO public.${folded} VALUES (1, 'folded-original')`,
      );
      const created = await runJob(scratchUrl, 'create', {
        tables: [`public.${mixed}`],
      });
      const result = backupTaskResultDataSchema.parse(created.result);
      if (!result.filename) throw new Error('No mixed-case archive');
      expect(
        JSON.parse(
          await readFile(
            join(directory, `${result.filename}.meta.json`),
            'utf8',
          ),
        ),
      ).toMatchObject({ tables: [`public.${mixed}`] });
      await scratchPool.query(
        `UPDATE public."${mixed}" SET note = 'mixed-after'`,
      );
      await scratchPool.query(
        `UPDATE public.${folded} SET note = 'folded-after'`,
      );
      await runJob(scratchUrl, 'restore', { filename: result.filename });
      expect(
        (await scratchPool.query(`SELECT note FROM public."${mixed}"`)).rows,
      ).toEqual([{ note: 'mixed-original' }]);
      expect(
        (await scratchPool.query(`SELECT note FROM public.${folded}`)).rows,
      ).toEqual([{ note: 'folded-after' }]);
    }, 30000);
    it.each(['url-options', 'inherited-options'] as const)(
      'freezes the actual %s search path and restores only the selected same-named schema table',
      async (mode) => {
        const schema = `backup_path_${scratchName.slice(-12)}.quoted"${mode}`;
        const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
        const selected = backupQualifiedTableName(schema, tableA);
        const view = `backup_path_view_${scratchName.slice(-12)}`;
        const previousOptions = process.env.PGOPTIONS;
        let applicationPool: ReturnType<typeof createPgPool> | undefined;
        try {
          await scratchPool.query(`CREATE SCHEMA ${quote(schema)}`);
          await scratchPool.query(
            `CREATE TABLE ${selected}(id integer PRIMARY KEY,note text NOT NULL)`,
          );
          await scratchPool.query(
            `INSERT INTO ${selected} VALUES(1,'namespaced-original')`,
          );
          const options = `-c search_path=${quote(
            schema,
          )},public -c application_name=backup_path_fixture`;
          const source = new URL(scratchUrl);
          source.searchParams.delete('options');
          if (mode === 'url-options')
            source.searchParams.set('options', options);
          else process.env.PGOPTIONS = options;
          applicationPool = createPgPool(source.toString(), { max: 1 });
          const apiSelection = await applicationPool.query(
            backupTableSelectionQuery([tableA]),
          );
          const frozen = resolveBackupTableSelection(
            [tableA],
            apiSelection.rows,
          );
          expect(frozen).toEqual([selected]);
          // Already-queued unqualified data keeps its original private identity,
          // but the Worker freezes what its actual NodePG session resolved.
          const original = await runJob(source.toString(), 'create', {
            tables: [tableA],
          });
          const originalName = (original.result as { filename: string })
            .filename;
          expect(
            JSON.parse(
              await readFile(
                join(directory, `${originalName}.meta.json`),
                'utf8',
              ),
            ).tables,
          ).toEqual(frozen);

          // A new API-frozen job remains exact even if the Worker uses a different
          // path. Neither pg_dump nor pg_restore receives arbitrary PGOPTIONS.
          const worker = new URL(scratchUrl);
          worker.searchParams.set('options', '-c search_path=public');
          const created = await runJob(worker.toString(), 'create', {
            tables: frozen,
          });
          const filename = (created.result as { filename: string }).filename;
          const metadata = JSON.parse(
            await readFile(join(directory, `${filename}.meta.json`), 'utf8'),
          );
          expect(metadata.tables).toEqual(frozen);
          await scratchPool.query(
            `UPDATE ${selected} SET note='namespaced-after' WHERE id=1`,
          );
          await scratchPool.query(
            `UPDATE public.${tableA} SET note='public-after' WHERE id=1`,
          );
          await scratchPool.query(
            `CREATE VIEW public.${view} AS SELECT id FROM public.${tableA}`,
          );
          // The other schema has an incoming view with the EXACT same base table
          // name. API/Worker preflight must not mistake it for an archived target.
          expect(
            selectiveBackupRestoreBlocked(
              (
                await scratchPool.query(
                  backupSelectiveRestoreQuery(metadata.tables),
                )
              ).rows,
            ),
          ).toBe(false);
          expect(
            selectiveBackupRestoreBlocked(
              (await scratchPool.query(backupSelectiveRestoreQuery([tableA])))
                .rows,
            ),
          ).toBe(true);
          const restored = await runJob(worker.toString(), 'restore', {
            filename,
          });
          expect(restored.state.status).toBe('completed');
          expect(restored.result).toMatchObject({ verification: 'confirmed' });
          expect(
            (await scratchPool.query(`SELECT note FROM ${selected} WHERE id=1`))
              .rows,
          ).toEqual([{ note: 'namespaced-original' }]);
          expect(
            (
              await scratchPool.query(
                `SELECT note FROM public.${tableA} WHERE id=1`,
              )
            ).rows,
          ).toEqual([{ note: 'public-after' }]);
        } finally {
          if (previousOptions === undefined) delete process.env.PGOPTIONS;
          else process.env.PGOPTIONS = previousOptions;
          await applicationPool?.end();
          await scratchPool.query(`DROP VIEW IF EXISTS public.${view}`);
          await scratchPool.query(
            `DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`,
          );
          await scratchPool.query(
            `UPDATE public.${tableA} SET note='original-a' WHERE id=1`,
          );
        }
      },
      30000,
    );
    it.each([
      'url',
      'inherited',
      'url-overrides-env',
      'empty-url-options',
      'database-default',
      'session-authorization',
      'database-session-default-ignored',
    ] as const)(
      'keeps the real effective role for backup and restore commands (%s)',
      async (mode) => {
        const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
        const role =
          mode === 'session-authorization'
            ? `backup auth_${suffix}"\\restricted`
            : `backup_restricted_${suffix}`;
        const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
        const sessionGuard = `backup_session_guard_${suffix}`;
        const allowed = `backup_role_allowed_${suffix}`;
        const privateTable = `backup_role_private_${suffix}`;
        const previousOptions = process.env.PGOPTIONS;
        let applicationPool: ReturnType<typeof createPgPool> | undefined;
        let roleCreated = false;
        let databaseRoleSet = false;
        let databaseSessionSet = false;
        let stagedDatabase: string | undefined;
        try {
          await scratchPool.query(
            `CREATE ROLE ${quote(role)} NOLOGIN${
              mode === 'database-default' ? ' CREATEDB' : ''
            }`,
          );
          roleCreated = true;
          await scratchPool.query(
            `GRANT USAGE, CREATE ON SCHEMA public TO ${quote(role)}`,
          );
          await scratchPool.query(
            `CREATE TABLE public.${allowed} (id integer PRIMARY KEY, note text NOT NULL)`,
          );
          await scratchPool.query(
            `INSERT INTO public.${allowed} VALUES (1, 'allowed-original')`,
          );
          await scratchPool.query(
            `ALTER TABLE public.${allowed} OWNER TO ${quote(role)}`,
          );
          await scratchPool.query(
            `CREATE TABLE public.${privateTable} (id integer PRIMARY KEY, note text NOT NULL)`,
          );
          await scratchPool.query(
            `INSERT INTO public.${privateTable} VALUES (1, 'private-original')`,
          );

          // A real login-authorized archive is later offered to a restricted
          // restore. Its preflight can resolve names without owning the table.
          const unrestricted = new URL(scratchUrl);
          unrestricted.searchParams.set(
            'options',
            '-c application_name=backup_role_admin',
          );
          const privateArchive = backupTaskResultDataSchema.parse(
            (
              await runJob(unrestricted.toString(), 'create', {
                tables: [`public.${privateTable}`],
              })
            ).result,
          );
          if (!privateArchive.filename)
            throw new Error('Missing role fixture archive');
          const fullArchive =
            mode === 'database-default'
              ? backupTaskResultDataSchema.parse(
                  (await runJob(unrestricted.toString(), 'create', {})).result,
                )
              : null;
          await scratchPool.query(
            `UPDATE public.${privateTable} SET note='private-live' WHERE id=1`,
          );

          const loginIdentity = (
            await scratchPool.query(
              'SELECT current_user AS role, session_user AS "sessionUser"',
            )
          ).rows[0];
          if (typeof loginIdentity?.sessionUser !== 'string')
            throw new Error('Missing login session identity');

          const source = new URL(scratchUrl);
          let guardedSession: string | undefined;
          if (mode === 'session-authorization') {
            const escapedRole = role
              .replaceAll('\\', '\\\\')
              .replaceAll(' ', '\\ ');
            source.searchParams.set(
              'options',
              '-c session_authorization=' +
                escapedRole +
                ' -c role=' +
                escapedRole +
                ' -c search_path=public',
            );
            process.env.PGOPTIONS =
              '-c application_name=unconfirmed_session_default';
            // PostgreSQL ignores startup session_authorization, while role
            // still restricts current_user. Guard the actual login session.
            guardedSession = loginIdentity.sessionUser;
          } else if (mode === 'database-session-default-ignored') {
            await adminPool.query(
              `ALTER DATABASE ${quote(
                scratchName,
              )} SET session_authorization TO ${quote(role)}`,
            );
            databaseSessionSet = true;
            expect(
              (
                await adminPool.query(
                  'SELECT setconfig FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname=$1) AND setrole=0',
                  [scratchName],
                )
              ).rows[0].setconfig,
            ).toContain(`session_authorization=${role}`);
            process.env.PGOPTIONS =
              '-c application_name=ignored_database_session_default';
            const defaultPool = createPgPool(unrestricted.toString(), {
              max: 1,
            });
            try {
              expect(
                (
                  await defaultPool.query(
                    'SELECT current_user AS role, session_user AS "sessionUser"',
                  )
                ).rows[0],
              ).toEqual({
                role: loginIdentity.role,
                sessionUser: loginIdentity.sessionUser,
              });
            } finally {
              await defaultPool.end();
            }
            // The stored database setting is dormant in PostgreSQL16.
            // Neither it nor a startup option changes the authenticated user.
            source.searchParams.set(
              'options',
              '-c session_authorization=' +
                loginIdentity.sessionUser.replace(/([\\ \t\n\r\v\f])/g, '\\$1'),
            );
            guardedSession = loginIdentity.sessionUser;
          } else if (mode === 'database-default') {
            await adminPool.query(
              `ALTER DATABASE ${scratchName} SET role TO ${role}`,
            );
            databaseRoleSet = true;
            source.searchParams.set(
              'options',
              '-c application_name=backup_database_role',
            );
            process.env.PGOPTIONS =
              '-c application_name=ignored_database_role_default';
          } else if (mode === 'url') {
            source.searchParams.set('options', `-c role=${role}`);
            process.env.PGOPTIONS = '-c application_name=ignored_role_default';
          } else {
            process.env.PGOPTIONS = `-c role=${role}`;
            if (mode === 'inherited') source.searchParams.delete('options');
            else
              source.searchParams.set(
                'options',
                mode === 'empty-url-options'
                  ? ''
                  : '-c application_name=backup_role_override',
              );
          }
          if (guardedSession !== undefined) {
            // Real DDL must use the frozen session_user, independently of
            // current_user restored by --role (including a login override).
            await scratchPool.query(
              `CREATE FUNCTION public.${sessionGuard}() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN IF session_user <> '${guardedSession.replaceAll(
                "'",
                "''",
              )}' THEN RAISE EXCEPTION 'Unconfirmed backup session user'; END IF; END; $$`,
            );
            await scratchPool.query(
              `CREATE EVENT TRIGGER ${sessionGuard} ON ddl_command_start WHEN TAG IN ('CREATE TABLE', 'DROP TABLE') EXECUTE FUNCTION public.${sessionGuard}()`,
            );
          }
          applicationPool = createPgPool(source.toString(), { max: 1 });
          const effectiveIdentity = (
            await applicationPool.query(
              'SELECT current_user AS role, session_user AS "sessionUser"',
            )
          ).rows[0];
          const restricted =
            mode !== 'url-overrides-env' &&
            mode !== 'database-session-default-ignored';
          expect(effectiveIdentity.role).toBe(
            mode === 'database-session-default-ignored'
              ? loginIdentity.sessionUser
              : restricted
              ? role
              : loginIdentity.role,
          );
          expect(effectiveIdentity.sessionUser).toBe(loginIdentity.sessionUser);

          // A restricted whole-database dump must fail on login-only tables;
          // silently reverting to the broader login role would publish it.
          const fullTaskId = randomUUID();
          if (restricted) {
            await expect(
              runJob(source.toString(), 'create', {}, { taskId: fullTaskId }),
            ).rejects.toThrow('备份任务失败，请核实数据库状态和备份文件');
            expect(states.get(fullTaskId)?.status).toBe('failed');
            expect(
              (await readdir(directory)).filter((file) =>
                file.includes(fullTaskId.replaceAll('-', '')),
              ),
            ).toEqual([]);
            await expect(
              runJob(source.toString(), 'restore', {
                filename: privateArchive.filename,
              }),
            ).rejects.toThrow('备份任务失败，请核实数据库状态和备份文件');
            expect(
              (
                await scratchPool.query(
                  `SELECT note FROM public.${privateTable} WHERE id=1`,
                )
              ).rows,
            ).toEqual([{ note: 'private-live' }]);
          } else {
            expect(
              (
                await runJob(
                  source.toString(),
                  'create',
                  {},
                  { taskId: fullTaskId },
                )
              ).state.status,
            ).toBe('completed');
            expect(
              (
                await runJob(source.toString(), 'restore', {
                  filename: privateArchive.filename,
                })
              ).state.status,
            ).toBe('completed');
            expect(
              (
                await scratchPool.query(
                  `SELECT note FROM public.${privateTable} WHERE id=1`,
                )
              ).rows,
            ).toEqual([{ note: 'private-original' }]);
          }

          const permitted = backupTaskResultDataSchema.parse(
            (
              await runJob(source.toString(), 'create', {
                tables: [`public.${allowed}`],
              })
            ).result,
          );
          if (!permitted.filename)
            throw new Error('Missing permitted role archive');
          await scratchPool.query(
            `UPDATE public.${allowed} SET note='allowed-live' WHERE id=1`,
          );
          expect(
            (
              await runJob(source.toString(), 'restore', {
                filename: permitted.filename,
              })
            ).state.status,
          ).toBe('completed');
          expect(
            (
              await scratchPool.query(
                `SELECT note FROM public.${allowed} WHERE id=1`,
              )
            ).rows,
          ).toEqual([{ note: 'allowed-original' }]);
          if (mode === 'database-default') {
            if (!fullArchive?.filename)
              throw new Error('Missing full role archive');
            const taskId = randomUUID();
            stagedDatabase = stagingDatabaseName(taskId, 'primary');
            const restored = await runJob(
              source.toString(),
              'restore',
              { filename: fullArchive.filename },
              { taskId },
            );
            expect(restored.state.status).toBe('completed');
            expect(restored.result).toMatchObject({
              restoreMode: 'isolated',
              targetDatabaseChanged: false,
              restoredDatabase: stagedDatabase,
            });
            expect(
              (
                await scratchPool.query(
                  `SELECT note FROM public.${privateTable} WHERE id=1`,
                )
              ).rows,
            ).toEqual([{ note: 'private-live' }]);
          }
        } finally {
          if (previousOptions === undefined) delete process.env.PGOPTIONS;
          else process.env.PGOPTIONS = previousOptions;
          await applicationPool?.end();
          if (
            mode === 'session-authorization' ||
            mode === 'database-session-default-ignored'
          ) {
            await scratchPool.query(
              `DROP EVENT TRIGGER IF EXISTS ${sessionGuard}`,
            );
            await scratchPool.query(
              `DROP FUNCTION IF EXISTS public.${sessionGuard}()`,
            );
          }
          if (databaseRoleSet)
            await adminPool.query(`ALTER DATABASE ${scratchName} RESET role`);
          if (databaseSessionSet)
            await adminPool.query(
              `ALTER DATABASE ${quote(
                scratchName,
              )} RESET session_authorization`,
            );
          if (stagedDatabase) {
            const owned = await adminPool.query(
              'SELECT pg_get_userbyid(datdba) = $2 AS owned FROM pg_database WHERE datname = $1',
              [stagedDatabase, role],
            );
            if (owned.rows[0]?.owned === true)
              await adminPool.query(
                `DROP DATABASE ${stagedDatabase} WITH (FORCE)`,
              );
          }
          await scratchPool.query(
            `DROP TABLE IF EXISTS public.${privateTable}, public.${allowed}`,
          );
          if (roleCreated) {
            await scratchPool.query(
              `REVOKE USAGE, CREATE ON SCHEMA public FROM ${quote(role)}`,
            );
            await scratchPool.query(`DROP ROLE ${quote(role)}`);
          }
        }
      },
      30000,
    );
    it('refuses a valid plus missing literal table instead of publishing a partial-selection archive', async () => {
      const taskId = randomUUID();
      await expect(
        runJob(
          scratchUrl,
          'create',
          {
            tables: [`public.${tableA}`, `public.absent_${scratchName}`],
          },
          { taskId },
        ),
      ).rejects.toThrow('备份任务失败，请核实数据库状态和备份文件');
      expect(states.get(taskId)).toMatchObject({
        status: 'failed',
        result: null,
        error: '备份任务失败，请核实数据库状态和备份文件',
        message: '备份任务失败，请核实数据库状态和备份文件',
      });
      expect(
        (await readdir(directory)).filter((name) =>
          name.includes(taskId.replaceAll('-', '')),
        ),
      ).toEqual([]);
      expect(
        (
          await scratchPool.query(
            `SELECT note FROM public.${tableA} WHERE id=1`,
          )
        ).rows,
      ).toEqual([{ note: 'original-a' }]);
    }, 30000);
    it.each(['foreign-key', 'view', 'materialized-view'] as const)(
      'refuses an unselected incoming %s before restore and leaves all live objects intact',
      async (kind) => {
        const name = `incoming_${kind.replaceAll('-', '_')}_${randomUUID()
          .replaceAll('-', '')
          .slice(0, 8)}`;
        const created = await runJob(scratchUrl, 'create', {
          tables: [`public.${tableA}`],
        });
        const artifact = backupTaskResultDataSchema.parse(created.result);
        if (!artifact.filename) throw new Error('Missing selective fixture');
        await scratchPool.query(
          `UPDATE public.${tableA} SET note='blocked-live-value' WHERE id=1`,
        );
        try {
          if (kind === 'foreign-key') {
            await scratchPool.query(
              `CREATE TABLE public.${name} (id integer PRIMARY KEY REFERENCES public.${tableA}(id))`,
            );
            await scratchPool.query(`INSERT INTO public.${name} VALUES (1)`);
          } else {
            await scratchPool.query(
              `CREATE ${
                kind === 'materialized-view' ? 'MATERIALIZED ' : ''
              }VIEW public.${name} AS SELECT id, note FROM public.${tableA}`,
            );
          }
          const probe = await scratchPool.query(
            backupSelectiveRestoreQuery([`public.${tableA}`]),
          );
          expect(selectiveBackupRestoreBlocked(probe.rows)).toBe(true);
          await expect(
            runJob(scratchUrl, 'restore', { filename: artifact.filename }),
          ).rejects.toThrow('未包含在归档中的外部依赖');
          expect(
            (
              await scratchPool.query(
                `SELECT note FROM public.${tableA} WHERE id=1`,
              )
            ).rows,
          ).toEqual([{ note: 'blocked-live-value' }]);
          expect(
            (await scratchPool.query(`SELECT id FROM public.${name}`)).rows,
          ).toEqual([{ id: 1 }]);
        } finally {
          await scratchPool.query(
            `DROP ${
              kind === 'foreign-key'
                ? 'TABLE'
                : kind === 'materialized-view'
                ? 'MATERIALIZED VIEW'
                : 'VIEW'
            } IF EXISTS public.${name}`,
          );
          await scratchPool.query(
            `UPDATE public.${tableA} SET note='original-a' WHERE id=1`,
          );
        }
      },
      30000,
    );
    it('restores a closed foreign-key selection atomically and detects references to a selected partition descendant', async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
      const parent = `closed_parent_${suffix}`,
        child = `closed_child_${suffix}`,
        external = `partition_reference_${suffix}`;
      try {
        await scratchPool.query(
          `CREATE TABLE public.${parent} (id integer PRIMARY KEY, note text)`,
        );
        await scratchPool.query(
          `CREATE TABLE public.${child} (id integer PRIMARY KEY, parent_id integer REFERENCES public.${parent}(id), note text)`,
        );
        await scratchPool.query(
          `INSERT INTO public.${parent} VALUES (1, 'original-parent')`,
        );
        await scratchPool.query(
          `INSERT INTO public.${child} VALUES (1, 1, 'original-child')`,
        );
        const tables = [`public.${parent}`, `public.${child}`];
        expect(
          selectiveBackupRestoreBlocked(
            (await scratchPool.query(backupSelectiveRestoreQuery(tables))).rows,
          ),
        ).toBe(false);
        const created = await runJob(scratchUrl, 'create', { tables });
        const artifact = backupTaskResultDataSchema.parse(created.result);
        if (!artifact.filename) throw new Error('Missing closed fixture');
        await scratchPool.query(
          `UPDATE public.${parent} SET note='mutated-parent'`,
        );
        await scratchPool.query(
          `UPDATE public.${child} SET note='mutated-child'`,
        );
        await runJob(scratchUrl, 'restore', { filename: artifact.filename });
        expect(
          (await scratchPool.query(`SELECT note FROM public.${parent}`)).rows,
        ).toEqual([{ note: 'original-parent' }]);
        expect(
          (await scratchPool.query(`SELECT note FROM public.${child}`)).rows,
        ).toEqual([{ note: 'original-child' }]);
        await scratchPool.query(
          `ALTER TABLE public.${partition} ADD UNIQUE (id)`,
        );
        await scratchPool.query(
          `CREATE TABLE public.${external} (id integer REFERENCES public.${partition}(id))`,
        );
        expect(
          selectiveBackupRestoreBlocked(
            (
              await scratchPool.query(
                backupSelectiveRestoreQuery([`public.${partitioned}`]),
              )
            ).rows,
          ),
        ).toBe(true);
      } finally {
        await scratchPool.query(`DROP TABLE IF EXISTS public.${external}`);
        await scratchPool.query(`DROP TABLE IF EXISTS public.${child}`);
        await scratchPool.query(`DROP TABLE IF EXISTS public.${parent}`);
      }
    }, 30000);
    it('detects an outside default referencing a selected owned sequence and permits its closed selection', async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
      const parent = `serial_parent_${suffix}`;
      const outside = `serial_default_${suffix}`;
      try {
        await scratchPool.query(
          `CREATE TABLE public.${parent} (id serial PRIMARY KEY, note text NOT NULL)`,
        );
        await scratchPool.query(
          `INSERT INTO public.${parent} (note) VALUES ('serial-original')`,
        );
        const created = await runJob(scratchUrl, 'create', {
          tables: [`public.${parent}`],
        });
        const artifact = backupTaskResultDataSchema.parse(created.result);
        if (!artifact.filename) throw new Error('Missing serial archive');
        await scratchPool.query(
          `CREATE TABLE public.${outside} (id integer DEFAULT nextval('public.${parent}_id_seq'::regclass))`,
        );
        await scratchPool.query(`INSERT INTO public.${outside} DEFAULT VALUES`);
        await scratchPool.query(
          `UPDATE public.${parent} SET note='serial-live'`,
        );
        expect(
          selectiveBackupRestoreBlocked(
            (
              await scratchPool.query(
                backupSelectiveRestoreQuery([`public.${parent}`]),
              )
            ).rows,
          ),
        ).toBe(true);
        await expect(
          runJob(scratchUrl, 'restore', { filename: artifact.filename }),
        ).rejects.toThrow('未包含在归档中的外部依赖');
        expect(
          (await scratchPool.query(`SELECT note FROM public.${parent}`)).rows,
        ).toEqual([{ note: 'serial-live' }]);
        expect(
          (await scratchPool.query(`SELECT id FROM public.${outside}`)).rows,
        ).toEqual([{ id: 2 }]);
        const tables = [`public.${parent}`, `public.${outside}`];
        expect(
          selectiveBackupRestoreBlocked(
            (await scratchPool.query(backupSelectiveRestoreQuery(tables))).rows,
          ),
        ).toBe(false);
        const closed = backupTaskResultDataSchema.parse(
          (await runJob(scratchUrl, 'create', { tables })).result,
        );
        if (!closed.filename) throw new Error('Missing closed serial archive');
        await scratchPool.query(
          `UPDATE public.${parent} SET note='serial-mutated'`,
        );
        await scratchPool.query(`INSERT INTO public.${outside} DEFAULT VALUES`);
        await runJob(scratchUrl, 'restore', { filename: closed.filename });
        expect(
          (await scratchPool.query(`SELECT note FROM public.${parent}`)).rows,
        ).toEqual([{ note: 'serial-live' }]);
        expect(
          (await scratchPool.query(`SELECT id FROM public.${outside}`)).rows,
        ).toEqual([{ id: 2 }]);
        expect(
          (
            await scratchPool.query(
              `SELECT nextval('public.${parent}_id_seq'::regclass)::integer AS id`,
            )
          ).rows,
        ).toEqual([{ id: 3 }]);
      } finally {
        await scratchPool.query(`DROP TABLE IF EXISTS public.${outside}`);
        await scratchPool.query(`DROP TABLE IF EXISTS public.${parent}`);
      }
    }, 30000);
    it('refuses an outside function returning the implicit row type of a selected table', async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
      const table = `row_type_${suffix}`;
      const outside = `row_function_${suffix}`;
      try {
        await scratchPool.query(
          `CREATE TABLE public.${table} (id integer PRIMARY KEY, note text NOT NULL)`,
        );
        await scratchPool.query(
          `INSERT INTO public.${table} VALUES (1, 'row-original')`,
        );
        const created = await runJob(scratchUrl, 'create', {
          tables: [`public.${table}`],
        });
        const artifact = backupTaskResultDataSchema.parse(created.result);
        if (!artifact.filename) throw new Error('Missing row type archive');
        await scratchPool.query(
          `CREATE FUNCTION public.${outside}() RETURNS SETOF public.${table} LANGUAGE SQL AS 'SELECT * FROM public.${table}'`,
        );
        await scratchPool.query(`UPDATE public.${table} SET note='row-live'`);
        expect(
          selectiveBackupRestoreBlocked(
            (
              await scratchPool.query(
                backupSelectiveRestoreQuery([`public.${table}`]),
              )
            ).rows,
          ),
        ).toBe(true);
        await expect(
          runJob(scratchUrl, 'restore', { filename: artifact.filename }),
        ).rejects.toThrow('未包含在归档中的外部依赖');
        expect(
          (await scratchPool.query(`SELECT note FROM public.${table}`)).rows,
        ).toEqual([{ note: 'row-live' }]);
        expect(
          (await scratchPool.query(`SELECT note FROM public.${outside}()`))
            .rows,
        ).toEqual([{ note: 'row-live' }]);
      } finally {
        await scratchPool.query(`DROP FUNCTION IF EXISTS public.${outside}()`);
        await scratchPool.query(`DROP TABLE IF EXISTS public.${table}`);
      }
    }, 30000);
    it('refuses ambiguous unqualified names instead of counting a hidden referencing table as archived', async () => {
      const hidden = `hidden_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
      await scratchPool.query(`CREATE SCHEMA ${hidden}`);
      try {
        await scratchPool.query(
          `CREATE TABLE ${hidden}.${tableB} (id integer REFERENCES public.${tableA}(id))`,
        );
        const tables = [tableA, tableB];
        const created = await runJob(scratchUrl, 'create', { tables });
        const artifact = backupTaskResultDataSchema.parse(created.result);
        if (!artifact.filename) throw new Error('Missing unqualified archive');
        expect(
          selectiveBackupRestoreBlocked(
            (await scratchPool.query(backupSelectiveRestoreQuery(tables))).rows,
          ),
        ).toBe(true);
        await expect(
          runJob(scratchUrl, 'restore', { filename: artifact.filename }),
        ).rejects.toThrow('未包含在归档中的外部依赖');
        expect(
          selectiveBackupRestoreBlocked(
            (
              await scratchPool.query(
                backupSelectiveRestoreQuery([
                  `public.${tableA}`,
                  `public.${tableB}`,
                ]),
              )
            ).rows,
          ),
        ).toBe(true);
      } finally {
        await scratchPool.query(`DROP TABLE ${hidden}.${tableB}`);
        await scratchPool.query(`DROP SCHEMA ${hidden}`);
      }
    }, 30000);
    it('publishes and replays a real dump when the API clock is ahead without changing its original identity', async () => {
      const createdAt = new Date(Date.now() + 60000).toISOString();
      const taskId = randomUUID();
      const created = await runJob(
        scratchUrl,
        'create',
        { tables: [`public.${tableA}`] },
        { createdAt, taskId },
      );
      const result = backupTaskResultDataSchema.parse(created.result);
      expect(created.state.status).toBe('completed');
      expect(created.state.createdAt).toBe(createdAt);
      expect(Date.parse(result.execution!.dumpStartedAt)).toBeLessThan(
        Date.parse(createdAt),
      );
      const replay = await runJob(
        scratchUrl,
        'create',
        { tables: [`public.${tableA}`] },
        { createdAt, taskId },
      );
      expect(replay.result).toEqual(created.result);
      expect(replay.state.status).toBe('completed');
    }, 30000);
    it('records a real delayed pg_dump execution window separately from its immutable acceptance timestamp', async () => {
      const acceptedAt = new Date(Date.now() - 2 * 86400000).toISOString();
      const beforeDump = Date.now();
      const created = await runJob(
        scratchUrl,
        'create',
        { tables: [`public.${tableA}`] },
        { createdAt: acceptedAt },
      );
      const artifact = backupTaskResultDataSchema.parse(created.result);
      expect(created.state.createdAt).toBe(acceptedAt);
      expect(artifact.timeSource).toBe('dump-start');
      expect(artifact.createdAt).toBe(artifact.execution?.dumpStartedAt);
      if (!artifact.filename || !artifact.execution)
        throw new Error('Missing execution window');
      expect(
        Date.parse(artifact.execution.dumpStartedAt),
      ).toBeGreaterThanOrEqual(beforeDump);
      expect(
        Date.parse(artifact.execution.dumpCompletedAt),
      ).toBeGreaterThanOrEqual(Date.parse(artifact.execution.dumpStartedAt));
      expect(
        Date.parse(artifact.execution.publicationStartedAt),
      ).toBeGreaterThanOrEqual(Date.parse(artifact.execution.dumpCompletedAt));
      expect(
        Date.parse(artifact.execution.publicationStartedAt),
      ).toBeLessThanOrEqual(Date.now());
      const metadata = JSON.parse(
        await readFile(
          join(directory, `${artifact.filename}.meta.json`),
          'utf8',
        ),
      );
      expect(metadata.execution).toEqual(artifact.execution);
      await runJob(scratchUrl, 'restore', { filename: artifact.filename });
      expect(
        (
          await scratchPool.query(
            `SELECT note FROM public.${tableA} WHERE id=1`,
          )
        ).rows,
      ).toEqual([{ note: 'original-a' }]);
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
      // The public path now rejects the known dependency before spawning.
      // Still prove the same actual CLI transaction rolls back every selected
      // table if a catalog dependency appears after a successful preflight.
      await expect(
        processCommand(
          'pg_restore',
          restoreCommandArgs(
            scratchName,
            join(directory, artifact.filename),
            (
              await scratchPool.query('SELECT current_user AS role')
            ).rows[0].role,
          ),
          commandEnvironment(scratchUrl),
          {
            timeoutMs: 30000,
            maxBytes: 10_000_000,
            signal: new AbortController().signal,
            checkpoint: async () => undefined,
            onProgress: async () => undefined,
          },
        ),
      ).rejects.toThrow('BACKUP_COMMAND_FAILED');
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

      await scratchPool.query(
        `UPDATE public.${tableA} SET note = 'before-registry-failure'`,
      );
      const registryUnavailable = await runJob(
        scratchUrl,
        'restore',
        { filename: artifact.filename },
        { failCommitWrites: true },
      );
      expect(registryUnavailable.state.status).toBe('processing');
      expect(registryUnavailable.result).toMatchObject({
        operation: 'restore',
        targetDatabaseChanged: true,
        verification: 'unconfirmed',
      });
      expect(
        Buffer.byteLength(JSON.stringify(registryUnavailable.result)),
      ).toBeLessThan(1024);
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

    it.each([false, true])(
      'retains a full plain-PG isolated restore after registry failure: %s',
      async (failCommitWrites) => {
        const taskId = randomUUID();
        let checkedPublication = false;
        const created = await runJob(
          scratchUrl,
          'create',
          {},
          {
            taskId,
            onDigestCheckpoint: async () => {
              const names = (await readdir(directory)).filter((name) =>
                name.includes(taskId.slice(0, 8)),
              );
              expect(names.some((name) => name.endsWith('.dump.partial'))).toBe(
                true,
              );
              expect(names.some((name) => name.endsWith('.dump'))).toBe(false);
              checkedPublication = true;
            },
          },
        );
        expect(checkedPublication).toBe(true);
        const artifact = backupTaskResultDataSchema.parse(created.result);
        if (!artifact.filename) throw new Error('No full backup artifact');
        const metadata = JSON.parse(
          await readFile(
            join(directory, `${artifact.filename}.meta.json`),
            'utf8',
          ),
        );
        expect(metadata).toMatchObject({
          version: 3,
          scope: 'full',
          databaseSettings: { timeZone: 'Asia/Shanghai' },
        });
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
          const restored = await runJob(
            overriddenUrl.toString(),
            'restore',
            {
              filename: artifact.filename,
            },
            { failCommitWrites },
          );
          expect(restored.state.status).toBe(
            failCommitWrites ? 'processing' : 'completed',
          );
          expect(restored.result).toMatchObject({
            restoreMode: 'isolated',
            targetDatabaseChanged: false,
            verification: failCommitWrites ? 'unconfirmed' : 'confirmed',
          });
          restoredDatabase = (restored.result as { restoredDatabase?: string })
            .restoredDatabase;
          if (!restoredDatabase) throw new Error('No isolated database');
          const stagedUrl = new URL(scratchUrl);
          stagedUrl.pathname = `/${restoredDatabase}`;
          const stagedPool = createPgPool(stagedUrl.toString(), { max: 1 });
          try {
            expect(
              (
                await stagedPool.query(
                  "SELECT current_setting('TimeZone') AS timezone",
                )
              ).rows[0].timezone,
            ).toBe('Asia/Shanghai');
            const databaseSettingsSql =
              'SELECT encoding, datcollate, datctype, datlocprovider, daticulocale, daticurules FROM pg_database WHERE datname = current_database()';
            expect(
              (await stagedPool.query(databaseSettingsSql)).rows[0],
            ).toEqual((await scratchPool.query(databaseSettingsSql)).rows[0]);
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
            (await scratchPool.query(`SELECT note FROM public.${tableA}`))
              .rows[0].note,
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
            (await scratchPool.query(`SELECT note FROM public.${tableA}`))
              .rows[0].note,
          ).toBe('online-newer');
        } finally {
          if (restoredDatabase)
            await adminPool.query(
              `DROP DATABASE ${restoredDatabase} WITH (FORCE)`,
            );
          await scratchPool.query(`DROP TABLE IF EXISTS public.${blocker}`);
        }
      },
      120000,
    );

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
        await adminPool.query(
          `ALTER DATABASE ${sourceName} SET TimeZone TO 'Pacific/Auckland'`,
        );
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
          version: 4,
          execution: artifact.execution,
          archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          databaseSettings: { timeZone: 'Pacific/Auckland' },
          timescale: {
            hypertables: expect.arrayContaining([`public.${hypertable}`]),
            continuousAggregates: expect.arrayContaining([`public.${cagg}`]),
          },
        });
        expect(artifact.timeSource).toBe('dump-start');
        expect(artifact.createdAt).toBe(metadata.execution.dumpStartedAt);
        await timescalePool.query(`UPDATE public.${hypertable} SET value = 99`);
        // A genuine different recovery point has the same Timescale catalog.
        // Pairing its digest with this archive must stop before CREATE DATABASE.
        const newer = await runJob(timescaleUrl, 'create', {});
        const newerArtifact = backupTaskResultDataSchema.parse(newer.result);
        const newerMetadata = JSON.parse(
          await readFile(
            join(directory, `${newerArtifact.filename}.meta.json`),
            'utf8',
          ),
        );
        expect(newerMetadata.archiveSha256).not.toBe(metadata.archiveSha256);
        const mismatchedTaskId = randomUUID();
        const metadataPath = join(directory, `${artifact.filename}.meta.json`);
        await writeFile(
          metadataPath,
          JSON.stringify({
            ...metadata,
            archiveSha256: newerMetadata.archiveSha256,
          }),
        );
        try {
          await expect(
            runJob(
              timescaleUrl,
              'restore',
              { filename: artifact.filename },
              { taskId: mismatchedTaskId },
            ),
          ).rejects.toThrow('备份文件与元数据不匹配');
          expect(
            (
              await adminPool.query(
                'SELECT 1 FROM pg_database WHERE datname = $1',
                [stagingDatabaseName(mismatchedTaskId, 'primary')],
              )
            ).rows,
          ).toHaveLength(0);
          expect(
            (
              await timescalePool.query(
                `SELECT value FROM public.${hypertable}`,
              )
            ).rows[0].value,
          ).toBe(99);
        } finally {
          await writeFile(metadataPath, JSON.stringify(metadata));
        }
        const restored = await runJob(
          timescaleUrl,
          'restore',
          {
            filename: artifact.filename,
          },
          { failCommitWrites: true },
        );
        expect(restored.state.status).toBe('processing');
        const result = backupTaskResultDataSchema.parse(restored.result);
        expect(result).toMatchObject({
          restoreMode: 'isolated',
          targetDatabaseChanged: false,
          verification: 'unconfirmed',
        });
        if (!result.restoredDatabase)
          throw new Error('Missing isolated database');
        retained.push(result.restoredDatabase);
        const restoredUrl = new URL(timescaleUrl);
        restoredUrl.pathname = `/${result.restoredDatabase}`;
        const restoredPool = createPgPool(restoredUrl.toString(), { max: 1 });
        try {
          expect(
            (
              await restoredPool.query(
                "SELECT current_setting('TimeZone') AS timezone",
              )
            ).rows[0].timezone,
          ).toBe('Pacific/Auckland');
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
