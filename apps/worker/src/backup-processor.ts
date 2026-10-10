import {
  assertBackupTaskRetention,
  BACKUP_COMMAND_PATH_MAX_LENGTH,
  BACKUP_TASK_MAX_AGE_MS,
  getBackupStorageDirectory,
  parsePostgresConnectionString,
  type Env,
} from '@asin-monitor/config';
import {
  BACKUP_ARTIFACT_METADATA_MAX_BYTES,
  backupArtifactMetadataSchema,
  backupCreationFilename,
  backupCreationFilenames,
  backupDatabaseSettingsSchema,
  backupFilenameCreatedAt,
  backupJobDataSchema,
  backupTimescaleManifestSchema,
  parseBackupTableIdentifiers,
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
  backupSelectiveRestoreQuery,
  backupTableSelectionQuery,
  createPgPool,
  isTerminalTaskStatus,
  RedisTaskRepository,
  resolveBackupTableSelection,
  selectiveBackupRestoreBlocked,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import * as tls from 'node:tls';
import {
  nativeBackupPublicationSync,
  waitForBackupSync,
  type BackupPublicationSync,
} from './backup-artifact-durability';
import { logger } from './logger';

export interface BackupProcessorOptions {
  env: Env;
  shutdownSignal: AbortSignal;
  isClosing(): boolean;
  assertJobLock(job: Job, token: string | undefined): Promise<void>;
  updateProgress(job: Job, progress: number): Promise<void>;
  publicationSync?: BackupPublicationSync;
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

// Keep trust-source metadata private; never serialize certificate contents into
// argv, process env, receipts or logs. The command wrapper creates an owned PEM
// only while a subprocess is alive and removes it after that child closes.
const commandDefaultTrust = new WeakSet<NodeJS.ProcessEnv>();

function applicationSslFromEnvironment(
  defaults: NodeJS.ProcessEnv,
): boolean | tls.ConnectionOptions {
  // pg 8.23.0 connection-parameters.js readSSLConfigFromEnvironment. Its
  // prefer/require/verify-ca settings require CA and hostname validation; they
  // do not mean libpq's weaker modes. URL parser output takes precedence.
  switch (defaults.PGSSLMODE) {
    case 'prefer':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return true;
    case 'no-verify':
      return { rejectUnauthorized: false };
    default:
      return false;
  }
}

export function commandEnvironment(
  connectionString: string,
  defaults: NodeJS.ProcessEnv = process.env,
  sessionUser?: string,
): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  // Reuse the application's node-postgres parser, including pathname database
  // precedence and reserved-character decoding, before isolating libpq's PG*.
  let parsed: ReturnType<typeof parsePostgresConnectionString>;
  try {
    parsed = parsePostgresConnectionString(connectionString);
  } catch {
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  }
  const user =
    parsed.user ||
    defaults.PGUSER ||
    (process.platform === 'win32' ? defaults.USERNAME : defaults.USER);
  const database = parsed.database || defaults.PGDATABASE || user;
  const host = parsed.host || defaults.PGHOST || 'localhost';
  const port = parsed.port || defaults.PGPORT || '5432';
  const password = parsed.password || defaults.PGPASSWORD;
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
  const ssl =
    parsed.ssl === undefined
      ? applicationSslFromEnvironment(defaults)
      : parsed.ssl === 'no-verify'
      ? { rejectUnauthorized: false }
      : parsed.ssl;
  const sslOptions =
    typeof ssl === 'object' && ssl !== null
      ? (ssl as tls.ConnectionOptions)
      : undefined;
  const sslFilePath = (name: string): string => {
    const value = parsed[name];
    if (typeof value !== 'string')
      throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
    return value;
  };
  const sslMode = !ssl
    ? 'disable'
    : sslOptions?.rejectUnauthorized === false
    ? 'require'
    : typeof sslOptions?.checkServerIdentity === 'function'
    ? 'verify-ca'
    : 'verify-full';
  // Explicit non-existent paths suppress libpq's automatic HOME certificates,
  // keys and CRLs, which node-postgres never uses. In particular, require must
  // not turn no-verify into verify-ca just because ~/.postgresql/root.crt exists.
  const noAutomaticFile = resolve(
    tmpdir(),
    `neo-backup-no-automatic-tls-${randomUUID()}`,
  );
  // Drop unrelated libpq controls (PGSERVICE, PGHOSTADDR, PGOPTIONS, etc.).
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('PG'),
    ),
  );
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    PGHOST: host.replace(/^\[|\]$/g, ''),
    PGPORT: port,
    PGUSER: user,
    ...(password ? { PGPASSWORD: password } : {}),
    ...(passfile ? { PGPASSFILE: passfile } : {}),
    PGDATABASE: database,
    PGSSLMODE: sslMode,
    PGGSSENCMODE: 'disable',
    PGSSLROOTCERT:
      sslMode !== 'disable' && sslMode !== 'require' && sslOptions?.ca
        ? sslFilePath('sslrootcert')
        : noAutomaticFile,
    PGSSLCERT: sslOptions?.cert ? sslFilePath('sslcert') : noAutomaticFile,
    PGSSLKEY: sslOptions?.key ? sslFilePath('sslkey') : noAutomaticFile,
    PGSSLCRL: noAutomaticFile,
    PGSSLCRLDIR: noAutomaticFile,
  };
  if (sessionUser !== undefined) {
    const confirmed = backupDatabaseRole(sessionUser);
    // PostgreSQL overrides startup session_authorization with the login user.
    // CLI options cannot preserve a session changed after authentication.
    // Refuse that identity instead of silently restoring the broader login.
    if (confirmed !== environment.PGUSER)
      throw new BackupCommandError('BACKUP_DATABASE_ROLE_UNCONFIRMED');
  }
  if (sslMode === 'verify-full' && !sslOptions?.ca)
    commandDefaultTrust.add(environment);
  return environment;
}

