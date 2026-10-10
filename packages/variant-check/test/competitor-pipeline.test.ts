import type {
  CompetitorAsin,
  CompetitorCheckRepositoryPort,
  CompetitorCheckUnit,
  CompetitorGroupCheckSnapshot,
  CompetitorVariantGroup,
} from '@asin-monitor/db';
import {
  competitorMonitorSnapshotDigest,
  createVariantCheckOperation,
} from '@asin-monitor/db';
import {
  CatalogDeferredError,
  catalogNotFoundResult,
  SpApiError,
  type CatalogVariantResult,
} from '@asin-monitor/sp-api';
import { describe, expect, it, vi } from 'vitest';
import {
  CompetitorCheckPipeline,
  type CompetitorCheckContext,
} from '../src/competitor-pipeline';

const before = new Date('2026-01-01T00:00:00.000Z');
const checkedAt = new Date('2026-09-12T00:00:00.000Z');

function group(): CompetitorVariantGroup {
  return {
    id: 'cg1',
    name: 'Competitor fixture group',
    country: 'US',
    brand: 'Fixture',
    isBroken: false,
    variantStatus: 'NORMAL',
    feishuNotifyEnabled: true,
    createTime: before,
    updateTime: before,
    lastCheckTime: null,
  };
}

function asin(index: number): CompetitorAsin {
  return {
    id: `ca${index}`,
    asin: `B00000000${index}`,
    name: `Competitor fixture ASIN ${index}`,
    asinType: 'MAIN_LINK',
    country: 'US',
    brand: 'Fixture',
    variantGroupId: 'cg1',
    isBroken: false,
    variantStatus: 'NORMAL',
    feishuNotifyEnabled: true,
    createTime: before,
    updateTime: before,
    lastCheckTime: null,
  };
}

function catalogResult(
  code: string,
  hasVariants: boolean,
): CatalogVariantResult {
  return {
    hasVariants,
    variantCount: hasVariants ? 1 : 0,
    details: {
      asin: code,
      country: 'US',
      title: hasVariants ? 'Fixture title' : '',
      brand: hasVariants ? 'Fixture brand' : null,
      parentAsin: null,
      variations: [],
      relationships: [],
    },
    meta: { source: 'spapi', apiVersion: '2022-04-01' },
  };
}

