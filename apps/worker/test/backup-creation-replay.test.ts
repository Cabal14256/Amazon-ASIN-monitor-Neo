import {
  backupArtifactMetadataSchema,
  type BackupJobData,
} from '@asin-monitor/contracts';
import {
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupProcessor } from '../src/backup-processor';

const dependencies = vi.hoisted(() => ({ pool: vi.fn(), spawn: vi.fn() }));
const filesystemFailure = vi.hoisted(() => ({
  unlinkSuffix: null as string | null,
  renameSuffix: null as string | null,
  code: 'EACCES',
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    unlink: async (path: string) => {
      if (
        filesystemFailure.unlinkSuffix &&
        path.endsWith(filesystemFailure.unlinkSuffix)
      ) {
        await fs.lstat(path);
        throw Object.assign(new Error(`private-token ${path}`), {
          code: filesystemFailure.code,
        });
      }
      return fs.unlink(path);
    },
    rename: async (from: string, to: string) => {
      if (
        filesystemFailure.renameSuffix &&
        from.endsWith(filesystemFailure.renameSuffix)
      )
        throw Object.assign(new Error(`private-token ${from}`), {
          code: 'EIO',
        });
      return fs.rename(from, to);
    },
  };
});
vi.mock('@asin-monitor/db', async (original) => ({
  ...(await original<typeof import('@asin-monitor/db')>()),
  createPgPool: dependencies.pool,
}));
vi.mock('node:child_process', () => ({ spawn: dependencies.spawn }));
const directories: string[] = [];
afterEach(async () => {
  filesystemFailure.unlinkSuffix = null;
  filesystemFailure.renameSuffix = null;
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.resetAllMocks();
});

async function fixture(createdAt = new Date().toISOString()) {
  const directory = await mkdtemp(join(tmpdir(), 'neo-backup-replay-'));
  directories.push(directory);
  const data: BackupJobData = {
    taskId: '10000000-0000-4000-8000-000000000161',
    taskType: 'backup',
    taskSubType: 'create',
    operation: 'create',
    target: 'primary',
    userId: 'backup-owner',
    createdAt,
    params: { description: 'nightly fixture' },
  };
  let current: TaskState = {
    ...data,
    status: 'pending',
    progress: 0,
    title: 'backup',
    message: '',
    error: null,
    result: null,
    updatedAt: data.createdAt,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    revision: 0,
  };
  const query = vi.fn(async (text: string) => ({
    rows: text.includes('pg_try_advisory_lock')
      ? [{ acquired: true }]
      : text.includes('SELECT EXISTS')
      ? [{ enabled: false }]
      : text.includes('pg_encoding_to_char')
      ? [
          {
            encoding: 'UTF8',
            lcCollate: 'C',
            lcCtype: 'C',
            localeProvider: 'c',
          },
        ]
      : text.includes('timezone')
      ? [{ timezone: 'Asia/Shanghai' }]
      : [],
  }));
  dependencies.pool.mockImplementation(() => ({
    connect: async () => ({ query, release: vi.fn() }),
    end: vi.fn(),
  }));
  let failedDumps = 0;
  dependencies.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null,
      stderr: { resume: vi.fn() },
      kill: vi.fn(),
    });
    void Promise.resolve().then(async () => {
      const output = args.find((arg) => arg.startsWith('--file='))!.slice(7);
      await writeFile(output, 'PGDMPfixture');
      const code = failedDumps-- > 0 ? 1 : 0;
      child.exitCode = code;
      child.emit('close', code, null);
    });
    return child;
  });
  const store = {
    read: vi.fn(async () => current),
    mutate: vi.fn(async (_id: string, change: TaskMutation) => {
      current = transitionTask(current, change, new Date());
      return current;
    }),
  };
  const execution = {
    isClosing: vi.fn(() => false),
    assertJobLock: vi.fn(async () => undefined),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const processor = createBackupProcessor(
    store,
    {
      env: {
        DATABASE_URL: 'postgresql://fixture@localhost/source',
        COMPETITOR_DATABASE_URL: 'postgresql://fixture@localhost/competitor',
        BACKUP_STORAGE_DIRECTORY: directory,
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: 2000,
        BACKUP_COMMAND_TIMEOUT_MS: 2000,
        BACKUP_MAX_BYTES: 1024,
      } as never,
      shutdownSignal: new AbortController().signal,
      ...execution,
      updateProgress: vi.fn(async () => undefined),
    },
    log,
  );
  const job = {
    id: data.taskId,
    name: 'create',
    data,
    attemptsMade: 0,
    opts: { attempts: 2 },
  } as Job;
  return {
    directory,
    data,
    job,
    store,
    processor,
    log,
    execution,
    state: () => current,
    setState: (value: TaskState) => {
      current = value;
    },
    failDumps: (value: number) => {
      failedDumps = value;
    },
  };
}

