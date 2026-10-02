import {
  BACKUP_COMMAND_PATH_MAX_LENGTH,
  getBackupStorageDirectory,
  type Env,
} from '@asin-monitor/config';
import {
  BACKUP_ARTIFACT_METADATA_MAX_BYTES,
  backupArtifactMetadataSchema,
  backupCreationFilename,
  backupDatabaseSettingsSchema,
  backupFilenameCreatedAt,
  backupJobDataSchema,
  backupTimescaleManifestSchema,
  sameBackupDatabaseLocale,
  type BackupArtifactMetadata,
  type BackupCreationReceipt,
  type BackupDatabaseSettings,
  type BackupJobData,
  type BackupRestoreReceipt,
  type BackupTimescaleManifest,
} from '@asin-monitor/contracts';
import {
  backupCreationIdentity,
  createPgPool,
  isTerminalTaskStatus,
  RedisTaskRepository,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { logger } from './logger';

export interface BackupProcessorOptions {
  env: Env;
  shutdownSignal: AbortSignal;
  isClosing(): boolean;
  assertJobLock(job: Job, token: string | undefined): Promise<void>;
  updateProgress(job: Job, progress: number): Promise<void>;
}

class TaskStopped extends Error {
  constructor(readonly state: TaskState) {
    super('Backup task already stopped');
  }
}

class BackupCommandError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const cancelledResult = { cancelled: true, message: '备份任务已取消' };
const cleanupErrorCodes = new Set([
  'EACCES',
  'EPERM',
  'EIO',
  'EROFS',
  'ENOSPC',
  'EBUSY',
  'ETXTBSY',
  'EMFILE',
  'ENFILE',
  'ENODEV',
  'ESTALE',
]);
const identityFields = (data: BackupJobData) => ({
  userId: data.userId,
  taskType: data.taskType,
  taskSubType: data.taskSubType,
  createdAt: data.createdAt,
});

function targetUrl(env: Env, target: BackupJobData['target']): string {
  return target === 'primary' ? env.DATABASE_URL : env.COMPETITOR_DATABASE_URL;
}

export function commandEnvironment(
  connectionString: string,
  defaults: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  // node-postgres resolves each missing URL field from PG* before its own
  // defaults. Resolve the same values before clearing libpq's inherited PG*.
  const parameter = (name: string, fromUrl?: string, fallback?: string) =>
    url.searchParams.get(name) || fromUrl || fallback || undefined;
  const user = parameter(
    'user',
    decodeURIComponent(url.username),
    defaults.PGUSER ||
      (process.platform === 'win32' ? defaults.USERNAME : defaults.USER),
  );
  const database = parameter(
    'database',
    decodeURIComponent(url.pathname.replace(/^\//, '')),
    defaults.PGDATABASE || user,
  );
  const host = parameter('host', url.hostname, defaults.PGHOST || 'localhost');
  const port = parameter('port', url.port, defaults.PGPORT || '5432');
  const password = parameter(
    'password',
    decodeURIComponent(url.password),
    defaults.PGPASSWORD,
  );
  const passfile = !password ? defaults.PGPASSFILE : undefined;
  if (passfile && (passfile.length > 1024 || /[\0\r\n]/.test(passfile)))
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  if (
    !database ||
    !host ||
    !user ||
    !port ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65_535
  )
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  const sslMode = url.searchParams.get('sslmode') || defaults.PGSSLMODE;
  if (
    sslMode &&
    ![
      'disable',
      'allow',
      'prefer',
      'require',
      'verify-ca',
      'verify-full',
    ].includes(sslMode)
  )
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  // Drop unrelated libpq controls (PGSERVICE, PGHOSTADDR, PGOPTIONS, etc.).
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('PG'),
    ),
  );
  return {
    ...inherited,
    PGHOST: host.replace(/^\[|\]$/g, ''),
    PGPORT: port,
    PGUSER: user,
    ...(password ? { PGPASSWORD: password } : {}),
    ...(passfile ? { PGPASSFILE: passfile } : {}),
    PGDATABASE: database,
    ...(sslMode ? { PGSSLMODE: sslMode } : {}),
    ...(url.searchParams.has('sslrootcert')
      ? { PGSSLROOTCERT: url.searchParams.get('sslrootcert')! }
      : {}),
    ...(url.searchParams.has('sslcert')
      ? { PGSSLCERT: url.searchParams.get('sslcert')! }
      : {}),
    ...(url.searchParams.has('sslkey')
      ? { PGSSLKEY: url.searchParams.get('sslkey')! }
      : {}),
  };
}

function commandPath(value: string | undefined, fallback: string): string {
  const path = value?.trim() || fallback;
  if (path.includes('\0') || path.length > BACKUP_COMMAND_PATH_MAX_LENGTH)
    throw new BackupCommandError('BACKUP_COMMAND_INVALID');
  return path;
}

function validTable(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(value);
}

export function stagingDatabaseName(
  taskId: string,
  target: BackupJobData['target'],
): string {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      taskId,
    )
  )
    throw new BackupCommandError('BACKUP_TASK_IDENTITY_INVALID');
  return `neo_restore_${target}_${taskId
    .replaceAll('-', '')
    .slice(0, 16)
    .toLowerCase()}`;
}

function quoteStagingDatabase(name: string): string {
  if (!/^neo_restore_(?:primary|competitor)_[a-f0-9]{16}$/.test(name))
    throw new BackupCommandError('BACKUP_RESTORE_DATABASE_INVALID');
  return `"${name}"`;
}

