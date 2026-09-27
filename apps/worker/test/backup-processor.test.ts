import { type BackupJobData } from '@asin-monitor/contracts';
import {
  transitionTask,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import type { Job } from 'bullmq';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  commandEnvironment,
  createBackupProcessor,
  processCommand,
  restoreCommandArgs,
  stagingDatabaseName,
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
      env: {} as never,
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

  it('terminates on oversized output instead of waiting for command timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-command-'));
    try {
      const output = join(directory, 'artifact.partial');
      await writeFile(output, Buffer.alloc(2048));
      await expect(
        processCommand(
          process.execPath,
          ['-e', 'setInterval(() => undefined, 1000)', `--file=${output}`],
          { ...process.env },
          { ...options(new AbortController().signal), maxBytes: 1024 },
        ),
      ).rejects.toThrow('BACKUP_MAX_BYTES_EXCEEDED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not reuse inherited PostgreSQL credentials', () => {
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
    const withoutPassword = commandEnvironment('postgresql://localhost/main');
    expect(withoutPassword.PGPASSWORD).toBeUndefined();
    expect(withoutPassword.PGPORT).toBeUndefined();
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
});
