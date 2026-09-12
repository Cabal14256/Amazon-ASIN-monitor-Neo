import type {
  VariantGroupCheckData,
  VariantView,
} from '@asin-monitor/contracts';
import {
  abortError,
  CatalogDeferredError,
  normalizeCountry,
  SpApiError,
  waitFor,
  type CatalogVariantChecker,
  type Logger,
  type RedisCatalogCheckStore,
} from '@asin-monitor/sp-api';
import { groupCheckResult, singleCheckResult } from './result-mapper';
import {
  VariantCheckError,
  type AsinCheckObservation,
  type GroupCheckSnapshot,
  type VariantCheckRepositoryPort,
  type VariantCheckUnit,
} from './types';

export const MAX_VARIANT_CHECK_RESULT_BYTES = 32 * 1024 * 1024;
export interface VariantCheckContext {
  forceRefresh?: boolean;
  signal?: AbortSignal;
  /** HTTP authenticates the current session; accepted jobs verify current owner
   * authority according to their task policy. Anonymous compatibility is explicit. */
  authorize(unit: VariantCheckUnit): Promise<void>;
  /** Task identity, lease, expiry and cancellation. Never log an upstream error. */
  checkpoint(): Promise<void>;
  onProgress?(completed: number, total: number): Promise<void> | void;
}
/** A stopped waiter is not proof that a COMMIT already sent to PostgreSQL failed.
 * Callers must not blindly retry a job that reports this condition. */
export class VariantCheckCommitUncertainError extends Error {
  readonly commitMayHaveSucceeded = true;
  constructor() {
    super('检查写入结果需要核实，请查询最新状态后重试');
    this.name = 'VariantCheckCommitUncertainError';
  }
}
interface CheckScope {
  signal: AbortSignal;
  guard(unit?: VariantCheckUnit): Promise<void>;
  stop(error: unknown): void;
  beginPersistence(): void;
  confirm(value: unknown): void;
}
function boundedResult<T>(value: T): T {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_VARIANT_CHECK_RESULT_BYTES)
    throw new VariantCheckError('capacity');
  return value;
}

/** Real business sequence: authorize/read -> bounded upstream checks -> lock and
 * revalidate/commit complete results -> advisory shared cache invalidation.
 */
