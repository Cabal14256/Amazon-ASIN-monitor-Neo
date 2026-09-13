import type {
  VariantCheckJobData,
  VariantCheckResultReference,
  VariantGroupCheckData,
} from '@asin-monitor/contracts';
import {
  decodeVariantCheckReceiptResult,
  VariantCheckError,
  variantCheckReceiptStorageBytes,
  type VariantCheckOperation,
  type VariantCheckRepositoryPort,
  type VariantCheckUnit,
} from '@asin-monitor/db';
import {
  abortError,
  SpApiError,
  waitFor,
  type CatalogParentQuery,
} from '@asin-monitor/sp-api';
import {
  MAX_VARIANT_CHECK_RESULT_BYTES,
  VariantCheckCommitUncertainError,
  type VariantCheckContext,
  type VariantCheckPipeline,
} from './pipeline';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
  variantCheckResultReference,
} from './task';

export type BatchCheckItem = {
  groupId: string;
  success: boolean;
  error?: string;
} & Partial<VariantGroupCheckData>;
export interface BatchCheckResult {
  total: number;
  results: BatchCheckItem[];
}
export type CheckExecutionContext = Omit<
  VariantCheckContext,
  'operation' | 'validateResult'
>;
const recoverable = (error: unknown) =>
  (error instanceof VariantCheckError &&
    [
      'group-not-found',
      'asin-not-found',
      'snapshot-changed',
      'capacity',
    ].includes(error.code)) ||
  (error instanceof SpApiError &&
    ['HTTP_ERROR', 'INVALID_RESPONSE', 'BODY_TOO_LARGE'].includes(error.code));
function failure(groupId: string, error?: unknown): BatchCheckItem {
  return {
    groupId,
    success: false,
    error:
      error instanceof VariantCheckError ? error.message : '变体组检查失败',
  };
}
export function batchCheckTaskResult(result: BatchCheckResult) {
  const successCount = result.results.filter((item) => item.success).length;
  const failedCount = result.total - successCount;
  return {
    success: true,
    ...result,
    successCount,
    failedCount,
    failedSamples: result.results
      .filter((item) => !item.success)
      .slice(0, 20)
      .map(({ groupId, error }) => ({ groupId, error })),
    summary: `共 ${result.total} 项，成功 ${successCount} 项，失败 ${failedCount} 项`,
    verificationPassed: failedCount === 0,
    warnings: failedCount ? [`有 ${failedCount} 个检查项失败`] : [],
  };
}

/** Shared synchronous batch execution and durable asynchronous completion.
 * PostgreSQL owns every SQL operation; no upstream request runs inside its TX. */
