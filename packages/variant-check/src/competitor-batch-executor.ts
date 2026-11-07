import {
  isNeoCatalogId,
  type VariantCheckJobData,
  type VariantCheckResultReference,
} from '@asin-monitor/contracts';
import {
  decodeVariantCheckReceiptResult,
  VARIANT_CHECK_RECEIPT_MAX_BYTES,
  VariantCheckError,
  variantCheckReceiptStorageBytes,
  type CompetitorCheckRepositoryPort,
  type CompetitorCheckUnit,
  type VariantCheckOperation,
} from '@asin-monitor/db';
import { abortError, SpApiError, waitFor } from '@asin-monitor/sp-api';
import type {
  CompetitorCheckContext,
  CompetitorCheckPipeline,
  CompetitorGroupCheckData,
} from './competitor-pipeline';
import { VariantCheckCommitUncertainError } from './pipeline';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
  variantCheckResultReference,
} from './task';

export type CompetitorBatchContext = Omit<
  CompetitorCheckContext,
  'operation' | 'validateResult' | 'scheduledMonitor' | 'snapshotDigest'
>;
export type CompetitorBatchItem = {
  groupId: string;
  success: boolean;
  error?: string;
} & Partial<CompetitorGroupCheckData>;
export interface CompetitorBatchResult {
  total: number;
  results: CompetitorBatchItem[];
}
type BatchJob = Extract<
  VariantCheckJobData,
  { taskSubType: 'competitor-variant-group' }
>;

function recoverable(error: unknown): boolean {
  return (
    (error instanceof VariantCheckError &&
      [
        'group-not-found',
        'asin-not-found',
        'snapshot-changed',
        'capacity',
      ].includes(error.code)) ||
    (error instanceof SpApiError &&
      ['HTTP_ERROR', 'INVALID_RESPONSE', 'BODY_TOO_LARGE'].includes(error.code))
  );
}
const failure = (groupId: string, error?: unknown): CompetitorBatchItem => ({
  groupId,
  success: false,
  error:
    error instanceof VariantCheckError ? error.message : '竞品变体组检查失败',
});

/** Competitor receipts stay in the competitor transaction, including the root
 * batch receipt. Input order and duplicates are part of the immutable request. */
