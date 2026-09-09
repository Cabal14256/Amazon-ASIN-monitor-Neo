import {
  batchDeleteSyncResult,
  buildBatchDeleteAnalysis,
  transitionTask,
  type AsinBatchDeleteRepositoryPort,
  type AsinBatchDeleteUnit,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAsinBatchDeleteProcessor } from '../src/asin-batch-delete-processor';

function fixture() {
  const data = {
    taskId: randomUUID(),
    userId: 'owner99',
    taskType: 'batch-delete' as const,
    taskSubType: 'variant-group-delete' as const,
    title: '批量删除变体组' as const,
    domain: 'asin' as const,
    createdAt: '2026-09-01T00:00:00.000Z',
    groupIds: ['g1', 'g2', 'absent'],
    asinIds: ['a1', 'a2', 'absent'],
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
    cancelRequestedAt: null,
    cancelledAt: null,
    revision: 0,
  };
  const analysis = buildBatchDeleteAnalysis(
    data,
    ['g1', 'g2'],
    [
      { id: 'a1', variantGroupId: 'g1' },
      { id: 'a2', variantGroupId: 'g3' },
    ],
    3,
  );
  const unit = {
    analyze: vi.fn(async () => analysis),
    execute: vi.fn(async (ids: { groupIds: string[]; asinIds: string[] }) =>
      batchDeleteSyncResult({
        totalRequested: ids.groupIds.length + ids.asinIds.length,
        deletedGroupCount: ids.groupIds.length,
        deletedDirectAsinCount: ids.asinIds.length,
        deletedNestedAsinCount:
          ids.groupIds[0] === 'g1' ? 2 : ids.groupIds.length,
        skipped: { groupIds: [], asinIds: [] },
      }),
    ),
  };
  const repository: AsinBatchDeleteRepositoryPort = {
    transaction: vi.fn(async (operation) =>
      operation(unit as unknown as AsinBatchDeleteUnit),
    ),
  };
  const store = {
    read: vi.fn(async () => state),
    mutate: vi.fn(async (_id: string, mutation: TaskMutation) => {
      if (state) state = transitionTask(state, mutation, new Date());
      return state;
    }),
  };
  let closing = false;
  const options = {
    chunkSize: 1,
    isClosing: () => closing,
    assertJobLock: vi.fn(async () => undefined),
    updateProgress: vi.fn(async (_job: Job, _progress: number) => undefined),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const processor = createAsinBatchDeleteProcessor(
    repository,
    store,
    options,
    log,
  );
  const job = {
    id: data.taskId,
    name: 'asin-batch-delete',
    data,
  } as unknown as Job;
  return {
    data,
    unit,
    store,
    options,
    log,
    job,
    repository,
    state: () => state,
    patch: (patch: Partial<TaskState>) => {
      state = { ...state!, ...patch };
    },
    expire: () => {
      state = null;
    },
    close: () => {
      closing = true;
    },
    run: () => processor(job, 'fixture-lock'),
  };
}
describe('actual ASIN batch processor control flow', () => {
  it('deletes groups before direct ASINs, excludes overlaps, and persists full result', async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.unit.execute.mock.calls.map(([ids]) => ids)).toEqual([
      { groupIds: ['g1'], asinIds: [] },
      { groupIds: ['g2'], asinIds: [] },
      { groupIds: [], asinIds: ['a2'] },
    ]);
    expect(result).toEqual({
      mode: 'async',
      totalRequested: 6,
      deletedGroupCount: 2,
      deletedDirectAsinCount: 1,
      deletedNestedAsinCount: 3,
      skippedCount: 2,
      skipped: { groupIds: ['absent'], asinIds: ['absent'] },
      failedCount: 0,
      failedSamples: [],
      total: 6,
      summary:
        '共 6 项，删除变体组 2 个，直接删除 ASIN 1 个，组内级联 ASIN 3 个，跳过 2 个',
      verificationPassed: true,
      warnings: ['有 2 个删除目标不存在或已被删除'],
    });
    expect(f.state()).toMatchObject({
      status: 'completed',
      progress: 100,
      result,
    });
    expect(
      f.store.mutate.mock.calls.every(([id]) => id === f.data.taskId),
    ).toBe(true);
  });
  it('counts failed chunks, continues independent work, and never persists private errors', async () => {
    const f = fixture();
    f.unit.execute.mockRejectedValueOnce(
      new Error('private SQL password=secret99'),
    );
    const result = await f.run();
    expect(result).toMatchObject({
      failedCount: 1,
      deletedGroupCount: 1,
      deletedDirectAsinCount: 1,
      deletedNestedAsinCount: 1,
      verificationPassed: false,
      failedSamples: [
        {
          index: 1,
          groupCount: 1,
          asinCount: 0,
          error: '删除分块失败，请刷新后核实剩余目标',
        },
      ],
    });
    expect(JSON.stringify([result, f.log, f.state()])).not.toContain(
      'secret99',
    );
  });
  it('acknowledges cancellation before any database query', async () => {
    const f = fixture();
    f.patch({ status: 'cancelling', cancelRequestedAt: f.data.createdAt });
    expect(await f.run()).toMatchObject({ cancelled: true });
    expect(f.state()?.status).toBe('cancelled');
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('cancellation during a chunk keeps committed deletion and stops subsequent chunks', async () => {
    const f = fixture();
    f.options.updateProgress.mockImplementation(async (_job, progress) => {
      if (progress > 5)
        f.patch({ status: 'cancelling', cancelRequestedAt: f.data.createdAt });
    });
    expect(await f.run()).toMatchObject({ cancelled: true });
    expect(f.unit.execute).toHaveBeenCalledOnce();
    expect(f.state()?.status).toBe('cancelled');
  });
  it.each(['completed', 'cancelled', 'failed'] as const)(
    'does not rerun a %s task',
    async (status) => {
      const f = fixture();
      f.patch({ status, result: { preserved: true } });
      if (status === 'failed') await expect(f.run()).rejects.toThrow('已失败');
      else await f.run();
      expect(f.repository.transaction).not.toHaveBeenCalled();
      expect(f.store.mutate).not.toHaveBeenCalled();
      expect(f.state()?.status).toBe(status);
    },
  );
  it.each(['userId', 'taskType', 'taskSubType', 'createdAt'] as const)(
    'refuses changed metadata %s without writes',
    async (field) => {
      const f = fixture();
      f.patch({ [field]: 'replacement' });
      await expect(f.run()).rejects.toThrow('批量删除失败');
      expect(f.repository.transaction).not.toHaveBeenCalled();
      expect(f.store.mutate).not.toHaveBeenCalled();
    },
  );
  it('does not resurrect expired metadata', async () => {
    const f = fixture();
    f.expire();
    await expect(f.run()).rejects.toThrow('批量删除失败');
    expect(f.repository.transaction).not.toHaveBeenCalled();
    expect(f.store.mutate).not.toHaveBeenCalled();
  });
  it('lost job lock stops database work and task mutation', async () => {
    const f = fixture();
    f.options.assertJobLock.mockRejectedValue(new Error('lost'));
    await expect(f.run()).rejects.toThrow();
    expect(f.repository.transaction).not.toHaveBeenCalled();
    expect(f.store.mutate).not.toHaveBeenCalled();
  });
  it('registry outage after a committed chunk stops further deletions', async () => {
    const f = fixture();
    f.options.updateProgress.mockImplementation(async (_job, progress) => {
      if (progress > 5)
        f.store.read.mockRejectedValue(new Error('Redis unavailable'));
    });
    await expect(f.run()).rejects.toThrow('批量删除失败');
    expect(f.unit.execute).toHaveBeenCalledOnce();
  });
  it('shutdown keeps completed chunks, marks failure and never reports user cancellation', async () => {
    const f = fixture();
    f.options.updateProgress.mockImplementation(async (_job, progress) => {
      if (progress > 5) f.close();
    });
    await expect(f.run()).rejects.toThrow('Worker 正在停止');
    expect(f.unit.execute).toHaveBeenCalledOnce();
    expect(f.state()).toMatchObject({
      status: 'failed',
      cancelRequestedAt: null,
    });
  });
  it.each([
    { taskId: 'bad' },
    { groupIds: [], asinIds: [] },
    { groupIds: [' g1'] },
    { groupIds: ['g1', 'g1'] },
    { groupIds: ['x'.repeat(51)] },
    { domain: 'competitor' },
    { createdAt: 'bad' },
    { taskType: 'export' },
    { extra: true },
  ])(
    'rejects invalid queue payload %j before metadata/database access',
    async (patch) => {
      const f = fixture();
      Object.assign(f.job.data, patch);
      await expect(f.run()).rejects.toThrow('任务数据无效');
      expect(f.store.read).not.toHaveBeenCalled();
      expect(f.repository.transaction).not.toHaveBeenCalled();
    },
  );
});
