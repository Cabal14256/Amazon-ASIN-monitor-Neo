import {
  transitionTask,
  type AsinImportRepositoryPort,
  type AsinImportUnit,
  type BatchAsinItem,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import {
  ImportFileStore,
  ImportResultStore,
  type AsinImportTaskData,
} from '@asin-monitor/import';
import { UnrecoverableError, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsinImportProcessor } from '../src/asin-import-processor';

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.restoreAllMocks();
});
async function fixture(rows = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'neo-import-processor-'));
  const files = new ImportFileStore(directory),
    reports = new ImportResultStore(directory);
  disposals.push(async () => {
    await files.close();
    await rm(directory, { recursive: true, force: true });
  });
  const taskId = randomUUID();
  const text =
    '变体组名称,国家,站点,品牌,ASIN,ASIN类型\n' +
    Array.from(
      { length: rows },
      (_, i) => `Group,US,Shop,Brand,B${String(i).padStart(9, '0')},1`,
    ).join('\n');
  const file = await files.save(
    Readable.from([text]),
    taskId,
    'fixture.csv',
    'text/csv',
    new AbortController().signal,
  );
  const data: AsinImportTaskData = {
    taskId,
    file,
    userId: 'owner-101',
    createdAt: '2026-09-01T00:00:00.000Z',
    taskType: 'import',
    taskSubType: 'asin',
    title: 'ASIN导入',
  };
  let state: TaskState | null = {
    ...data,
    status: 'pending',
    progress: 0,
    message: '',
    error: null,
    result: null,
    updatedAt: data.createdAt,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelRequestedAt: null,
    revision: 0,
  };
  const unit = {
    findOrCreateImportGroup: vi.fn(async () => 'group-101'),
    writeImportChunk: vi.fn(async (items: BatchAsinItem[]) => ({
      successCount: items.length,
      failedCount: 0,
      errors: [],
    })),
  };
  const repository: AsinImportRepositoryPort = {
    transaction: vi.fn(async (operation) =>
      operation(unit as unknown as AsinImportUnit),
    ),
  };
  const mutate = async (_id: string, change: TaskMutation) => {
    if (state) state = transitionTask(state, change, new Date());
    return state;
  };
  const store = { read: vi.fn(async () => state), mutate: vi.fn(mutate) };
  const shutdown = new AbortController();
  const options = {
    shutdownSignal: shutdown.signal,
    assertJobLock: vi.fn(async () => undefined),
    updateProgress: vi.fn(async (_job: Job, _progress: number) => undefined),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const processor = createAsinImportProcessor(
    repository,
    store,
    files,
    reports,
    options,
    log,
  );
  const job = { id: taskId, name: 'asin-import', data } as Job;
  return {
    data,
    directory,
    files,
    reports,
    unit,
    repository,
    store,
    mutate,
    shutdown,
    options,
    log,
    job,
    state: () => state,
    patch: (patch: Partial<TaskState>) => {
      state = { ...state!, ...patch };
    },
    expire: () => {
      state = null;
    },
    run: () => processor(job, 'fixture-lock'),
  };
}