function quoteSqlLiteral(value: string): string {
  return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export function createStagingDatabaseSql(
  name: string,
  settings: BackupDatabaseSettings,
): string {
  const parsed = backupDatabaseSettingsSchema.parse(settings);
  return (
    `CREATE DATABASE ${quoteStagingDatabase(name)} TEMPLATE template0` +
    ` ENCODING ${quoteSqlLiteral(parsed.encoding)}` +
    ` LC_COLLATE ${quoteSqlLiteral(parsed.lcCollate)}` +
    ` LC_CTYPE ${quoteSqlLiteral(parsed.lcCtype)}` +
    ` LOCALE_PROVIDER ${parsed.localeProvider}` +
    (parsed.localeProvider === 'icu'
      ? ` ICU_LOCALE ${quoteSqlLiteral(parsed.icuLocale)}` +
        (parsed.icuRules
          ? ` ICU_RULES ${quoteSqlLiteral(parsed.icuRules)}`
          : '')
      : '')
  );
}

/** Older artifacts predate this field; D8 requires Shanghai wall-clock defaults. */
export function stagingDatabaseTimeZoneSql(
  name: string,
  settings: BackupDatabaseSettings,
): string {
  const parsed = backupDatabaseSettingsSchema.parse(settings);
  return `ALTER DATABASE ${quoteStagingDatabase(
    name,
  )} SET TimeZone TO ${quoteSqlLiteral(parsed.timeZone ?? 'Asia/Shanghai')}`;
}

// Read the database setting rather than a role/session override. A source
// without a database override uses its effective session timezone.
const databaseTimeZoneSql =
  "SELECT split_part(setting, '=', 2) AS timezone FROM pg_db_role_setting CROSS JOIN LATERAL unnest(setconfig) AS setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setrole = 0 AND lower(split_part(setting, '=', 1)) = 'timezone'";

async function verifyStagingTimeZone(
  pool: ReturnType<typeof createPgPool>,
  settings: BackupDatabaseSettings,
): Promise<void> {
  const result = await pool.query(databaseTimeZoneSql);
  if (result.rows[0]?.timezone !== (settings.timeZone ?? 'Asia/Shanghai'))
    throw new BackupCommandError('BACKUP_RESTORE_TIMEZONE_MISMATCH');
}

async function archiveSha256(
  path: string,
  checkpoint: () => Promise<void>,
  maxBytes: number,
): Promise<string> {
  const hash = createHash('sha256');
  let bytesSinceCheckpoint = 0;
  let bytes = 0;
  await checkpoint();
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes)
      throw new BackupCommandError('BACKUP_ARTIFACT_INVALID');
    hash.update(chunk);
    bytesSinceCheckpoint += chunk.length;
    if (bytesSinceCheckpoint >= 8 * 1024 * 1024) {
      await checkpoint();
      bytesSinceCheckpoint = 0;
    }
  }
  await checkpoint();
  return hash.digest('hex');
}

export function connectionForDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  // node-postgres gives the query-level database option precedence over the
  // path. Keeping it would reconnect staging work to the online database.
  parsed.searchParams.delete('database');
  parsed.searchParams.delete('dbname');
  return parsed.toString();
}

export function timescaleExtensionCreateSql(version: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version))
    throw new BackupCommandError('BACKUP_TIMESCALE_VERSION_INVALID');
  return `CREATE EXTENSION timescaledb VERSION '${version}'`;
}

