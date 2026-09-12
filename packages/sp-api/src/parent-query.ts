import {
  CatalogDeferredError,
  type CatalogVariantChecker,
} from './catalog-checker';
import { abortError, SpApiError, waitFor } from './errors';
import { normalizeCountry } from './request';

export interface ParentAsinQueryItem {
  asin: string;
  hasParentAsin: boolean;
  parentAsin: string | null;
  parentTitle: string;
  title: string;
  brand: string | null;
  hasVariants: boolean;
  variantCount: number;
  error: string | null;
}
export interface ParentAsinQueryOptions {
  signal?: AbortSignal;
  onProgress?(completed: number, total: number): void | Promise<void>;
}
export const MAX_PARENT_QUERY_ITEMS = 1000;
export const MAX_PARENT_QUERY_BYTES = 32 * 1024 * 1024;

/** Two-pass Legacy parent lookup: preserve order/duplicates, collect per-item
 * failures, then fetch each distinct parent title once. No ASIN state is written.
 */
export class CatalogParentQuery {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly checker: Pick<CatalogVariantChecker, 'check'>,
    private readonly concurrency = 5,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20)
      throw new SpApiError('INVALID_CONFIG');
  }
  async query(
    asins: unknown[],
    country: string,
    options: ParentAsinQueryOptions = {},
  ): Promise<ParentAsinQueryItem[]> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (options.signal?.aborted) throw new SpApiError('CANCELLED');
    if (!Array.isArray(asins) || !asins.length)
      throw new SpApiError('INVALID_INPUT');
    if (asins.length > MAX_PARENT_QUERY_ITEMS)
      throw new SpApiError('BODY_TOO_LARGE');
    const inputs = asins
      .map((value) =>
        typeof value === 'string' ? value.trim().toUpperCase() : '',
      )
      .filter((value) => /^[A-Z][A-Z0-9]{9}$/.test(value));
    if (!inputs.length) throw new SpApiError('INVALID_INPUT');
    const normalizedCountry = normalizeCountry(country);
    if (this.active.size >= 4) throw new SpApiError('CAPACITY');
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort(new SpApiError('CANCELLED'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      900_000,
    );
    const signal = controller.signal;
    const ensureActive = () => {
      if (signal.aborted) throw abortError(signal);
    };
    const run = async <T>(
      values: T[],
      action: (value: T, index: number) => Promise<void>,
    ) => {
      let next = 0;
      const workers = Array.from(
        { length: Math.min(values.length, this.concurrency) },
        async () => {
          try {
            while (next < values.length) {
              ensureActive();
              const index = next++;
              await action(values[index], index);
              ensureActive();
            }
          } catch (error) {
            controller.abort(
              error instanceof SpApiError
                ? error
                : new SpApiError('DEPENDENCY_ERROR'),
            );
            throw error;
          }
        },
      );
      // Keep actual admission until every started check/progress callback settles.
      const settled = await Promise.allSettled(workers);
      ensureActive();
      const failure = settled.find((value) => value.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    };
    const work = Promise.resolve()
      .then(async () => {
        const results = new Array<ParentAsinQueryItem>(inputs.length);
        let completed = 0,
          bytes = 2;
        let progress = Promise.resolve();
        const account = (value: unknown, copies = 1) => {
          bytes += (Buffer.byteLength(JSON.stringify(value)) + 1) * copies;
          if (bytes > MAX_PARENT_QUERY_BYTES)
            throw new SpApiError('BODY_TOO_LARGE');
        };
        await run(inputs, async (asin, index) => {
          let item: ParentAsinQueryItem;
          try {
            const result = await this.checker.check(asin, normalizedCountry, {
              forceRefresh: true,
              priority: 1,
              signal,
            });
            ensureActive();
            const parentAsin = result.details.parentAsin;
            item = {
              asin,
              hasParentAsin: !!parentAsin,
              parentAsin,
              parentTitle: '',
              title: result.details.title,
              brand: result.details.brand,
              hasVariants: result.hasVariants,
              variantCount: result.variantCount,
              error: null,
            };
          } catch (error) {
            ensureActive();
            item = {
              asin,
              hasParentAsin: false,
              parentAsin: null,
              parentTitle: '',
              title: '',
              brand: null,
              hasVariants: false,
              variantCount: 0,
              error:
                error instanceof CatalogDeferredError
                  ? 'ASIN检查失败，已加入延后队列'
                  : 'ASIN查询失败，请稍后重试',
            };
          }
          account(item);
          results[index] = item;
          const done = ++completed;
          progress = progress.then(async () => {
            ensureActive();
            await options.onProgress?.(done, inputs.length);
          });
          await progress;
        });
        const parents = new Map<string, string>();
        const references = new Map<string, number>();
        const parentTasks: string[] = [];
        for (const item of results) {
          if (!item.parentAsin) continue;
          references.set(
            item.parentAsin,
            (references.get(item.parentAsin) ?? 0) + 1,
          );
        }
        for (const item of results) {
          const parent = item.parentAsin;
          if (!parent || parents.has(parent)) continue;
          parents.set(parent, parent === item.asin ? item.title : '');
          if (parent === item.asin) account(item.title, references.get(parent));
          else parentTasks.push(parent);
        }
        await run(parentTasks, async (parent) => {
          let title = '';
          try {
            const result = await this.checker.check(parent, normalizedCountry, {
              forceRefresh: false,
              priority: 1,
              signal,
            });
            ensureActive();
            title = result.details.title;
          } catch {
            ensureActive();
          }
          account(title, references.get(parent));
          parents.set(parent, title);
        });
        for (const item of results) {
          if (!item.parentAsin) continue;
          item.parentTitle = parents.get(item.parentAsin) ?? '';
        }
        ensureActive();
        return results;
      })
      .finally(() => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        this.active.delete(controller);
      });
    return waitFor(work, signal);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active)
      controller.abort(new SpApiError('CLOSED'));
  }
}
