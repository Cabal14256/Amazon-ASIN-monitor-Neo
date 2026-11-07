import {
  transitionTask,
  type CatalogExportQueryRepositoryPort,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAsinExportProcessor } from '../src/asin-export-processor';
import { createVariantGroupExportProcessor } from '../src/variant-group-export-processor';

async function fixture(kind: 'competitor-asin' | 'competitor-variant-group') {
  const taskId = randomUUID(),
    createdAt = new Date().toISOString();
  const directory = await mkdtemp(join(tmpdir(), 'competitor-recovery-'));
  const data = {
    taskId,
    userId: 'owner',
    taskType: 'export',
    taskSubType: kind,
    exportType: kind,
    createdAt,
    params: {},
  };
  let state = {
    ...data,
    title: kind,
    status: 'pending',
    progress: 0,
    message: '',
    error: null,
    result: null,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    revision: 0,
  } as TaskState;
  const list = vi.fn(async () => ({
    groups: [],
    asins: [],
    total: 0,
    totalASINs: 0,
  }));
  const repository: CatalogExportQueryRepositoryPort = {
    read: async (action) =>
      action(
        { listExportGroups: list, listExportChildrenPage: async () => [] },
        () => undefined,
      ),
  };
  let lostCompletion = false;
  const store = {
    read: async () => state,
    mutate: async (
      _id: string,
      change: Parameters<typeof transitionTask>[1],
    ) => {
      if (change.kind === 'completed' && lostCompletion)
        throw new Error('ACK lost');
      return (state = transitionTask(state, change, new Date()));
    },
  };
  const authorize = vi.fn(async (_userId: string) => undefined);
  const artifacts = new ExportArtifactStore(directory);
  const options = {
    competitor: true,
    authorize,
    shutdownSignal: new AbortController().signal,
    isClosing: () => false,
    assertJobLock: async () => undefined,
    updateProgress: async () => undefined,
  };
  const processor =
    kind === 'competitor-asin'
      ? createAsinExportProcessor(repository, store, artifacts, options)
      : createVariantGroupExportProcessor(
          repository,
          store,
          artifacts,
          options,
        );
  const job = {
    id: taskId,
    name: kind,
    data,
    attemptsMade: 0,
    opts: { attempts: 2 },
  };
  return {
    taskId,
    directory,
    artifacts,
    list,
    authorize,
    job,
    processor,
    get state() {
      return state;
    },
    loseCompletion(value: boolean) {
      lostCompletion = value;
    },
    cancel() {
      state = transitionTask(state, { kind: 'cancel-request' }, new Date());
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
describe.each(['competitor-asin', 'competitor-variant-group'] as const)(
  '%s recovery boundaries',
  (kind) => {
    it('reconciles a published artifact after lost completion ACK without a second snapshot', async () => {
      const f = await fixture(kind);
      try {
        f.loseCompletion(true);
        await expect(f.processor(f.job as never, 'token')).rejects.toThrow(
          'EXPORT_COMPLETION_UNCONFIRMED',
        );
        const artifact = await f.artifacts.read(f.taskId);
        expect(artifact).not.toBeNull();
        f.loseCompletion(false);
        f.job.attemptsMade = 1;
        await f.processor(f.job as never, 'token');
        expect(f.state).toMatchObject({
          status: 'completed',
          result: { exportType: kind, artifact },
        });
        expect(f.list).toHaveBeenCalledTimes(1);
      } finally {
        await f.cleanup();
      }
    });
    it('cancels an uncertain published attempt and removes its private artifact', async () => {
      const f = await fixture(kind);
      try {
        f.loseCompletion(true);
        await expect(f.processor(f.job as never, 'token')).rejects.toThrow(
          'EXPORT_COMPLETION_UNCONFIRMED',
        );
        f.cancel();
        f.loseCompletion(false);
        f.job.attemptsMade = 1;
        await expect(
          f.processor(f.job as never, 'token'),
        ).resolves.toMatchObject({ cancelled: true });
        expect(f.state.status).toBe('cancelled');
        expect(await f.artifacts.read(f.taskId)).toBeNull();
        expect(f.list).toHaveBeenCalledTimes(1);
        expect(await readdir(f.directory)).toEqual([]);
      } finally {
        await f.cleanup();
      }
    });
    it('rechecks live primary authority before accessing competitor data', async () => {
      const f = await fixture(kind);
      try {
        f.authorize.mockRejectedValue(new Error('EXPORT_AUTHORITY_REVOKED'));
        f.job.attemptsMade = 1;
        await expect(f.processor(f.job as never, 'token')).rejects.toThrow(
          'EXPORT_ATTEMPT_FAILED',
        );
        expect(f.state.status).toBe('failed');
        expect(f.authorize).toHaveBeenCalledWith('owner');
        expect(f.list).not.toHaveBeenCalled();
        expect(await readdir(f.directory)).toEqual([]);
      } finally {
        await f.cleanup();
      }
    });
  },
);