async function readTimescaleManifest(client: {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<BackupTimescaleManifest> {
  const version = await client.query(
    "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'",
  );
  const hypertables = await client.query(
    "SELECT hypertable_schema || '.' || hypertable_name AS relation FROM timescaledb_information.hypertables ORDER BY 1",
  );
  const continuousAggregates = await client.query(
    "SELECT view_schema || '.' || view_name AS relation FROM timescaledb_information.continuous_aggregates ORDER BY 1",
  );
  return backupTimescaleManifestSchema.parse({
    extensionVersion: version.rows[0]?.extversion,
    hypertables: hypertables.rows.map((row) => row.relation),
    continuousAggregates: continuousAggregates.rows.map((row) => row.relation),
  });
}

function sameTimescaleManifest(
  left: BackupTimescaleManifest,
  right: BackupTimescaleManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function restoreCommandArgs(database: string, input: string): string[] {
  if (!database || database.includes('\0'))
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  return [
    '--exit-on-error',
    '--single-transaction',
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-acl',
    `--dbname=${database}`,
    input,
  ];
}

export function processCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  options: {
    timeoutMs: number;
    maxBytes: number;
    signal: AbortSignal;
    checkpoint: () => Promise<void>;
    onProgress: (bytes: number) => Promise<void>;
    pollIntervalMs?: number;
    /** A zero pg_restore exit means its single transaction committed. */
    zeroExitIsCommitted?: boolean;
  },
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let polling = false;
    let stopError: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poller: ReturnType<typeof setInterval> | undefined;
    let pollingTask: Promise<void> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      options.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise();
    };
    const stop = (error: Error) => {
      stopError ??= error;
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      child.kill('SIGTERM');
      const force = setTimeout(() => {
        if (child && child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }, 2000);
      force.unref();
    };
    const abort = () => {
      stop(new BackupCommandError('BACKUP_COMMAND_CANCELLED'));
    };
    if (options.signal.aborted) {
      finish(new BackupCommandError('BACKUP_COMMAND_CANCELLED'));
      return;
    }
    try {
      child = spawn(command, args, {
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      finish(new BackupCommandError('BACKUP_COMMAND_START_FAILED'));
      return;
    }
    // Drain stderr without persisting command output, which may contain PII.
    child.stderr?.resume();
    child.once('error', () => {
      stopError ??= new BackupCommandError('BACKUP_COMMAND_FAILED');
    });
    // close follows exit and waits for stdio to close. Never release the caller
    // to delete an incomplete dump while the child can still write to it.
    child.once('close', (code, signal) => {
      if (poller) clearInterval(poller);
      void (async () => {
        await pollingTask;
        if (settled) return;
        if (options.zeroExitIsCommitted && code === 0 && !signal) finish();
        else if (stopError) finish(stopError);
        else if (code === 0) finish();
        else
          finish(
            new BackupCommandError(
              signal ? 'BACKUP_COMMAND_SIGNALLED' : 'BACKUP_COMMAND_FAILED',
            ),
          );
      })();
    });
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    timer = setTimeout(() => {
      stop(new BackupCommandError('BACKUP_COMMAND_TIMEOUT'));
    }, options.timeoutMs);
    timer.unref();
    poller = setInterval(() => {
      if (polling || stopError || settled) return;
      polling = true;
      pollingTask = (async () => {
        try {
          await options.checkpoint();
          const output = args
            .find((value) => value.startsWith('--file='))
            ?.slice(7);
          if (!output) return;
          let bytes: number;
          try {
            bytes = (await stat(output)).size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
          }
          if (bytes > options.maxBytes) {
            stop(new BackupCommandError('BACKUP_MAX_BYTES_EXCEEDED'));
            return;
          }
          await options.onProgress(bytes);
        } catch (error) {
          stop(
            error instanceof Error ? error : new Error('BACKUP_POLL_FAILED'),
          );
        } finally {
          polling = false;
        }
      })();
    }, options.pollIntervalMs ?? 500);
    poller.unref();
  });
}

async function healthCheck(env: Env, target: BackupJobData['target']) {
  const pool = createPgPool(targetUrl(env, target), {
    max: 1,
    connectionTimeoutMillis: Math.min(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      2000,
    ),
    statement_timeout: 2000,
  });
  try {
    const expected = commandEnvironment(targetUrl(env, target)).PGDATABASE;
    const result = await pool.query('SELECT current_database() AS database');
    if (!expected || result.rows[0]?.database !== expected)
      throw new BackupCommandError('BACKUP_TARGET_MISMATCH');
  } finally {
    await pool.end();
  }
}

/** Session-level advisory lock shared by every worker for one backup target. */
export async function acquireBackupTargetLock(
  env: Env,
  target: BackupJobData['target'],
) {
  const advisoryKey = target === 'primary' ? 161 : 162;
  const pool = createPgPool(targetUrl(env, target), {
    max: 1,
    connectionTimeoutMillis: Math.min(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      2000,
    ),
    statement_timeout: 30000,
  });
  try {
    const client = await pool.connect();
    try {
      const acquired = await client.query(
        'SELECT pg_try_advisory_lock(1313165122, $1) AS acquired',
        [advisoryKey],
      );
      if (acquired.rows[0]?.acquired !== true)
        throw new BackupCommandError('BACKUP_TARGET_BUSY');
      const extension = await client.query(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS enabled",
      );
      const lockedClient = client;
      let released = false;
      return {
        hasTimescale: extension.rows[0]?.enabled === true,
        async ensureHeld() {
          if (released) throw new BackupCommandError('BACKUP_TARGET_LOCK_LOST');
          await lockedClient.query('SELECT 1');
        },
        async readTimescaleManifest() {
          if (released || extension.rows[0]?.enabled !== true)
            throw new BackupCommandError('BACKUP_TIMESCALE_REQUIRED');
          return readTimescaleManifest(lockedClient);
        },
        async readDatabaseSettings(): Promise<BackupDatabaseSettings> {
          const result = await lockedClient.query(
            'SELECT pg_encoding_to_char(encoding) AS encoding, datcollate AS "lcCollate", datctype AS "lcCtype", datlocprovider AS "localeProvider", daticulocale AS "icuLocale", daticurules AS "icuRules" FROM pg_database WHERE datname = current_database()',
          );
          const row = result.rows[0];
          const timeZone = await lockedClient.query(databaseTimeZoneSql);
          const effectiveTimeZone =
            timeZone.rows[0]?.timezone ??
            (
              await lockedClient.query(
                "SELECT current_setting('TimeZone') AS timezone",
              )
            ).rows[0]?.timezone;
          const settings = backupDatabaseSettingsSchema.safeParse(
            row?.localeProvider === 'i'
              ? {
                  encoding: row.encoding,
                  lcCollate: row.lcCollate,
                  lcCtype: row.lcCtype,
                  timeZone: effectiveTimeZone,
                  localeProvider: 'icu',
                  icuLocale: row.icuLocale,
                  ...(row.icuRules ? { icuRules: row.icuRules } : {}),
                }
              : row?.localeProvider === 'c'
              ? {
                  encoding: row.encoding,
                  lcCollate: row.lcCollate,
                  lcCtype: row.lcCtype,
                  timeZone: effectiveTimeZone,
                  localeProvider: 'libc',
                }
              : null,
          );
          if (!settings.success)
            throw new BackupCommandError('BACKUP_SOURCE_LOCALE_UNSUPPORTED');
          return settings.data;
        },
        async stagingDatabaseExists(name: string) {
          quoteStagingDatabase(name);
          const result = await lockedClient.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [name],
          );
          return result.rows.length > 0;
        },
        async createStagingDatabase(
          name: string,
          settings: BackupDatabaseSettings,
        ) {
          await lockedClient.query(createStagingDatabaseSql(name, settings));
        },
        async ownsStagingDatabase(name: string) {
          quoteStagingDatabase(name);
          const result = await lockedClient.query(
            'SELECT pg_get_userbyid(datdba) = current_user AS owned FROM pg_database WHERE datname = $1',
            [name],
          );
          return result.rows.length === 1 && result.rows[0]?.owned === true;
        },
        async restrictStagingDatabase(name: string) {
          await lockedClient.query(
            `REVOKE CONNECT ON DATABASE ${quoteStagingDatabase(
              name,
            )} FROM PUBLIC`,
          );
        },
        async setStagingTimeZone(
          name: string,
          settings: BackupDatabaseSettings,
        ) {
          await lockedClient.query(stagingDatabaseTimeZoneSql(name, settings));
        },
        async dropStagingDatabase(name: string) {
          await lockedClient.query(
            `DROP DATABASE ${quoteStagingDatabase(name)} WITH (FORCE)`,
          );
        },
        async release() {
          if (released) return;
          released = true;
          try {
            await lockedClient.query(
              'SELECT pg_advisory_unlock(1313165122, $1)',
              [advisoryKey],
            );
          } finally {
            lockedClient.release();
            await pool.end();
          }
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function assertCustomDump(path: string, maxBytes: number) {
  const details = await lstat(path);
  if (!details.isFile() || details.size < 5 || details.size > maxBytes)
    throw new BackupCommandError('BACKUP_ARTIFACT_INVALID');
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 5 || header.toString('ascii') !== 'PGDMP')
      throw new BackupCommandError('BACKUP_ARTIFACT_INVALID');
  } finally {
    await file.close();
  }
  return details;
}

async function restorePostgresqlIsolated(input: {
  databaseUrl: string;
  directoryFile: string;
  taskId: string;
  target: BackupJobData['target'];
  databaseSettings: BackupDatabaseSettings;
  lock: Awaited<ReturnType<typeof acquireBackupTargetLock>>;
  env: Env;
  signal: AbortSignal;
  checkpoint(): Promise<void>;
  progress(value: number, message: string): Promise<void>;
}): Promise<string> {
  const database = stagingDatabaseName(input.taskId, input.target);
  const databaseUrl = connectionForDatabase(input.databaseUrl, database);
  const commandEnv = commandEnvironment(databaseUrl);
  let created = false;
  let keep = false;
  let error: unknown;
  let cleanupFailed = false;
  try {
    await input.checkpoint();
    if (await input.lock.stagingDatabaseExists(database))
      throw new BackupCommandError('BACKUP_RESTORE_DATABASE_EXISTS');
    try {
      // TEMPLATE template0 is enforced by createStagingDatabase(), so objects
      // added to the online target after the backup cannot survive restore.
      await input.lock.createStagingDatabase(database, input.databaseSettings);
    } catch {
      throw new BackupCommandError('BACKUP_RESTORE_CREATE_UNCONFIRMED');
    }
    created = true;
    if (!(await input.lock.ownsStagingDatabase(database)))
      throw new BackupCommandError('BACKUP_RESTORE_DATABASE_OWNER_MISMATCH');
    await input.lock.restrictStagingDatabase(database);
    await input.lock.setStagingTimeZone(database, input.databaseSettings);
    await input.checkpoint();
    await input.progress(50, '正在恢复到隔离 PostgreSQL 数据库');
    await processCommand(
      commandPath(input.env.PG_RESTORE_PATH, 'pg_restore'),
      [
        '--format=custom',
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-acl',
        `--dbname=${database}`,
        input.directoryFile,
      ],
      commandEnv,
      {
        timeoutMs: input.env.BACKUP_COMMAND_TIMEOUT_MS,
        maxBytes: input.env.BACKUP_MAX_BYTES,
        signal: input.signal,
        checkpoint: input.checkpoint,
        onProgress: async () => undefined,
      },
    );
    const pool = createPgPool(databaseUrl, {
      max: 1,
      connectionTimeoutMillis: Math.min(
        input.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
        5000,
      ),
      statement_timeout: 5000,
    });
    try {
      const current = await pool.query('SELECT current_database() AS database');
      if (current.rows[0]?.database !== database)
        throw new BackupCommandError('BACKUP_TARGET_MISMATCH');
      await verifyStagingTimeZone(pool, input.databaseSettings);
    } finally {
      await pool.end();
    }
    await input.checkpoint();
    await input.progress(
      100,
      '隔离 PostgreSQL 数据库恢复完成，在线目标库未切换',
    );
    keep = true;
  } catch (caught) {
    error = caught;
  } finally {
    if (created && !keep) {
      try {
        await input.lock.dropStagingDatabase(database);
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed)
    throw new BackupCommandError('BACKUP_RESTORE_CLEANUP_FAILED');
  if (error) throw error;
  return database;
}

async function restoreTimescaleIsolated(input: {
  databaseUrl: string;
  directoryFile: string;
  taskId: string;
  target: BackupJobData['target'];
  manifest: BackupTimescaleManifest;
  databaseSettings: BackupDatabaseSettings;
  lock: Awaited<ReturnType<typeof acquireBackupTargetLock>>;
  env: Env;
  signal: AbortSignal;
  checkpoint(): Promise<void>;
  progress(value: number, message: string): Promise<void>;
}): Promise<string> {
  const database = stagingDatabaseName(input.taskId, input.target);
  const databaseUrl = connectionForDatabase(input.databaseUrl, database);
  const commandEnv = commandEnvironment(databaseUrl);
  const openPool = () =>
    createPgPool(databaseUrl, {
      max: 1,
      connectionTimeoutMillis: Math.min(
        input.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
        5000,
      ),
      statement_timeout: 60000,
    });
  let pool: ReturnType<typeof createPgPool> | undefined;
  let created = false;
  let preRestore = false;
  let keep = false;
  let error: unknown;
  let cleanupFailed = false;
  try {
    await input.checkpoint();
    if (await input.lock.stagingDatabaseExists(database))
      throw new BackupCommandError('BACKUP_RESTORE_DATABASE_EXISTS');
    try {
      await input.lock.createStagingDatabase(database, input.databaseSettings);
    } catch {
      // A lost acknowledgement can leave a newly-created database behind.
      // Never drop it without a confirmed CREATE result.
      throw new BackupCommandError('BACKUP_RESTORE_CREATE_UNCONFIRMED');
    }
    created = true;
    if (!(await input.lock.ownsStagingDatabase(database)))
      throw new BackupCommandError('BACKUP_RESTORE_DATABASE_OWNER_MISMATCH');
    await input.lock.restrictStagingDatabase(database);
    await input.lock.setStagingTimeZone(database, input.databaseSettings);
    pool = openPool();
    await pool.query(
      timescaleExtensionCreateSql(input.manifest.extensionVersion),
    );
    const installed = await readTimescaleManifest(pool);
    if (installed.extensionVersion !== input.manifest.extensionVersion)
      throw new BackupCommandError('BACKUP_TIMESCALE_VERSION_MISMATCH');
    await input.checkpoint();
    await pool.query('SELECT timescaledb_pre_restore()');
    preRestore = true;
    // The restore subprocess uses a new connection. Verify that the database
    // setting is visible beyond the session that ran pre_restore().
    await pool.end();
    pool = openPool();
    const restoring = await pool.query(
      "SELECT current_setting('timescaledb.restoring', true) AS enabled",
    );
    if (restoring.rows[0]?.enabled !== 'on')
      throw new BackupCommandError('BACKUP_TIMESCALE_PRE_RESTORE_FAILED');
    await input.checkpoint();
    await input.progress(50, '正在恢复到隔离 TimescaleDB 数据库');
    await processCommand(
      commandPath(input.env.PG_RESTORE_PATH, 'pg_restore'),
      [
        '--format=custom',
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        `--dbname=${database}`,
        input.directoryFile,
      ],
      commandEnv,
      {
        timeoutMs: input.env.BACKUP_COMMAND_TIMEOUT_MS,
        maxBytes: input.env.BACKUP_MAX_BYTES,
        signal: input.signal,
        checkpoint: input.checkpoint,
        onProgress: async () => undefined,
      },
    );
    await input.checkpoint();
    // Keep the restored database quiescent for operator review. Commit the
    // transition out of restore mode and job suspension atomically, so no
    // retention/columnstore/refresh policy can run between the two steps.
    const finishClient = await pool.connect();
    try {
      await finishClient.query('BEGIN');
      await finishClient.query('SELECT timescaledb_post_restore()');
      await finishClient.query(
        'SELECT public.alter_job(id::integer, scheduled => false) FROM _timescaledb_config.bgw_job WHERE id >= 1000',
      );
      await finishClient.query('COMMIT');
    } catch (finishError) {
      try {
        await finishClient.query('ROLLBACK');
      } catch {
        // The staging database is deleted on every failure path below.
      }
      throw finishError;
    } finally {
      finishClient.release();
    }
    preRestore = false;
    await pool.end();
    pool = openPool();
    const normal = await pool.query(
      "SELECT current_setting('timescaledb.restoring', true) AS enabled",
    );
    if (normal.rows[0]?.enabled === 'on')
      throw new BackupCommandError('BACKUP_TIMESCALE_POST_RESTORE_FAILED');
    const scheduledJobs = await pool.query(
      'SELECT id FROM _timescaledb_config.bgw_job WHERE id >= 1000 AND scheduled IS DISTINCT FROM false LIMIT 1',
    );
    if (scheduledJobs.rows.length > 0)
      throw new BackupCommandError('BACKUP_TIMESCALE_JOBS_ACTIVE');
    const restored = await readTimescaleManifest(pool);
    if (!sameTimescaleManifest(input.manifest, restored))
      throw new BackupCommandError('BACKUP_TIMESCALE_CATALOG_MISMATCH');
    await verifyStagingTimeZone(pool, input.databaseSettings);
    await input.checkpoint();
    await input.progress(
      100,
      '隔离 TimescaleDB 数据库恢复完成，在线目标库未切换',
    );
    keep = true;
  } catch (caught) {
    error = caught;
  } finally {
    if (preRestore) {
      try {
        pool ??= openPool();
        await pool.query('SELECT timescaledb_post_restore()');
      } catch {
        // The database will be dropped after closing this pool. Keep the
        // cleanup result explicit if DROP DATABASE cannot complete.
      }
    }
    try {
      await pool?.end();
    } catch {
      cleanupFailed = true;
    }
    if (created && !keep) {
      try {
        await input.lock.dropStagingDatabase(database);
        cleanupFailed = false;
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed)
    throw new BackupCommandError('BACKUP_RESTORE_CLEANUP_FAILED');
  if (error) throw error;
  return database;
}

export async function readBackupArtifactMetadataFile(path: string) {
  const details = await lstat(path);
  if (!details.isFile() || details.size > BACKUP_ARTIFACT_METADATA_MAX_BYTES)
    throw new Error('BACKUP_METADATA_INVALID');
  return backupArtifactMetadataSchema.parse(
    JSON.parse(await readFile(path, 'utf8')),
  );
}

export function createBackupProcessor(
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>,
  options: BackupProcessorOptions,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, unknown, string> {
  return async (job, token) => {
    const parsed = backupJobDataSchema.safeParse(job.data);
    if (
      !parsed.success ||
      job.id !== parsed.data.taskId ||
      job.name !== parsed.data.operation
    )
      throw new UnrecoverableError('备份任务数据无效');
    const data = parsed.data;
    const controller = new AbortController();
    const shutdown = () =>
      controller.abort(new Error('BACKUP_WORKER_SHUTDOWN'));
    options.shutdownSignal.addEventListener('abort', shutdown, { once: true });
    const verify = (state: TaskState | null): TaskState => {
      if (
        !state ||
        state.taskId !== data.taskId ||
        state.userId !== data.userId ||
        state.taskType !== data.taskType ||
        state.taskSubType !== data.taskSubType ||
        state.createdAt !== data.createdAt
      )
        throw new Error('BACKUP_TASK_IDENTITY_INVALID');
      return state;
    };
    const mutate = async (change: TaskMutation) =>
      verify(await store.mutate(data.taskId, change, identityFields(data)));
    const check = async () => {
      if (options.isClosing()) throw new Error('BACKUP_WORKER_STOPPING');
      await options.assertJobLock(job, token);
      const state = verify(await store.read(data.taskId));
      if (isTerminalTaskStatus(state.status)) throw new TaskStopped(state);
      if (state.cancelRequestedAt || state.status === 'cancelling')
        throw new TaskStopped(state);
      return state;
    };
    let progressBytes = 0;
    let artifactPath: string | undefined;
    let metadataPartialPath: string | undefined;
    let metadataPublishedPath: string | undefined;
    let publishedStagingDatabase: string | undefined;
    let committedRestore: BackupRestoreReceipt | undefined;
    let publishedCreation: BackupCreationReceipt | undefined;
    let publishedCreationObserved = false;
    let cleanupFailed = false;
    const cleanupOwnedArtifact = async (
      path: string,
      artifact: 'archive-partial' | 'metadata-partial' | 'metadata-orphan',
    ): Promise<boolean> => {
      try {
        await unlink(path);
        return true;
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined;
        if (code === 'ENOENT') return true;
        cleanupFailed = true;
        log.warn('备份产物清理失败，请按任务 ID 核对残留产物', {
          reason: 'backup_artifact_cleanup_failed',
          taskId: data.taskId,
          target: data.target,
          artifact,
          code:
            typeof code === 'string' && cleanupErrorCodes.has(code)
              ? code
              : 'UNKNOWN',
        });
        return false;
      }
    };
    const creationIdentity =
      data.operation === 'create' ? backupCreationIdentity(data) : undefined;
    const directory = resolve(getBackupStorageDirectory(options.env));
    const creationFilename =
      data.operation === 'create'
        ? backupCreationFilename(data.taskId, data.createdAt, data.target)
        : undefined;
    const resultFor = (
      metadata: BackupArtifactMetadata & { archiveSha256: string },
      details: { size: number },
    ): BackupCreationReceipt => ({
      operation: 'create',
      filename: creationFilename!,
      size: details.size,
      createdAt: backupFilenameCreatedAt(creationFilename!)!,
      target: data.target,
      format: 'custom',
      sourceEngine: metadata.sourceEngine,
      restoreSupported: true,
      ...(metadata.version !== 1 && metadata.description
        ? { description: metadata.description }
        : {}),
      backupCreationCommit: {
        version: 1,
        taskId: data.taskId,
        userId: data.userId,
        taskCreatedAt: data.createdAt,
        creationIdentity: creationIdentity!,
        archiveSha256: metadata.archiveSha256,
      },
    });
    const recoverPublishedCreation = async (): Promise<boolean> => {
      if (!creationFilename) return false;
      const output = resolve(directory, creationFilename);
      try {
        await lstat(output);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
        publishedCreationObserved = true;
        throw error;
      }
      publishedCreationObserved = true;
      const metadata = await readBackupArtifactMetadataFile(
        `${output}.meta.json`,
      );
      if (
        (metadata.version !== 3 && metadata.version !== 4) ||
        metadata.creationIdentity !== creationIdentity ||
        metadata.filename !== creationFilename ||
        metadata.target !== data.target
      )
        throw new BackupCommandError('BACKUP_CREATION_IDENTITY_INVALID');
      const details = await assertCustomDump(
        output,
        options.env.BACKUP_MAX_BYTES,
      );
      // Recovery reads an already committed artifact and original identity. It
      // neither needs the expired execution lease nor starts database work.
      if (
        (await archiveSha256(
          output,
          async () => {
            verify(await store.read(data.taskId));
          },
          options.env.BACKUP_MAX_BYTES,
        )) !== metadata.archiveSha256
      )
        throw new BackupCommandError('BACKUP_METADATA_MISMATCH');
      publishedCreation = resultFor(metadata, details);
      await mutate({
        kind: 'backup-create-committed',
        result: publishedCreation,
        message: '备份完成（已恢复发布结果）',
      });
      return true;
    };
    const finishIsolatedRestore = async (
      restoredDatabase: string,
      filename: string,
    ) => {
      publishedStagingDatabase = restoredDatabase;
      committedRestore = {
        operation: 'restore',
        format: 'custom',
        filename,
        target: data.target,
        restoreMode: 'isolated',
        restoredDatabase,
        targetDatabaseChanged: false,
        verification: 'unconfirmed',
        message:
          '隔离数据库已恢复，任务状态尚未确认；请核对恢复数据库，在线目标库未切换',
      };
      await mutate({ kind: 'restore-committed', result: committedRestore });
      const completed = await mutate({
        kind: 'restore-confirmed',
        result: {
          ...committedRestore,
          verification: 'confirmed',
          message: '隔离数据库恢复完成，在线目标库未切换',
        },
      });
      log.info('隔离数据库恢复完成', { target: data.target, restoredDatabase });
      return completed.result;
    };
    let targetLock:
      | Awaited<ReturnType<typeof acquireBackupTargetLock>>
      | undefined;
    const progress = async (value: number, message: string) => {
      await check();
      await mutate({ kind: 'progress', progress: value, message });
      await options.updateProgress(job, value);
    };
    try {
      verify(await store.read(data.taskId));
      if (await recoverPublishedCreation()) return publishedCreation;
      const initial = await check();
      if (
        data.operation === 'restore' &&
        (initial.startedAt || initial.status === 'processing')
      )
        throw new BackupCommandError('BACKUP_TASK_INTERRUPTED');
      await mutate({ kind: 'processing', message: '备份任务开始处理' });
      const lock = await acquireBackupTargetLock(options.env, data.target);
      targetLock = lock;
      if (
        data.operation === 'create' &&
        data.params.tables?.length &&
        lock.hasTimescale
      )
        throw new BackupCommandError('BACKUP_TIMESCALE_TABLE_DUMP_UNSUPPORTED');
      await mkdir(directory, { recursive: true });
      const databaseUrl = targetUrl(options.env, data.target);
      const environment = commandEnvironment(databaseUrl);
      const timeoutMs = options.env.BACKUP_COMMAND_TIMEOUT_MS;
      const maxBytes = options.env.BACKUP_MAX_BYTES;
      if (data.operation === 'create') {
        const filename = creationFilename!;
        const output = resolve(directory, basename(filename));
        const partial = `${output}.partial`;
        // Re-check after obtaining the lease: a previous publisher may have
        // committed between the initial read and advisory lock acquisition.
        if (await recoverPublishedCreation()) return publishedCreation;
        // The target lease excludes another active publisher. Partial names
        // contain the full immutable task UUID, so an interrupted attempt can
        // clean only its own unpublished files before starting another dump.
        for (const [path, artifact] of [
          [partial, 'archive-partial'],
          [`${output}.meta.json.partial`, 'metadata-partial'],
          [`${output}.meta.json`, 'metadata-orphan'],
        ] as const)
          if (!(await cleanupOwnedArtifact(path, artifact)))
            throw new BackupCommandError('BACKUP_CREATION_CLEANUP_FAILED');
        artifactPath = partial;
        const reservation = await open(partial, 'wx', 0o600);
        await reservation.close();
        const tables = data.params.tables?.filter(validTable) ?? [];
        if (data.params.tables && tables.length !== data.params.tables.length)
          throw new BackupCommandError('BACKUP_TABLES_INVALID');
        const sourceManifest = lock.hasTimescale
          ? await lock.readTimescaleManifest()
          : undefined;
        const databaseSettings = await lock.readDatabaseSettings();
        await progress(1, '正在创建 PostgreSQL 自定义格式备份');
        await processCommand(
          commandPath(options.env.PG_DUMP_PATH, 'pg_dump'),
          [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            `--file=${partial}`,
            ...tables.map((table) => `--table-and-children=${table}`),
          ],
          environment,
          {
            timeoutMs,
            maxBytes,
            signal: controller.signal,
            checkpoint: async () => {
              await check();
              await lock.ensureHeld();
            },
            onProgress: async (bytes) => {
              progressBytes = bytes;
              await progress(
                Math.min(95, Math.max(2, Math.floor((bytes / maxBytes) * 90))),
                '正在写入备份文件',
              );
            },
          },
        );
        const details = await assertCustomDump(partial, maxBytes);
        await lock.ensureHeld();
        if (
          sourceManifest &&
          !sameTimescaleManifest(
            sourceManifest,
            await lock.readTimescaleManifest(),
          )
        )
          throw new BackupCommandError('BACKUP_TIMESCALE_SCHEMA_CHANGED');
        await chmod(partial, 0o600);
        await progress(96, '正在校验备份文件');
        const digest = await archiveSha256(
          partial,
          async () => {
            await check();
            await lock.ensureHeld();
          },
          maxBytes,
        );
        const metadata = backupArtifactMetadataSchema.parse(
          sourceManifest
            ? {
                version: 4,
                creationIdentity,
                filename,
                target: data.target,
                sourceEngine: 'timescaledb',
                timescale: sourceManifest,
                archiveSha256: digest,
                databaseSettings,
                ...(data.params.description
                  ? { description: data.params.description }
                  : {}),
              }
            : {
                version: 3,
                creationIdentity,
                filename,
                target: data.target,
                sourceEngine: 'postgresql',
                scope: tables.length ? 'selective' : 'full',
                archiveSha256: digest,
                databaseSettings,
                ...(tables.length ? { tables } : {}),
                ...(data.params.description
                  ? { description: data.params.description }
                  : {}),
              },
        );
        metadataPartialPath = `${output}.meta.json.partial`;
        await writeFile(metadataPartialPath, JSON.stringify(metadata), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        await check();
        await lock.ensureHeld();
        await rename(metadataPartialPath, `${output}.meta.json`);
        metadataPartialPath = undefined;
        metadataPublishedPath = `${output}.meta.json`;
        // The final dump name is the API's discovery boundary. Publish it
        // only after its complete sidecar exists; a failed rename removes the
        // orphan sidecar and partial archive in the catch path.
        await check();
        await lock.ensureHeld();
        await rename(partial, output);
        artifactPath = undefined;
        metadataPublishedPath = undefined;
        if (metadata.version !== 3 && metadata.version !== 4)
          throw new BackupCommandError('BACKUP_METADATA_MISMATCH');
        publishedCreation = resultFor(metadata, details);
        const completed = await mutate({
          kind: 'backup-create-committed',
          result: publishedCreation,
          message: '备份完成',
        });
        log.info('PostgreSQL 备份任务完成', {
          target: data.target,
          size: details.size,
          progressBytes,
        });
        return completed.result;
      }
      const filename = data.params.filename;
      if (
        !/^backup_[0-9]{8}-[0-9]{6}-(?:[a-f0-9]{8}|[a-f0-9]{32})-(primary|competitor)\.dump$/i.test(
          filename,
        ) ||
        !filename.endsWith(`-${data.target}.dump`)
      )
        throw new BackupCommandError('BACKUP_FILENAME_INVALID');
      const input = resolve(directory, basename(filename));
      artifactPath = undefined;
      await assertCustomDump(input, maxBytes);
      let metadata;
      try {
        metadata = await readBackupArtifactMetadataFile(`${input}.meta.json`);
      } catch {
        throw new BackupCommandError('BACKUP_METADATA_UNVERIFIED');
      }
      if (metadata.filename !== filename || metadata.target !== data.target)
        throw new BackupCommandError('BACKUP_METADATA_UNVERIFIED');
      if ((metadata.sourceEngine === 'timescaledb') !== lock.hasTimescale)
        throw new BackupCommandError('BACKUP_SOURCE_TARGET_MISMATCH');
      if (metadata.version !== 3 && metadata.version !== 4)
        throw new BackupCommandError('BACKUP_METADATA_UNVERIFIED');
      if (
        (await archiveSha256(
          input,
          async () => {
            await check();
            await lock.ensureHeld();
          },
          maxBytes,
        )) !== metadata.archiveSha256
      )
        throw new BackupCommandError('BACKUP_METADATA_MISMATCH');
      if (metadata.sourceEngine === 'timescaledb') {
        const liveManifest = await lock.readTimescaleManifest();
        if (
          metadata.timescale.extensionVersion !== liveManifest.extensionVersion
        )
          throw new BackupCommandError('BACKUP_TIMESCALE_VERSION_MISMATCH');
        await progress(5, '正在创建隔离 TimescaleDB 恢复数据库');
        const restoredDatabase = await restoreTimescaleIsolated({
          databaseUrl,
          directoryFile: input,
          taskId: data.taskId,
          target: data.target,
          manifest: metadata.timescale,
          databaseSettings: metadata.databaseSettings,
          lock,
          env: options.env,
          signal: controller.signal,
          checkpoint: async () => {
            await check();
            await lock.ensureHeld();
          },
          progress,
        });
        return await finishIsolatedRestore(restoredDatabase, filename);
      }
      if (metadata.version !== 3 || metadata.sourceEngine !== 'postgresql')
        throw new BackupCommandError('BACKUP_METADATA_UNVERIFIED');
      if (metadata.scope === 'full') {
        await progress(5, '正在创建隔离 PostgreSQL 恢复数据库');
        const restoredDatabase = await restorePostgresqlIsolated({
          databaseUrl,
          directoryFile: input,
          taskId: data.taskId,
          target: data.target,
          databaseSettings: metadata.databaseSettings,
          lock,
          env: options.env,
          signal: controller.signal,
          checkpoint: async () => {
            await check();
            await lock.ensureHeld();
          },
          progress,
        });
        return await finishIsolatedRestore(restoredDatabase, filename);
      }
      if (
        !sameBackupDatabaseLocale(
          metadata.databaseSettings,
          await lock.readDatabaseSettings(),
        )
      )
        throw new BackupCommandError('BACKUP_TARGET_LOCALE_MISMATCH');
      await progress(5, '正在恢复 PostgreSQL 备份');
      await processCommand(
        commandPath(options.env.PG_RESTORE_PATH, 'pg_restore'),
        restoreCommandArgs(environment.PGDATABASE!, input),
        environment,
        {
          timeoutMs,
          maxBytes,
          signal: controller.signal,
          zeroExitIsCommitted: true,
          checkpoint: async () => {
            await check();
            await lock.ensureHeld();
          },
          onProgress: async () => {
            await progress(50, '正在执行 PostgreSQL 恢复');
          },
        },
      );
      // pg_restore --single-transaction has committed when the process exits
      // successfully. Persist that point of no return before any post-restore
      // lock, health, progress, or cancellation checks can fail.
      committedRestore = {
        operation: 'restore',
        format: 'custom',
        filename,
        target: data.target,
        restoreMode: 'in-place',
        targetDatabaseChanged: true,
        verification: 'unconfirmed',
        message: '数据库恢复事务已提交，健康检查尚未确认；请核对数据库状态',
      };
      await mutate({
        kind: 'restore-committed',
        result: committedRestore,
      });
      await lock.ensureHeld();
      await healthCheck(options.env, data.target);
      const completed = await mutate({
        kind: 'restore-confirmed',
        result: {
          ...committedRestore,
          verification: 'confirmed',
          message: '恢复完成',
        },
      });
      await options.updateProgress(job, 100);
      log.info('PostgreSQL 恢复任务完成', { target: data.target });
      return completed.result;
    } catch (error) {
      if (artifactPath)
        await cleanupOwnedArtifact(artifactPath, 'archive-partial');
      if (metadataPartialPath)
        await cleanupOwnedArtifact(metadataPartialPath, 'metadata-partial');
      if (metadataPublishedPath)
        await cleanupOwnedArtifact(metadataPublishedPath, 'metadata-orphan');
      if (publishedCreation) {
        // Publication is the durable commit. A lost registry acknowledgement
        // cannot cause a second pg_dump or turn an existing archive into failure.
        log.warn('备份已发布，任务完成状态待核实', {
          reason: 'backup_creation_status_unconfirmed',
        });
        return publishedCreation;
      }
      if (committedRestore) {
        log.error('数据库恢复已保留，但任务完成确认失败', {
          target: data.target,
          reason: 'backup_restore_postcommit_unconfirmed',
        });
        try {
          const state = await mutate({
            kind: 'restore-committed',
            result: committedRestore,
          });
          if (state.status === 'completed') return state.result;
        } catch {
          log.warn('已提交恢复任务状态写入未确认', {
            reason: 'backup_restore_commit_status_unconfirmed',
          });
        }
        // BullMQ uses a separate connection from the task registry. Retain
        // this bounded commit receipt in its completed result so query-time
        // reconciliation can recover it when registry writes failed.
        return committedRestore;
      }
      if (error instanceof TaskStopped) {
        if (error.state.status === 'cancelled') return cancelledResult;
        if (error.state.status === 'completed') return error.state.result;
        if (
          error.state.cancelRequestedAt ||
          error.state.status === 'cancelling'
        ) {
          await mutate({ kind: 'cancelled', message: cancelledResult.message });
          return cancelledResult;
        }
        throw new UnrecoverableError('备份任务已停止');
      }
      let message = publishedStagingDatabase
        ? `隔离数据库 ${publishedStagingDatabase} 已恢复，但任务状态未确认；请人工核对，在线目标库未切换`
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_SOURCE_TARGET_MISMATCH'
        ? '备份文件来源数据库类型与恢复目标不一致'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_TIMESCALE_TABLE_DUMP_UNSUPPORTED'
        ? 'TimescaleDB 不支持通过 Neo 接口按表备份，请创建完整数据库备份'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_TIMESCALE_VERSION_MISMATCH'
        ? 'TimescaleDB 扩展版本与备份不一致，隔离恢复已停止'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_RESTORE_CLEANUP_FAILED'
        ? '隔离恢复失败且临时数据库清理未确认，请人工核对任务 ID 与数据库'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_RESTORE_CREATE_UNCONFIRMED'
        ? '隔离数据库创建结果未确认，请人工核对任务 ID 与数据库，在线目标库未切换'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_RESTORE_DATABASE_EXISTS'
        ? '该任务的隔离恢复数据库已存在，禁止覆盖，请人工核对'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_TARGET_BUSY'
        ? '目标数据库正在执行备份或恢复，请稍后重试'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_METADATA_UNVERIFIED'
        ? '备份文件来源未验证，禁止通过 Neo 自动恢复'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_METADATA_MISMATCH'
        ? '备份文件与元数据不匹配，禁止自动恢复'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_TARGET_LOCALE_MISMATCH'
        ? '恢复目标数据库的字符集或排序规则与备份不一致，禁止原位恢复'
        : '备份任务失败，请核实数据库状态和备份文件';
      if (cleanupFailed)
        message += '；备份产物清理未确认，请按任务 ID 核对残留产物';
      let cancelled = false;
      const retryCreation =
        data.operation === 'create' &&
        job.attemptsMade + 1 < (job.opts?.attempts ?? 2);
      try {
        await options.assertJobLock(job, token);
        const state = verify(await store.read(data.taskId));
        if (
          (state.cancelRequestedAt || state.status === 'cancelling') &&
          !(
            error instanceof BackupCommandError &&
            error.reason === 'BACKUP_RESTORE_CLEANUP_FAILED'
          ) &&
          !publishedStagingDatabase &&
          !publishedCreationObserved
        ) {
          await mutate({ kind: 'cancelled', message: cancelledResult.message });
          cancelled = true;
        } else if (!retryCreation) await mutate({ kind: 'failed', message });
      } catch {
        log.warn('备份任务状态写入未确认', {
          reason: 'backup_status_unconfirmed',
        });
      }
      if (cancelled) return cancelledResult;
      if (retryCreation) {
        log.warn('备份创建未发布，将使用原任务重试', {
          reason: 'backup_creation_retry',
        });
        throw new Error(message);
      }
      log.error('PostgreSQL 备份任务失败', {
        target: data.target,
        reason:
          error instanceof BackupCommandError ? error.reason : 'backup_failed',
      });
      throw new UnrecoverableError(message);
    } finally {
      try {
        await targetLock?.release();
      } catch {
        log.warn('备份目标数据库锁释放未确认', {
          reason: 'backup_target_unlock_unconfirmed',
        });
      }
      options.shutdownSignal.removeEventListener('abort', shutdown);
    }
  };
}
