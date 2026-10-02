import {
  BACKUP_ARTIFACT_METADATA_MAX_BYTES,
  type BackupJobData,
} from '@asin-monitor/contracts';
import {
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import type { Job } from 'bullmq';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  commandEnvironment,
  connectionForDatabase,
  createBackupProcessor,
  createStagingDatabaseSql,
  processCommand,
  readBackupArtifactMetadataFile,
  restoreCommandArgs,
  stagingDatabaseName,
  stagingDatabaseTimeZoneSql,
  timescaleExtensionCreateSql,
} from '../src/backup-processor';

const data: BackupJobData = {
  taskId: '10000000-0000-4000-8000-000000000161',
  taskType: 'backup',
  taskSubType: 'create',
  operation: 'create',
  target: 'primary',
  userId: 'backup-owner',
  createdAt: new Date(Date.now() - 1000).toISOString(),
  params: {},
};

function state(): TaskState {
  return {
    ...data,
    taskSubType: data.taskSubType,
    title: 'backup',
    status: 'pending',
    progress: 0,
    message: '',
    error: null,
    result: null,
    updatedAt: data.createdAt,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: new Date().toISOString(),
    cancelledAt: null,
    revision: 0,
  };
}

describe('backup processor', () => {
  it('honors a cancellation request before spawning pg_dump', async () => {
    let current: TaskState | null = state();
    const store = {
      read: vi.fn(async () => current),
      mutate: vi.fn(async (_id: string, change: TaskMutation) => {
        if (current) current = transitionTask(current, change, new Date());
        return current;
      }),
    };
    const processor = createBackupProcessor(store, {
      env: {
        DATABASE_URL: 'postgresql://localhost/primary',
        COMPETITOR_DATABASE_URL: 'postgresql://localhost/competitor',
        BACKUP_STORAGE_DIRECTORY: undefined,
        PG_DUMP_PATH: 'pg_dump',
        PG_RESTORE_PATH: 'pg_restore',
        BACKUP_COMMAND_TIMEOUT_MS: 1000,
        BACKUP_MAX_BYTES: 1024,
        TASK_META_TTL_SECONDS: 604800,
      } as never,
      shutdownSignal: new AbortController().signal,
      isClosing: () => false,
      assertJobLock: vi.fn(async () => undefined),
      updateProgress: vi.fn(async () => undefined),
    });
    const result = await processor(
      { id: data.taskId, name: 'create', data } as Job,
      'lock',
    );
    expect(result).toEqual({ cancelled: true, message: '备份任务已取消' });
    expect(current?.status).toBe('cancelled');
    expect(store.mutate).toHaveBeenCalled();
  });

  it('rejects a non-backup job payload before any task mutation', async () => {
    const store = { read: vi.fn(), mutate: vi.fn() };
    const processor = createBackupProcessor(store, {
      env: { TASK_META_TTL_SECONDS: 604800 } as never,
      shutdownSignal: new AbortController().signal,
      isClosing: () => false,
      assertJobLock: vi.fn(async () => undefined),
      updateProgress: vi.fn(async () => undefined),
    });
    await expect(
      processor(
        {
          id: data.taskId,
          name: 'create',
          data: { ...data, taskType: 'import' },
        } as Job,
        'lock',
      ),
    ).rejects.toThrow('备份任务数据无效');
    expect(store.mutate).not.toHaveBeenCalled();
  });
});

