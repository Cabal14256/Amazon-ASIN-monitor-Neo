import type { Env } from '@asin-monitor/config';
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
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackupProcessor } from '../src/backup-processor';

/** The private plain-PG database is created only on the disposable CI cluster.
 * The competing archive is a real, valid pg_dump with different table data. */
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'real pg_restore consumes only the verified private snapshot',
  () => {
    const sourceUrl = process.env.DATABASE_URL ?? '';
    const scratchName = `neo_snapshot_ci_${randomUUID()
      .replaceAll('-', '')
      .slice(0, 12)}`;
    let adminPool: ReturnType<typeof createPgPool>;
    let scratchPool: ReturnType<typeof createPgPool>;
    let scratchCreated = false;
    let scratchUrl: string;
    let directory: string;

    async function runJob(
      operation: 'create' | 'restore',
      params: { tables?: string[]; filename?: string },
      onProgress?: (value: number) => Promise<void>,
    ) {
      const data = backupJobDataSchema.parse({
        taskId: randomUUID(),
        taskType: 'backup',
        taskSubType: operation,
        operation,
        target: 'primary',
        userId: 'archive-snapshot-integration',
        createdAt: new Date().toISOString(),
        params,
      });
      let state: TaskState = {
        taskId: data.taskId,
        taskType: 'backup',
        taskSubType: operation,
        userId: data.userId,
        createdAt: data.createdAt,
        updatedAt: data.createdAt,
        title: 'snapshot integration',
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
      };
      const processor = createBackupProcessor(
        {
          read: async () => state,
          mutate: async (_id: string, change: TaskMutation) => {
            state = transitionTask(state, change, new Date());
            return state;
          },
        },
        {
          env: {
            DATABASE_URL: scratchUrl,
            COMPETITOR_DATABASE_URL: scratchUrl,
            BACKUP_STORAGE_DIRECTORY: directory,
            DATABASE_POOL_CONNECTION_TIMEOUT_MS: 2000,
            BACKUP_COMMAND_TIMEOUT_MS: 30000,
            BACKUP_MAX_BYTES: 10_000_000,
            TASK_META_TTL_SECONDS: 604800,
            PG_DUMP_PATH: 'pg_dump',
            PG_RESTORE_PATH: 'pg_restore',
          } as Env,
          shutdownSignal: new AbortController().signal,
          isClosing: () => false,
          assertJobLock: async () => undefined,
          updateProgress: async (_job, value) => onProgress?.(value),
        },
        {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      );
      const result = backupTaskResultDataSchema.parse(
        await processor(
          { id: data.taskId, name: operation, data } as Job,
          'fixture-lock',
        ),
      );
      expect(state.status).toBe('completed');
      return result;
    }

    beforeAll(async () => {
      if (
        process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
          'amazon_asin_monitor_ci' ||
        new URL(sourceUrl).pathname !== '/amazon_asin_monitor_ci'
      )
        throw new Error(
          'Snapshot integration requires the disposable CI database',
        );
      directory = await mkdtemp(join(tmpdir(), 'neo-snapshot-integration-'));
      adminPool = createPgPool(sourceUrl, { max: 1 });
      await adminPool.query(
        `CREATE DATABASE ${scratchName} TEMPLATE template0`,
      );
      scratchCreated = true;
      await adminPool.query(
        `ALTER DATABASE ${scratchName} SET TimeZone TO 'Asia/Shanghai'`,
      );
      const url = new URL(sourceUrl);
      url.pathname = `/${scratchName}`;
      scratchUrl = url.toString();
      scratchPool = createPgPool(scratchUrl, { max: 1 });
      await scratchPool.query(
        'CREATE TABLE public.snapshot_rows (id integer PRIMARY KEY, note text NOT NULL)',
      );
      await scratchPool.query(
        "INSERT INTO public.snapshot_rows VALUES (1, 'verified-original')",
      );
    }, 30000);

    afterAll(async () => {
      await scratchPool?.end();
      if (scratchCreated)
        await adminPool.query(`DROP DATABASE ${scratchName} WITH (FORCE)`);
      await adminPool?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    }, 30000);

    it.each(['pathname-replacement', 'same-inode-write'] as const)(
      'restores verified rows after %s of the source archive',
      async (attack) => {
        await scratchPool.query(
          "UPDATE public.snapshot_rows SET note = 'verified-original' WHERE id = 1",
        );
        const original = await runJob('create', {
          tables: ['public.snapshot_rows'],
        });
        await scratchPool.query(
          "UPDATE public.snapshot_rows SET note = 'unchecked-archive' WHERE id = 1",
        );
        const competing = await runJob('create', {
          tables: ['public.snapshot_rows'],
        });
        if (!original.filename || !competing.filename)
          throw new Error('No native snapshot fixture archives');
        const input = join(directory, original.filename);
        const originalBytes = await readFile(input);
        const competingBytes = await readFile(
          join(directory, competing.filename),
        );
        expect(competingBytes).not.toEqual(originalBytes);
        await scratchPool.query(
          "UPDATE public.snapshot_rows SET note = 'live-before-restore' WHERE id = 1",
        );
        const writer = await open(input, 'r+');
        let attacked = false;
        try {
          const restored = await runJob(
            'restore',
            { filename: original.filename },
            async (value) => {
              // This checkpoint is after the manifest digest comparison and
              // before real pg_restore starts its transaction.
              if (value !== 5 || attacked) return;
              attacked = true;
              if (attack === 'pathname-replacement') {
                await rename(input, `${input}.replaced`);
                await writeFile(input, competingBytes);
              } else {
                const before = await writer.stat();
                await writer.truncate(0);
                await writer.writeFile(competingBytes);
                expect((await stat(input)).ino).toBe(before.ino);
              }
            },
          );
          expect(attacked).toBe(true);
          expect(await readFile(input)).toEqual(competingBytes);
          expect(restored).toMatchObject({
            operation: 'restore',
            restoreMode: 'in-place',
            targetDatabaseChanged: true,
            verification: 'confirmed',
          });
          expect(
            (
              await scratchPool.query(
                'SELECT note FROM public.snapshot_rows WHERE id = 1',
              )
            ).rows,
          ).toEqual([{ note: 'verified-original' }]);
        } finally {
          await writer.close();
        }
      },
      60000,
    );
  },
);
