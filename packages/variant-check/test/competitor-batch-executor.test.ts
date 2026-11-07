import type { VariantCheckJobData } from '@asin-monitor/contracts';
import {
  decodeVariantCheckReceiptResult,
  VariantCheckError,
  type CompetitorCheckRepositoryPort,
  type CompetitorCheckUnit,
  type VariantCheckOperation,
} from '@asin-monitor/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompetitorBatchCheckExecutor,
  type CompetitorBatchContext,
} from '../src/competitor-batch-executor';
import type {
  CompetitorCheckPipeline,
  CompetitorGroupCheckData,
} from '../src/competitor-pipeline';
import { VariantCheckCommitUncertainError } from '../src/pipeline';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
  variantCheckResultOperation,
} from '../src/task';
import { deferred, flush } from './fixtures';

const job: Extract<
  VariantCheckJobData,
  { taskSubType: 'competitor-variant-group' }
> = {
  taskId: '10000000-0000-4000-8000-000000000251',
  userId: 'batch-competitor-owner',
  taskType: 'batch-check',
  taskSubType: 'competitor-variant-group',
  createdAt: '2026-11-06T00:00:00.000Z',
  expiresAt: '2026-11-13T00:00:00.000Z',
  params: { groupIds: ['g1', 'g2', 'g3'], forceRefresh: true },
};
const result = (id: string, padding = '') =>
  ({
    isBroken: false,
    brokenASINs: [],
    brokenByType: {},
    groupSnapshot: { id },
    details: { totalASINs: 0, brokenCount: 0, results: [], padding },
  } as unknown as CompetitorGroupCheckData);