export class CompetitorBatchCheckExecutor {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly repository: CompetitorCheckRepositoryPort,
    private readonly pipeline: Pick<CompetitorCheckPipeline, 'checkGroup'>,
    private readonly concurrency = 2,
  ) {
    this.validateConcurrency(concurrency);
  }
  private validateConcurrency(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 8)
      throw new VariantCheckError('invalid-input');
  }
  private async run<T>(
    context: CompetitorBatchContext,
    action: (scope: CompetitorBatchContext) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (context.signal?.aborted) throw abortError(context.signal);
    if (this.active.size >= 4) throw new VariantCheckError('capacity');
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
            controller.signal.throwIfAborted();
            await context.checkpoint();
            controller.signal.throwIfAborted();
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
  private async guard(
    context: CompetitorBatchContext,
    unit?: CompetitorCheckUnit,
  ) {
    context.signal?.throwIfAborted();
    await context.checkpoint();
    if (unit) await context.authorize(unit);
    context.signal?.throwIfAborted();
  }
  private read(
    operation: VariantCheckOperation,
    context: CompetitorBatchContext,
  ) {
    return this.repository.transaction(async (unit) => {
      await this.guard(context, unit);
      const result = await unit.readReceipt(operation);
      await this.guard(context, unit);
      return result;
    }, context.signal);
  }
  private async save(
    operation: VariantCheckOperation,
    result: unknown,
    context: CompetitorBatchContext,
  ) {
    let readyToCommit = false;
    try {
      return await this.repository.transaction(async (unit) => {
        await this.guard(context, unit);
        const existing = await unit.readReceipt(operation, true);
        if (existing !== undefined) return existing;
        await unit.saveReceipt(operation, result);
        await this.guard(context, unit);
        readyToCommit = true;
        return result;
      }, context.signal);
    } catch (error) {
      if (readyToCommit) throw new VariantCheckCommitUncertainError();
      throw error;
    }
  }
  execute(
    raw: unknown,
    context: CompetitorBatchContext,
  ): Promise<VariantCheckResultReference> {
    const data = parseVariantCheckJob(raw);
    if (data.taskSubType !== 'competitor-variant-group')
      throw new VariantCheckError('invalid-input');
    const operation = variantCheckJobOperation(data);
    return this.run(context, async (scope) => {
      if ((await this.read(operation, scope)) !== undefined)
        return variantCheckResultReference(operation);
      const result = await this.batch(
        data.params.groupIds,
        { ...scope, forceRefresh: data.params.forceRefresh },
        this.concurrency,
        data,
      );
      const successCount = result.results.filter((item) => item.success).length;
      const failedCount = result.total - successCount;
      const complete = {
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
      await this.save(
        operation,
        decodeVariantCheckReceiptResult(complete, 'competitor-batch'),
        scope,
      );
      return variantCheckResultReference(operation);
    });
  }
  checkGroups(
    groupIds: string[],
    context: CompetitorBatchContext,
    concurrency = 3,
  ): Promise<CompetitorBatchResult> {
    if (
      !Array.isArray(groupIds) ||
      !groupIds.length ||
      groupIds.length > 1000 ||
      groupIds.some((id) => !isNeoCatalogId(id))
    )
      throw new VariantCheckError('invalid-input');
    this.validateConcurrency(concurrency);
    const inputs = [...groupIds];
    return this.run(context, (scope) => this.batch(inputs, scope, concurrency));
  }
  private async batch(
    groupIds: string[],
    context: CompetitorBatchContext,
    concurrency: number,
    data?: BatchJob,
  ): Promise<CompetitorBatchResult> {
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
    const reserve = (index: number, value: CompetitorBatchItem) => {
      const size = variantCheckReceiptStorageBytes(value) + 256;
      const next = bytes - sizes[index] + size;
      if (next > VARIANT_CHECK_RECEIPT_MAX_BYTES - 65_536)
        throw new VariantCheckError('capacity');
      bytes = next;
      sizes[index] = size;
    };
    const operations = data
      ? groupIds.map((_, index) => variantCheckJobOperation(data, index))
      : [];
    const recovered = new Set<number>();
    // Charge all committed results before admitting more business writes.
    for (let index = 0; index < operations.length; index++) {
      const receipt = await this.read(operations[index], context);
      if (receipt === undefined) continue;
      const value = {
        ...(receipt as CompetitorGroupCheckData),
        groupId: groupIds[index],
        success: true,
      };
      reserve(index, value);
      results[index] = value;
      recovered.add(index);
    }
    const pending = groupIds.map((_, index) => index);
    const running = new Map<string, Promise<void>>();
    let completed = 0;
    let failed: unknown;
    let progress = Promise.resolve();
    const runItem = async (index: number) => {
      await this.guard(context);
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
    };
    try {
      while (pending.length || running.size) {
        await this.guard(context);
        while (running.size < concurrency && !failed) {
          // A duplicate must observe its predecessor's committed snapshot.
          // Skip busy IDs so unrelated groups can still use every free slot.
          const offset = pending.findIndex(
            (index) => !running.has(groupIds[index]),
          );
          if (offset === -1) break;
          const [index] = pending.splice(offset, 1);
          const id = groupIds[index];
          const work = runItem(index)
            .catch((error: unknown) => {
              failed ??= error;
              stop.abort(error);
            })
            .finally(() => running.delete(id));
          running.set(id, work);
        }
        if (running.size) await Promise.race(running.values());
        if (failed) break;
      }
    } catch (error) {
      failed ??= error;
      stop.abort(error);
    } finally {
      // Cancellation cannot release physical admission while group I/O remains.
      await Promise.all(running.values());
    }
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
