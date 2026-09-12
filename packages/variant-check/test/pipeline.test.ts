import {
  CatalogDeferredError,
  SpApiError,
  catalogNotFoundResult,
  type CatalogVariantChecker,
} from '@asin-monitor/sp-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VariantCheckCommitUncertainError,
  VariantCheckPipeline,
  type VariantCheckContext,
} from '../src/pipeline';
import {
  VariantCheckError,
  type GroupCheckSnapshot,
  type VariantCheckRepositoryPort,
  type VariantCheckUnit,
} from '../src/types';
import { asin, checkedAt, deferred, flush, group, product } from './fixtures';

function fixture(
  count = 1,
  options?: ConstructorParameters<typeof VariantCheckPipeline>[4],
) {
  const state: GroupCheckSnapshot = {
    group: group(),
    asins: Array.from({ length: count }, (_, i) => asin(i + 1)),
  };
  let inTransaction = 0;
  const commits: unknown[] = [];
  const unit = {
    loadSingle: vi.fn(async () =>
      structuredClone({ group: state.group, asin: state.asins[0] }),
    ),
    loadGroup: vi.fn(async () => structuredClone(state)),
    commitSingle: vi.fn<VariantCheckUnit['commitSingle']>(
      async (_expected, result, guard) => {
        await guard();
        const value = {
          group: state.group,
          asin: {
            ...state.asins[0],
            isBroken: !result.hasVariants,
            variantStatus: result.hasVariants ? 'NORMAL' : 'BROKEN',
            lastCheckTime: checkedAt,
            updateTime: checkedAt,
          },
          result,
        };
        await guard();
        return value;
      },
    ),
    commitGroup: vi.fn<VariantCheckUnit['commitGroup']>(
      async (_expected, observations, guard) => {
        await guard();
        const autoBroken = observations.some(
          (value) =>
            value.kind === 'failed' ||
            (value.kind === 'checked' && !value.result.hasVariants),
        );
        const value = {
          group: {
            ...state.group,
            isBroken: autoBroken,
            variantStatus: autoBroken ? 'BROKEN' : 'NORMAL',
            lastCheckTime: state.asins.length ? checkedAt : null,
          },
          asins: state.asins.map((row, i) => {
            const observation = observations[i];
            const broken =
              observation.kind === 'deferred'
                ? row.isBroken
                : observation.kind === 'failed' ||
                  !observation.result.hasVariants;
            return {
              ...row,
              isBroken: broken,
              variantStatus: broken ? 'BROKEN' : 'NORMAL',
              lastCheckTime: checkedAt,
              updateTime: checkedAt,
            };
          }),
          observations,
        };
        await guard();
        return value;
      },
    ),
  };
  let transactionNumber = 0;
  const hooks: { afterAction?(number: number): Promise<void> } = {};
  const repository: VariantCheckRepositoryPort = {
    async transaction(action) {
      const number = ++transactionNumber;
      inTransaction++;
      try {
        const value = await action(unit as unknown as VariantCheckUnit);
        await hooks.afterAction?.(number);
        if (number % 2 === 0) commits.push(value);
        return value;
      } finally {
        inTransaction--;
      }
    },
  };
  const check = vi.fn<CatalogVariantChecker['check']>(async (code) => {
    expect(inTransaction).toBe(0);
    return product(Number(code.slice(1)));
  });
  const cache = {
    invalidate: vi.fn(
      async (_identity: unknown, _signal: AbortSignal): Promise<void> =>
        undefined,
    ),
    clearDeferred: vi.fn(
      async (_identity: unknown, _signal: AbortSignal): Promise<void> =>
        undefined,
    ),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const context: VariantCheckContext = {
    authorize: vi.fn(async () => undefined),
    checkpoint: vi.fn(async () => undefined),
  };
  const pipeline = new VariantCheckPipeline(
    repository,
    { check },
    cache,
    logger,
    options,
  );
  return {
    pipeline,
    unit,
    check,
    cache,
    logger,
    context,
    state,
    hooks,
    commits,
  };
}
const live: VariantCheckPipeline[] = [];
const setup = (
  count = 1,
  options?: ConstructorParameters<typeof VariantCheckPipeline>[4],
) => {
  const f = fixture(count, options);
  live.push(f.pipeline);
  return f;
};
afterEach(() => {
  for (const item of live.splice(0)) item.close();
  vi.useRealTimers();
});

describe('Primary variant business pipeline', () => {
  it.each([
    { threshold: 0, force: false, expected: false },
    { threshold: 3, force: false, expected: false },
    { threshold: 2, force: false, expected: true },
    { threshold: 2, force: true, expected: false },
  ])(
    'uses hybrid only for enabled thresholds and non-forced groups: $threshold / $force',
    async ({ threshold, force, expected }) => {
      const check = vi.fn(async () => [product(1), product(2)]);
      const f = setup(2, { hybrid: { check }, batchThreshold: threshold });
      await f.pipeline.checkGroup('g1', { ...f.context, forceRefresh: force });
      expect(check).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(f.check).toHaveBeenCalledTimes(expected ? 0 : 2);
      expect(f.unit.commitGroup).toHaveBeenCalledOnce();
      if (expected)
        expect(check).toHaveBeenCalledWith(
          ['B000000001', 'B000000002'],
          'US',
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            checkpoint: expect.any(Function),
          }),
        );
    },
  );

  it('refuses an enabled batch threshold without its real hybrid dependency', () => {
    expect(() => setup(2, { batchThreshold: 2 })).toThrow(SpApiError);
  });

  it('does not persist a partial hybrid array or continue individual checks after a hybrid lifecycle failure', async () => {
    const check = vi.fn(async () => [product(1)]);
    const f = setup(2, { hybrid: { check }, batchThreshold: 2 });
    await expect(f.pipeline.checkGroup('g1', f.context)).rejects.toMatchObject({
      code: 'invalid-result',
    });
    check.mockRejectedValueOnce(new SpApiError('CANCELLED'));
    await expect(f.pipeline.checkGroup('g1', f.context)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(f.check).not.toHaveBeenCalled();
    expect(f.unit.commitGroup).not.toHaveBeenCalled();
  });

  it('checks outside transactions, reauthorizes locked writes, and returns the complete result only after commit', async () => {
    const f = setup();
    f.cache.invalidate.mockImplementation(async () => {
      expect(f.commits).toHaveLength(1);
    });
    const result = await f.pipeline.checkSingle('a1', {
      ...f.context,
      forceRefresh: true,
    });
    expect(result).toMatchObject({
      isBroken: false,
      raw: { details: product() },
    });
    expect(f.check).toHaveBeenCalledWith(
      'B000000001',
      'US',
      expect.objectContaining({ forceRefresh: true, priority: 1 }),
    );
    expect(f.context.authorize).toHaveBeenCalledTimes(5);
    expect(f.unit.commitSingle).toHaveBeenCalledOnce();
    expect(f.cache.invalidate).toHaveBeenCalledWith(
      { asin: 'B000000001', country: 'US', owner: 'primary' },
      expect.any(AbortSignal),
    );
  });

  it('rejects initial authorization before reading business records or contacting Amazon', async () => {
    const f = setup();
    const denied = new Error('Permission revoked');
    f.context.authorize = vi.fn(async () => {
      throw denied;
    });
    await expect(f.pipeline.checkSingle('a1', f.context)).rejects.toBe(denied);
    expect(f.unit.loadSingle).not.toHaveBeenCalled();
    expect(f.check).not.toHaveBeenCalled();
    expect(f.commits).toEqual([]);
  });

  it.each(['before-write', 'after-lock'] as const)(
    'rolls back when permission changes %s',
    async (phase) => {
      const f = setup();
      let checks = 0;
      const denied = new Error('Permission revoked');
      f.context.authorize = vi.fn(async () => {
        if (++checks === (phase === 'before-write' ? 2 : 3)) throw denied;
      });
      await expect(f.pipeline.checkSingle('a1', f.context)).rejects.toBe(
        denied,
      );
      expect(f.commits).toEqual([]);
      expect(f.cache.invalidate).not.toHaveBeenCalled();
    },
  );

  it('propagates stale snapshot conflicts without cache invalidation or retries', async () => {
    const f = setup();
    f.unit.commitSingle.mockRejectedValue(
      new VariantCheckError('snapshot-changed'),
    );
    await expect(f.pipeline.checkSingle('a1', f.context)).rejects.toMatchObject(
      { code: 'snapshot-changed' },
    );
    expect(f.check).toHaveBeenCalledOnce();
    expect(f.commits).toEqual([]);
    expect(f.cache.invalidate).not.toHaveBeenCalled();
  });

  it('reports a lost COMMIT acknowledgement as uncertain without exposing connection details', async () => {
    const f = setup();
    f.hooks.afterAction = async (number) => {
      if (number === 2) throw new Error('postgres://secret@example');
    };
    await expect(f.pipeline.checkSingle('a1', f.context)).rejects.toMatchObject(
      {
        name: 'VariantCheckCommitUncertainError',
        commitMayHaveSucceeded: true,
      },
    );
    expect(f.cache.invalidate).not.toHaveBeenCalled();
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('secret');
  });

  it('reports cancellation while COMMIT is pending as uncertain and does not repeat persistence', async () => {
    const f = setup();
    const gate = deferred<void>();
    const controller = new AbortController();
    f.hooks.afterAction = async (number) => {
      if (number === 2) await gate.promise;
    };
    const result = f.pipeline
      .checkSingle('a1', { ...f.context, signal: controller.signal })
      .catch((error: unknown) => error);
    await flush();
    expect(f.unit.commitSingle).toHaveBeenCalledOnce();
    controller.abort();
    expect(await result).toBeInstanceOf(VariantCheckCommitUncertainError);
    gate.resolve();
    await flush();
    expect(f.unit.commitSingle).toHaveBeenCalledOnce();
  });

  it('keeps cancelled noncooperative Amazon calls admitted until actual settlement and never writes late results', async () => {
    const f = setup();
    const gate = deferred<ReturnType<typeof product>>();
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    f.check.mockImplementation(() => gate.promise);
    const pending = controllers.map((controller) =>
      f.pipeline
        .checkSingle('a1', { ...f.context, signal: controller.signal })
        .catch((error: unknown) => error),
    );
    await flush();
    expect(f.check).toHaveBeenCalledTimes(8);
    controllers.forEach((controller) => controller.abort());
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 8 }, () =>
        expect.objectContaining({ code: 'CANCELLED' }),
      ),
    );
    await expect(f.pipeline.checkSingle('a1', f.context)).rejects.toMatchObject(
      { code: 'capacity' },
    );
    gate.resolve(product());
    await flush();
    expect(f.unit.commitSingle).not.toHaveBeenCalled();
    f.check.mockResolvedValue(product());
    await expect(
      f.pipeline.checkSingle('a1', f.context),
    ).resolves.toMatchObject({ isBroken: false });
  });

  it('stops at the overall deadline even while an authorization checkpoint ignores cancellation', async () => {
    vi.useFakeTimers();
    const f = setup();
    const gate = deferred<void>();
    f.context.checkpoint = () => gate.promise;
    const result = f.pipeline
      .checkSingle('a1', f.context)
      .catch((error: unknown) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(900000);
    expect(await result).toMatchObject({ code: 'TIMEOUT' });
    gate.resolve();
    await flush();
    expect(f.unit.loadSingle).not.toHaveBeenCalled();
    expect(f.check).not.toHaveBeenCalled();
  });

  it('captures forceRefresh and authorization callbacks at dispatch', async () => {
    const f = setup();
    const context = { ...f.context, forceRefresh: true };
    const result = f.pipeline.checkSingle('a1', context);
    context.forceRefresh = false;
    context.authorize = async () => {
      throw new Error('Mutated callback');
    };
    await result;
    expect(f.check.mock.calls[0][2]?.forceRefresh).toBe(true);
  });

  it('caps group concurrency at three and preserves input order with serialized progress', async () => {
    const f = setup(6);
    const gates = Array.from({ length: 6 }, () =>
      deferred<ReturnType<typeof product>>(),
    );
    const reports: number[] = [];
    const progressGate = deferred<void>();
    f.check.mockImplementation(
      (code) => gates[Number(code.slice(1)) - 1].promise,
    );
    const result = f.pipeline.checkGroup('g1', {
      ...f.context,
      onProgress: async (done, total) => {
        expect(total).toBe(6);
        reports.push(done);
        if (done === 1) await progressGate.promise;
      },
    });
    await flush();
    expect(f.check).toHaveBeenCalledTimes(3);
    gates[2].resolve(product(3));
    gates[0].resolve(product(1));
    gates[1].resolve(product(2));
    await flush();
    expect(reports).toEqual([1]);
    expect(f.check).toHaveBeenCalledTimes(3);
    progressGate.resolve();
    await flush();
    expect(f.check).toHaveBeenCalledTimes(6);
    for (const index of [5, 4, 3]) gates[index].resolve(product(index + 1));
    const output = await result;
    expect(reports).toEqual([1, 2, 3, 4, 5, 6]);
    expect(output.details?.results.map((row) => row.asin)).toEqual(
      f.state.asins.map((row) => row.asin),
    );
    expect(
      f.unit.commitGroup.mock.calls[0][1].map((row) => row.asinId),
    ).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it('persists partial group failures safely and preserves a deferred child automatic state', async () => {
    const f = setup(3);
    f.state.asins[1].isBroken = true;
    f.check.mockImplementation(async (code) => {
      if (code === 'B000000002')
        throw new CatalogDeferredError(new SpApiError('HTTP_ERROR', 503));
      if (code === 'B000000003')
        throw new Error('token=upstream-private-payload');
      return product();
    });
    const output = await f.pipeline.checkGroup('g1', f.context);
    expect(output.brokenByType).toEqual({
      SP_API_ERROR: 1,
      NOT_FOUND: 0,
      NO_VARIANTS: 0,
    });
    expect(f.unit.commitGroup.mock.calls[0][1]).toMatchObject([
      { kind: 'checked' },
      { kind: 'deferred' },
      { kind: 'failed', error: 'SP-API检查失败' },
    ]);
    expect(output.brokenASINs).toMatchObject([
      { asin: 'B000000002', statusSource: 'AUTO' },
      { asin: 'B000000003', errorType: 'SP_API_ERROR' },
    ]);
    expect(
      JSON.stringify([
        output,
        f.logger.info.mock.calls,
        f.logger.warn.mock.calls,
      ]),
    ).not.toContain('upstream-private-payload');
  });

  it.each([
    'CAPACITY',
    'DEPENDENCY_ERROR',
    'TIMEOUT',
    'CLOSED',
    'CANCELLED',
  ] as const)(
    'aborts the group on %s, signals siblings and never dispatches remaining items',
    async (code) => {
      const f = setup(5);
      const gate = deferred<ReturnType<typeof product>>();
      f.check.mockImplementation((productCode) =>
        productCode === 'B000000001'
          ? Promise.reject(new SpApiError(code))
          : gate.promise,
      );
      await expect(
        f.pipeline.checkGroup('g1', f.context),
      ).rejects.toMatchObject({ code });
      expect(f.check.mock.calls.length).toBeLessThanOrEqual(3);
      expect(f.check.mock.calls.every((call) => call[2]?.signal?.aborted)).toBe(
        true,
      );
      gate.resolve(product(2));
      await flush();
      expect(f.check.mock.calls.length).toBeLessThanOrEqual(3);
      expect(f.unit.commitGroup).not.toHaveBeenCalled();
    },
  );

  it('stops on task progress persistence failure with no fabricated group state', async () => {
    const f = setup(6);
    const failure = new Error('Task lease expired');
    await expect(
      f.pipeline.checkGroup('g1', {
        ...f.context,
        onProgress: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(f.check.mock.calls.length).toBeLessThanOrEqual(3);
    expect(f.unit.commitGroup).not.toHaveBeenCalled();
  });

  it('rejects a full response larger than 32 MiB while the write transaction can still roll back', async () => {
    const f = setup(3);
    const title = 'x'.repeat(6 * 1024 * 1024);
    f.check.mockImplementation(async (code) =>
      product(Number(code.slice(1)), true, title),
    );
    await expect(f.pipeline.checkGroup('g1', f.context)).rejects.toMatchObject({
      code: 'capacity',
    });
    // Each Catalog result is below 8 MiB. The complete response contains both
    // per-item details and the frozen raw view, so its bound must precede COMMIT.
    expect(f.unit.commitGroup).toHaveBeenCalledOnce();
    expect(f.commits).toEqual([]);
    expect(f.cache.invalidate).not.toHaveBeenCalled();
  });

  it('bounds retained observations before starting a transaction for a very large group', async () => {
    const f = setup(7);
    const title = 'x'.repeat(6 * 1024 * 1024);
    f.check.mockImplementation(async (code) =>
      product(Number(code.slice(1)), true, title),
    );
    await expect(f.pipeline.checkGroup('g1', f.context)).rejects.toMatchObject({
      code: 'capacity',
    });
    await flush();
    expect(f.unit.commitGroup).not.toHaveBeenCalled();
  });

  it('does not contact Amazon or clear caches for an empty group', async () => {
    const f = setup(0);
    await expect(f.pipeline.checkGroup('g1', f.context)).resolves.toMatchObject(
      { isBroken: true, details: { results: [] } },
    );
    expect(f.check).not.toHaveBeenCalled();
    expect(f.cache.invalidate).not.toHaveBeenCalled();
  });

  it('clears the deferred entry only for a confirmed NOT_FOUND and treats cache failure as advisory', async () => {
    const f = setup();
    f.check.mockResolvedValue(catalogNotFoundResult('B000000001', 'US'));
    await f.pipeline.checkSingle('a1', f.context);
    expect(f.cache.clearDeferred).toHaveBeenCalledOnce();
    f.cache.invalidate.mockRejectedValue(new Error('Redis secret payload'));
    await expect(
      f.pipeline.checkSingle('a1', f.context),
    ).resolves.toMatchObject({ isBroken: true });
    expect(f.logger.warn).toHaveBeenCalledWith('检查已提交，共享缓存清理失败', {
      reason: 'variant_check_cache_invalidation_failed',
    });
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('secret');
  });

  it('returns confirmed success if the caller cancels during cache cleanup', async () => {
    const f = setup();
    const gate = deferred<void>();
    const controller = new AbortController();
    f.cache.invalidate.mockImplementation(() => gate.promise);
    const result = f.pipeline.checkSingle('a1', {
      ...f.context,
      signal: controller.signal,
    });
    await flush();
    expect(f.cache.invalidate).toHaveBeenCalledOnce();
    controller.abort();
    await expect(result).resolves.toMatchObject({ isBroken: false });
    gate.resolve();
    await flush();
  });

  it('bounds post-commit cleanup to two seconds and retains cleanup admission until actual I/O settles', async () => {
    vi.useFakeTimers();
    const f = setup();
    const gate = deferred<void>();
    f.cache.invalidate.mockImplementation(() => gate.promise);
    for (let i = 0; i < 8; i++) {
      const result = f.pipeline.checkSingle('a1', f.context);
      await flush();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(result).resolves.toMatchObject({ isBroken: false });
    }
    await expect(
      f.pipeline.checkSingle('a1', f.context),
    ).resolves.toMatchObject({ isBroken: false });
    expect(f.cache.invalidate).toHaveBeenCalledTimes(8);
    expect(f.cache.invalidate.mock.calls.every((call) => call[1].aborted)).toBe(
      true,
    );
    expect(f.logger.warn).toHaveBeenCalledWith(
      '检查已提交，共享缓存清理容量已满',
      { reason: 'variant_check_cache_capacity' },
    );
    gate.resolve();
    await flush();
    await f.pipeline.checkSingle('a1', f.context);
    expect(f.cache.invalidate).toHaveBeenCalledTimes(9);
  });

  it('cleans group caches with at most eight actual calls and stops pending work at the deadline', async () => {
    vi.useFakeTimers();
    const f = setup(20);
    const gate = deferred<void>();
    f.cache.invalidate.mockImplementation(() => gate.promise);
    const result = f.pipeline.checkGroup('g1', f.context);
    await flush();
    await flush();
    expect(f.cache.invalidate).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    gate.resolve();
    await flush();
    expect(f.cache.invalidate).toHaveBeenCalledTimes(8);
  });

  it('closes pending operations and rejects future checks without allowing late writes', async () => {
    const f = setup();
    const gate = deferred<ReturnType<typeof product>>();
    f.check.mockImplementation(() => gate.promise);
    const result = f.pipeline
      .checkSingle('a1', f.context)
      .catch((error: unknown) => error);
    await flush();
    f.pipeline.close();
    expect(await result).toMatchObject({ code: 'CLOSED' });
    await expect(f.pipeline.checkGroup('g1', f.context)).rejects.toMatchObject({
      code: 'CLOSED',
    });
    gate.resolve(product());
    await flush();
    expect(f.unit.commitSingle).not.toHaveBeenCalled();
  });
});