describe('actual streaming import processor and durable result recovery', () => {
  it('parses a stored CSV, writes bounded chunks, saves full results before metadata and removes input', async () => {
    const f = await fixture(1001);
    const result = await f.run();
    expect(
      f.unit.writeImportChunk.mock.calls.map(([items]) => items.length),
    ).toEqual([1000, 1]);
    expect(result).toMatchObject({
      successCount: 1001,
      failedCount: 0,
      total: 1001,
      downloadUrl: `/api/v1/tasks/${f.data.taskId}/download`,
    });
    expect(f.state()).toMatchObject({
      status: 'completed',
      progress: 100,
      result,
    });
    expect(
      (await f.reports.read(f.data, new AbortController().signal))?.result,
    ).toMatchObject({ successCount: 1001, originalFilename: 'fixture.csv' });
    expect(await readdir(f.directory)).toEqual([
      expect.stringMatching(/\.result\.json$/),
    ]);
  });
  it('recovers a published report after a completion write fails without reimporting', async () => {
    const f = await fixture();
    f.store.mutate.mockImplementation(async (id, change) => {
      if (change.kind === 'completed') throw new Error('private redis secret');
      return f.mutate(id, change);
    });
    await expect(f.run()).rejects.toThrow('导入结果已保存');
    expect(f.state()?.status).toBe('processing');
    expect((await readdir(f.directory)).length).toBe(2);
    f.store.mutate.mockImplementation(f.mutate);
    expect(await f.run()).toMatchObject({ successCount: 2 });
    expect(f.unit.writeImportChunk).toHaveBeenCalledOnce();
    expect(f.state()?.status).toBe('completed');
    expect((await readdir(f.directory)).length).toBe(1);
  });
  it('recovers an applied completion whose acknowledgement was lost', async () => {
    const f = await fixture();
    f.store.mutate.mockImplementation(async (id, change) => {
      const state = await f.mutate(id, change);
      if (change.kind === 'completed') throw new Error('lost ack');
      return state;
    });
    await expect(f.run()).rejects.toThrow('导入结果已保存');
    expect(f.state()?.status).toBe('completed');
    f.store.mutate.mockImplementation(f.mutate);
    expect(await f.run()).toMatchObject({ successCount: 2 });
    expect(f.unit.writeImportChunk).toHaveBeenCalledOnce();
  });
  it('refuses to rerun an interrupted attempt without a complete report', async () => {
    const f = await fixture();
    f.patch({ status: 'processing', startedAt: f.data.createdAt });
    await expect(f.run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.repository.transaction).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('核实'),
    });
  });
  it('cancels before any database action and removes the unused input', async () => {
    const f = await fixture();
    f.patch({ status: 'cancelling', cancelRequestedAt: f.data.createdAt });
    expect(await f.run()).toMatchObject({ cancelled: true });
    expect(f.repository.transaction).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual([]);
  });
  it('retains committed chunks when cancelled and never starts the next one', async () => {
    const f = await fixture(1001);
    f.unit.writeImportChunk.mockImplementation(async (items) => {
      f.patch({ cancelRequestedAt: f.data.createdAt, status: 'cancelling' });
      return { successCount: items.length, failedCount: 0, errors: [] };
    });
    expect(await f.run()).toMatchObject({ cancelled: true });
    expect(f.unit.writeImportChunk).toHaveBeenCalledOnce();
    expect(f.state()?.status).toBe('cancelled');
  });
  it.each(['userId', 'taskType', 'taskSubType', 'createdAt'] as const)(
    'refuses changed immutable metadata %s',
    async (field) => {
      const f = await fixture();
      f.patch({ [field]: 'replacement' });
      await expect(f.run()).rejects.toThrow();
      expect(f.repository.transaction).not.toHaveBeenCalled();
      expect(f.store.mutate).not.toHaveBeenCalled();
      expect(await readdir(f.directory)).toEqual([
        expect.stringMatching(/\.csv$/),
      ]);
    },
  );
  it('does not recreate expired metadata or remove an unconfirmed input', async () => {
    const f = await fixture();
    f.expire();
    await expect(f.run()).rejects.toThrow();
    expect(f.store.mutate).not.toHaveBeenCalled();
    expect(f.repository.transaction).not.toHaveBeenCalled();
    expect((await readdir(f.directory)).length).toBe(1);
  });
  it('stops after lease loss and does not mutate metadata or repeat committed work on retry', async () => {
    const f = await fixture(1001);
    f.unit.writeImportChunk.mockImplementation(async (items) => {
      f.options.assertJobLock.mockRejectedValue(new Error('lost'));
      return { successCount: items.length, failedCount: 0, errors: [] };
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.state()?.status).toBe('processing');
    expect(f.unit.writeImportChunk).toHaveBeenCalledOnce();
    expect((await readdir(f.directory)).length).toBe(1);
    f.options.assertJobLock.mockResolvedValue(undefined);
    await expect(f.run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.unit.writeImportChunk).toHaveBeenCalledOnce();
  });
  it('aborts parsing promptly on shutdown and marks a confirmed failure', async () => {
    const f = await fixture();
    const verify = f.files.verifiedPath.bind(f.files);
    vi.spyOn(f.files, 'verifiedPath').mockImplementation(async (...args) => {
      const path = await verify(...args);
      f.shutdown.abort();
      return path;
    });
    await expect(f.run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.repository.transaction).not.toHaveBeenCalled();
    expect(f.state()?.status).toBe('failed');
  });
  it('checks cancellation during a long file read and releases it without database work', async () => {
    const f = await fixture();
    vi.spyOn(f.files, 'verifiedPath').mockImplementation(
      async (_file, signal) => {
        f.patch({ status: 'cancelling', cancelRequestedAt: f.data.createdAt });
        return new Promise<string>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
        });
      },
    );
    expect(await f.run()).toMatchObject({ cancelled: true });
    expect(f.repository.transaction).not.toHaveBeenCalled();
    expect(f.state()?.status).toBe('cancelled');
  });
  it('stops on a registry outage after group creation without writing ASINs or deleting the input', async () => {
    const f = await fixture();
    f.unit.findOrCreateImportGroup.mockImplementation(async () => {
      f.store.read.mockRejectedValue(new Error('registry unavailable'));
      return 'group-101';
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.unit.writeImportChunk).not.toHaveBeenCalled();
    expect(f.state()?.status).toBe('processing');
    expect((await readdir(f.directory)).length).toBe(1);
    f.store.read.mockImplementation(async () => f.state());
    await expect(f.run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.unit.findOrCreateImportGroup).toHaveBeenCalledOnce();
  });
  it('persists only fixed errors when a database driver throws private context', async () => {
    const f = await fixture();
    f.unit.writeImportChunk.mockRejectedValue(
      new Error('password=private101 SQL payload'),
    );
    await expect(f.run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(
      JSON.stringify([
        f.state(),
        ...f.log.error.mock.calls,
        ...f.log.warn.mock.calls,
      ]),
    ).not.toContain('private101');
  });
  it.each(['job-name', 'job-id', 'file-id', 'owner', 'timestamp'] as const)(
    'rejects invalid payload %s before touching metadata',
    async (field) => {
      const f = await fixture();
      if (field === 'job-name') f.job.name = 'export';
      if (field === 'job-id') f.job.id = randomUUID();
      if (field === 'file-id') f.job.data.file.taskId = randomUUID();
      if (field === 'owner') f.job.data.userId = '';
      if (field === 'timestamp') f.job.data.createdAt = 'invalid';
      await expect(f.run()).rejects.toThrow('任务数据无效');
      expect(f.store.read).not.toHaveBeenCalled();
      expect(f.repository.transaction).not.toHaveBeenCalled();
    },
  );
});