function fixture() {
  const snapshot: CompetitorGroupCheckSnapshot = {
    group: group(),
    asins: [asin(1), asin(2), asin(3)],
  };
  const loadGroup = vi.fn(async () => structuredClone(snapshot));
  const commitGroup = vi.fn<CompetitorCheckUnit['commitGroup']>(
    async (_expected, observations, guard) => {
      await guard();
      const broken = (index: number) => {
        const item = observations[index];
        return (
          item.kind === 'failed' ||
          !item.result.hasVariants ||
          item.result.variantCount === 0
        );
      };
      const failed = observations.some((_, index) => broken(index));
      return {
        group: {
          ...snapshot.group,
          isBroken: failed,
          variantStatus: failed ? 'BROKEN' : 'NORMAL',
          lastCheckTime: checkedAt,
        },
        asins: snapshot.asins.map((row, index) => ({
          ...row,
          isBroken: broken(index),
          variantStatus: broken(index) ? 'BROKEN' : 'NORMAL',
          lastCheckTime: checkedAt,
          updateTime: checkedAt,
        })),
        observations,
      };
    },
  );
  const unit = {
    readReceipt: vi.fn(async () => undefined),
    saveReceipt: vi.fn(async () => undefined),
    purgeExpiredReceipts: vi.fn(async () => 0),
    loadGroup,
    loadSingle: vi.fn(),
    commitSingle: vi.fn(),
    commitGroup,
  } as unknown as CompetitorCheckUnit & {
    loadGroup: typeof loadGroup;
    commitGroup: typeof commitGroup;
  };
  const repository = {
    transaction: vi.fn(
      async (action: (value: CompetitorCheckUnit) => unknown) => action(unit),
    ),
  } as unknown as CompetitorCheckRepositoryPort;
  const cache = {
    claim: vi.fn(async () => 'claim-1'),
    write: vi.fn(async () => undefined),
    invalidate: vi.fn(
      async (_identity: unknown, _signal: AbortSignal) => undefined,
    ),
    clearDeferred: vi.fn(
      async (_identity: unknown, _signal: AbortSignal) => undefined,
    ),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const checker = { check: vi.fn() };
  const pipeline = new CompetitorCheckPipeline(
    repository,
    checker,
    cache,
    logger,
  );
  const context: CompetitorCheckContext = {
    forceRefresh: true,
    checkpoint: vi.fn(async () => undefined),
    authorize: vi.fn(async () => undefined),
    onProgress: vi.fn(),
  };
  return {
    snapshot,
    unit,
    repository,
    cache,
    logger,
    checker,
    pipeline,
    context,
  };
}
function monitorContext(f: ReturnType<typeof fixture>): CompetitorCheckContext {
  const snapshotDigest = competitorMonitorSnapshotDigest(f.snapshot);
  return {
    ...f.context,
    forceRefresh: false,
    snapshotDigest,
    operation: createVariantCheckOperation(
      {
        taskId: '9e3376d4-f99c-4e61-8765-b81f045c3f6a',
        userId: 'owner',
        taskType: 'competitor-monitor',
        taskSubType: 'competitor',
        taskCreatedAt: '2026-10-02T00:00:00.000Z',
        expiresAt: '2026-10-10T00:00:00.000Z',
        step: 'monitor-1234567890abcdef12345678',
        resultKind: 'competitor-group',
      },
      { groupId: 'cg1', forceRefresh: false, snapshotDigest },
    ),
  };
}

describe('competitor check pipeline', () => {
  it('retains shared group admission until cancelled noncooperative competitor work actually settles', async () => {
    const f = fixture();
    let settle!: () => void;
    const blocked = new Promise<void>((resolve) => {
      settle = resolve;
    });
    f.checker.check.mockImplementation(async (code: string) => {
      await blocked;
      return catalogResult(code, true);
    });
    const release = vi.fn();
    const acquire = vi.fn(async () => release);
    const stop = new AbortController();
    const work = f.pipeline.checkGroup('cg1', {
      ...f.context,
      signal: stop.signal,
      groupAdmission: { acquire },
    } as CompetitorCheckContext);
    void work.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.checker.check).toHaveBeenCalledTimes(3));
      expect(acquire).toHaveBeenCalledTimes(1);
      stop.abort();
      await expect(work).rejects.toThrow('CANCELLED');
      expect(release).not.toHaveBeenCalled();
      settle();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(f.unit.commitGroup).not.toHaveBeenCalled();
    } finally {
      stop.abort();
      settle();
      await work.catch(() => {});
      f.pipeline.close();
    }
  });
  it('clears only the old deferred item after a normal force-refresh recovery without invalidating its successful cache', async () => {
    const f = fixture(),
      context = monitorContext(f);
    f.checker.check.mockImplementation(
      async (
        code: string,
        _country: string,
        options: { forceRefresh: boolean },
      ) => {
        if (code === 'B000000001' && !options.forceRefresh)
          throw new CatalogDeferredError(new SpApiError('HTTP_ERROR', 503));
        return catalogResult(code, true);
      },
    );
    const result = await f.pipeline.checkGroup('cg1', context);
    expect(result).toMatchObject({
      isBroken: false,
      brokenASINs: [],
      brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
      groupSnapshot: {
        isBroken: 0,
        children: [
          { id: 'ca1', isBroken: 0 },
          { id: 'ca2', isBroken: 0 },
          { id: 'ca3', isBroken: 0 },
        ],
      },
    });
    expect(
      f.unit.commitGroup.mock.calls[0][1].every(
        (item) => item.kind === 'checked' && item.result.hasVariants,
      ),
    ).toBe(true);
    expect(f.unit.commitGroup.mock.calls[0][3]).toEqual({
      operation: context.operation,
      snapshotDigest: context.snapshotDigest,
    });
    expect(f.cache.clearDeferred).toHaveBeenCalledOnce();
    expect(f.cache.clearDeferred).toHaveBeenCalledWith(
      { asin: 'B000000001', country: 'US', owner: 'competitor' },
      expect.any(AbortSignal),
    );
    expect(f.cache.invalidate).not.toHaveBeenCalled();
  });
  it('rechecks shared deferred inputs once before an atomic monitor receipt and keeps confirmed NOT_FOUND distinct', async () => {
    const f = fixture(),
      context = monitorContext(f);
    const trace: { force: boolean; time: number }[] = [];
    f.checker.check.mockImplementation(
      async (
        code: string,
        _country: string,
        options: { forceRefresh: boolean },
      ) => {
        if (code === 'B000000001') {
          trace.push({ force: options.forceRefresh, time: Date.now() });
          if (!options.forceRefresh)
            throw new CatalogDeferredError(new SpApiError('HTTP_ERROR', 503));
          return catalogNotFoundResult(code, 'US');
        }
        return catalogResult(code, code === 'B000000003');
      },
    );
    const output = await f.pipeline.checkGroup('cg1', context);
    expect(trace.map((item) => item.force)).toEqual([false, true]);
    expect(trace[1].time - trace[0].time).toBeGreaterThanOrEqual(1900);
    expect(output.brokenByType).toEqual({
      SP_API_ERROR: 0,
      NOT_FOUND: 1,
      NO_VARIANTS: 1,
    });
    expect(f.unit.commitGroup).toHaveBeenCalledWith(
      f.snapshot,
      expect.any(Array),
      expect.any(Function),
      { operation: context.operation, snapshotDigest: context.snapshotDigest },
    );
    expect(vi.mocked(f.unit.saveReceipt)).toHaveBeenCalledOnce();
    expect(f.cache.clearDeferred).toHaveBeenCalledWith(
      { asin: 'B000000001', country: 'US', owner: 'competitor' },
      expect.any(AbortSignal),
    );
  });
  it('commits a final deferred upstream failure only after its bounded second check', async () => {
    const f = fixture(),
      context = monitorContext(f);
    f.snapshot.asins = [f.snapshot.asins[0]];
    context.snapshotDigest = competitorMonitorSnapshotDigest(f.snapshot);
    context.operation = createVariantCheckOperation(
      { ...context.operation! },
      {
        groupId: 'cg1',
        forceRefresh: false,
        snapshotDigest: context.snapshotDigest,
      },
    );
    f.checker.check.mockRejectedValue(
      new CatalogDeferredError(new SpApiError('HTTP_ERROR', 503)),
    );
    const output = await f.pipeline.checkGroup('cg1', context);
    expect(f.checker.check).toHaveBeenCalledTimes(2);
    expect(output.brokenByType.SP_API_ERROR).toBe(1);
    expect(f.unit.commitGroup.mock.calls[0][1]).toEqual([
      { asinId: 'ca1', kind: 'failed', error: 'SP-API延后复核失败' },
    ]);
  });
  it('rejects changed fixed inputs before upstream work and replays a committed receipt without rechecking new members', async () => {
    const f = fixture(),
      context = monitorContext(f);
    f.snapshot.asins.push(asin(4));
    await expect(f.pipeline.checkGroup('cg1', context)).rejects.toMatchObject({
      code: 'snapshot-changed',
    });
    expect(f.checker.check).not.toHaveBeenCalled();
    expect(f.unit.commitGroup).not.toHaveBeenCalled();
    f.snapshot.asins.pop();
    f.checker.check.mockImplementation(async (code: string) =>
      catalogResult(code, true),
    );
    const output = await f.pipeline.checkGroup('cg1', context);
    const count = f.checker.check.mock.calls.length;
    vi.mocked(f.unit.readReceipt).mockResolvedValue(output);
    f.snapshot.asins.push(asin(4));
    expect(await f.pipeline.checkGroup('cg1', context)).toEqual(output);
    expect(f.checker.check).toHaveBeenCalledTimes(count);
    expect(f.unit.commitGroup).toHaveBeenCalledOnce();
  });
  it.each(['failed', 'not-found'])(
    'bounds cleanup for 5000 %s observations even if the cache ignores abort',
    async (kind) => {
      vi.useFakeTimers();
      const f = fixture();
      const signals: AbortSignal[] = [];
      const releases: (() => void)[] = [];
      const cleanup =
        kind === 'failed' ? f.cache.invalidate : f.cache.clearDeferred;
      cleanup.mockImplementation(async (_identity, signal) => {
        signals.push(signal);
        await new Promise<void>((resolve) => releases.push(resolve));
        return undefined;
      });
      f.snapshot.asins = Array.from({ length: 5000 }, (_, index) => ({
        ...asin(index),
        asin: `B${String(index).padStart(9, '0')}`,
      }));
      f.checker.check.mockImplementation(async (code: string) => {
        if (kind === 'failed') throw new Error('upstream failed');
        return catalogNotFoundResult(code, 'US');
      });
      let settled = false;
      const work = f.pipeline.checkGroup('cg1', f.context).then((result) => {
        settled = true;
        return result;
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(f.unit.commitGroup).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledTimes(8);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2000);
        expect((await work).isBroken).toBe(true);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(new Set(signals).size).toBe(1);
        expect(cleanup).toHaveBeenCalledTimes(8);
        expect(f.logger.warn).toHaveBeenCalledWith(expect.any(String), {
          reason: 'competitor_check_cache_invalidation_failed',
        });
      } finally {
        f.pipeline.close();
        releases.forEach((release) => release());
        await work.catch(() => undefined);
        vi.useRealTimers();
      }
    },
  );

  it('aborts advisory cleanup on shutdown while returning the confirmed result', async () => {
    const f = fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const signals: AbortSignal[] = [];
    f.checker.check.mockRejectedValue(new Error('upstream failed'));
    f.cache.invalidate.mockImplementation(async (_identity, signal) => {
      signals.push(signal);
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return undefined;
    });
    const work = f.pipeline.checkGroup('cg1', f.context);
    await ready;
    f.pipeline.close();
    expect((await work).isBroken).toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(f.unit.commitGroup).toHaveBeenCalledOnce();
  });

  it('does not let a delayed earlier commit overwrite the newer checker cache result', async () => {
    const original = asin(1);
    const parent = group();
    let currentClaim = '';
    let cached: CatalogVariantResult | undefined;
    let claims = 0;
    let commits = 0;
    let releaseEarlier!: () => void;
    let earlierCommitted!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseEarlier = resolve;
    });
    const waitForEarlierCommit = new Promise<void>((resolve) => {
      earlierCommitted = resolve;
    });
    const cache = {
      claim: vi.fn(async () => {
        currentClaim = String(++claims);
        return currentClaim;
      }),
      write: vi.fn(
        async (
          _identity: unknown,
          claim: string,
          result: CatalogVariantResult,
        ) => {
          if (claim === currentClaim) cached = result;
        },
      ),
      invalidate: vi.fn(async () => {
        cached = undefined;
      }),
      clearDeferred: vi.fn(async () => undefined),
    };
    const checker = {
      check: vi.fn(
        async (
          _asin: string,
          _country: string,
          options: {
            signal: AbortSignal;
          },
        ) => {
          const result = catalogResult(
            original.asin,
            claims === 0 ? false : true,
          );
          const identity = {
            asin: original.asin,
            country: original.country,
            owner: 'competitor' as const,
          };
          const claim = await cache.claim();
          await cache.write(identity, claim, result);
          options.signal.throwIfAborted();
          return result;
        },
      ),
    };
    const unit = {
      loadSingle: async () => ({ group: parent, asin: original }),
      commitSingle: async (
        snapshot: { group: CompetitorVariantGroup; asin: CompetitorAsin },
        result: CatalogVariantResult,
        guard: () => Promise<void>,
      ) => {
        await guard();
        commits++;
        return { ...snapshot, result };
      },
    } as unknown as CompetitorCheckUnit;
    const repository: CompetitorCheckRepositoryPort = {
      transaction: async (action) => {
        const priorCommits = commits;
        const output = await action(unit);
        if (priorCommits === 0 && commits === 1) {
          earlierCommitted();
          await waitForRelease;
        }
        return output;
      },
    };
    const pipeline = new CompetitorCheckPipeline(repository, checker, cache, {
      info() {},
      warn() {},
    });
    const context: CompetitorCheckContext = {
      forceRefresh: true,
      authorize: async () => undefined,
      checkpoint: async () => undefined,
    };
    const earlier = pipeline.checkSingle(original.id, context);
    try {
      await waitForEarlierCommit;
      const newer = await pipeline.checkSingle(original.id, context);
      expect((newer as { isBroken: boolean }).isBroken).toBe(false);
      releaseEarlier();
      const first = await earlier;
      expect((first as { isBroken: boolean }).isBroken).toBe(true);
      expect(cached?.hasVariants).toBe(true);
      expect(commits).toBe(2);
    } finally {
      releaseEarlier();
      await earlier.catch(() => undefined);
      pipeline.close();
    }
  });

  it('keeps the Legacy child snapshot update time while reporting the new check state', async () => {
    const f = fixture();
    f.checker.check
      .mockResolvedValueOnce(catalogResult(f.snapshot.asins[0].asin, false))
      .mockResolvedValueOnce(catalogResult(f.snapshot.asins[1].asin, true))
      .mockResolvedValueOnce(catalogResult(f.snapshot.asins[2].asin, true));

    const output = await f.pipeline.checkGroup('cg1', f.context);
    const committed = await f.unit.commitGroup.mock.results[0].value;

    expect(f.unit.commitGroup.mock.calls[0][0].asins[0].updateTime).toEqual(
      before,
    );
    expect(committed.asins[0].updateTime).toEqual(checkedAt);
    expect(output.groupSnapshot.children[0]).toMatchObject({
      id: 'ca1',
      isBroken: 1,
      variantStatus: 'BROKEN',
      updateTime: before.toISOString(),
      lastCheckTime: checkedAt.toISOString(),
    });
    expect(output.groupSnapshot.children[1]).toMatchObject({
      id: 'ca2',
      isBroken: 0,
      variantStatus: 'NORMAL',
      updateTime: before.toISOString(),
      lastCheckTime: checkedAt.toISOString(),
    });
  });

  it('preserves the Legacy empty group result without history work', async () => {
    const f = fixture();
    f.unit.loadGroup.mockResolvedValueOnce({
      group: { ...f.snapshot.group, isBroken: true, variantStatus: 'BROKEN' },
      asins: [],
    });
    f.unit.commitGroup.mockResolvedValueOnce({
      group: { ...f.snapshot.group, isBroken: true, variantStatus: 'BROKEN' },
      asins: [],
      observations: [],
    });

    const output = await f.pipeline.checkGroup('cg1', f.context);

    expect(output).toMatchObject({
      isBroken: true,
      brokenASINs: [],
      brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
      groupSnapshot: { isBroken: 0, variantStatus: 'NORMAL' },
      details: { message: '竞品变体组中没有ASIN' },
    });
    expect(output.details).toEqual({ message: '竞品变体组中没有ASIN' });
    expect(f.checker.check).not.toHaveBeenCalled();
  });

  it('continues a group after an upstream ASIN failure and commits SP_API_ERROR', async () => {
    const f = fixture();
    f.checker.check
      .mockResolvedValueOnce(catalogResult(f.snapshot.asins[0].asin, true))
      .mockRejectedValueOnce(new Error('upstream failure'))
      .mockResolvedValueOnce(catalogResult(f.snapshot.asins[2].asin, true));

    const output = await f.pipeline.checkGroup('cg1', f.context);

    expect(f.checker.check).toHaveBeenCalledTimes(3);
    expect(f.unit.commitGroup).toHaveBeenCalledOnce();
    const observations = f.unit.commitGroup.mock.calls[0][1];
    expect(observations.map((item) => item.kind)).toEqual([
      'checked',
      'failed',
      'checked',
    ]);
    expect(output).toMatchObject({
      isBroken: true,
      brokenByType: { SP_API_ERROR: 1, NOT_FOUND: 0, NO_VARIANTS: 0 },
      brokenASINs: [
        { asin: f.snapshot.asins[1].asin, errorType: 'SP_API_ERROR' },
      ],
      details: {
        results: [
          { asin: f.snapshot.asins[0].asin, hasVariants: true },
          {
            asin: f.snapshot.asins[1].asin,
            errorType: 'SP_API_ERROR',
          },
          { asin: f.snapshot.asins[2].asin, hasVariants: true },
        ],
      },
      groupSnapshot: {
        isBroken: 1,
        children: [
          { asinType: '1', parentId: 'cg1', isBroken: 0 },
          { asinType: '1', parentId: 'cg1', isBroken: 1 },
          { asinType: '1', parentId: 'cg1', isBroken: 0 },
        ],
      },
    });
    expect(f.context.onProgress).toHaveBeenCalledTimes(3);
    expect(f.cache.claim).not.toHaveBeenCalled();
    expect(f.cache.write).not.toHaveBeenCalled();
    expect(f.cache.invalidate).toHaveBeenCalledWith(
      { asin: f.snapshot.asins[1].asin, country: 'US', owner: 'competitor' },
      expect.any(AbortSignal),
    );
  });

  it('keeps a confirmed missing product distinct from an upstream failure', async () => {
    const f = fixture();
    f.checker.check
      .mockResolvedValueOnce(catalogNotFoundResult('B000000001', 'US'))
      .mockResolvedValueOnce(catalogResult('B000000002', false))
      .mockResolvedValueOnce(catalogResult('B000000003', true));

    const output = await f.pipeline.checkGroup('cg1', f.context);

    expect(output).toMatchObject({
      brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 1, NO_VARIANTS: 1 },
      brokenASINs: [
        { asin: 'B000000001', errorType: 'NOT_FOUND' },
        { asin: 'B000000002', errorType: 'NO_VARIANTS' },
      ],
      details: {
        results: [
          { asin: 'B000000001', errorType: 'NOT_FOUND' },
          { asin: 'B000000002', errorType: 'NO_VARIANTS' },
          { asin: 'B000000003', hasVariants: true },
        ],
      },
    });
    expect(
      f.unit.commitGroup.mock.calls[0][1].every(
        (item) => item.kind === 'checked',
      ),
    ).toBe(true);
    expect(f.cache.claim).not.toHaveBeenCalled();
    expect(f.cache.write).not.toHaveBeenCalled();
    expect(f.cache.invalidate).not.toHaveBeenCalled();
    expect(f.cache.clearDeferred).toHaveBeenCalledOnce();
    expect(f.cache.clearDeferred).toHaveBeenCalledWith(
      { asin: 'B000000001', country: 'US', owner: 'competitor' },
      expect.any(AbortSignal),
    );
  });

  it('aborts the whole group for cancellation and does not commit a partial result', async () => {
    const f = fixture();
    f.checker.check.mockRejectedValue(new SpApiError('TIMEOUT'));

    await expect(f.pipeline.checkGroup('cg1', f.context)).rejects.toMatchObject(
      {
        code: 'TIMEOUT',
      },
    );
    expect(f.unit.commitGroup).not.toHaveBeenCalled();
  });
});