export class VariantCheckExecutor {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly repository: VariantCheckRepositoryPort,
    private readonly pipeline: Pick<
      VariantCheckPipeline,
      'checkSingle' | 'checkGroup'
    >,
    private readonly parents: Pick<CatalogParentQuery, 'query'>,
    private readonly batchConcurrency = 2,
  ) {
    if (
      !Number.isInteger(batchConcurrency) ||
      batchConcurrency < 1 ||
      batchConcurrency > 8
    )
      throw new VariantCheckError('invalid-input');
  }
  private async run<T>(
    context: CheckExecutionContext,
    action: (scope: CheckExecutionContext) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (context.signal?.aborted) throw abortError(context.signal);
    if (this.active.size >= 4) throw new VariantCheckError('capacity');
    context = { ...context };
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort(new SpApiError('CANCELLED'));
    context.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      900_000,
    );
    timer.unref();
    const work = Promise.resolve()
      .then(() =>
        action({
          ...context,
          signal: controller.signal,
          checkpoint: async () => {
            if (controller.signal.aborted) throw abortError(controller.signal);
            await context.checkpoint();
            if (controller.signal.aborted) throw abortError(controller.signal);
          },
        }),
      )
      .finally(() => {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
        this.active.delete(controller);
      });
    return waitFor(work, controller.signal);
  }
  private async guard(context: CheckExecutionContext, unit?: VariantCheckUnit) {
    context.signal?.throwIfAborted();
    await context.checkpoint();
    if (unit) await context.authorize(unit);
    context.signal?.throwIfAborted();
  }
  private read(
    operation: VariantCheckOperation,
    context: CheckExecutionContext,
  ) {
    return this.repository.transaction(async (unit) => {
      await this.guard(context, unit);
      const result = await unit.readReceipt(operation);
      await this.guard(context, unit);
      return result;
    });
  }
  private async save(
    operation: VariantCheckOperation,
    result: unknown,
    context: CheckExecutionContext,
  ) {
    let readyToCommit = false;
    try {
      return await this.repository.transaction(async (unit) => {
        await this.guard(context, unit);
        const existing = await unit.readReceipt(operation, true);
        await this.guard(context, unit);
        if (existing !== undefined) return existing;
        await unit.saveReceipt(operation, result);
        await this.guard(context, unit);
        readyToCommit = true;
        return result;
      });
    } catch (error) {
      if (readyToCommit) throw new VariantCheckCommitUncertainError();
      throw error;
    }
  }
  execute(
    raw: unknown,
    context: CheckExecutionContext,
  ): Promise<VariantCheckResultReference> {
    const data = parseVariantCheckJob(raw);
    const operation = variantCheckJobOperation(data);
    return this.run(context, async (scope) => {
      const existing = await this.read(operation, scope);
      if (existing !== undefined) return variantCheckResultReference(operation);
      if (data.taskSubType === 'asin-check') {
        await this.pipeline.checkSingle(data.params.asinId, {
          ...scope,
          forceRefresh: data.params.forceRefresh,
          operation,
        });
      } else if (data.taskSubType === 'variant-group-check') {
        await this.pipeline.checkGroup(data.params.groupId, {
          ...scope,
          forceRefresh: data.params.forceRefresh,
          operation,
        });
      } else if (data.taskSubType === 'parent-asin-query') {
        const result = await this.parents.query(
          data.params.asins,
          data.params.country,
          {
            signal: scope.signal,
            onProgress: async (completed, total) => {
              await this.repository.transaction((unit) =>
                this.guard(scope, unit),
              );
              await scope.onProgress?.(completed, total);
            },
          },
        );
        await this.save(operation, result, scope);
      } else {
        const result = batchCheckTaskResult(
          await this.batch(
            data.params.groupIds,
            { ...scope, forceRefresh: data.params.forceRefresh },
            this.batchConcurrency,
            data,
          ),
        );
        await this.save(
          operation,
          decodeVariantCheckReceiptResult(result, 'batch'),
          scope,
        );
      }
      return variantCheckResultReference(operation);
    });
  }
  checkGroups(
    groupIds: string[],
    context: CheckExecutionContext,
    concurrency = 3,
  ): Promise<BatchCheckResult> {
    if (
      !Array.isArray(groupIds) ||
      !groupIds.length ||
      groupIds.length > 1000 ||
      groupIds.some(
        (id) =>
          typeof id !== 'string' ||
          !id ||
          id.length > 100 ||
          /[\x00-\x1f\x7f]/u.test(id),
      )
    )
      throw new VariantCheckError('invalid-input');
    const inputs = [...groupIds];
    return this.run(context, (scope) => this.batch(inputs, scope, concurrency));
  }
  private async batch(
    groupIds: string[],
    context: CheckExecutionContext,
    concurrency: number,
    data?: Extract<VariantCheckJobData, { taskSubType: 'variant-group' }>,
  ): Promise<BatchCheckResult> {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new VariantCheckError('invalid-input');
    const stop = new AbortController();
    context = {
      ...context,
      signal: context.signal
        ? AbortSignal.any([context.signal, stop.signal])
        : stop.signal,
    };
    const results = groupIds.map((id) => failure(id));
    const sizes = results.map(
      (item) => variantCheckReceiptStorageBytes(item) + 256,
    );
    let bytes = sizes.reduce((sum, size) => sum + size, 0);
    const reserve = (index: number, value: BatchCheckItem) => {
      const size = variantCheckReceiptStorageBytes(value) + 256;
      const next = bytes - sizes[index] + size;
      // Reserve space for JSON punctuation, all failure slots and Legacy task summary.
      if (next > MAX_VARIANT_CHECK_RESULT_BYTES - 65_536)
        throw new VariantCheckError('capacity');
      bytes = next;
      sizes[index] = size;
    };
    const operations = data
      ? groupIds.map((_, index) => variantCheckJobOperation(data, index))
      : [];
    const recovered = new Set<number>();
    // Account for every prior committed group before allowing any new write.
    // An interrupted attempt cannot consume the remaining budget a second time.
    for (let index = 0; index < operations.length; index++) {
      const receipt = await this.read(operations[index], context);
      if (receipt === undefined) continue;
      const value = {
        ...(receipt as VariantGroupCheckData),
        groupId: groupIds[index],
        success: true,
      };
      reserve(index, value);
      results[index] = value;
      recovered.add(index);
    }
    let next = 0,
      completed = 0;
    let failed: unknown;
    let progress = Promise.resolve();
    const workers = Array.from(
      { length: Math.min(concurrency, groupIds.length) },
      async () => {
        try {
          while (true) {
            await this.guard(context);
            const index = next++;
            if (index >= groupIds.length) return;
            if (!recovered.has(index)) {
              try {
                const value = await this.pipeline.checkGroup(groupIds[index], {
                  ...context,
                  operation: operations[index],
                  onProgress: undefined,
                  validateResult: (value) =>
                    reserve(index, {
                      ...value,
                      groupId: groupIds[index],
                      success: true,
                    }),
                });
                results[index] = {
                  ...value,
                  groupId: groupIds[index],
                  success: true,
                };
              } catch (error) {
                context.signal?.throwIfAborted();
                if (!recoverable(error)) throw error;
                const value = failure(groupIds[index], error);
                reserve(index, value);
                results[index] = value;
              }
            }
            const done = ++completed;
            progress = progress.then(async () => {
              await this.guard(context);
              await context.onProgress?.(done, groupIds.length);
            });
            await progress;
          }
        } catch (error) {
          failed ??= error;
          stop.abort(error);
        }
      },
    );
    await Promise.all(workers);
    if (failed) throw failed;
    await this.guard(context);
    return { total: groupIds.length, results };
  }
  close() {
    this.closed = true;
    for (const controller of this.active)
      controller.abort(new SpApiError('CLOSED'));
  }
}
