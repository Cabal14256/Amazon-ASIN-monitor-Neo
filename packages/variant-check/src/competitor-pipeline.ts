import { competitorCheckDataSchema } from '@asin-monitor/contracts';
import {
  assertVariantCheckOperationRequest,
  competitorMonitorSnapshotDigest,
  VariantCheckError,
  type CommittedCompetitorGroupCheck,
  type CommittedCompetitorSingleCheck,
  type CompetitorCheckObservation,
  type CompetitorCheckRepositoryPort,
  type CompetitorCheckUnit,
  type CompetitorGroupCheckSnapshot,
  type VariantCheckOperation,
} from '@asin-monitor/db';
import {
  abortError,
  CatalogDeferredError,
  decodeCatalogVariantResult,
  normalizeCountry,
  SpApiError,
  waitFor,
  type CatalogVariantChecker,
  type CatalogVariantResult,
  type Logger,
  type RedisCatalogCheckStore,
} from '@asin-monitor/sp-api';
import { setTimeout as delay } from 'node:timers/promises';
import {
  VariantCheckCommitUncertainError,
  type VariantGroupAdmission,
} from './pipeline';
import { normalizeAsinType } from './record-mapper';

const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE = 8;
export interface CompetitorCheckContext {
  forceRefresh: boolean;
  signal?: AbortSignal;
  groupAdmission?: VariantGroupAdmission;
  operation?: VariantCheckOperation;
  snapshotDigest?: string;
  authorize(unit: CompetitorCheckUnit): Promise<void>;
  checkpoint(): Promise<void>;
  onProgress?(completed: number, total: number): Promise<void> | void;
}
interface Scope {
  signal: AbortSignal;
  guard(unit?: CompetitorCheckUnit): Promise<void>;
  confirmed(value: unknown): void;
  started(): void;
}
const broken = (value: CatalogVariantResult) =>
  !value.hasVariants || value.variantCount === 0;
function bounded<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (
    !encoded ||
    Buffer.byteLength(encoded) > MAX_RESULT_BYTES ||
    !competitorCheckDataSchema.safeParse(value).success
  )
    throw new VariantCheckError('invalid-result');
  return value;
}
function singleResult(value: CommittedCompetitorSingleCheck) {
  return {
    isBroken: broken(value.result),
    details: { asin: value.asin.asin, result: value.result },
  };
}
export type CompetitorSingleCheckData = ReturnType<typeof singleResult>;
const legacyFlag = (value: boolean | null) =>
  value === null ? null : value ? 1 : 0;
const iso = (value: Date | null) => value?.toISOString() ?? null;
function groupResult(
  value: CommittedCompetitorGroupCheck,
  initial: CompetitorGroupCheckSnapshot,
) {
  const observed = new Map(
    value.observations.map((item) => [item.asinId, item]),
  );
  const initialAsins = new Map(initial.asins.map((asin) => [asin.id, asin]));
  const counts = { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 };
  const results = value.asins.map((asin) => {
    const observation = observed.get(asin.id);
    if (!observation) throw new VariantCheckError('invalid-result');
    if (observation.kind !== 'checked') {
      counts.SP_API_ERROR++;
      return {
        asin: asin.asin,
        errorType: 'SP_API_ERROR' as const,
        error: observation.error,
      };
    }
    const result = observation.result;
    const kind =
      result.errorType || (broken(result) ? 'NO_VARIANTS' : undefined);
    if (kind === 'NOT_FOUND' || kind === 'NO_VARIANTS') counts[kind]++;
    return {
      asin: asin.asin,
      hasVariants: result.hasVariants,
      variantCount: result.variantCount,
      ...(kind ? { errorType: kind } : {}),
    };
  });
  const brokenASINs = results.flatMap((row) =>
    !('hasVariants' in row) || !row.hasVariants || row.variantCount === 0
      ? [{ asin: row.asin, errorType: row.errorType || 'NO_VARIANTS' }]
      : [],
  );
  const group = value.group;
  // Legacy findById derives the displayed snapshot from children, including
  // empty groups; the check result can be broken without mutating the DB row.
  const snapshotBroken = value.asins.some((asin) => asin.isBroken === true);
  const snapshotStatus = snapshotBroken ? 'BROKEN' : 'NORMAL';
  const groupSnapshot = {
    id: group.id,
    name: group.name,
    country: group.country,
    brand: group.brand,
    is_broken: snapshotBroken ? 1 : 0,
    isBroken: snapshotBroken ? 1 : 0,
    variant_status: snapshotStatus,
    variantStatus: snapshotStatus,
    feishu_notify_enabled: legacyFlag(group.feishuNotifyEnabled),
    feishuNotifyEnabled: legacyFlag(group.feishuNotifyEnabled) ?? 0,
    create_time: iso(group.createTime),
    update_time: iso(group.updateTime),
    last_check_time: iso(group.lastCheckTime),
    createTime: iso(group.createTime),
    updateTime: iso(group.updateTime),
    lastCheckTime: iso(group.lastCheckTime),
    children: value.asins.map((asin) => {
      const before = initialAsins.get(asin.id);
      if (!before) throw new VariantCheckError('invalid-result');
      return {
        id: before.id,
        asin: before.asin,
        name: before.name,
        asinType: normalizeAsinType(before.asinType),
        country: before.country,
        brand: before.brand,
        parentId: group.id,
        isBroken: legacyFlag(asin.isBroken),
        variantStatus: asin.variantStatus,
        createTime: iso(before.createTime),
        updateTime: iso(before.updateTime),
        lastCheckTime: iso(asin.lastCheckTime),
        feishuNotifyEnabled: legacyFlag(before.feishuNotifyEnabled) ?? 0,
      };
    }),
  };
  return {
    isBroken: value.asins.length === 0 ? true : brokenASINs.length > 0,
    brokenASINs,
    brokenByType: counts,
    groupSnapshot,
    details: value.asins.length
      ? {
          totalASINs: value.asins.length,
          brokenCount: brokenASINs.length,
          results,
        }
      : { message: '竞品变体组中没有ASIN' },
  };
}
export type CompetitorGroupCheckData = ReturnType<typeof groupResult>;