const close: Array<() => void> = [];
afterEach(() => {
  close.splice(0).forEach((f) => f());
  vi.useRealTimers();
});
function setup(concurrency = 2) {
  const receipts = new Map<
    string,
    { operation: VariantCheckOperation; result: unknown }
  >();
  const writes: string[] = [];
  const unit = {
    readReceipt: vi.fn<CompetitorCheckUnit['readReceipt']>(
      async (operation) => {
        const saved = receipts.get(operation.operationKey);
        if (
          saved &&
          JSON.stringify(saved.operation) !== JSON.stringify(operation)
        )
          throw new VariantCheckError('operation-mismatch');
        return structuredClone(saved?.result);
      },
    ),
    saveReceipt: vi.fn<CompetitorCheckUnit['saveReceipt']>(
      async (operation, output) => {
        expect(operation.resultKind.startsWith('competitor-')).toBe(true);
        receipts.set(operation.operationKey, {
          operation,
          result: decodeVariantCheckReceiptResult(output, operation.resultKind),
        });
      },
    ),
  };
  const repository: CompetitorCheckRepositoryPort = {
    transaction: async (action) =>
      action(unit as unknown as CompetitorCheckUnit),
  };
  const pipeline = {
    checkGroup: vi.fn<CompetitorCheckPipeline['checkGroup']>(
      async (id, scope) => {
        await scope.checkpoint();
        const output = result(id);
        scope.validateResult?.(output);
        if (scope.operation) await unit.saveReceipt(scope.operation, output);
        writes.push(id);
        return output;
      },
    ),
  };
  const context: CompetitorBatchContext = {
    forceRefresh: true,
    checkpoint: vi.fn(async () => undefined),
    authorize: vi.fn(async () => undefined),
    onProgress: vi.fn(async () => undefined),
  };
  const executor = new CompetitorBatchCheckExecutor(
    repository,
    pipeline,
    concurrency,
  );
  close.push(() => executor.close());
  return { executor, repository, unit, receipts, writes, pipeline, context };
}
describe('dedicated competitor bounded batch executor', () => {
  it('retains input order, duplicate positions, raw bytes and competitor-only receipt identities', async () => {
    const f = setup(1),
      ids = [' raw ', '   ', '.', '😺'.repeat(50), ' raw '];
    const data = {
      ...job,
      params: { groupIds: ids, forceRefresh: false, country: 'zz' },
    };
    const reference = await f.executor.execute(data, f.context);
    expect(reference.resultKind).toBe('competitor-batch');
    expect(f.writes).toEqual(ids);
    expect(
      f.pipeline.checkGroup.mock.calls.map(([, c]) => [
        c.operation?.step,
        c.operation?.resultKind,
        c.forceRefresh,
      ]),
    ).toEqual(ids.map((_, i) => [`group-${i}`, 'competitor-group', false]));
    expect(f.receipts.get(reference.operationKey)?.result).toMatchObject({
      total: 5,
      successCount: 5,
      results: ids.map((groupId) => ({ groupId, success: true })),
    });
    expect(variantCheckResultOperation(data, reference)).toEqual(
      variantCheckJobOperation(data),
    );
    expect(parseVariantCheckJob(data).params).toMatchObject({ country: 'zz' });
    expect(Buffer.byteLength(JSON.stringify(reference))).toBeLessThan(1024);
  });
  it.each(['x'.repeat(51), '😺'.repeat(51), '\u0001', '\u0085', '\ud800'])(
    'rejects unsafe literal %j before any work',
    async (id) => {
      const f = setup();
      await expect(
        Promise.resolve().then(() => f.executor.checkGroups([id], f.context)),
      ).rejects.toMatchObject({ code: 'invalid-input' });
      expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
    },
  );
  it('isolates recoverable group failures and replays the complete root without rechecking', async () => {
    const f = setup();
    const original = f.pipeline.checkGroup.getMockImplementation()!;
    f.pipeline.checkGroup.mockImplementation(async (id, scope) => {
      if (id === 'g2') throw new VariantCheckError('group-not-found');
      return original(id, scope);
    });
    const reference = await f.executor.execute(job, f.context);
    expect(f.receipts.get(reference.operationKey)?.result).toMatchObject({
      total: 3,
      successCount: 2,
      failedCount: 1,
      verificationPassed: false,
      results: [
        { groupId: 'g1', success: true },
        { groupId: 'g2', success: false },
        { groupId: 'g3', success: true },
      ],
    });
    expect(await f.executor.execute(job, f.context)).toEqual(reference);
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(3);
    expect(f.context.onProgress).toHaveBeenLastCalledWith(3, 3);
  });
  it('recovers per-index group receipts before admitting new work after a restart', async () => {
    const f = setup();
    await f.unit.saveReceipt(
      variantCheckJobOperation(job, 1),
      result('g2', 'full old payload'),
    );
    const reference = await f.executor.execute(job, f.context);
    expect(f.writes).toEqual(['g1', 'g3']);
    expect(f.receipts.get(reference.operationKey)?.result).toMatchObject({
      results: [{}, { details: { padding: 'full old payload' } }, {}],
    });
  });
  it('enforces the configured async concurrency and preserves ordering after out-of-order completion', async () => {
    const f = setup(),
      gates = [
        deferred<CompetitorGroupCheckData>(),
        deferred<CompetitorGroupCheckData>(),
        deferred<CompetitorGroupCheckData>(),
      ];
    f.pipeline.checkGroup.mockImplementation(
      (id) => gates[Number(id.slice(1)) - 1].promise,
    );
    const running = f.executor.checkGroups(['g1', 'g2', 'g3'], f.context, 2);
    await flush();
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(2);
    gates[1].resolve(result('g2'));
    await flush();
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(3);
    gates[2].resolve(result('g3'));
    gates[0].resolve(result('g1'));
    expect((await running).results.map((r) => r.groupId)).toEqual([
      'g1',
      'g2',
      'g3',
    ]);
  });
  it('does not publish partial completion or dispatch later groups after an uncertain commit', async () => {
    const f = setup(1);
    f.pipeline.checkGroup.mockRejectedValue(
      new VariantCheckCommitUncertainError(),
    );
    await expect(f.executor.execute(job, f.context)).rejects.toBeInstanceOf(
      VariantCheckCommitUncertainError,
    );
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(1);
    expect(f.receipts.has(variantCheckJobOperation(job).operationKey)).toBe(
      false,
    );
  });
  it('serializes duplicate positions while unrelated groups keep the free concurrency slot', async () => {
    const f = setup(),
      first = deferred<CompetitorGroupCheckData>(),
      other = deferred<CompetitorGroupCheckData>();
    let duplicates = 0;
    f.pipeline.checkGroup.mockImplementation(async (id) => {
      if (id === 'g1' && ++duplicates === 1) return first.promise;
      if (id === 'g2') return other.promise;
      return result(id);
    });
    const running = f.executor.execute(
      { ...job, params: { ...job.params, groupIds: ['g1', 'g1', 'g2'] } },
      f.context,
    );
    await flush();
    expect(f.pipeline.checkGroup.mock.calls.map(([id]) => id)).toEqual([
      'g1',
      'g2',
    ]);
    other.resolve(result('g2'));
    await flush();
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(2);
    first.resolve(result('g1'));
    const reference = await running;
    expect(f.pipeline.checkGroup.mock.calls.map(([id]) => id)).toEqual([
      'g1',
      'g2',
      'g1',
    ]);
    expect(
      f.pipeline.checkGroup.mock.calls.map(
        ([, scope]) => scope.operation?.step,
      ),
    ).toEqual(['group-0', 'group-2', 'group-1']);
    expect(f.receipts.get(reference.operationKey)?.result).toMatchObject({
      successCount: 3,
      results: [{ groupId: 'g1' }, { groupId: 'g1' }, { groupId: 'g2' }],
    });
  });
  it('never starts waiting duplicates after cancellation or an uncertain predecessor commit', async () => {
    const f = setup(),
      gate = deferred<CompetitorGroupCheckData>();
    f.pipeline.checkGroup.mockImplementation(() => gate.promise);
    const running = f.executor.execute(
      { ...job, params: { ...job.params, groupIds: ['g1', 'g1'] } },
      f.context,
    );
    const rejected = expect(running).rejects.toBeInstanceOf(
      VariantCheckCommitUncertainError,
    );
    await flush();
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(1);
    gate.reject(new VariantCheckCommitUncertainError());
    await rejected;
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(1);
    expect(f.receipts.size).toBe(0);
  });
  it('recovers a root COMMIT acknowledgement loss without duplicate group/history writes', async () => {
    const f = setup(),
      transaction = f.repository.transaction;
    let lose = true;
    f.repository.transaction = async (action) => {
      const value = await transaction(action);
      if (lose && f.receipts.has(variantCheckJobOperation(job).operationKey)) {
        lose = false;
        throw new Error('lost root commit acknowledgement');
      }
      return value;
    };
    await expect(f.executor.execute(job, f.context)).rejects.toBeInstanceOf(
      VariantCheckCommitUncertainError,
    );
    await f.executor.execute(job, f.context);
    expect(f.writes).toEqual(['g1', 'g2', 'g3']);
  });
  it('rejects a changed request hash before replaying a saved group', async () => {
    const f = setup();
    await f.unit.saveReceipt(variantCheckJobOperation(job, 0), result('g1'));
    await expect(
      f.executor.execute(
        { ...job, params: { ...job.params, forceRefresh: false } },
        f.context,
      ),
    ).rejects.toMatchObject({ code: 'operation-mismatch' });
    expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
  });
  it('retains physical admission after caller cancellation until the actual group work settles', async () => {
    const f = setup(),
      gate = deferred<CompetitorGroupCheckData>(),
      controller = new AbortController();
    f.pipeline.checkGroup.mockImplementation(() => gate.promise);
    const runs = Array.from({ length: 4 }, () =>
      f.executor
        .checkGroups(['g1'], { ...f.context, signal: controller.signal })
        .catch((e: unknown) => e),
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
    gate.resolve(result('g1'));
    await flush();
    expect((await f.executor.checkGroups(['g1'], f.context)).total).toBe(1);
    expect(f.receipts.has(variantCheckJobOperation(job).operationKey)).toBe(
      false,
    );
  });
  it('checks authority before root replay and stops on failed progress ownership', async () => {
    const f = setup(1);
    f.context.onProgress = async () => {
      throw new Error('lease lost');
    };
    await expect(f.executor.execute(job, f.context)).rejects.toThrow(
      'lease lost',
    );
    expect(f.pipeline.checkGroup).toHaveBeenCalledTimes(1);
    f.context.authorize = async () => {
      throw new Error('permission revoked');
    };
    await expect(f.executor.execute(job, f.context)).rejects.toThrow(
      'permission revoked',
    );
  });
});
