import {
  abortError,
  CatalogDeferredError,
  getMarketplaceId,
  MAX_CATALOG_BYTES,
  normalizeCountry,
  parseCatalogRelationships,
  SpApiError,
  waitFor,
  type CatalogVariantChecker,
  type Logger,
  type SpApiClient,
} from '@asin-monitor/sp-api';
import {
  decodeGroupCatalogResult,
  type CatalogSearchVariantResult,
  type GroupCatalogResult,
} from './hybrid-result';

interface SearchSummary {
  hasVariants: boolean;
  parentAsin: string | null;
  failed?: true;
}
export interface CatalogHybridOptions {
  signal?: AbortSignal;
  checkpoint(): Promise<void>;
  onProgress?(completed: number, total: number): void | Promise<void>;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const fatal = (error: unknown) =>
  !(error instanceof CatalogDeferredError) &&
  error instanceof SpApiError &&
  [
    'CANCELLED',
    'CLOSED',
    'CAPACITY',
    'TIMEOUT',
    'DEPENDENCY_ERROR',
    'INVALID_CONFIG',
  ].includes(error.code);
const absent = (asin: string): CatalogSearchVariantResult => ({
  asin,
  hasVariants: false,
  variantCount: 0,
  errorType: 'NO_VARIANTS',
  details: { asin, parentAsin: null, source: 'batch_search' },
});

/** The real searchCatalogItems operation uses GET, CSV identifiers and a maximum
 * page size of 20. Legacy used an unsupported POST body, which forced fallback.
 * https://developer-docs.amazon/sp-api/docs/catalog-items-api-v2022-04-01-reference
 */
export class CatalogHybridChecker {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly standard: Pick<SpApiClient, 'call'>,
    private readonly checker: Pick<CatalogVariantChecker, 'check'>,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {}
  async check(
    asins: string[],
    country: string,
    options: CatalogHybridOptions,
  ): Promise<GroupCatalogResult[]> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (options.signal?.aborted) throw new SpApiError('CANCELLED');
    if (
      !Array.isArray(asins) ||
      asins.length > 5000 ||
      asins.some(
        (value) =>
          typeof value !== 'string' ||
          !/^[A-Z0-9]{10}$/.test(value.trim().toUpperCase()),
      )
    )
      throw new SpApiError('INVALID_INPUT');
    const inputs = asins.map((value) => value.trim().toUpperCase());
    const normalizedCountry = normalizeCountry(country);
    if (this.active.size >= 4) throw new SpApiError('CAPACITY');
    options = { ...options };
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort(new SpApiError('CANCELLED'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      900000,
    );
    const ensure = () => {
      if (controller.signal.aborted) throw abortError(controller.signal);
    };
    let checkpointFailed = false;
    const guard = async () => {
      ensure();
      try {
        await options.checkpoint();
      } catch (error) {
        checkpointFailed = true;
        throw error;
      }
      ensure();
    };
    const work = Promise.resolve()
      .then(async () => {
        const summaries = new Map<string, SearchSummary>();
        // Search each distinct identifier once; keep the original order and
        // duplicates for the detailed pass and the returned business result.
        const distinct = [...new Set(inputs)];
        for (let start = 0; start < distinct.length; start += 20) {
          const batch = distinct.slice(start, start + 20);
          await guard();
          try {
            const found = await this.search(
              batch,
              normalizedCountry,
              controller.signal,
              guard,
            );
            for (const [asin, summary] of found) summaries.set(asin, summary);
          } catch (error) {
            ensure();
            if (checkpointFailed || fatal(error)) throw error;
            this.logger.warn('批量目录查询失败，将逐项查询', {
              reason: 'catalog_batch_search_failed',
              count: batch.length,
            });
            for (const asin of batch)
              summaries.set(asin, {
                hasVariants: false,
                parentAsin: null,
                failed: true,
              });
          }
          await guard();
        }
        const results: GroupCatalogResult[] = [];
        let bytes = 2;
        for (const asin of inputs) {
          await guard();
          const summary = summaries.get(asin)!;
          let result: GroupCatalogResult;
          if (!summary.hasVariants && !summary.failed) result = absent(asin);
          else {
            try {
              result = await this.checker.check(asin, normalizedCountry, {
                forceRefresh: false,
                priority: 1,
                signal: controller.signal,
              });
            } catch (error) {
              ensure();
              if (fatal(error)) throw error;
              result = {
                asin,
                hasVariants: summary.hasVariants,
                variantCount: 0,
                errorType: 'SP_API_ERROR',
                details: {
                  asin,
                  parentAsin: summary.parentAsin,
                  source: 'batch_search_fallback',
                  error: '详细查询失败',
                  errorMessage: 'SP-API检查失败',
                },
              };
            }
          }
          await guard();
          result = decodeGroupCatalogResult(result, asin, normalizedCountry);
          bytes += Buffer.byteLength(JSON.stringify(result)) + 1;
          if (bytes > 32 * 1024 * 1024) throw new SpApiError('BODY_TOO_LARGE');
          results.push(result);
          await options.onProgress?.(results.length, inputs.length);
          await guard();
        }
        return results;
      })
      .finally(() => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        this.active.delete(controller);
      });
    return waitFor(work, controller.signal);
  }
  private async search(
    asins: string[],
    country: string,
    signal: AbortSignal,
    guard: () => Promise<void>,
  ): Promise<Map<string, SearchSummary>> {
    const summaries = new Map<string, SearchSummary>();
    const wanted = new Set(asins),
      tokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      await guard();
      const response = await this.standard.call(
        'GET',
        '/catalog/2022-04-01/items',
        country,
        {
          identifiers: asins.join(','),
          identifiersType: 'ASIN',
          marketplaceIds: getMarketplaceId(country),
          includedData: 'summaries,relationships',
          pageSize: 20,
          ...(pageToken ? { pageToken } : {}),
        },
        undefined,
        { maxRetries: 3, priority: 2, signal },
      );
      // A task checkpoint failure must propagate as lifecycle failure, not be
      // reinterpreted as an Amazon error that permits more requests.
      await guard();
      let data: Record<string, unknown> | undefined;
      try {
        const raw = JSON.stringify(response.data);
        if (!raw || Buffer.byteLength(raw) > MAX_CATALOG_BYTES)
          throw new SpApiError('BODY_TOO_LARGE');
        data = record(JSON.parse(raw));
      } catch (error) {
        if (error instanceof SpApiError) throw error;
        throw new SpApiError('INVALID_RESPONSE');
      }
      if (!data || !Array.isArray(data.items) || data.items.length > 20)
        throw new SpApiError('INVALID_RESPONSE');
      for (const value of data.items) {
        const item = record(value);
        if (!item || typeof item.asin !== 'string')
          throw new SpApiError('INVALID_RESPONSE');
        const asin = item.asin.trim().toUpperCase();
        if (!wanted.has(asin)) continue;
        if (summaries.has(asin)) throw new SpApiError('INVALID_RESPONSE');
        const relationships = parseCatalogRelationships(item, asin);
        const summary = Array.isArray(item.summaries)
          ? record(item.summaries[0])
          : undefined;
        const rawParent = summary?.parentAsin || null;
        if (
          rawParent !== null &&
          (typeof rawParent !== 'string' ||
            !/^[A-Z0-9]{10}$/.test(rawParent.trim().toUpperCase()))
        )
          throw new SpApiError('INVALID_RESPONSE');
        let parent =
          typeof rawParent === 'string' ? rawParent.trim().toUpperCase() : null;
        if (parent === asin) parent = null;
        const parentAsin = relationships.parentASIN || parent;
        if (parentAsin !== null && !/^[A-Z0-9]{10}$/.test(parentAsin))
          throw new SpApiError('INVALID_RESPONSE');
        summaries.set(asin, {
          hasVariants:
            relationships.variantASINs.length > 0 ||
            relationships.isChild ||
            relationships.isParent ||
            !!parent,
          parentAsin,
        });
      }
      if (data.pagination !== undefined && !record(data.pagination))
        throw new SpApiError('INVALID_RESPONSE');
      const next = record(data.pagination)?.nextToken;
      if (next === undefined || next === null || next === '') {
        for (const asin of asins)
          if (!summaries.has(asin))
            summaries.set(asin, { hasVariants: false, parentAsin: null });
        return summaries;
      }
      if (typeof next !== 'string' || next.length > 2048 || tokens.has(next))
        throw new SpApiError('INVALID_RESPONSE');
      tokens.add(next);
      pageToken = next;
    }
    throw new SpApiError('INVALID_RESPONSE');
  }
  close(): void {
    this.closed = true;
    for (const controller of this.active)
      controller.abort(new SpApiError('CLOSED'));
  }
}
