import type {
  VariantCheckJobData,
  VariantGroupCheckData,
} from '@asin-monitor/contracts';
import {
  decodeVariantCheckReceiptResult,
  VariantCheckError,
  type VariantCheckOperation,
  type VariantCheckRepositoryPort,
  type VariantCheckUnit,
} from '@asin-monitor/db';
import { type CatalogParentQuery } from '@asin-monitor/sp-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  batchCheckTaskResult,
  VariantCheckExecutor,
  type CheckExecutionContext,
} from '../src/executor';
import {
  VariantCheckCommitUncertainError,
  type VariantCheckPipeline,
} from '../src/pipeline';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
  variantCheckResultOperation,
  variantCheckResultReference,
} from '../src/task';
import { deferred, flush } from './fixtures';

const identity = {
  taskId: '10000000-0000-4000-8000-000000000105',
  userId: 'fixture-owner',
  createdAt: '2026-09-13T00:00:00.000Z',
  expiresAt: '2026-09-20T00:00:00.000Z',
};
const batch: Extract<VariantCheckJobData, { taskSubType: 'variant-group' }> = {
  ...identity,
  taskType: 'batch-check',
  taskSubType: 'variant-group',
  params: { groupIds: ['g1', 'g2', 'g3'], forceRefresh: true },
};
const groupResult = (id: string, padding = ''): VariantGroupCheckData => ({
  isBroken: false,
  groupSnapshot: { id },
  brokenASINs: [],
  brokenByType: {},
  details: { results: [], padding },
});
const disposals: Array<() => void> = [];
afterEach(() => {
  disposals.splice(0).forEach((close) => close());
  vi.useRealTimers();
});
function setup(concurrency = 2) {
  const receipts = new Map<
    string,
    { operation: VariantCheckOperation; result: unknown }
  >();
  const writes: string[] = [];
  const unit = {
    readReceipt: vi.fn<VariantCheckUnit['readReceipt']>(async (operation) => {
      const stored = receipts.get(operation.operationKey);
      if (
        stored &&
        JSON.stringify(stored.operation) !== JSON.stringify(operation)
      )
        throw new VariantCheckError('operation-mismatch');
      return structuredClone(stored?.result);
    }),
    saveReceipt: vi.fn<VariantCheckUnit['saveReceipt']>(
      async (operation, result) => {
        receipts.set(operation.operationKey, {
          operation,
          result: decodeVariantCheckReceiptResult(result, operation.resultKind),
        });
      },
    ),
  };
  const repository: VariantCheckRepositoryPort = {
    transaction: async (action) => action(unit as unknown as VariantCheckUnit),
  };
  const pipeline = {
    checkSingle: vi.fn<VariantCheckPipeline['checkSingle']>(async () => {
      throw new Error('unused');
    }),
    checkGroup: vi.fn<VariantCheckPipeline['checkGroup']>(
      async (id, context) => {
        await context.checkpoint();
        const result = groupResult(id);
        context.validateResult?.(result);
        if (context.operation)
          await unit.saveReceipt(context.operation, result);
        writes.push(id);
        return result;
      },
    ),
  };
  const parents = {
    query: vi.fn<CatalogParentQuery['query']>(async () => [
      {
        asin: 'B000000001',
        hasParentAsin: false,
        parentAsin: null,
        parentTitle: '',
        title: 'Full title',
        brand: null,
        hasVariants: false,
        variantCount: 0,
        error: null,
      },
    ]),
  };
  const context: CheckExecutionContext = {
    authorize: vi.fn(async () => undefined),
    checkpoint: vi.fn(async () => undefined),
    onProgress: vi.fn(async () => undefined),
  };
  const executor = new VariantCheckExecutor(
    repository,
    pipeline,
    parents,
    concurrency,
  );
  disposals.push(() => executor.close());
  return {
    executor,
    repository,
    unit,
    receipts,
    writes,
    pipeline,
    parents,
    context,
  };
}
describe('complete check task execution and replay', () => {
  it('preserves ordered success and failed groups and the full Legacy task summary', async () => {
    const f = setup();
    f.pipeline.checkGroup.mockImplementation(async (id, context) => {
      if (id === 'g2') throw new VariantCheckError('group-not-found');
      const result = groupResult(id);
      context.validateResult?.(result);
      await f.unit.saveReceipt(context.operation!, result);
      return result;
    });
    const reference = await f.executor.execute(batch, f.context);
    const result = f.receipts.get(reference.operationKey)!.result;
    expect(result).toMatchObject({
      total: 3,
      successCount: 2,
      failedCount: 1,
      verificationPassed: false,
      results: [
        { groupId: 'g1', success: true, groupSnapshot: { id: 'g1' } },
        { groupId: 'g2', success: false, error: '变体组不存在' },
        { groupId: 'g3', success: true },
      ],
      summary: '共 3 项，成功 2 项，失败 1 项',
      warnings: ['有 1 个检查项失败'],
    });
    expect(Buffer.byteLength(JSON.stringify(reference))).toBeLessThan(1024);
    expect(f.context.onProgress).toHaveBeenLastCalledWith(3, 3);
    expect(await f.executor.execute(batch, f.context)).toEqual(reference);
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(3);
  });
  it('resumes only unfinished groups after a prior attempt stopped', async () => {
    const f = setup();
    const operation = variantCheckJobOperation(batch, 1);
    await f.unit.saveReceipt(
      operation,
      groupResult('g2', 'original full payload'),
    );
    const reference = await f.executor.execute(batch, f.context);
    expect(f.writes).toEqual(['g1', 'g3']);
    expect(f.receipts.get(reference.operationKey)!.result).toMatchObject({
      results: [{}, { details: { padding: 'original full payload' } }, {}],
    });
  });
  it('retains duplicate group positions with distinct operation steps', async () => {
    const f = setup(1);
    const data = {
      ...batch,
      params: { ...batch.params, groupIds: ['g1', 'g1'] },
    };
    await f.executor.execute(data, f.context);
    expect(
      f.pipeline.checkGroup.mock.calls.map(
        ([, context]) => context.operation?.step,
      ),
    ).toEqual(['group-0', 'group-1']);
  });
  it('does not start the next group until a configured concurrency slot settles', async () => {
    const f = setup(),
      gate = deferred<VariantGroupCheckData>();
    f.pipeline.checkGroup.mockImplementation(() => gate.promise);
    const running = f.executor.checkGroups(['g1', 'g2', 'g3'], f.context, 2);
    await flush();
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(2);
    gate.resolve(groupResult('g1'));
    expect((await running).results).toHaveLength(3);
  });
  it('rolls aggregate capacity back to a failed group before a new group write', async () => {
    const f = setup(1);
    f.pipeline.checkGroup.mockImplementation(async (id, context) => {
      const result = groupResult(id, 'x'.repeat(17 * 1024 * 1024));
      context.validateResult?.(result);
      await f.unit.saveReceipt(context.operation!, result);
      f.writes.push(id);
      return result;
    });
    const reference = await f.executor.execute(
      { ...batch, params: { ...batch.params, groupIds: ['g1', 'g2'] } },
      f.context,
    );
    expect(f.writes).toEqual(['g1']);
    expect(f.receipts.get(reference.operationKey)!.result).toMatchObject({
      successCount: 1,
      failedCount: 1,
      results: [{ success: true }, { success: false }],
    });
  });
  it('accounts for prior results before new groups so a retry cannot exceed the full result budget', async () => {
    const f = setup(1);
    await f.unit.saveReceipt(
      variantCheckJobOperation(batch, 1),
      groupResult('g2', 'x'.repeat(20 * 1024 * 1024)),
    );
    f.pipeline.checkGroup.mockImplementation(async (id, context) => {
      const result = groupResult(id, 'x'.repeat(15 * 1024 * 1024));
      context.validateResult?.(result);
      f.writes.push(id);
      return result;
    });
    const reference = await f.executor.execute(batch, f.context);
    expect(f.writes).toEqual([]);
    expect(f.receipts.get(reference.operationKey)!.result).toMatchObject({
      successCount: 1,
      failedCount: 2,
    });
  });
  it('does not convert uncertain writes into per-group failure and stops later dispatch', async () => {
    const f = setup(1);
    f.pipeline.checkGroup.mockRejectedValue(
      new VariantCheckCommitUncertainError(),
    );
    await expect(f.executor.execute(batch, f.context)).rejects.toBeInstanceOf(
      VariantCheckCommitUncertainError,
    );
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(1);
    expect(f.receipts.has(variantCheckJobOperation(batch).operationKey)).toBe(
      false,
    );
  });
  it('checks fresh authority before reading a completed result', async () => {
    const f = setup();
    await f.executor.execute(batch, f.context);
    const reads = f.unit.readReceipt.mock.calls.length;
    f.context.authorize = async () => {
      throw new Error('denied');
    };
    await expect(f.executor.execute(batch, f.context)).rejects.toThrow(
      'denied',
    );
    expect(f.unit.readReceipt).toHaveBeenCalledTimes(reads);
  });
  it('persists parent lookup once without invoking state-changing checks', async () => {
    const f = setup();
    const data = {
      ...identity,
      taskType: 'variant-check',
      taskSubType: 'parent-asin-query',
      params: { asins: ['b000000001'], country: 'us' },
    };
    const reference = await f.executor.execute(data, f.context);
    expect(f.parents.query).toHaveBeenCalledWith(
      ['B000000001'],
      'US',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(f.receipts.get(reference.operationKey)!.result).toMatchObject([
      { title: 'Full title' },
    ]);
    await f.executor.execute(data, f.context);
    expect(f.parents.query).toHaveBeenCalledTimes(1);
    expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
  });
  it('recovers a lost final receipt COMMIT acknowledgement without rerunning checked groups', async () => {
    const f = setup();
    const original = f.repository.transaction;
    let failCommit = true;
    f.repository.transaction = async (action) => {
      const result = await original(action);
      if (
        failCommit &&
        f.receipts.has(variantCheckJobOperation(batch).operationKey)
      ) {
        failCommit = false;
        throw new Error('lost ack');
      }
      return result;
    };
    await expect(f.executor.execute(batch, f.context)).rejects.toBeInstanceOf(
      VariantCheckCommitUncertainError,
    );
    await f.executor.execute(batch, f.context);
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(3);
  });
  it('retains actual admission after caller cancellation until noncooperative work settles', async () => {
    const f = setup(),
      gate = deferred<VariantGroupCheckData>(),
      controller = new AbortController();
    f.pipeline.checkGroup.mockImplementation(() => gate.promise);
    const runs = Array.from({ length: 4 }, () =>
      f.executor
        .checkGroups(['g1'], { ...f.context, signal: controller.signal })
        .catch((error: unknown) => error),
    );
    await flush();
    controller.abort();
    expect(await Promise.all(runs)).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({ code: 'CANCELLED' }),
      ),
    );
    await expect(
      f.executor.checkGroups(['g1'], f.context),
    ).rejects.toMatchObject({ code: 'capacity' });
    gate.resolve(groupResult('g1'));
    await flush();
    expect((await f.executor.checkGroups(['g1'], f.context)).total).toBe(1);
  });
  it('propagates progress callback failure and never dispatches another group', async () => {
    const f = setup(1);
    f.context.onProgress = async () => {
      throw new Error('lease lost');
    };
    await expect(f.executor.execute(batch, f.context)).rejects.toThrow(
      'lease lost',
    );
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(1);
  });
  it('limits failed samples while retaining every complete failure result', () => {
    const result = batchCheckTaskResult({
      total: 30,
      results: Array.from({ length: 30 }, (_, index) => ({
        groupId: `g${index}`,
        success: false,
        error: '检查失败',
      })),
    });
    expect(result.failedSamples).toHaveLength(20);
    expect(result.results).toHaveLength(30);
  });
});
describe('owned task result reference', () => {
  it('reconstructs the receipt from independently authenticated task identity', () => {
    const operation = variantCheckJobOperation(batch);
    const reference = variantCheckResultReference(operation);
    expect(variantCheckResultOperation(batch, reference)).toEqual(operation);
    expect(reference).not.toHaveProperty('userId');
    for (const patch of [
      { userId: 'foreign-owner' },
      { createdAt: '2026-09-13T00:00:00.001Z' },
      { taskSubType: 'competitor-variant-group' },
    ])
      expect(() =>
        variantCheckResultOperation({ ...batch, ...patch }, reference),
      ).toThrow(VariantCheckError);
  });
  it.each([
    { userId: '' },
    { taskType: 'import' },
    { expiresAt: identity.createdAt },
    { taskId: '../fixture' },
    { params: { groupIds: [], forceRefresh: true } },
    { params: { groupIds: ['g1'], forceRefresh: true, secret: 'forbidden' } },
  ])('rejects a malformed queued payload before execution (%j)', (patch) => {
    expect(() => parseVariantCheckJob({ ...batch, ...patch })).toThrow(
      VariantCheckError,
    );
  });
  it('detects a changed request in a saved group receipt before any new work', async () => {
    const f = setup();
    await f.unit.saveReceipt(
      variantCheckJobOperation(batch, 0),
      groupResult('g1'),
    );
    await expect(
      f.executor.execute(
        { ...batch, params: { ...batch.params, forceRefresh: false } },
        f.context,
      ),
    ).rejects.toMatchObject({ code: 'operation-mismatch' });
    expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
  });
});
