import { getBackupStorageDirectory, type Env } from '@asin-monitor/config';
import {
  backupArtifactMetadataSchema,
  backupJobDataSchema,
  type BackupJobData,
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
): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database || !url.hostname)
    throw new BackupCommandError('BACKUP_DATABASE_URL_INVALID');
  const sslMode = url.searchParams.get('sslmode');
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
  // Libpq falls back to inherited PG* values when one is absent. Clear them so
  // a URL without a password/port cannot silently select another database.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('PG'),
    ),
  );
  return {
    ...inherited,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    ...(url.port ? { PGPORT: url.port } : {}),
    ...(url.username ? { PGUSER: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
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
        if (stopError) finish(stopError);
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
    statement_timeout: 2000,
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
      if (data.operation === 'restore' && lock.hasTimescale)
        throw new BackupCommandError('BACKUP_TIMESCALE_RESTORE_UNSUPPORTED');
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
        await chmod(partial, 0o600);
        await progress(100, '备份完成');
        await rename(partial, output);
        // A valid dump is now discoverable. Keep it for operator reconciliation
        // if the following Redis completion acknowledgement is ambiguous.
        artifactPath = undefined;
        const metadata = backupArtifactMetadataSchema.parse({
          version: 1,
          filename,
          target: data.target,
          sourceEngine: lock.hasTimescale ? 'timescaledb' : 'postgresql',
        });
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
          restoreSupported: !lock.hasTimescale,
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
        const sidecar = `${input}.meta.json`;
        const details = await lstat(sidecar);
        if (!details.isFile() || details.size > 4096)
          throw new Error('BACKUP_METADATA_INVALID');
        metadata = backupArtifactMetadataSchema.parse(
          JSON.parse(await readFile(sidecar, 'utf8')),
        );
      } catch {
        throw new BackupCommandError('BACKUP_METADATA_UNVERIFIED');
      }
      if (metadata.filename !== filename || metadata.target !== data.target)
        throw new BackupCommandError('BACKUP_METADATA_UNVERIFIED');
      if (metadata.sourceEngine !== 'postgresql')
        throw new BackupCommandError('BACKUP_TIMESCALE_RESTORE_UNSUPPORTED');
      await progress(5, '正在恢复 PostgreSQL 备份');
      await processCommand(
        commandPath(options.env.PG_RESTORE_PATH, 'pg_restore'),
        restoreCommandArgs(environment.PGDATABASE!, input),
        environment,
        {
          timeoutMs,
          maxBytes,
          signal: controller.signal,
          checkpoint: async () => {
            await check();
            await lock.ensureHeld();
          },
          onProgress: async () => {
            await progress(50, '正在执行 PostgreSQL 恢复');
          },
        },
      );
      await lock.ensureHeld();
      await healthCheck(options.env, data.target);
      await progress(100, '恢复完成');
      const completed = await mutate({
        kind: 'completed',
        result: {
          operation: 'restore',
          format: 'custom',
          message: '恢复完成',
          filename,
          target: data.target,
        },
        message: '恢复完成',
      });
      log.info('PostgreSQL 恢复任务完成', { target: data.target });
      return completed.result;
    } catch (error) {
      if (artifactPath) await unlink(artifactPath).catch(() => undefined);
      if (metadataPartialPath)
        await unlink(metadataPartialPath).catch(() => undefined);
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
      const message =
        error instanceof BackupCommandError &&
        error.reason === 'BACKUP_TIMESCALE_RESTORE_UNSUPPORTED'
          ? 'TimescaleDB 不支持通过 Neo 接口原位恢复，请在隔离库按运行手册恢复'
          : error instanceof BackupCommandError &&
            error.reason === 'BACKUP_TIMESCALE_TABLE_DUMP_UNSUPPORTED'
          ? 'TimescaleDB 不支持通过 Neo 接口按表备份，请创建完整数据库备份'
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
        if (state.cancelRequestedAt || state.status === 'cancelling') {
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