export class VariantCheckPipeline {
  private readonly active = new Set<AbortController>();
  private readonly cleanups = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly repository: VariantCheckRepositoryPort,
    private readonly checker: Pick<CatalogVariantChecker, 'check'>,
    private readonly cache: Pick<
      RedisCatalogCheckStore,
      'invalidate' | 'clearDeferred'
    >,
    private readonly logger: Pick<Logger, 'info' | 'warn'>,
  ) {}
  private async run<T>(
    context: VariantCheckContext,
    execute: (scope: CheckScope) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (context.signal?.aborted) throw new SpApiError('CANCELLED');
    if (
      context.forceRefresh !== undefined &&
      typeof context.forceRefresh !== 'boolean'
    )
      throw new VariantCheckError('invalid-input');
    if (this.active.size >= 8) throw new VariantCheckError('capacity');
    // Callers may reuse or mutate their options after dispatch. Capture the
    // callbacks and signal for this invocation before any asynchronous work.
    context = { ...context };
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort(new SpApiError('CANCELLED'));
    context.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      900000,
    );
    let persistenceStarted = false;
    let confirmed: { value: T } | undefined;
    const ensure = () => {
      if (controller.signal.aborted) throw abortError(controller.signal);
    };
    const scope: CheckScope = {
      signal: controller.signal,
      stop(error) {
        controller.abort(error);
      },
      beginPersistence() {
        persistenceStarted = true;
      },
      confirm(value) {
        confirmed = { value: value as T };
      },
      async guard(unit) {
        ensure();
        await context.checkpoint();
        ensure();
        if (unit) {
          await context.authorize(unit);
          ensure();
        }
      },
    };
    const work = Promise.resolve()
      .then(() => execute(scope))
      .finally(() => {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
        this.active.delete(controller);
      });
    try {
      return await waitFor(work, controller.signal);
    } catch (error) {
      // Once the repository confirms COMMIT, cancellation during advisory work
      // cannot erase that fact and make a Worker retry a successful write.
      if (confirmed) return confirmed.value;
      if (persistenceStarted && controller.signal.aborted)
        throw new VariantCheckCommitUncertainError();
      if (
        controller.signal.aborted &&
        controller.signal.reason instanceof Error
      )
        throw controller.signal.reason;
      throw error;
    }
  }
  private async persist<T>(
    scope: CheckScope,
    action: (unit: VariantCheckUnit) => Promise<T>,
  ): Promise<T> {
    let readyToCommit = false;
    try {
      const output = await this.repository.transaction(async (unit) => {
        await scope.guard(unit);
        scope.beginPersistence();
        const value = boundedResult(await action(unit));
        await scope.guard(unit);
        readyToCommit = true;
        return value;
      });
      scope.confirm(output);
      return output;
    } catch (error) {
      // A connection loss or repository deadline after the callback returned
      // can mean the COMMIT was sent and its acknowledgement was lost.
      if (readyToCommit) throw new VariantCheckCommitUncertainError();
      throw error;
    }
  }
  private async invalidate(
    entries: { asin: string; country: string; notFound: boolean }[],
  ): Promise<void> {
    if (!entries.length || this.closed) return;
    if (this.cleanups.size >= 8) {
      this.logger.warn('检查已提交，共享缓存清理容量已满', {
        reason: 'variant_check_cache_capacity',
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
          const entry = entries[next++];
          try {
            const identity = {
              asin: entry.asin,
              country: normalizeCountry(entry.country),
              owner: 'primary' as const,
            };
            await this.cache.invalidate(identity, controller.signal);
            if (entry.notFound && !controller.signal.aborted)
              await this.cache.clearDeferred(identity, controller.signal);
          } catch {
            failed = true;
          }
        }
      }),
    ).finally(() => {
      clearTimeout(timer);
      // A timed-out adapter still owns its cleanup slot until it actually
      // settles. Repeated successful checks cannot accumulate unbounded I/O.
      this.cleanups.delete(controller);
    });
    try {
      await waitFor(work, controller.signal);
    } catch {
      failed = true;
    }
    if (failed)
      this.logger.warn('检查已提交，共享缓存清理失败', {
        reason: 'variant_check_cache_invalidation_failed',
      });
  }
  checkSingle(
    asinId: string,
    context: VariantCheckContext,
  ): Promise<VariantView> {
    context = { ...context };
    return this.run(context, async (scope) => {
      const snapshot = await this.repository.transaction(async (unit) => {
        await scope.guard(unit);
        return unit.loadSingle(asinId);
      });
      await scope.guard();
      const result = await this.checker.check(
        snapshot.asin.asin,
        snapshot.asin.country,
        {
          forceRefresh: context.forceRefresh ?? false,
          priority: 1,
          signal: scope.signal,
        },
      );
      await scope.guard();
      const output = await this.persist(scope, async (unit) => {
        const committed = await unit.commitSingle(snapshot, result, () =>
          scope.guard(unit),
        );
        // Full serialization bound is checked while rollback remains possible.
        return singleCheckResult(committed);
      });
      await this.invalidate([
        {
          asin: snapshot.asin.asin,
          country: snapshot.asin.country,
          notFound: result.errorType === 'NOT_FOUND',
        },
      ]);
      this.logger.info('单 ASIN 检查完成');
      return output;
    });
  }
  checkGroup(
    groupId: string,
    context: VariantCheckContext,
  ): Promise<VariantGroupCheckData> {
    context = { ...context };
    return this.run(context, async (scope) => {
      const snapshot = await this.repository.transaction(async (unit) => {
        await scope.guard(unit);
        return unit.loadGroup(groupId);
      });
      await scope.guard();
      const observations = await this.observeGroup(snapshot, context, scope);
      const output = await this.persist(scope, async (unit) => {
        const committed = await unit.commitGroup(snapshot, observations, () =>
          scope.guard(unit),
        );
        return groupCheckResult(committed);
      });
      const byId = new Map(snapshot.asins.map((row) => [row.id, row]));
      await this.invalidate(
        observations.map((observation) => ({
          asin: byId.get(observation.asinId)!.asin,
          country: snapshot.group.country,
          notFound:
            observation.kind === 'checked' &&
            observation.result.errorType === 'NOT_FOUND',
        })),
      );
      this.logger.info('变体组检查完成', { count: observations.length });
      return output;
    });
  }
  private async observeGroup(
    snapshot: GroupCheckSnapshot,
    context: VariantCheckContext,
    scope: CheckScope,
  ): Promise<AsinCheckObservation[]> {
    const observations = new Array<AsinCheckObservation>(snapshot.asins.length);
    let next = 0,
      completed = 0,
      bytes = 0;
    let progress = Promise.resolve();
    let failure: unknown;
    const workers = Array.from(
      { length: Math.min(3, snapshot.asins.length) },
      async () => {
        try {
          while (next < snapshot.asins.length && !failure) {
            await scope.guard();
            if (failure) break;
            const index = next++;
            // Another worker can exhaust the list while this guard awaits I/O.
            if (index >= snapshot.asins.length) break;
            const asin = snapshot.asins[index];
            let observation: AsinCheckObservation;
            try {
              const result = await this.checker.check(
                asin.asin,
                snapshot.group.country,
                {
                  forceRefresh: context.forceRefresh ?? false,
                  priority: 1,
                  signal: scope.signal,
                },
              );
              observation = { asinId: asin.id, kind: 'checked', result };
            } catch (error) {
              if (scope.signal.aborted) throw abortError(scope.signal);
              if (
                !(error instanceof CatalogDeferredError) &&
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
              observation =
                error instanceof CatalogDeferredError
                  ? {
                      asinId: asin.id,
                      kind: 'deferred',
                      error: 'ASIN检查失败，已加入延后队列',
                    }
                  : {
                      asinId: asin.id,
                      kind: 'failed',
                      error: 'SP-API检查失败',
                    };
            }
            await scope.guard();
            bytes += Buffer.byteLength(JSON.stringify(observation));
            if (bytes > MAX_VARIANT_CHECK_RESULT_BYTES)
              throw new VariantCheckError('capacity');
            observations[index] = observation;
            const done = ++completed;
            progress = progress.then(async () => {
              await scope.guard();
              await context.onProgress?.(done, snapshot.asins.length);
            });
            await progress;
          }
        } catch (error) {
          failure ??= error;
          scope.stop(failure);
        }
      },
    );
    await Promise.all(workers);
    if (failure) throw failure;
    await scope.guard();
    return observations;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active)
      controller.abort(new SpApiError('CLOSED'));
    for (const controller of this.cleanups)
      controller.abort(new SpApiError('CLOSED'));
  }
}