/** Same bounded checker and cache as primary, with separate competitor identity,
 * snapshots, history and transactional receipts. Network calls never hold SQL TXs. */
export class CompetitorCheckPipeline {
  private readonly active = new Set<AbortController>();
  private readonly cleanups = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly repository: CompetitorCheckRepositoryPort,
    private readonly checker: Pick<CatalogVariantChecker, 'check'>,
    private readonly cache: Pick<
      RedisCatalogCheckStore,
      'invalidate' | 'clearDeferred'
    >,
    private readonly logger: Pick<Logger, 'info' | 'warn'>,
  ) {}
  private async run<T>(
    context: CompetitorCheckContext,
    action: (scope: Scope) => Promise<T>,
  ): Promise<T> {
    context = { ...context };
    if (this.closed) throw new SpApiError('CLOSED');
    if (this.active.size >= MAX_ACTIVE) throw new VariantCheckError('capacity');
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort(new SpApiError('CANCELLED'));
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      900_000,
    );
    timer.unref();
    let commitStarted = false;
    let confirmation: { value: T } | undefined;
    const scope: Scope = {
      signal: controller.signal,
      started: () => {
        commitStarted = true;
      },
      confirmed: (value) => {
        confirmation = { value: value as T };
      },
      guard: async (unit) => {
        controller.signal.throwIfAborted();
        await context.checkpoint();
        controller.signal.throwIfAborted();
        if (unit) await context.authorize(unit);
        controller.signal.throwIfAborted();
      },
    };
    let releaseAdmission: (() => void) | undefined;
    const work = Promise.resolve().then(async () => {
      if (context.groupAdmission) {
        releaseAdmission = await context.groupAdmission.acquire(
          controller.signal,
          () => scope.guard(),
        );
        await scope.guard();
      }
      return action(scope);
    });
    try {
      return await waitFor(work, controller.signal);
    } catch (error) {
      if (confirmation) return confirmation.value;
      if (
        commitStarted &&
        (controller.signal.aborted ||
          (error instanceof Error &&
            error.message.includes('commit-uncertain')))
      )
        throw new VariantCheckCommitUncertainError();
      if (controller.signal.aborted) throw abortError(controller.signal);
      throw error;
    } finally {
      controller.abort();
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      // The underlying transaction still owns its admission slot until settled.
      void work
        .finally(() => {
          this.active.delete(controller);
          releaseAdmission?.();
        })
        .catch(() => {});
    }
  }
  private async read<T>(
    context: CompetitorCheckContext,
    scope: Scope,
    load: (unit: CompetitorCheckUnit) => Promise<T>,
  ): Promise<{ snapshot: T } | { completed: unknown }> {
    return this.repository.transaction(async (unit) => {
      await scope.guard(unit);
      if (context.operation) {
        const result = await unit.readReceipt(context.operation);
        await scope.guard(unit);
        if (result !== undefined) return { completed: bounded(result) };
      }
      return { snapshot: await load(unit) };
    }, scope.signal);
  }
  private async persist<T>(
    context: CompetitorCheckContext,
    scope: Scope,
    commit: (unit: CompetitorCheckUnit) => Promise<T>,
  ): Promise<T> {
    let readyToCommit = false;
    try {
      const output = await this.repository.transaction(async (unit) => {
        await scope.guard(unit);
        if (context.operation) {
          const existing = await unit.readReceipt(context.operation, true);
          await scope.guard(unit);
          if (existing !== undefined) return bounded(existing) as T;
        }
        scope.started();
        const result = bounded(await commit(unit));
        if (context.operation)
          await unit.saveReceipt(context.operation, result);
        await scope.guard(unit);
        readyToCommit = true;
        return result;
      }, scope.signal);
      scope.confirmed(output);
      return output;
    } catch (error) {
      if (readyToCommit) throw new VariantCheckCommitUncertainError();
      throw error;
    }
  }
  private async cleanupCache(
    rows: {
      asin: string;
      country: string;
      failed: boolean;
      notFound: boolean;
    }[],
  ) {
    const entries = rows.filter((row) => row.failed || row.notFound);
    if (!entries.length || this.closed) return;
    if (this.cleanups.size >= 8) {
      this.logger.warn('竞品检查已提交，缓存清理容量已满', {
        reason: 'competitor_check_cache_capacity',
      });
      return;
    }
    const controller = new AbortController();
    this.cleanups.add(controller);
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      2000,
    );
    let next = 0;
    let failed = false;
    const work = Promise.all(
      Array.from({ length: Math.min(8, entries.length) }, async () => {
        while (!controller.signal.aborted && next < entries.length) {
          const row = entries[next++];
          try {
            const identity = {
              asin: row.asin,
              country: normalizeCountry(row.country),
              owner: 'competitor' as const,
            };
            // Successful checker writes retain their fenced claim.
            if (row.failed)
              await this.cache.invalidate(identity, controller.signal);
            if (row.notFound && !controller.signal.aborted)
              await this.cache.clearDeferred(identity, controller.signal);
          } catch {
            failed = true;
          }
        }
      }),
    ).finally(() => {
      clearTimeout(timer);
      // Uncooperative I/O retains its cleanup slot until it actually settles.
      this.cleanups.delete(controller);
    });
    try {
      await waitFor(work, controller.signal);
    } catch {
      failed = true;
    }
    if (failed)
      this.logger.warn('竞品检查已提交，缓存清理失败', {
        reason: 'competitor_check_cache_invalidation_failed',
      });
  }
  checkSingle(
    id: string,
    context: CompetitorCheckContext,
  ): Promise<CompetitorSingleCheckData> {
    if (context.operation) {
      if (context.operation.resultKind !== 'competitor-asin')
        throw new VariantCheckError('invalid-input');
      assertVariantCheckOperationRequest(context.operation, {
        asinId: id,
        forceRefresh: context.forceRefresh,
      });
    }
    return this.run<CompetitorSingleCheckData>(context, async (scope) => {
      const initial = await this.read(context, scope, (unit) =>
        unit.loadSingle(id),
      );
      if ('completed' in initial)
        return initial.completed as CompetitorSingleCheckData;
      const snapshot = initial.snapshot;
      await scope.guard();
      const result = decodeCatalogVariantResult(
        await this.checker.check(snapshot.asin.asin, snapshot.asin.country, {
          forceRefresh: context.forceRefresh,
          priority: 1,
          owner: 'competitor',
          signal: scope.signal,
        }),
        snapshot.asin.asin,
        normalizeCountry(snapshot.asin.country),
      );
      const output = await this.persist(context, scope, async (unit) =>
        singleResult(
          await unit.commitSingle(snapshot, result, () => scope.guard(unit)),
        ),
      );
      scope.confirmed(output);
      await this.cleanupCache([
        {
          asin: snapshot.asin.asin,
          country: snapshot.asin.country,
          failed: false,
          notFound: result.errorType === 'NOT_FOUND',
        },
      ]);
      this.logger.info('竞品 ASIN 检查完成');
      return output;
    });
  }
  checkGroup(
    id: string,
    context: CompetitorCheckContext,
  ): Promise<CompetitorGroupCheckData> {
    if (context.operation) {
      if (context.operation.resultKind !== 'competitor-group')
        throw new VariantCheckError('invalid-input');
      assertVariantCheckOperationRequest(context.operation, {
        groupId: id,
        forceRefresh: context.forceRefresh,
        ...(context.operation.taskType === 'competitor-monitor'
          ? { snapshotDigest: context.snapshotDigest }
          : {}),
      });
    }
    return this.run<CompetitorGroupCheckData>(context, async (scope) => {
      const initial = await this.read(context, scope, (unit) =>
        unit.loadGroup(id),
      );
      if ('completed' in initial)
        return initial.completed as CompetitorGroupCheckData;
      const snapshot: CompetitorGroupCheckSnapshot = initial.snapshot;
      const monitor = context.operation?.taskType === 'competitor-monitor';
      if (
        monitor &&
        (context.forceRefresh ||
          !context.snapshotDigest ||
          !/^[a-f0-9]{64}$/.test(context.snapshotDigest) ||
          competitorMonitorSnapshotDigest(snapshot) !== context.snapshotDigest)
      )
        throw new VariantCheckError('snapshot-changed');
      const observations = new Array<
        | CompetitorCheckObservation
        | { asinId: string; kind: 'deferred'; error: string }
      >(snapshot.asins.length);
      let next = 0;
      let completed = 0;
      let progress = Promise.resolve();
      let failure: unknown;
      await Promise.all(
        Array.from({ length: Math.min(3, snapshot.asins.length) }, async () => {
          while (next < snapshot.asins.length && !failure) {
            try {
              await scope.guard();
              const index = next++;
              if (index >= snapshot.asins.length) break;
              const row = snapshot.asins[index];
              let observation: (typeof observations)[number];
              try {
                const result = decodeCatalogVariantResult(
                  await this.checker.check(row.asin, row.country, {
                    forceRefresh: context.forceRefresh,
                    priority: 1,
                    owner: 'competitor',
                    signal: scope.signal,
                  }),
                  row.asin,
                  normalizeCountry(row.country),
                );
                observation = { asinId: row.id, kind: 'checked', result };
              } catch (error) {
                if (scope.signal.aborted) throw abortError(scope.signal);
                if (
                  error instanceof SpApiError &&
                  [
                    'CANCELLED',
                    'CLOSED',
                    'CAPACITY',
                    'TIMEOUT',
                    'DEPENDENCY_ERROR',
                  ].includes(error.code)
                )
                  throw error;
                observation = {
                  asinId: row.id,
                  kind:
                    monitor && error instanceof CatalogDeferredError
                      ? 'deferred'
                      : 'failed',
                  error: 'SP-API检查失败',
                };
              }
              observations[index] = observation;
              const done = ++completed;
              progress = progress.then(async () => {
                await scope.guard();
                await context.onProgress?.(done, snapshot.asins.length);
              });
              await progress;
            } catch (error) {
              failure ??= error;
              break;
            }
          }
        }),
      );
      if (failure) throw failure;
      const deferred = observations.flatMap((value, index) =>
        value.kind === 'deferred' ? [index] : [],
      );
      if (deferred.length) {
        await delay(2000, undefined, { signal: scope.signal });
        let nextDeferred = 0;
        let deferredFailure: unknown;
        await Promise.all(
          Array.from({ length: Math.min(2, deferred.length) }, async () => {
            while (nextDeferred < deferred.length && !deferredFailure) {
              const index = deferred[nextDeferred++],
                row = snapshot.asins[index];
              try {
                await scope.guard();
                try {
                  const result = decodeCatalogVariantResult(
                    await this.checker.check(row.asin, row.country, {
                      forceRefresh: true,
                      priority: 1,
                      owner: 'competitor',
                      signal: scope.signal,
                    }),
                    row.asin,
                    normalizeCountry(row.country),
                  );
                  observations[index] = {
                    asinId: row.id,
                    kind: 'checked',
                    result,
                  };
                } catch (error) {
                  if (scope.signal.aborted) throw abortError(scope.signal);
                  if (
                    error instanceof SpApiError &&
                    [
                      'CANCELLED',
                      'CLOSED',
                      'CAPACITY',
                      'TIMEOUT',
                      'DEPENDENCY_ERROR',
                    ].includes(error.code)
                  )
                    throw error;
                  observations[index] = {
                    asinId: row.id,
                    kind: 'failed',
                    error: 'SP-API延后复核失败',
                  };
                }
                await scope.guard();
              } catch (error) {
                deferredFailure ??= error;
              }
            }
          }),
        );
        if (deferredFailure) throw deferredFailure;
      }
      await scope.guard();
      const finalObservations: CompetitorCheckObservation[] = observations.map(
        (item) => {
          if (item.kind === 'deferred')
            throw new VariantCheckError('invalid-result');
          return item;
        },
      );
      const output = await this.persist(context, scope, async (unit) =>
        groupResult(
          await unit.commitGroup(
            snapshot,
            finalObservations,
            () => scope.guard(unit),
            monitor
              ? {
                  operation: context.operation!,
                  snapshotDigest: context.snapshotDigest!,
                }
              : undefined,
          ),
          snapshot,
        ),
      );
      scope.confirmed(output);
      await this.cleanupCache(
        snapshot.asins.map((row, index) => ({
          asin: row.asin,
          country: row.country,
          failed: observations[index].kind !== 'checked',
          notFound:
            observations[index].kind === 'checked' &&
            (observations[index].result.errorType === 'NOT_FOUND' ||
              (deferred.includes(index) &&
                observations[index].result.errorType !== 'SP_API_ERROR')),
        })),
      );
      this.logger.info('竞品变体组检查完成', {
        count: snapshot.asins.length,
      });
      return output;
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active)
      controller.abort(new SpApiError('CLOSED'));
    for (const controller of this.cleanups)
      controller.abort(new SpApiError('CLOSED'));
  }
}
