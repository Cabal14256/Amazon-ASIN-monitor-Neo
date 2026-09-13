import type { VariantCheckJobData } from '@asin-monitor/contracts';
import {
  transitionTask,
  VariantCheckError,
  type TaskMutation,
  type TaskState,
} from '@asin-monitor/db';
import {
  variantCheckJobOperation,
  variantCheckResultReference,
  type VariantCheckExecutor,
} from '@asin-monitor/variant-check';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVariantCheckProcessor } from '../src/variant-check-processor';

afterEach(() => {
  vi.useRealTimers();
});
function fixture(type: 'variant-check' | 'batch-check' = 'variant-check') {
  const now = Date.now();
  const identity = {
    taskId: '10000000-0000-4000-8000-000000000105',
    userId: 'fixture-owner',
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(),
  };
  const data: VariantCheckJobData =
    type === 'variant-check'
      ? {
          ...identity,
          taskType: type,
          taskSubType: 'asin-check',
          params: { asinId: 'a1', forceRefresh: true },
        }
      : {
          ...identity,
          taskType: type,
          taskSubType: 'variant-group',
          params: { groupIds: ['g1', 'g2'], forceRefresh: false },
        };
  let state: TaskState | null = {
    ...identity,
    taskType: data.taskType,
    taskSubType: data.taskSubType,
    title: 'Fixture check',
    status: 'pending',
    progress: 0,
    message: '',
    error: null,
    result: null,
    updatedAt: identity.createdAt,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    revision: 0,
  };
  const store = {
    read: vi.fn(async () => state),
    mutate: vi.fn(async (_id: string, change: TaskMutation) => {
      if (state) state = transitionTask(state, change, new Date());
      return state;
    }),
  };
  const reference = variantCheckResultReference(variantCheckJobOperation(data));
  const execute = vi.fn<VariantCheckExecutor['execute']>(
    async (_data, context) => {
      await context.checkpoint();
      await context.onProgress?.(1, 2);
      return reference;
    },
  );
  const shutdown = new AbortController();
  const options = {
    taskType: type,
    shutdownSignal: shutdown.signal,
    assertJobLock: vi.fn(async () => undefined),
    updateProgress: vi.fn(async (_job: Job, _progress: number) => undefined),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const processor = createVariantCheckProcessor(
    { execute },
    store,
    options,
    log,
  );
  const job = {
    id: data.taskId,
    name: data.taskType,
    data,
    attemptsMade: 0,
    opts: { attempts: 2 },
  } as Job;
  return {
    data,
    reference,
    execute,
    store,
    options,
    log,
    job,
    shutdown,
    state: () => state,
    patch: (patch: Partial<TaskState>) => {
      state = { ...state!, ...patch };
    },
    expire: () => {
      state = null;
    },
    run: () => processor(job, 'fixture-lease'),
  };
}
describe('variant and batch BullMQ processor lifecycle', () => {
  it.each(['variant-check', 'batch-check'] as const)(
    'completes %s with a compact durable reference and progress',
    async (type) => {
      const f = fixture(type);
      expect(await f.run()).toEqual(f.reference);
      expect(f.state()).toMatchObject({
        status: 'completed',
        result: f.reference,
        progress: 100,
      });
      expect(f.options.updateProgress).toHaveBeenCalledWith(f.job, 50);
      expect(f.store.mutate).toHaveBeenCalledWith(
        f.data.taskId,
        expect.objectContaining({ kind: 'completed' }),
        f.data,
      );
    },
  );
  it('does not turn a retryable first attempt into a terminal failure', async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(
      new Error('private fixture dependency failure'),
    );
    await expect(f.run()).rejects.toThrow('检查任务失败');
    expect(f.state()).toMatchObject({ status: 'processing', result: null });
    f.job.attemptsMade = 1;
    expect(await f.run()).toEqual(f.reference);
    expect(f.state()?.status).toBe('completed');
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
      'private fixture',
    );
  });
  it('makes an exhausted failure terminal and unrecoverable', async () => {
    const f = fixture();
    f.job.attemptsMade = 1;
    f.execute.mockRejectedValue(new Error('dependency failed'));
    await expect(f.run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.state()?.status).toBe('failed');
  });
  it('retains published results when Redis completion acknowledgement is lost', async () => {
    const f = fixture();
    const original = f.store.mutate.getMockImplementation()!;
    f.store.mutate.mockImplementation(async (id, mutation) => {
      if (mutation.kind === 'completed') throw new Error('uncertain Redis ack');
      return original(id, mutation);
    });
    await expect(f.run()).rejects.toThrow('检查结果已保存');
    expect(f.state()?.status).toBe('processing');
    f.store.mutate.mockImplementation(original);
    f.job.attemptsMade = 1;
    expect(await f.run()).toEqual(f.reference);
  });
  it('returns already completed references without invoking the executor', async () => {
    const f = fixture();
    f.patch({ status: 'completed', result: f.reference });
    expect(await f.run()).toEqual(f.reference);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('does not accept a completed reference from a different task incarnation', async () => {
    const f = fixture();
    f.patch({
      status: 'completed',
      result: { ...f.reference, operationKey: 'a'.repeat(64) },
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    { userId: 'different-owner' },
    { taskType: 'import' },
    { taskSubType: 'parent-asin-query' },
    { createdAt: '2026-01-01T00:00:00.000Z' },
  ])('rejects changed metadata without overwriting it (%j)', async (patch) => {
    const f = fixture();
    f.patch(patch);
    await expect(f.run()).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.mutate).not.toHaveBeenCalled();
  });
  it('never starts an expired or missing task', async () => {
    const f = fixture();
    f.expire();
    await expect(f.run()).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
    const expired = fixture();
    expired.data.expiresAt = new Date(Date.now() - 500).toISOString();
    await expect(expired.run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(expired.execute).not.toHaveBeenCalled();
    expect(expired.state()?.status).toBe('failed');
  });
  it('handles pre-start cancellation without calling the executor', async () => {
    const f = fixture();
    f.patch({
      status: 'cancelling',
      cancelRequestedAt: new Date().toISOString(),
    });
    expect(await f.run()).toMatchObject({ cancelled: true });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.state()?.status).toBe('cancelled');
  });
  it('checks lease ownership before every persistence checkpoint', async () => {
    const f = fixture();
    f.execute.mockImplementation(async (_data, context) => {
      f.options.assertJobLock.mockRejectedValue(new Error('lease lost'));
      await context.authorize({} as never);
      return f.reference;
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.state()?.status).toBe('processing');
    expect(
      f.store.mutate.mock.calls.some(
        ([, mutation]) => mutation.kind === 'completed',
      ),
    ).toBe(false);
  });
  it('heartbeat cancels a pending upstream request and preserves cancellation state', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.execute.mockImplementation(
      async (_data, context) =>
        new Promise((_resolve, reject) => {
          context.signal!.addEventListener(
            'abort',
            () => reject(context.signal!.reason),
            { once: true },
          );
        }),
    );
    const running = f.run();
    await vi.advanceTimersByTimeAsync(1);
    f.patch({
      status: 'cancelling',
      cancelRequestedAt: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running).toMatchObject({ cancelled: true });
    expect(f.state()?.status).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not mark a shutdown interruption as a permanent business failure', async () => {
    const f = fixture();
    f.job.attemptsMade = 1;
    f.execute.mockImplementation(async (_data, context) => {
      f.shutdown.abort();
      await context.checkpoint();
      return f.reference;
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.state()?.status).toBe('processing');
  });
  it('rejects invalid job kind before metadata access', async () => {
    const f = fixture();
    f.job.name = 'asin-import';
    await expect(f.run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.store.read).not.toHaveBeenCalled();
  });
  it('does not retry incompatible operation identities', async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new VariantCheckError('operation-mismatch'));
    await expect(f.run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.state()?.status).toBe('failed');
  });
});