describe('backup command boundary', () => {
  const options = (signal: AbortSignal) => ({
    signal,
    timeoutMs: 2000,
    maxBytes: 1024,
    checkpoint: vi.fn(async () => undefined),
    onProgress: vi.fn(async () => undefined),
    pollIntervalMs: 20,
  });

  it('settles immediately for a signal aborted before spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      processCommand(
        process.execPath,
        ['-e', ''],
        {},
        options(controller.signal),
      ),
    ).rejects.toThrow('BACKUP_COMMAND_CANCELLED');
  });

  it('waits for a cancelled child to close', async () => {
    const controller = new AbortController();
    const running = processCommand(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1000)'],
      { ...process.env },
      options(controller.signal),
    );
    setTimeout(() => controller.abort(), 100);
    await expect(running).rejects.toThrow('BACKUP_COMMAND_CANCELLED');
  });

  it('recognizes a zero pg_restore exit despite a late progress failure', async () => {
    const run = () =>
      processCommand(
        process.execPath,
        ['-e', 'process.exit(0)'],
        { ...process.env },
        {
          ...options(new AbortController().signal),
          timeoutMs: 3000,
          pollIntervalMs: 5,
          checkpoint: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            throw new Error('progress store unavailable');
          },
          zeroExitIsCommitted: true,
        },
      );
    await expect(run()).resolves.toBeUndefined();
  });

  it('terminates on oversized output instead of waiting for command timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-command-'));
    try {
      const output = join(directory, 'artifact.partial');
      await writeFile(output, Buffer.alloc(2048));
      await expect(
        processCommand(
          process.execPath,
          [
            '-e',
            'setInterval(() => undefined, 1000)',
            '--',
            `--file=${output}`,
          ],
          { ...process.env },
          { ...options(new AbortController().signal), maxBytes: 1024 },
        ),
      ).rejects.toThrow('BACKUP_MAX_BYTES_EXCEEDED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads large valid Timescale metadata but rejects a file past the bound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-command-'));
    try {
      const path = join(directory, 'artifact.meta.json');
      const metadata = {
        version: 2,
        filename: 'backup_20260927-020000-abcdef01-primary.dump',
        target: 'primary',
        sourceEngine: 'timescaledb',
        timescale: {
          extensionVersion: '2.22.0',
          hypertables: Array.from(
            { length: 100 },
            (_, index) => `public.table_${index}_${'x'.repeat(80)}`,
          ),
          continuousAggregates: [],
        },
        databaseSettings: {
          encoding: 'UTF8',
          lcCollate: 'C',
          lcCtype: 'C',
          localeProvider: 'libc',
        },
      };
      const serialized = JSON.stringify(metadata);
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(4096);
      await writeFile(path, serialized);
      expect(await readBackupArtifactMetadataFile(path)).toEqual(metadata);
      await truncate(path, BACKUP_ARTIFACT_METADATA_MAX_BYTES + 1);
      await expect(readBackupArtifactMetadataFile(path)).rejects.toThrow(
        'BACKUP_METADATA_INVALID',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the same PG defaults as node-postgres before isolating libpq', () => {
    const env = commandEnvironment(
      'postgresql://backup-user:backup-pass@[::1]:5433/main?sslmode=require',
    );
    expect(env).toMatchObject({
      PGHOST: '::1',
      PGPORT: '5433',
      PGUSER: 'backup-user',
      PGPASSWORD: 'backup-pass',
      PGDATABASE: 'main',
      PGSSLMODE: 'require',
    });
    const defaults = {
      PGHOST: 'db.internal',
      PGPORT: '5544',
      PGUSER: 'app_user',
      PGPASSWORD: 'app_secret',
      PGDATABASE: 'app_db',
      PGSSLMODE: 'verify-full',
      PGHOSTADDR: 'wrong-host',
      PGSERVICE: 'wrong-service',
    };
    const inherited = commandEnvironment('postgresql:///', defaults);
    expect(inherited).toMatchObject({
      PGHOST: 'db.internal',
      PGPORT: '5544',
      PGUSER: 'app_user',
      PGPASSWORD: 'app_secret',
      PGDATABASE: 'app_db',
      PGSSLMODE: 'verify-full',
    });
    expect(inherited.PGHOSTADDR).toBeUndefined();
    expect(inherited.PGSERVICE).toBeUndefined();
    const customPassfile = commandEnvironment(
      'postgresql://app@localhost/main',
      {
        PGPASSFILE: '/run/secrets/postgres.pgpass',
        PGSERVICE: 'wrong-service',
      },
    );
    expect(customPassfile.PGPASSFILE).toBe('/run/secrets/postgres.pgpass');
    expect(customPassfile.PGPASSWORD).toBeUndefined();
    expect(customPassfile.PGSERVICE).toBeUndefined();
    expect(
      commandEnvironment('postgresql://app:explicit@localhost/main', {
        PGPASSFILE: '/run/secrets/postgres.pgpass',
      }).PGPASSFILE,
    ).toBeUndefined();
    expect(() =>
      commandEnvironment('postgresql://app@localhost/main', {
        PGPASSFILE: 'invalid\npath',
      }),
    ).toThrow('BACKUP_DATABASE_URL_INVALID');
    const override = commandEnvironment(
      'postgresql://explicit:pass@localhost/main?host=query-host&port=6001',
      defaults,
    );
    expect(override).toMatchObject({
      PGHOST: 'query-host',
      PGPORT: '6001',
      PGUSER: 'explicit',
      PGPASSWORD: 'pass',
      PGDATABASE: 'main',
    });
  });

  it('passes the database name to pg_restore without putting credentials in argv', () => {
    const environment = commandEnvironment(
      'postgresql://restore_user:private_password@localhost/backup_ci',
    );
    const args = restoreCommandArgs(environment.PGDATABASE!, '/tmp/test.dump');
    expect(args).toContain('--dbname=backup_ci');
    expect(args).toContain('--single-transaction');
    expect(args.join(' ')).not.toContain('private_password');
  });

  it.each([
    ['postgresql://backup@localhost/main?database=competitor', 'main'],
    ['postgresql://backup@localhost/competitor?database=main', 'competitor'],
    [
      'postgresql://backup@localhost/finance%2F2026?database=other',
      'finance%2F2026',
    ],
    [
      'postgresql://backup@localhost/%E6%95%B0%E6%8D%AE%20%E5%BA%93?database=other',
      '数据 库',
    ],
  ])(
    'uses the application driver target for CLI database %s',
    (connectionString, expected) => {
      // Construct the actual driver used by the application's db package without
      // opening a connection. Do not duplicate its URL parsing rules in a fixture.
      const { Client } = createRequire(
        join(__dirname, '../../../packages/db/package.json'),
      )('pg') as {
        Client: new (config: { connectionString: string }) => {
          connectionParameters: { database: string };
        };
      };
      const client = new Client({ connectionString });
      const environment = commandEnvironment(connectionString, {
        PGDATABASE: 'fallback_database',
      });
      expect(client.connectionParameters.database).toBe(expected);
      expect(environment.PGDATABASE).toBe(client.connectionParameters.database);
      expect(
        restoreCommandArgs(environment.PGDATABASE!, '/tmp/test.dump'),
      ).toContain(`--dbname=${expected}`);
    },
  );

  it('ignores a query-only database exactly as the application driver does', () => {
    expect(
      commandEnvironment('postgresql://backup@localhost/?database=other', {
        PGDATABASE: 'fallback_database',
      }).PGDATABASE,
    ).toBe('fallback_database');
    expect(
      commandEnvironment('postgresql://backup@localhost/?database=other', {})
        .PGDATABASE,
    ).toBe('backup');
  });

  it('derives a bounded isolated database name from a validated task ID and target', () => {
    expect(stagingDatabaseName(data.taskId, 'primary')).toBe(
      'neo_restore_primary_1000000000004000',
    );
    expect(stagingDatabaseName(data.taskId, 'competitor')).toBe(
      'neo_restore_competitor_1000000000004000',
    );
    expect(() =>
      stagingDatabaseName('bad; DROP DATABASE postgres', 'primary'),
    ).toThrow('BACKUP_TASK_IDENTITY_INVALID');
  });
  it('removes query-level database overrides from staging connections', () => {
    const staging = connectionForDatabase(
      'postgresql://backup@localhost/online?database=production&sslmode=require',
      'neo_restore_primary_1000000000004000',
    );
    expect(new URL(staging).searchParams.has('database')).toBe(false);
    expect(commandEnvironment(staging).PGDATABASE).toBe(
      'neo_restore_primary_1000000000004000',
    );
    expect(new URL(staging).searchParams.get('sslmode')).toBe('require');
  });
  it('installs the archived TimescaleDB version without SQL injection', () => {
    expect(timescaleExtensionCreateSql('2.22.0')).toBe(
      "CREATE EXTENSION timescaledb VERSION '2.22.0'",
    );
    expect(() =>
      timescaleExtensionCreateSql("2.22.0'; DROP DATABASE online; --"),
    ).toThrow('BACKUP_TIMESCALE_VERSION_INVALID');
  });
  it('creates staging with archived libc and ICU text settings using escaped literals', () => {
    const name = 'neo_restore_primary_1000000000004000';
    expect(
      createStagingDatabaseSql(name, {
        encoding: 'UTF8',
        lcCollate: 'C.UTF-8',
        lcCtype: 'C.UTF-8',
        localeProvider: 'libc',
      }),
    ).toBe(
      `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING E'UTF8' LC_COLLATE E'C.UTF-8' LC_CTYPE E'C.UTF-8' LOCALE_PROVIDER libc`,
    );
    expect(
      createStagingDatabaseSql(name, {
        encoding: 'UTF8',
        lcCollate: 'C',
        lcCtype: 'C',
        localeProvider: 'icu',
        icuLocale: "en-US@collation=standard'\\safe",
        icuRules: '&a < b',
      }),
    ).toContain("ICU_LOCALE E'en-US@collation=standard\\'\\\\safe'");
    expect(
      createStagingDatabaseSql(name, {
        encoding: 'UTF8',
        lcCollate: 'C',
        lcCtype: 'C',
        localeProvider: 'icu',
        icuLocale: 'en-US',
        icuRules: '&a < b',
      }),
    ).toContain("ICU_RULES E'&a < b'");
    expect(() =>
      createStagingDatabaseSql(name, {
        encoding: 'UTF8',
        lcCollate: 'C\nDROP DATABASE online',
        lcCtype: 'C',
        localeProvider: 'libc',
      }),
    ).toThrow();
  });
  it('restores source timezone and uses the D8 fallback for old sidecars', () => {
    const name = 'neo_restore_primary_1000000000004000';
    const settings = {
      encoding: 'UTF8',
      lcCollate: 'C',
      lcCtype: 'C',
      localeProvider: 'libc' as const,
    };
    expect(stagingDatabaseTimeZoneSql(name, settings)).toBe(
      `ALTER DATABASE "${name}" SET TimeZone TO E'Asia/Shanghai'`,
    );
    expect(
      stagingDatabaseTimeZoneSql(name, {
        ...settings,
        timeZone: 'Pacific/Auckland',
      }),
    ).toContain("TO E'Pacific/Auckland'");
    expect(
      stagingDatabaseTimeZoneSql(name, {
        ...settings,
        timeZone: "UTC'; DROP DATABASE online; --",
      }),
    ).toContain("E'UTC\\'; DROP DATABASE online; --'");
    expect(() =>
      stagingDatabaseTimeZoneSql(name, {
        ...settings,
        timeZone: 'UTC\nprivate',
      }),
    ).toThrow();
  });
});