function commandPath(value: string | undefined, fallback: string): string {
  const path = value?.trim() || fallback;
  if (path.includes('\0') || path.length > BACKUP_COMMAND_PATH_MAX_LENGTH)
    throw new BackupCommandError('BACKUP_COMMAND_INVALID');
  return path;
}

function validTable(value: string): boolean {
  return parseBackupTableIdentifiers(value) !== null;
}

function literalTablePattern(value: string): string {
  if (!validTable(value)) throw new BackupCommandError('BACKUP_TABLES_INVALID');
  // pg_dump uses psql patterns; quote each identifier to prevent case folding.
  return parseBackupTableIdentifiers(value)!
    .map((identifier) => `"${identifier.replaceAll('"', '""')}"`)
    .join('.');
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
  pool: { query(sql: string): Promise<{ rows: Record<string, unknown>[] }> },
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
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  let bytesSinceCheckpoint = 0;
  let bytes = 0;
  await checkpoint();
  for await (const chunk of createReadStream(path, { signal })) {
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
  // Remove redundant aliases so the isolated pathname is unambiguous for all
  // clients used during staging and selective restore.
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

function backupDatabaseRole(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 1024
  )
    throw new BackupCommandError('BACKUP_DATABASE_ROLE_UNCONFIRMED');
  return value;
}

export function restoreCommandArgs(
  database: string,
  input: string,
  role: string,
): string[] {
  if (!database || database.includes('\0'))
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  return [
    '--exit-on-error',
    '--single-transaction',
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-acl',
    `--role=${backupDatabaseRole(role)}`,
    `--dbname=${database}`,
    input,
  ];
}

interface BackupCommandOptions {
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  checkpoint: () => Promise<void>;
  onProgress: (bytes: number) => Promise<void>;
  pollIntervalMs?: number;
  /** A zero pg_restore exit means its single transaction committed. */
  zeroExitIsCommitted?: boolean;
}

async function defaultNodeCertificateAuthorities(): Promise<string[]> {
  if (typeof tls.getCACertificates === 'function')
    return tls.getCACertificates('default');
  // Node 20 uses the bundled roots unless OpenSSL CA mode was explicitly
  // selected. Its effective OpenSSL store cannot be enumerated; fail closed
  // rather than substituting a different trust set. A URL sslrootcert avoids
  // this fallback and provides the exact explicit CA to both clients.
  if (
    process.execArgv.includes('--use-openssl-ca') ||
    /(?:^|\s)--use-openssl-ca(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '')
  )
    throw new BackupCommandError('BACKUP_TLS_ROOTS_UNAVAILABLE');
  const roots = [...tls.rootCertificates];
  if (process.env.NODE_EXTRA_CA_CERTS) {
    const extra = await readFile(process.env.NODE_EXTRA_CA_CERTS, 'utf8');
    roots.push(extra);
  }
  return roots;
}

export async function processCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  options: BackupCommandOptions,
): Promise<void> {
  if (options.signal.aborted)
    throw new BackupCommandError('BACKUP_COMMAND_CANCELLED');
  let trustDirectory: string | undefined;
  let trustFile: string | undefined;
  try {
    let effectiveEnvironment = environment;
    if (commandDefaultTrust.has(environment)) {
      const roots = await defaultNodeCertificateAuthorities();
      if (roots.length === 0)
        throw new BackupCommandError('BACKUP_TLS_ROOTS_UNAVAILABLE');
      trustDirectory = await mkdtemp(resolve(tmpdir(), 'neo-backup-trust-'));
      await chmod(trustDirectory, 0o700);
      trustFile = resolve(trustDirectory, 'node-default-ca.pem');
      await writeFile(trustFile, roots.join('\n'), { mode: 0o600, flag: 'wx' });
      effectiveEnvironment = { ...environment, PGSSLROOTCERT: trustFile };
    }
    return await executeBackupCommand(
      command,
      args,
      effectiveEnvironment,
      options,
    );
  } finally {
    // Only remove our exact newly-created file and empty owned directory. A
    // retained public CA is a recoverable hygiene issue, not a failed archive.
    if (trustFile)
      await unlink(trustFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT')
          logger.warn('备份临时信任证书清理失败', { code: error.code });
      });
    if (trustDirectory)
      await rmdir(trustDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT')
          logger.warn('备份临时信任目录清理失败', { code: error.code });
      });
  }
}

function executeBackupCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  options: BackupCommandOptions,
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
      // Freeze privileges from the actual application session, including URL
      // options, PGOPTIONS and role defaults, without forwarding arbitrary GUCs.
      const role = await client.query(
        'SELECT current_user AS role, session_user AS "sessionUser"',
      );
      const effectiveRole = backupDatabaseRole(role.rows[0]?.role);
      const sessionUser = backupDatabaseRole(role.rows[0]?.sessionUser);
      const extension = await client.query(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS enabled",
      );
      const lockedClient = client;
      let released = false;
      return {
        effectiveRole,
        sessionUser,
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
        async assertSelectiveRestoreSupported(tables: readonly string[]) {
          if (released) throw new BackupCommandError('BACKUP_TARGET_LOCK_LOST');
          const result = await lockedClient.query(
            backupSelectiveRestoreQuery(tables),
          );
          if (selectiveBackupRestoreBlocked(result.rows))
            throw new BackupCommandError(
              'BACKUP_SELECTIVE_RESTORE_DEPENDENCIES',
            );
        },
        async resolveTables(tables: readonly string[]) {
          if (released) throw new BackupCommandError('BACKUP_TARGET_LOCK_LOST');
          try {
            const result = await lockedClient.query(
              backupTableSelectionQuery(tables),
            );
            return resolveBackupTableSelection(tables, result.rows);
          } catch {
            throw new BackupCommandError('BACKUP_TABLE_SELECTION_UNCONFIRMED');
          }
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
          // pg_restore authenticates before --role, so a SET-only membership
          // needs an explicit CONNECT grant for the frozen login identity.
          await lockedClient.query(
            `GRANT CONNECT ON DATABASE ${quoteStagingDatabase(
              name,
            )} TO "${sessionUser.replaceAll('"', '""')}"`,
          );
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

/** The caller owns this new private path until every actual file operation and
 * restore child has settled. Hash the copy itself, never source read chunks. */
async function copyRestoreSnapshot(
  sourcePath: string,
  snapshotPath: string,
  input: {
    maxBytes: number;
    signal: AbortSignal;
    checkpoint: () => Promise<void>;
  },
): Promise<string> {
  input.signal.throwIfAborted();
  await input.checkpoint();
  const source = await open(sourcePath, 'r');
  try {
    const details = await source.stat();
    if (!details.isFile() || details.size < 5 || details.size > input.maxBytes)
      throw new BackupCommandError('BACKUP_ARTIFACT_INVALID');
    input.signal.throwIfAborted();
    const snapshot = await open(snapshotPath, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      let sinceCheckpoint = 0;
      let lastCheckpoint = Date.now();
      while (true) {
        input.signal.throwIfAborted();
        const { bytesRead } = await source.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        input.signal.throwIfAborted();
        if (bytesRead === 0) break;
        if (offset + bytesRead > input.maxBytes)
          throw new BackupCommandError('BACKUP_ARTIFACT_INVALID');
        let written = 0;
        while (written < bytesRead) {
          input.signal.throwIfAborted();
          const { bytesWritten } = await snapshot.write(
            buffer,
            written,
            bytesRead - written,
            offset + written,
          );
          input.signal.throwIfAborted();
          if (bytesWritten === 0)
            throw new BackupCommandError('BACKUP_ARTIFACT_INVALID');
          written += bytesWritten;
        }
        offset += bytesRead;
        sinceCheckpoint += bytesRead;
        if (
          sinceCheckpoint >= 8 * 1024 * 1024 ||
          Date.now() - lastCheckpoint >= 500
        ) {
          await input.checkpoint();
          input.signal.throwIfAborted();
          sinceCheckpoint = 0;
          lastCheckpoint = Date.now();
        }
      }
    } finally {
      // Abort never races cleanup against a pending read/write. Both handle
      // closes finish before the outer owner may unlink the private snapshot.
      await snapshot.close();
    }
  } finally {
    await source.close();
  }
  input.signal.throwIfAborted();
  await assertCustomDump(snapshotPath, input.maxBytes);
  input.signal.throwIfAborted();
  const verified = await open(snapshotPath, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    let sinceCheckpoint = 0;
    let lastCheckpoint = Date.now();
    while (true) {
      input.signal.throwIfAborted();
      const { bytesRead } = await verified.read(
        buffer,
        0,
        buffer.length,
        offset,
      );
      input.signal.throwIfAborted();
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > input.maxBytes)
        throw new BackupCommandError('BACKUP_ARTIFACT_INVALID');
      hash.update(buffer.subarray(0, bytesRead));
      sinceCheckpoint += bytesRead;
      if (
        sinceCheckpoint >= 8 * 1024 * 1024 ||
        Date.now() - lastCheckpoint >= 500
      ) {
        await input.checkpoint();
        input.signal.throwIfAborted();
        sinceCheckpoint = 0;
        lastCheckpoint = Date.now();
      }
    }
  } finally {
    // The owner must not remove the file while a hashing read still owns it.
    await verified.close();
  }
  await input.checkpoint();
  input.signal.throwIfAborted();
  return hash.digest('hex');
}

/** Keep one leased session so reconnects cannot silently restore login privileges. */
async function openBackupStagingPool(
  databaseUrl: string,
  env: Env,
  identity: { readonly effectiveRole: string; readonly sessionUser: string },
  statementTimeout: number,
) {
  const pool = createPgPool(databaseUrl, {
    max: 1,
    connectionTimeoutMillis: Math.min(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      5000,
    ),
    statement_timeout: statementTimeout,
  });
  try {
    const client = await pool.connect();
    try {
      const expectedRole = backupDatabaseRole(identity.effectiveRole);
      const expectedSession = backupDatabaseRole(identity.sessionUser);
      await client.query(
        `SET SESSION AUTHORIZATION "${expectedSession.replaceAll('"', '""')}"`,
      );
      await client.query(`SET ROLE "${expectedRole.replaceAll('"', '""')}"`);
      const actual = await client.query(
        'SELECT current_user AS role, session_user AS "sessionUser"',
      );
      if (
        actual.rows[0]?.role !== expectedRole ||
        actual.rows[0]?.sessionUser !== expectedSession
      )
        throw new BackupCommandError('BACKUP_DATABASE_ROLE_UNCONFIRMED');
      let closing: Promise<void> | undefined;
      return {
        query: client.query.bind(client),
        end(): Promise<void> {
          closing ??= (async () => {
            client.release();
            await pool.end();
          })();
          return closing;
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
  const commandEnv = commandEnvironment(
    databaseUrl,
    process.env,
    input.lock.sessionUser,
  );
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
        `--role=${input.lock.effectiveRole}`,
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
    const pool = await openBackupStagingPool(
      databaseUrl,
      input.env,
      input.lock,
      5000,
    );
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
  const commandEnv = commandEnvironment(
    databaseUrl,
    process.env,
    input.lock.sessionUser,
  );
  const openPool = () =>
    openBackupStagingPool(databaseUrl, input.env, input.lock, 60000);
  let pool: Awaited<ReturnType<typeof openPool>> | undefined;
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
    pool = await openPool();
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
    pool = undefined;
    pool = await openPool();
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
        `--role=${input.lock.effectiveRole}`,
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
    const finishClient = pool;
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
    }
    preRestore = false;
    await pool.end();
    pool = undefined;
    pool = await openPool();
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
        pool ??= await openPool();
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
  assertBackupTaskRetention(options.env);
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
    const deadline = Date.parse(data.createdAt) + BACKUP_TASK_MAX_AGE_MS;
    let lifecycleTimer: ReturnType<typeof setTimeout> | undefined;
    const checkDeadline = () => {
      if (Date.now() >= deadline) {
        const error = new BackupCommandError('BACKUP_TASK_EXPIRED');
        controller.abort(error);
        throw error;
      }
      controller.signal.throwIfAborted();
    };
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
      checkDeadline();
      return state;
    };
    let progressBytes = 0;
    let artifactPath: string | undefined;
    let metadataPartialPath: string | undefined;
    let metadataPublishedPath: string | undefined;
    let restoreSnapshotPath: string | undefined;
    let restoreSnapshotDirectory: string | undefined;
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
    const creationFilenames =
      data.operation === 'create'
        ? backupCreationFilenames(data.taskId, data.createdAt, data.target)
        : undefined;
    const publicationSync =
      options.publicationSync ?? nativeBackupPublicationSync;
    const syncPublication = async (
      paths: readonly string[],
      includeDirectory: boolean,
      signal?: AbortSignal,
    ) => {
      try {
        for (const path of paths)
          await waitForBackupSync(
            () => publicationSync.syncFile(path),
            options.env.BACKUP_COMMAND_TIMEOUT_MS,
            signal,
          );
        if (includeDirectory)
          await waitForBackupSync(
            () => publicationSync.syncDirectory(directory),
            options.env.BACKUP_COMMAND_TIMEOUT_MS,
            signal,
          );
      } catch {
        throw new BackupCommandError('BACKUP_PUBLICATION_SYNC_UNCONFIRMED');
      }
    };
    const resultFor = (
      metadata: BackupArtifactMetadata & { archiveSha256: string },
      details: { size: number },
      filename = creationFilename!,
    ): BackupCreationReceipt => ({
      operation: 'create',
      filename,
      size: details.size,
      ...('execution' in metadata && metadata.execution
        ? {
            createdAt: metadata.execution.dumpStartedAt,
            timeSource: 'dump-start' as const,
            execution: metadata.execution,
          }
        : {
            createdAt: backupFilenameCreatedAt(filename)!,
            timeSource: 'filename' as const,
          }),
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
      if (!creationFilenames) return false;
      const existing: { filename: string; output: string }[] = [];
      for (const filename of creationFilenames) {
        const output = resolve(directory, filename);
        try {
          await lstat(output);
          existing.push({ filename, output });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            publishedCreationObserved = true;
            throw error;
          }
        }
      }
      if (existing.length === 0) return false;
      publishedCreationObserved = true;
      // Never guess which publication is authoritative or start another dump.
      if (existing.length !== 1)
        throw new BackupCommandError('BACKUP_CREATION_IDENTITY_INVALID');
      const [{ filename: publishedFilename, output }] = existing;
      publishedCreationObserved = true;
      const metadata = await readBackupArtifactMetadataFile(
        `${output}.meta.json`,
      );
      if (
        (metadata.version !== 3 && metadata.version !== 4) ||
        metadata.creationIdentity !== creationIdentity ||
        metadata.filename !== publishedFilename ||
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
      // An observed rename is not a durability receipt. This also upgrades
      // older valid sidecars by syncing their unchanged original files before
      // emitting the existing proof; never changes identity or archive hash.
      await syncPublication([output, `${output}.meta.json`], true);
      verify(await store.read(data.taskId));
      publishedCreation = resultFor(metadata, details, publishedFilename);
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
      lifecycleTimer = setTimeout(() => {
        controller.abort(new BackupCommandError('BACKUP_TASK_EXPIRED'));
      }, Math.min(BACKUP_TASK_MAX_AGE_MS, Math.max(1, deadline - Date.now())));
      lifecycleTimer.unref();
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
      const environment = commandEnvironment(
        databaseUrl,
        process.env,
        lock.sessionUser,
      );
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
        const requestedTables = data.params.tables?.filter(validTable) ?? [];
        if (
          data.params.tables &&
          requestedTables.length !== data.params.tables.length
        )
          throw new BackupCommandError('BACKUP_TABLES_INVALID');
        const tables = requestedTables.length
          ? await lock.resolveTables(requestedTables)
          : [];
        const sourceManifest = lock.hasTimescale
          ? await lock.readTimescaleManifest()
          : undefined;
        const databaseSettings = await lock.readDatabaseSettings();
        await progress(1, '正在创建 PostgreSQL 自定义格式备份');
        const dumpStartedAt = new Date().toISOString();
        await processCommand(
          commandPath(options.env.PG_DUMP_PATH, 'pg_dump'),
          [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            `--role=${lock.effectiveRole}`,
            `--file=${partial}`,
            ...(tables.length ? ['--strict-names'] : []),
            ...tables.map(
              (table) => `--table-and-children=${literalTablePattern(table)}`,
            ),
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
        const dumpCompletedAt = new Date().toISOString();
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
          controller.signal,
        );
        const execution = {
          timeSource: 'dump-start' as const,
          dumpStartedAt,
          dumpCompletedAt,
          publicationStartedAt: new Date().toISOString(),
        };
        const metadata = backupArtifactMetadataSchema.parse(
          sourceManifest
            ? {
                version: 4,
                creationIdentity,
                execution,
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
                execution,
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
        await syncPublication(
          [partial, metadataPartialPath],
          false,
          controller.signal,
        );
        await check();
        await lock.ensureHeld();
        checkDeadline();
        await rename(metadataPartialPath, `${output}.meta.json`);
        metadataPartialPath = undefined;
        metadataPublishedPath = `${output}.meta.json`;
        // The final dump name is the API's discovery boundary. Publish it
        // only after its complete sidecar exists; a failed rename removes the
        // orphan sidecar and partial archive in the catch path.
        await check();
        await lock.ensureHeld();
        checkDeadline();
        await rename(partial, output);
        publishedCreationObserved = true;
        artifactPath = undefined;
        metadataPublishedPath = undefined;
        await syncPublication([], true, controller.signal);
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
      // A private copy separates restoration from shared archive writers. Keep
      // the timeout active through copy/header/hash, and await real settlement
      // before its owner cleans anything; never Promise.race file operations.
      const snapshotTimer = setTimeout(() => {
        controller.abort(new BackupCommandError('BACKUP_COMMAND_TIMEOUT'));
      }, timeoutMs);
      snapshotTimer.unref();
      try {
        restoreSnapshotDirectory = await mkdtemp(
          resolve(tmpdir(), 'neo-backup-restore-'),
        );
        await chmod(restoreSnapshotDirectory, 0o700);
        restoreSnapshotPath = resolve(restoreSnapshotDirectory, 'archive.dump');
        if (
          (await copyRestoreSnapshot(input, restoreSnapshotPath, {
            maxBytes,
            signal: controller.signal,
            checkpoint: async () => {
              await check();
              await lock.ensureHeld();
            },
          })) !== metadata.archiveSha256
        )
          throw new BackupCommandError('BACKUP_METADATA_MISMATCH');
      } finally {
        clearTimeout(snapshotTimer);
      }
      if (metadata.sourceEngine === 'timescaledb') {
        const liveManifest = await lock.readTimescaleManifest();
        if (
          metadata.timescale.extensionVersion !== liveManifest.extensionVersion
        )
          throw new BackupCommandError('BACKUP_TIMESCALE_VERSION_MISMATCH');
        await progress(5, '正在创建隔离 TimescaleDB 恢复数据库');
        const restoredDatabase = await restoreTimescaleIsolated({
          databaseUrl,
          directoryFile: restoreSnapshotPath,
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
          directoryFile: restoreSnapshotPath,
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
      await lock.assertSelectiveRestoreSupported(metadata.tables);
      await processCommand(
        commandPath(options.env.PG_RESTORE_PATH, 'pg_restore'),
        restoreCommandArgs(
          environment.PGDATABASE!,
          restoreSnapshotPath,
          lock.effectiveRole,
        ),
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
    } catch (caught) {
      const error =
        caught instanceof BackupCommandError &&
        [
          'BACKUP_RESTORE_CLEANUP_FAILED',
          'BACKUP_RESTORE_CREATE_UNCONFIRMED',
        ].includes(caught.reason)
          ? caught
          : !(caught instanceof TaskStopped) &&
            controller.signal.reason instanceof BackupCommandError
          ? controller.signal.reason
          : caught;
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
          (error.state.cancelRequestedAt ||
            error.state.status === 'cancelling') &&
          !cleanupFailed
        ) {
          await mutate({ kind: 'cancelled', message: cancelledResult.message });
          return cancelledResult;
        }
        if (!cleanupFailed) throw new UnrecoverableError('备份任务已停止');
      }
      let message = publishedStagingDatabase
        ? `隔离数据库 ${publishedStagingDatabase} 已恢复，但任务状态未确认；请人工核对，在线目标库未切换`
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_TASK_EXPIRED'
        ? '备份任务超过六天执行期限，请核对状态后重新提交'
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
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_SELECTIVE_RESTORE_DEPENDENCIES'
        ? '所选表有未包含在归档中的外部依赖，禁止原位恢复；请使用完整隔离恢复或包含依赖的备份'
        : error instanceof BackupCommandError &&
          error.reason === 'BACKUP_PUBLICATION_SYNC_UNCONFIRMED'
        ? '备份文件持久化同步未确认，请按任务 ID 核对归档和元数据，禁止自动创建替代备份'
        : '备份任务失败，请核实数据库状态和备份文件';
      if (cleanupFailed)
        message += '；备份产物清理未确认，请按任务 ID 核对残留产物';
      let cancelled = false;
      const retryCreation =
        data.operation === 'create' &&
        !cleanupFailed &&
        !publishedCreationObserved &&
        !(
          error instanceof BackupCommandError &&
          error.reason === 'BACKUP_TASK_EXPIRED'
        ) &&
        job.attemptsMade + 1 < (job.opts?.attempts ?? 2);
      const uncertain = Boolean(
        cleanupFailed ||
          publishedStagingDatabase ||
          publishedCreationObserved ||
          (error instanceof BackupCommandError &&
            [
              'BACKUP_RESTORE_CLEANUP_FAILED',
              'BACKUP_RESTORE_CREATE_UNCONFIRMED',
            ].includes(error.reason)),
      );
      try {
        await options.assertJobLock(job, token);
        const state = verify(await store.read(data.taskId));
        if (
          (state.cancelRequestedAt || state.status === 'cancelling') &&
          !uncertain
        ) {
          await mutate({ kind: 'cancelled', message: cancelledResult.message });
          cancelled = true;
        } else if (!retryCreation) {
          const failed = await mutate({
            kind: uncertain ? 'failed' : 'backup-uncommitted-failed',
            message,
          });
          cancelled = failed.status === 'cancelled';
        }
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
      if (lifecycleTimer) clearTimeout(lifecycleTimer);
      // A cleanup failure is an operational warning, never a failed committed
      // restore receipt. Remove only our exact private file and empty directory.
      for (const [path, cleanup] of [
        [restoreSnapshotPath, unlink],
        [restoreSnapshotDirectory, rmdir],
      ] as const) {
        if (!path) continue;
        try {
          await cleanup(path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code !== 'ENOENT')
            log.warn('恢复临时归档清理未确认，请按任务 ID 核对', {
              reason: 'backup_restore_snapshot_cleanup_failed',
              taskId: data.taskId,
              target: data.target,
              code: code && cleanupErrorCodes.has(code) ? code : 'UNKNOWN',
            });
        }
      }
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
