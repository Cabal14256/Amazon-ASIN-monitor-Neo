import { getBackupStorageDirectory, type Env } from '@asin-monitor/config';
import {
  BACKUP_ARTIFACT_METADATA_MAX_BYTES,
  backupArtifactMetadataSchema,
  backupJobDataSchema,
  backupTimescaleManifestSchema,
  type BackupJobData,
  type BackupTimescaleManifest,
} from '@asin-monitor/contracts';
import {
  createPgPool,
  isTerminalTaskStatus,
  RedisTaskRepository,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { spawn, type ChildProcess } from 'node:child_process';
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
  if (path.includes('\0') || path.length > 512)
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

/** Session-level advisory lock shared by every Neo backup/restore worker. */
export async function acquireBackupTargetLock(
  env: Env,
  target: BackupJobData['target'],
) {
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
        'SELECT pg_try_advisory_lock(1313165122, 161) AS acquired',
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
        async stagingDatabaseExists(name: string) {
          quoteStagingDatabase(name);
          const result = await lockedClient.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [name],
          );
          return result.rows.length > 0;
        },
        async createStagingDatabase(name: string) {
          await lockedClient.query(
            `CREATE DATABASE ${quoteStagingDatabase(name)} TEMPLATE template0`,
          );
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
              'SELECT pg_advisory_unlock(1313165122, 161)',
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
      await input.lock.createStagingDatabase(database);
    } catch {
      throw new BackupCommandError('BACKUP_RESTORE_CREATE_UNCONFIRMED');
    }
    created = true;
    if (!(await input.lock.ownsStagingDatabase(database)))
      throw new BackupCommandError('BACKUP_RESTORE_DATABASE_OWNER_MISMATCH');
    await input.lock.restrictStagingDatabase(database);
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
      await input.lock.createStagingDatabase(database);
    } catch {
      // A lost acknowledgement can leave a newly-created database behind.
      // Never drop it without a confirmed CREATE result.
      throw new BackupCommandError('BACKUP_RESTORE_CREATE_UNCONFIRMED');
    }
    created = true;
    if (!(await input.lock.ownsStagingDatabase(database)))
      throw new BackupCommandError('BACKUP_RESTORE_DATABASE_OWNER_MISMATCH');
    await input.lock.restrictStagingDatabase(database);
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
    let publishedStagingDatabase: string | undefined;
    let committedInPlaceRestore:
      | {
          operation: 'restore';
          format: 'custom';
          filename: string;
          target: BackupJobData['target'];
          restoreMode: 'in-place';
          targetDatabaseChanged: true;
          verification: 'unconfirmed';
          message: string;
        }
      | undefined;
    let targetLock:
      | Awaited<ReturnType<typeof acquireBackupTargetLock>>
      | undefined;
    const progress = async (value: number, message: string) => {
      await check();
      await mutate({ kind: 'progress', progress: value, message });
      await options.updateProgress(job, value);
    };
    try {
      const initial = await check();
      if (initial.startedAt || initial.status === 'processing')
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
      const directory = resolve(getBackupStorageDirectory(options.env));
      await mkdir(directory, { recursive: true });
      const databaseUrl = targetUrl(options.env, data.target);
      const environment = commandEnvironment(databaseUrl);
      const timeoutMs = options.env.BACKUP_COMMAND_TIMEOUT_MS;
      const maxBytes = options.env.BACKUP_MAX_BYTES;
      if (data.operation === 'create') {
        const stamp = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
          .formatToParts(new Date())
          .reduce<Record<string, string>>((out, part) => {
            if (part.type !== 'literal') out[part.type] = part.value;
            return out;
          }, {});
        const filename = `backup_${stamp.year}${stamp.month}${stamp.day}-${
          stamp.hour
        }${stamp.minute}${stamp.second}-${data.taskId.slice(0, 8)}-${
          data.target
        }.dump`;
        const output = resolve(directory, basename(filename));
        const partial = `${output}.partial`;
        artifactPath = partial;
        const reservation = await open(partial, 'wx', 0o600);
        await reservation.close();
        const tables = data.params.tables?.filter(validTable) ?? [];
        if (data.params.tables && tables.length !== data.params.tables.length)
          throw new BackupCommandError('BACKUP_TABLES_INVALID');
        const sourceManifest = lock.hasTimescale
          ? await lock.readTimescaleManifest()
          : undefined;
        await progress(1, '正在创建 PostgreSQL 自定义格式备份');
        await processCommand(
          commandPath(options.env.PG_DUMP_PATH, 'pg_dump'),
          [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            `--file=${partial}`,
            ...tables.map((table) => `--table=${table}`),
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
        await progress(100, '备份完成');
        await rename(partial, output);
        // A valid dump is now discoverable. Keep it for operator reconciliation
        // if the following Redis completion acknowledgement is ambiguous.
        artifactPath = undefined;
        const metadata = backupArtifactMetadataSchema.parse(
          sourceManifest
            ? {
                version: 2,
                filename,
                target: data.target,
                sourceEngine: 'timescaledb',
                timescale: sourceManifest,
                ...(data.params.description
                  ? { description: data.params.description }
                  : {}),
              }
            : {
                version: 3,
                filename,
                target: data.target,
                sourceEngine: 'postgresql',
                scope: tables.length ? 'selective' : 'full',
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
        await rename(metadataPartialPath, `${output}.meta.json`);
        metadataPartialPath = undefined;
        const result = {
          operation: 'create' as const,
          filename,
          size: details.size,
          createdAt: details.birthtime.toISOString(),
          target: data.target,
          format: 'custom' as const,
          sourceEngine: metadata.sourceEngine,
          restoreSupported: true,
          ...('description' in metadata && metadata.description
            ? { description: metadata.description }
            : {}),
        };
        const completed = await mutate({
          kind: 'completed',
          result,
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
        !/^backup_[0-9]{8}-[0-9]{6}-[a-f0-9]{8}-(primary|competitor)\.dump$/i.test(
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
      if (metadata.sourceEngine === 'postgresql' && metadata.version !== 3)
        throw new BackupCommandError('BACKUP_METADATA_UNVERIFIED');
      if (metadata.sourceEngine === 'timescaledb') {
        if (metadata.version !== 2)
          throw new BackupCommandError('BACKUP_METADATA_UNVERIFIED');
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
          lock,
          env: options.env,
          signal: controller.signal,
          checkpoint: async () => {
            await check();
            await lock.ensureHeld();
          },
          progress,
        });
        publishedStagingDatabase = restoredDatabase;
        const completed = await mutate({
          kind: 'completed',
          result: {
            operation: 'restore',
            format: 'custom',
            message: '隔离数据库恢复完成，在线目标库未切换',
            filename,
            target: data.target,
            restoreMode: 'isolated',
            restoredDatabase,
            targetDatabaseChanged: false,
          },
          message: '隔离数据库恢复完成，在线目标库未切换',
        });
        log.info('TimescaleDB 隔离数据库恢复完成', {
          target: data.target,
          restoredDatabase,
        });
        return completed.result;
      }
      if (metadata.version === 3 && metadata.scope === 'full') {
        await progress(5, '正在创建隔离 PostgreSQL 恢复数据库');
        const restoredDatabase = await restorePostgresqlIsolated({
          databaseUrl,
          directoryFile: input,
          taskId: data.taskId,
          target: data.target,
          lock,
          env: options.env,
          signal: controller.signal,
          checkpoint: async () => {
            await check();
            await lock.ensureHeld();
          },
          progress,
        });
        publishedStagingDatabase = restoredDatabase;
        const completed = await mutate({
          kind: 'completed',
          result: {
            operation: 'restore',
            format: 'custom',
            message: '隔离数据库恢复完成，在线目标库未切换',
            filename,
            target: data.target,
            restoreMode: 'isolated',
            restoredDatabase,
            targetDatabaseChanged: false,
          },
          message: '隔离数据库恢复完成，在线目标库未切换',
        });
        log.info('PostgreSQL 隔离数据库恢复完成', {
          target: data.target,
          restoredDatabase,
        });
        return completed.result;
      }
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
      committedInPlaceRestore = {
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
        result: committedInPlaceRestore,
      });
      await lock.ensureHeld();
      await healthCheck(options.env, data.target);
      const completed = await mutate({
        kind: 'restore-confirmed',
        result: {
          ...committedInPlaceRestore,
          verification: 'confirmed',
          message: '恢复完成',
        },
      });
      await options.updateProgress(job, 100);
      log.info('PostgreSQL 恢复任务完成', { target: data.target });
      return completed.result;
    } catch (error) {
      if (artifactPath) await unlink(artifactPath).catch(() => undefined);
      if (metadataPartialPath)
        await unlink(metadataPartialPath).catch(() => undefined);
      if (committedInPlaceRestore) {
        log.error('PostgreSQL 恢复事务已提交，但完成确认失败', {
          target: data.target,
          reason: 'backup_restore_postcommit_unconfirmed',
        });
        try {
          const state = await mutate({
            kind: 'restore-committed',
            result: committedInPlaceRestore,
          });
          if (state.status === 'completed') return state.result;
        } catch {
          log.warn('已提交恢复任务状态写入未确认', {
            reason: 'backup_restore_commit_status_unconfirmed',
          });
        }
        throw new UnrecoverableError(
          '数据库恢复事务已提交，但任务状态或健康检查未确认；请人工核对数据库',
        );
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
      const message = publishedStagingDatabase
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
        : '备份任务失败，请核实数据库状态和备份文件';
      let cancelled = false;
      try {
        await options.assertJobLock(job, token);
        const state = verify(await store.read(data.taskId));
        if (
          (state.cancelRequestedAt || state.status === 'cancelling') &&
          !(
            error instanceof BackupCommandError &&
            error.reason === 'BACKUP_RESTORE_CLEANUP_FAILED'
          ) &&
          !publishedStagingDatabase
        ) {
          await mutate({ kind: 'cancelled', message: cancelledResult.message });
          cancelled = true;
        } else await mutate({ kind: 'failed', message });
      } catch {
        log.warn('备份任务状态写入未确认', {
          reason: 'backup_status_unconfirmed',
        });
      }
      log.error('PostgreSQL 备份任务失败', {
        target: data.target,
        reason:
          error instanceof BackupCommandError ? error.reason : 'backup_failed',
      });
      if (cancelled) return cancelledResult;
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