describe('creation attempts and durable publication', () => {
  it.each(['cancelling', 'cancelled', 'failed'] as const)(
    'recovers a durable publication before respecting later %s metadata',
    async (status) => {
      const f = await fixture();
      const result = await f.processor(f.job, 'lock');
      f.setState({
        ...f.state(),
        status,
        result: null,
        cancelRequestedAt: new Date().toISOString(),
        cancelledAt: status === 'cancelled' ? new Date().toISOString() : null,
      });
      f.job.attemptsMade = 1;
      expect(await f.processor(f.job, 'lock')).toEqual(result);
      expect(f.state()).toMatchObject({
        status: 'completed',
        result,
        cancelledAt: null,
      });
      expect(dependencies.spawn).toHaveBeenCalledTimes(1);
    },
  );
  it('does not turn a damaged committed archive into a successful cancellation', async () => {
    const f = await fixture();
    const result = (await f.processor(f.job, 'lock')) as { filename: string };
    await writeFile(join(f.directory, result.filename), 'PGDMPcorrupt');
    f.setState({
      ...f.state(),
      status: 'cancelling',
      result: null,
      cancelRequestedAt: new Date().toISOString(),
    });
    f.job.attemptsMade = 1;
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.state().status).not.toBe('completed');
    expect(dependencies.spawn).toHaveBeenCalledTimes(1);
  });
  it('stops before a replacement dump when its previous partial cannot be removed', async () => {
    const f = await fixture();
    f.failDumps(1);
    filesystemFailure.unlinkSuffix = '.dump.partial';
    filesystemFailure.code = 'EACCES';
    await expect(f.processor(f.job, 'lock')).rejects.not.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.state().status).toBe('processing');
    expect(dependencies.spawn).toHaveBeenCalledOnce();
    f.job.attemptsMade = 1;
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(dependencies.spawn).toHaveBeenCalledOnce();
    expect(f.state()).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('产物清理未确认'),
    });
    expect(f.log.warn).toHaveBeenCalledWith(
      '备份产物清理失败，请按任务 ID 核对残留产物',
      expect.objectContaining({
        taskId: f.data.taskId,
        artifact: 'archive-partial',
        code: 'EACCES',
      }),
    );
  });
  it.each([
    ['archive-partial', '.dump.partial', null, 'EACCES'],
    ['metadata-partial', '.meta.json.partial', '.meta.json.partial', 'EROFS'],
    ['metadata-orphan', '.meta.json', '.dump.partial', 'EIO'],
    ['archive-partial', '.dump.partial', null, 'ESECRET_TOKEN_VALUE'],
  ] as const)(
    'reports an orphaned %s after failed publication and failed cleanup',
    async (artifact, suffix, renameSuffix, code) => {
      const f = await fixture();
      f.job.opts.attempts = 1;
      if (!renameSuffix) f.failDumps(1);
      filesystemFailure.unlinkSuffix = suffix;
      filesystemFailure.renameSuffix = renameSuffix;
      filesystemFailure.code = code;
      await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(f.log.warn).toHaveBeenCalledWith(
        '备份产物清理失败，请按任务 ID 核对残留产物',
        {
          reason: 'backup_artifact_cleanup_failed',
          taskId: f.data.taskId,
          target: 'primary',
          artifact,
          code: code === 'ESECRET_TOKEN_VALUE' ? 'UNKNOWN' : code,
        },
      );
      expect(f.state()).toMatchObject({
        status: 'failed',
        message: expect.stringContaining('产物清理未确认'),
      });
      expect(
        (await readdir(f.directory)).some((name) => name.endsWith(suffix)),
      ).toBe(true);
      const logs = JSON.stringify([
        f.log.warn.mock.calls,
        f.log.error.mock.calls,
      ]);
      expect(logs).not.toContain(f.directory);
      expect(logs).not.toContain('private-token');
      expect(logs).not.toContain('ESECRET_TOKEN_VALUE');
    },
  );
  it('retries a transient dump failure without making task metadata terminal', async () => {
    const f = await fixture();
    f.failDumps(1);
    const failed = f.processor(f.job, 'lock');
    await expect(failed).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(f.state().status).toBe('processing');
    expect(f.log.error).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual([]);
    f.job.attemptsMade = 1;
    const result = (await f.processor(f.job, 'lock')) as { filename: string };
    expect(f.state().status).toBe('completed');
    expect(dependencies.spawn).toHaveBeenCalledTimes(2);
    expect(result.filename).toContain(f.data.taskId.replaceAll('-', ''));
    expect((await readdir(f.directory)).sort()).toEqual(
      [result.filename, `${result.filename}.meta.json`].sort(),
    );
    const metadata = backupArtifactMetadataSchema.parse(
      JSON.parse(
        await readFile(
          join(f.directory, `${result.filename}.meta.json`),
          'utf8',
        ),
      ),
    );
    expect(metadata).toMatchObject({
      description: 'nightly fixture',
      creationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it.each([false, true])(
    'returns a bounded publication receipt after completion ACK loss (already committed=%s)',
    async (commit) => {
      const f = await fixture();
      const mutate = f.store.mutate.getMockImplementation()!;
      let lose = true;
      f.store.mutate.mockImplementation(async (id, change) => {
        if (lose && change.kind === 'backup-create-committed') {
          lose = false;
          if (commit) await mutate(id, change);
          throw new Error('private-redis-token');
        }
        return mutate(id, change);
      });
      const result = (await f.processor(f.job, 'lock')) as { filename: string };
      expect(result).toMatchObject({
        operation: 'create',
        target: 'primary',
        format: 'custom',
      });
      expect(
        JSON.stringify(result) + JSON.stringify(f.log.warn.mock.calls),
      ).not.toContain('private-redis');
      // No registry completion was committed: model process exit after the
      // final archive rename, followed by cancellation before redelivery.
      if (!commit)
        f.setState({
          ...f.state(),
          status: 'cancelling',
          cancelRequestedAt: new Date().toISOString(),
        });
      f.job.attemptsMade = 1;
      expect(await f.processor(f.job, 'lock')).toEqual(result);
      expect(dependencies.spawn).toHaveBeenCalledTimes(1);
      expect(f.state().status).toBe('completed');
    },
  );
  it('recovers a validated published archive after execution lease and shutdown loss without database work', async () => {
    const f = await fixture();
    const result = await f.processor(f.job, 'lock');
    f.setState({ ...f.state(), status: 'processing', result: null });
    f.execution.isClosing.mockReturnValue(true);
    f.execution.assertJobLock.mockRejectedValue(
      new Error('private-lease-token'),
    );
    dependencies.pool.mockClear();
    expect(await f.processor(f.job, 'expired-lock')).toEqual(result);
    expect(dependencies.pool).not.toHaveBeenCalled();
    expect(dependencies.spawn).toHaveBeenCalledTimes(1);
    expect(f.state().status).toBe('completed');
  });
  it('accepts cancellation while hashing an already published file and keeps its original recovery point', async () => {
    const f = await fixture('2026-09-01T16:00:00.123Z');
    const result = (await f.processor(f.job, 'lock')) as {
      filename: string;
      createdAt: string;
    };
    f.setState({ ...f.state(), status: 'processing', result: null });
    const read = f.store.read.getMockImplementation()!;
    let reads = 0;
    f.store.read.mockImplementation(async () => {
      if (++reads === 3)
        f.setState({
          ...f.state(),
          status: 'cancelling',
          cancelRequestedAt: new Date().toISOString(),
        });
      return read();
    });
    expect(await f.processor(f.job, 'lock')).toEqual(result);
    expect(f.state().status).toBe('completed');
    expect(result.createdAt).toBe('2026-09-01T16:00:00.000Z');
    expect(dependencies.spawn).toHaveBeenCalledTimes(1);
  });
  it('still cancels an unpublished creation without running a dump or database lease', async () => {
    const f = await fixture();
    f.setState({
      ...f.state(),
      status: 'cancelling',
      cancelRequestedAt: new Date().toISOString(),
    });
    expect(await f.processor(f.job, 'lock')).toMatchObject({ cancelled: true });
    expect(f.state().status).toBe('cancelled');
    expect(dependencies.spawn).not.toHaveBeenCalled();
    expect(dependencies.pool).not.toHaveBeenCalled();
  });
  it('fails closed when task ownership changes during published archive verification', async () => {
    const f = await fixture();
    await f.processor(f.job, 'lock');
    f.setState({ ...f.state(), status: 'processing', result: null });
    const read = f.store.read.getMockImplementation()!;
    let reads = 0;
    f.store.read.mockImplementation(async () => {
      if (++reads === 3)
        f.setState({ ...f.state(), userId: 'replacement-owner' });
      return read();
    });
    f.job.attemptsMade = 1;
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.state()).toMatchObject({
      userId: 'replacement-owner',
      status: 'processing',
      result: null,
    });
    expect(dependencies.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain(
      'replacement-owner',
    );
  });
  it('refuses a published file when the immutable request differs and does not dump again', async () => {
    const f = await fixture();
    const result = (await f.processor(f.job, 'lock')) as { filename: string };
    f.setState({ ...f.state(), status: 'processing', completedAt: null });
    f.job.attemptsMade = 1;
    f.job.data = { ...f.data, params: { description: 'different request' } };
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(dependencies.spawn).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.directory, result.filename), 'utf8')).toBe(
      'PGDMPfixture',
    );
  });
  it('fails terminally only after the last creation attempt', async () => {
    const f = await fixture();
    f.failDumps(1);
    f.job.attemptsMade = 1;
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.state().status).toBe('failed');
    expect(await readdir(f.directory)).toEqual([]);
  });
  it('cleans its own interrupted prepublication files and publishes one final archive', async () => {
    const f = await fixture();
    const result = (await f.processor(f.job, 'lock')) as { filename: string };
    // Model a process exit after publishing metadata but before the archive rename.
    await rename(
      join(f.directory, result.filename),
      join(f.directory, `${result.filename}.partial`),
    );
    f.setState({ ...f.state(), status: 'processing', completedAt: null });
    f.job.attemptsMade = 1;
    expect(await f.processor(f.job, 'lock')).toMatchObject({
      filename: result.filename,
    });
    expect(dependencies.spawn).toHaveBeenCalledTimes(2);
    expect((await readdir(f.directory)).sort()).toEqual(
      [result.filename, `${result.filename}.meta.json`].sort(),
    );
    expect(f.state().status).toBe('completed');
  });
  it('refuses a corrupt published archive without overwriting it', async () => {
    const f = await fixture();
    const result = (await f.processor(f.job, 'lock')) as { filename: string };
    await writeFile(join(f.directory, result.filename), 'PGDMPcorrupt');
    f.setState({ ...f.state(), status: 'processing', completedAt: null });
    f.job.attemptsMade = 1;
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(dependencies.spawn).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.directory, result.filename), 'utf8')).toBe(
      'PGDMPcorrupt',
    );
  });
  it('does not replay a previously started restore', async () => {
    const f = await fixture();
    f.job.data = {
      ...f.data,
      taskSubType: 'restore',
      operation: 'restore',
      params: { filename: 'backup_20260927-020000-abcdef01-primary.dump' },
    };
    f.job.name = 'restore';
    f.job.opts.attempts = 1;
    f.setState({
      ...f.state(),
      taskSubType: 'restore',
      status: 'processing',
      startedAt: new Date().toISOString(),
    });
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(dependencies.pool).not.toHaveBeenCalled();
    expect(dependencies.spawn).not.toHaveBeenCalled();
  });
});
