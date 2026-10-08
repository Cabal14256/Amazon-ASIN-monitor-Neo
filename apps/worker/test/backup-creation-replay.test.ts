import {
  backupArtifactMetadataSchema,
  type BackupJobData,
} from '@asin-monitor/contracts';
import {
  backupCreationIdentity,
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAbortSignal, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupProcessor } from '../src/backup-processor';

const dependencies = vi.hoisted(() => ({ pool: vi.fn(), spawn: vi.fn() }));
const filesystemFailure = vi.hoisted(() => ({
  unlinkSuffix: null as string | null,
  renameSuffix: null as string | null,
  code: 'EACCES',
  stallHash: false,
  hashStream: null as import('node:stream').PassThrough | null,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    createReadStream: (path: string, options?: { signal?: AbortSignal }) => {
      if (!filesystemFailure.stallHash)
        return fs.createReadStream(path, options);
      const stream = new PassThrough();
      filesystemFailure.hashStream = stream;
      if (options?.signal) addAbortSignal(options.signal, stream);
      return stream;
    },
  };
});
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
  vi.useRealTimers();
  filesystemFailure.stallHash = false;
  filesystemFailure.hashStream?.destroy();
  filesystemFailure.hashStream = null;
  filesystemFailure.unlinkSuffix = null;
  filesystemFailure.renameSuffix = null;
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(createdAt = new Date().toISOString(), ttl = 604800) {
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
  const query = vi.fn(
    async (
      input: string | { text: string; values?: unknown[] },
    ): Promise<{ rows: Record<string, unknown>[] }> => {
      const text = typeof input === 'string' ? input : input.text;
      return {
        rows: text.includes('backup_table_selection')
          ? (input as { values: string[][] }).values[0].map((name) => {
              const parts = [...name.matchAll(/"((?:[^"]|"")*)"/g)].map(
                (part) => part[1].replaceAll('""', '"'),
              );
              return {
                schema: parts.length === 2 ? parts[0] : 'application',
                name: parts.at(-1),
                kind: 'r',
                persistence: 'p',
              };
            })
          : text.includes('backup_selective_restore_dependencies')
          ? [{ blocked: false }]
          : text.includes('pg_try_advisory_lock')
          ? [{ acquired: true }]
          : text.includes('current_user AS role')
          ? [{ role: 'restricted Backup"Role', sessionUser: 'fixture' }]
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
      };
    },
  );
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
  const shutdown = new AbortController();
  const publicationSync = {
    syncFile: vi.fn(async (path: string) => {
      const handle = await open(path, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }),
    // Windows cannot fsync a directory with Node. Publication ordering is
    // injected here; Linux real-CLI Integration uses the default native path.
    syncDirectory: vi.fn(async (_path: string): Promise<void> => undefined),
  };
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
        TASK_META_TTL_SECONDS: ttl,
      } as never,
      shutdownSignal: shutdown.signal,
      ...execution,
      publicationSync,
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
    publicationSync,
    shutdown,
    query,
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
  it('rebuilds the confirmed session authorization even when it equals the login user', async () => {
    const f = await fixture();
    vi.stubEnv(
      'PGOPTIONS',
      '-c session_authorization=unconfirmed -c search_path=application',
    );
    await f.processor(f.job, 'lock');
    expect(dependencies.spawn).toHaveBeenCalledOnce();
    expect(dependencies.spawn.mock.calls[0]?.[2].env.PGOPTIONS).toBe(
      '-c session_authorization=fixture',
    );
    expect(dependencies.spawn.mock.calls[0]?.[1]).toContain(
      '--role=restricted Backup"Role',
    );
    expect(f.query).toHaveBeenCalledWith(
      'SELECT current_user AS role, session_user AS "sessionUser"',
    );
    expect(f.state().status).toBe('completed');
  });
  it('runs pg_dump with the effective role from the locked application session while isolating arbitrary startup options', async () => {
    const f = await fixture();
    vi.stubEnv(
      'PGOPTIONS',
      '-c role=inherited_other -c search_path=application',
    );
    await f.processor(f.job, 'lock');
    expect(dependencies.spawn).toHaveBeenCalledOnce();
    expect(dependencies.spawn.mock.calls[0]?.[1]).toContain(
      '--role=restricted Backup"Role',
    );
    expect(dependencies.spawn.mock.calls[0]?.[2].env.PGOPTIONS).toBe(
      '-c session_authorization=fixture',
    );
    expect(f.query).toHaveBeenCalledWith(
      'SELECT current_user AS role, session_user AS "sessionUser"',
    );
  });
  it.each([undefined, null, '', 'invalid\0role'])(
    'rejects an unconfirmed effective role before any backup command (%s)',
    async (role) => {
      const f = await fixture();
      const original = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (input) => {
        const text = typeof input === 'string' ? input : input.text;
        return text.includes('current_user AS role')
          ? {
              rows:
                role === undefined ? [] : [{ role, sessionUser: 'fixture' }],
            }
          : original(input);
      });
      await expect(f.processor(f.job, 'lock')).rejects.toThrow(
        '备份任务失败，请核实数据库状态和备份文件',
      );
      expect(dependencies.spawn).not.toHaveBeenCalled();
      expect(f.state().result).toBeNull();
      expect(await readdir(f.directory)).toEqual([]);
    },
  );
  it.each([undefined, null, '', 'invalid\0session', 42, 'x'.repeat(1025)])(
    'rejects an unconfirmed session user before creating any archive (%s)',
    async (sessionUser) => {
      const f = await fixture();
      const original = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (input) => {
        const text = typeof input === 'string' ? input : input.text;
        return text.includes('current_user AS role')
          ? { rows: [{ role: 'restricted Backup"Role', sessionUser }] }
          : original(input);
      });
      await expect(f.processor(f.job, 'lock')).rejects.toThrow(
        '备份任务失败，请核实数据库状态和备份文件',
      );
      expect(dependencies.spawn).not.toHaveBeenCalled();
      expect(f.state().result).toBeNull();
      expect(await readdir(f.directory)).toEqual([]);
    },
  );
  it('rebuilds only the confirmed session authorization with PostgreSQL option escaping', async () => {
    const f = await fixture();
    const role = 'Current "Odd"\\Role';
    const sessionUser = 'Session "Odd"\\Role -c role=broader\tline\nend\r\v\f';
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (input) => {
      const text = typeof input === 'string' ? input : input.text;
      return text.includes('current_user AS role')
        ? { rows: [{ role, sessionUser }] }
        : original(input);
    });
    vi.stubEnv(
      'PGOPTIONS',
      '-c session_authorization=unconfirmed -c role=broader -c search_path=private',
    );
    await f.processor(f.job, 'lock');
    expect(dependencies.spawn).toHaveBeenCalledOnce();
    const [, args, options] = dependencies.spawn.mock.calls[0]!;
    expect(args).toContain('--role=Current "Odd"\\Role');
    expect(options.env.PGOPTIONS).toBe(
      '-c session_authorization=Session\\ "Odd"\\\\Role\\ -c\\ role=broader\\\tline\\\nend\\\r\\\v\\\f',
    );
    expect(options.env.PGOPTIONS).not.toContain('unconfirmed');
    expect(options.env.PGOPTIONS).not.toContain('search_path');
    expect(options.shell).toBe(false);
    expect(f.state().status).toBe('completed');
  });
  it('resolves unqualified queued tables on the actual NodePG lock session, freezes canonical metadata and isolates CLI options', async () => {
    const f = await fixture();
    vi.stubEnv(
      'PGOPTIONS',
      '-c search_path=application -c statement_timeout=999999',
    );
    f.job.data = { ...f.data, params: { tables: ['Orders'] } };
    await f.processor(f.job, 'lock');
    expect(dependencies.spawn.mock.calls[0]?.[1]).toContain(
      '--table-and-children="application"."Orders"',
    );
    expect(dependencies.spawn.mock.calls[0]?.[2].env.PGOPTIONS).toBe(
      '-c session_authorization=fixture',
    );
    const filename = (f.state().result as { filename: string }).filename;
    const metadata = JSON.parse(
      await readFile(join(f.directory, `${filename}.meta.json`), 'utf8'),
    );
    expect(metadata.tables).toEqual(['application.Orders']);
    expect(metadata.creationIdentity).toBe(backupCreationIdentity(f.job.data));
    // The queued input stays unchanged; retries and older private identities
    // must not be re-hashed against the resolved sidecar table list.
    expect(f.job.data.params.tables).toEqual(['Orders']);
  });
  it('rejects a changed API-frozen namespace in the locked session before starting pg_dump', async () => {
    const f = await fixture();
    f.job.data = { ...f.data, params: { tables: ['expected.Orders'] } };
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (input) => {
      const text = typeof input === 'string' ? input : input.text;
      return text.includes('backup_table_selection')
        ? {
            rows: [
              { schema: 'other', name: 'Orders', kind: 'r', persistence: 'p' },
            ],
          }
        : query(input);
    });
    await expect(f.processor(f.job, 'lock')).rejects.toThrow(
      '备份任务失败，请核实数据库状态和备份文件',
    );
    expect(dependencies.spawn).not.toHaveBeenCalled();
    expect(f.state().result).toBeNull();
    expect(await readdir(f.directory)).toEqual([]);
  });
  it('checks incoming dependency safety again under the target lease before any restore command', async () => {
    const f = await fixture();
    f.job.data = { ...f.data, params: { tables: ['public.OrderItems'] } };
    const artifact = (await f.processor(f.job, 'lock')) as { filename: string };
    const data = {
      ...f.data,
      taskSubType: 'restore',
      operation: 'restore',
      params: { filename: artifact.filename },
    };
    f.job.name = 'restore';
    f.job.data = data;
    f.setState({
      ...f.state(),
      taskSubType: 'restore',
      status: 'pending',
      startedAt: null,
      result: null,
    });
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (input) => {
      const text = typeof input === 'string' ? input : input.text;
      return text.includes('backup_selective_restore_dependencies')
        ? { rows: [{ blocked: true }] }
        : query(input);
    });
    await expect(f.processor(f.job, 'lock')).rejects.toThrow(
      '未包含在归档中的外部依赖',
    );
    expect(f.state()).toMatchObject({ status: 'failed', result: null });
    expect(dependencies.spawn).toHaveBeenCalledOnce();
  });
  it('honors cancellation during partial sync before publishing either final file', async () => {
    const f = await fixture();
    const sync = f.publicationSync.syncFile.getMockImplementation()!;
    f.publicationSync.syncFile.mockImplementation(async (path) => {
      await sync(path);
      f.setState(
        transitionTask(f.state(), { kind: 'cancel-request' }, new Date()),
      );
    });
    await expect(f.processor(f.job, 'lock')).resolves.toMatchObject({
      cancelled: true,
    });
    expect(f.state().status).toBe('cancelled');
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.publicationSync.syncDirectory).not.toHaveBeenCalled();
  });
  it('finishes a durable publication when cancellation races with successful directory sync', async () => {
    const f = await fixture();
    f.publicationSync.syncDirectory.mockImplementation(async () => {
      f.setState(
        transitionTask(f.state(), { kind: 'cancel-request' }, new Date()),
      );
    });
    await f.processor(f.job, 'lock');
    expect(f.state()).toMatchObject({ status: 'completed', cancelledAt: null });
    expect(dependencies.spawn).toHaveBeenCalledOnce();
  });
  it('does not confirm cancellation or completion after shutdown interrupts a late final directory sync', async () => {
    const f = await fixture();
    let finish!: () => void;
    f.publicationSync.syncDirectory.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const outcome = f.processor(f.job, 'lock');
    const rejected = expect(outcome).rejects.toBeInstanceOf(UnrecoverableError);
    await vi.waitFor(
      () => expect(f.publicationSync.syncDirectory).toHaveBeenCalledOnce(),
      { interval: 5 },
    );
    f.setState(
      transitionTask(f.state(), { kind: 'cancel-request' }, new Date()),
    );
    f.shutdown.abort();
    await rejected;
    finish();
    await Promise.resolve();
    expect(f.state().status).toBe('failed');
    expect(
      f.store.mutate.mock.calls.some(
        ([, mutation]) => mutation.kind === 'backup-create-committed',
      ),
    ).toBe(false);
    expect(await readdir(f.directory)).toHaveLength(2);
    f.publicationSync.syncDirectory.mockResolvedValue(undefined);
    await f.processor(f.job, 'lock');
    expect(f.state().status).toBe('completed');
    expect(dependencies.spawn).toHaveBeenCalledOnce();
  });
  it('cleans only its unpublished files after a failed partial file sync without a completed proof', async () => {
    const f = await fixture();
    f.publicationSync.syncFile.mockRejectedValue(
      new Error('private-disk-token'),
    );
    await expect(f.processor(f.job, 'lock')).rejects.toThrow();
    expect(f.state().status).toBe('processing');
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.publicationSync.syncDirectory).not.toHaveBeenCalled();
    expect(
      f.store.mutate.mock.calls.some(
        ([, mutation]) => mutation.kind === 'backup-create-committed',
      ),
    ).toBe(false);
  });
  it('does not manufacture a recovered completion after a retained final file fails sync', async () => {
    const f = await fixture();
    const result = await f.processor(f.job, 'lock');
    f.setState({ ...f.state(), status: 'failed', result: null });
    f.store.mutate.mockClear();
    f.publicationSync.syncFile.mockRejectedValue(
      new Error('private-disk-token'),
    );
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.state().status).toBe('failed');
    expect(
      f.store.mutate.mock.calls.some(
        ([, mutation]) => mutation.kind === 'backup-create-committed',
      ),
    ).toBe(false);
    expect(dependencies.spawn).toHaveBeenCalledOnce();
    f.publicationSync.syncFile.mockImplementation(async (path) => {
      const file = await open(path, 'r+');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    });
    expect(await f.processor(f.job, 'lock')).toEqual(result);
  });
  it('syncs both partial files before rename and the containing directory before the completion proof', async () => {
    const f = await fixture();
    const mutate = f.store.mutate.getMockImplementation()!;
    f.store.mutate.mockImplementation(async (id, change) => {
      if (change.kind === 'backup-create-committed') {
        expect(
          f.publicationSync.syncFile.mock.calls.map(([path]) =>
            path.slice(path.lastIndexOf('.dump')),
          ),
        ).toEqual(['.dump.partial', '.dump.meta.json.partial']);
        expect(f.publicationSync.syncDirectory).toHaveBeenCalledWith(
          f.directory,
        );
        expect(
          (await readdir(f.directory)).some((name) =>
            name.endsWith('.partial'),
          ),
        ).toBe(false);
      }
      return mutate(id, change);
    });
    await f.processor(f.job, 'lock');
    expect(f.state().status).toBe('completed');
  });
  it('retains both final files without a completed proof when directory sync fails and recovers only after successful sync', async () => {
    const f = await fixture();
    f.publicationSync.syncDirectory.mockRejectedValue(
      new Error('private-volume-token'),
    );
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.state().status).not.toBe('completed');
    expect(
      f.store.mutate.mock.calls.some(
        ([, mutation]) => mutation.kind === 'backup-create-committed',
      ),
    ).toBe(false);
    expect(
      (await readdir(f.directory)).filter((name) => !name.endsWith('.partial')),
    ).toHaveLength(2);
    f.publicationSync.syncDirectory.mockResolvedValue(undefined);
    await f.processor(f.job, 'lock');
    expect(f.state().status).toBe('completed');
    expect(
      f.publicationSync.syncFile.mock.calls
        .slice(-2)
        .map(([path]) => path.slice(path.lastIndexOf('.dump'))),
    ).toEqual(['.dump', '.dump.meta.json']);
    expect(dependencies.spawn).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain(
      'private-volume-token',
    );
  });
  it('replays an older unqualified v3 sidecar without resolving again or changing its proof and filename-time fallback', async () => {
    const f = await fixture();
    f.job.data = { ...f.data, params: { tables: ['Orders'] } };
    const current = (await f.processor(f.job, 'lock')) as {
      filename: string;
      backupCreationCommit: unknown;
    };
    const sidecarPath = join(f.directory, `${current.filename}.meta.json`);
    const metadata = JSON.parse(await readFile(sidecarPath, 'utf8'));
    delete metadata.execution;
    metadata.tables = ['Orders'];
    const originalSidecar = JSON.stringify(metadata);
    await writeFile(sidecarPath, originalSidecar);
    f.query.mockClear();
    f.query.mockRejectedValue(new Error('private-catalog-unavailable'));
    f.setState({ ...f.state(), status: 'failed', result: null });
    const result = (await f.processor(f.job, 'lock')) as {
      execution?: unknown;
      backupCreationCommit: unknown;
    };
    expect(result).toMatchObject({ timeSource: 'filename' });
    expect(result.execution).toBeUndefined();
    expect(result.backupCreationCommit).toEqual(current.backupCreationCommit);
    expect(await readFile(sidecarPath, 'utf8')).toBe(originalSidecar);
    expect(f.job.data.params.tables).toEqual(['Orders']);
    expect(f.query).not.toHaveBeenCalled();
    expect(dependencies.spawn).toHaveBeenCalledTimes(1);
  });
  it('records the actual delayed dump window and replays its original execution times', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const acceptedAt = '2026-10-01T00:00:00.000Z';
    const dumpStartedAt = '2026-10-03T01:00:00.123Z';
    const dumpCompletedAt = '2026-10-03T01:02:00.456Z';
    const publicationStartedAt = '2026-10-03T01:03:00.789Z';
    vi.setSystemTime(new Date(dumpStartedAt));
    const f = await fixture(acceptedAt);
    const spawn = dependencies.spawn.getMockImplementation()!;
    dependencies.spawn.mockImplementation((...args) => {
      const child = spawn(...args);
      vi.setSystemTime(new Date(dumpCompletedAt));
      return child;
    });
    const mutate = f.store.mutate.getMockImplementation()!;
    f.store.mutate.mockImplementation(async (id, change) => {
      if (change.kind === 'progress' && change.progress === 96)
        vi.setSystemTime(new Date(publicationStartedAt));
      return mutate(id, change);
    });
    const result = (await f.processor(f.job, 'lock')) as { filename: string };
    const execution = {
      timeSource: 'dump-start',
      dumpStartedAt,
      dumpCompletedAt,
      publicationStartedAt,
    };
    expect(result).toMatchObject({
      createdAt: dumpStartedAt,
      timeSource: 'dump-start',
      execution,
      backupCreationCommit: { taskCreatedAt: acceptedAt },
    });
    expect(result.filename).toContain('20261001-080000');
    const sidecar = JSON.parse(
      await readFile(join(f.directory, `${result.filename}.meta.json`), 'utf8'),
    );
    expect(sidecar).toMatchObject({ execution });
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
    f.setState({ ...f.state(), status: 'failed', result: null });
    expect(await f.processor(f.job, 'lock')).toEqual(result);
    expect(dependencies.spawn).toHaveBeenCalledTimes(1);
  });
  it('rejects metadata retention shorter than the bounded backup lifecycle', async () => {
    await expect(fixture(undefined, 1)).rejects.toThrow(
      'BACKUP_TASK_RETENTION_TOO_SHORT',
    );
  });
  it('fails an expired queued creation without a dump or a new retry window', async () => {
    const f = await fixture(
      new Date(Date.now() - 6 * 86400000 - 1).toISOString(),
    );
    await expect(f.processor(f.job, 'lock')).rejects.toThrow(
      '备份任务超过六天执行期限',
    );
    expect(f.state().status).toBe('failed');
    expect(dependencies.spawn).not.toHaveBeenCalled();
    expect(dependencies.pool).not.toHaveBeenCalled();
  });
  it('passes every selected table identifier as a literal pg_dump pattern', async () => {
    const f = await fixture();
    f.job.data = {
      ...f.data,
      params: {
        tables: [
          'public.OrderItems',
          'MixedSchema.MixedTable',
          'Simple',
          '"schema.dot""quoted"."OrderItems"',
        ],
      },
    };
    await f.processor(f.job, 'lock');
    expect(dependencies.spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '--strict-names',
        '--table-and-children="public"."OrderItems"',
        '--table-and-children="MixedSchema"."MixedTable"',
        '--table-and-children="application"."Simple"',
        '--table-and-children="schema.dot""quoted"."OrderItems"',
      ]),
    );
  });
  it('preserves a cancel accepted between the final failure read and its CAS', async () => {
    const f = await fixture();
    f.failDumps(1);
    f.job.attemptsMade = 1;
    const mutate = f.store.mutate.getMockImplementation()!;
    f.store.mutate.mockImplementation(async (id, change) => {
      if (['failed', 'backup-uncommitted-failed'].includes(change.kind))
        f.setState(
          transitionTask(f.state(), { kind: 'cancel-request' }, new Date()),
        );
      return mutate(id, change);
    });
    await expect(f.processor(f.job, 'lock')).resolves.toMatchObject({
      cancelled: true,
    });
    expect(f.state()).toMatchObject({ status: 'cancelled', error: null });
    expect(await readdir(f.directory)).toEqual([]);
  });
  it('preserves failure when partial cleanup is uncertain while cancellation races', async () => {
    const f = await fixture();
    f.failDumps(1);
    filesystemFailure.unlinkSuffix = '.dump.partial';
    const mutate = f.store.mutate.getMockImplementation()!;
    f.store.mutate.mockImplementation(async (id, change) => {
      if (change.kind === 'failed')
        f.setState(
          transitionTask(f.state(), { kind: 'cancel-request' }, new Date()),
        );
      return mutate(id, change);
    });
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.state().status).toBe('failed');
    expect(f.state().message).toContain('清理未确认');
    expect(await readdir(f.directory)).toHaveLength(1);
  });
  it('does not retry or confirm cancellation after an interrupted creation cannot clean its partial', async () => {
    const f = await fixture();
    filesystemFailure.unlinkSuffix = '.dump.partial';
    const mutate = f.store.mutate.getMockImplementation()!;
    f.store.mutate.mockImplementation(async (id, change) => {
      const next = await mutate(id, change);
      if (change.kind === 'progress' && change.progress === 96)
        f.setState(
          transitionTask(f.state(), { kind: 'cancel-request' }, new Date()),
        );
      return next;
    });
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.state().status).toBe('failed');
    expect(f.state().message).toContain('清理未确认');
    expect(await readdir(f.directory)).toHaveLength(1);
  });
  it('aborts a stalled hash at the original queue deadline and never publishes on a late read', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(
      new Date(Date.parse(f.data.createdAt) + 6 * 86400000 - 200),
    );
    filesystemFailure.stallHash = true;
    const outcome = f.processor(f.job, 'lock').then(
      () => 'completed',
      (error: Error) => error.message,
    );
    await vi.waitFor(
      () => expect(filesystemFailure.hashStream).not.toBeNull(),
      { interval: 10 },
    );
    // The timer was set from the remaining immutable age, not a fresh six days.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const aborted = filesystemFailure.hashStream?.destroyed;
    filesystemFailure.hashStream?.end('late hash bytes');
    const result = await outcome;
    expect(aborted).toBe(true);
    expect(result).toContain('备份任务超过六天执行期限');
    expect(f.state().status).toBe('failed');
    expect(await readdir(f.directory)).toEqual([]);
  });
  it('terminates a silent restore at the queue deadline and ignores a late callback', async () => {
    const f = await fixture();
    f.job.data = { ...f.data, params: { tables: ['public.OrderItems'] } };
    const artifact = (await f.processor(f.job, 'lock')) as { filename: string };
    const createdAt = new Date(Date.now() - 6 * 86400000 + 200).toISOString();
    const restoreData = {
      ...f.data,
      operation: 'restore',
      taskSubType: 'restore',
      createdAt,
      params: { filename: artifact.filename },
    };
    f.job.name = 'restore';
    f.job.data = restoreData;
    f.setState({
      ...f.state(),
      taskSubType: 'restore',
      createdAt,
      status: 'pending',
      startedAt: null,
      result: null,
    });
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      stderr: { resume: vi.fn() },
      kill: vi.fn(() => {
        child.signalCode = 'SIGTERM';
        child.emit('close', null, 'SIGTERM');
        return true;
      }),
    });
    dependencies.spawn.mockReturnValue(child);
    await expect(f.processor(f.job, 'lock')).rejects.toThrow(
      '备份任务超过六天执行期限',
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0, null);
    expect(f.state()).toMatchObject({ status: 'failed', result: null });
    expect(
      f.store.mutate.mock.calls.some(
        ([, change]) => change.kind === 'restore-committed',
      ),
    ).toBe(false);
  });
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
  it('stops all retries immediately when its unpublished partial cannot be removed', async () => {
    const f = await fixture();
    f.failDumps(1);
    filesystemFailure.unlinkSuffix = '.dump.partial';
    filesystemFailure.code = 'EACCES';
    await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(f.state().status).toBe('failed');
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
    ['archive-partial', '.dump.partial', null],
    ['metadata-partial', '.meta.json.partial', '.meta.json.partial'],
    ['metadata-orphan', '.meta.json', '.dump.partial'],
  ] as const)(
    'cannot confirm cancellation on redelivery after a non-cancellation failure leaves an unconfirmed %s',
    async (_artifact, suffix, renameSuffix) => {
      const f = await fixture();
      if (!renameSuffix) f.failDumps(1);
      filesystemFailure.unlinkSuffix = suffix;
      filesystemFailure.renameSuffix = renameSuffix;
      const initial = await f
        .processor(f.job, 'lock')
        .catch((error: unknown) => error);
      const files = await readdir(f.directory);
      expect(files).toHaveLength(1);
      expect(files[0]?.endsWith(suffix)).toBe(true);
      // Even an unexpected redelivery after a user requests cancellation must
      // preserve the failed/manual-check receipt, rather than forget uncertainty.
      f.setState(
        transitionTask(f.state(), { kind: 'cancel-request' }, new Date()),
      );
      f.job.attemptsMade = 1;
      await expect(f.processor(f.job, 'lock')).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(initial).toBeInstanceOf(UnrecoverableError);
      expect(f.state()).toMatchObject({
        status: 'failed',
        message: expect.stringContaining('产物清理未确认'),
      });
      expect(await readdir(f.directory)).toEqual(files);
      expect(dependencies.spawn).toHaveBeenCalledOnce();
      expect(f.log.warn).not.toHaveBeenCalledWith(
        '备份创建未发布，将使用原任务重试',
        { reason: 'backup_creation_retry' },
      );
    },
  );
  it.each([
    ['archive-partial', '.dump.partial', null, 'EACCES'],
    ['metadata-partial', '.meta.json.partial', '.meta.json.partial', 'EROFS'],
    ['metadata-orphan', '.meta.json', '.dump.partial', 'EIO'],
    ['archive-partial', '.dump.partial', null, 'ESECRET_TOKEN_VALUE'],
  ] as const)(
    'reports an orphaned %s after failed publication and failed cleanup',
    async (artifact, suffix, renameSuffix, code) => {
      const f = await fixture();
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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T16:00:00.123Z'));
    const f = await fixture('2026-09-01T16:00:00.123Z');
    const result = (await f.processor(f.job, 'lock')) as {
      filename: string;
      createdAt: string;
    };
    vi.setSystemTime(new Date('2026-09-09T16:00:00.123Z'));
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
    expect(result.createdAt).toBe('2026-09-01T16:00:00.123Z');
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
