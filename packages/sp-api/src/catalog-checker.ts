import { performance } from 'node:perf_hooks';
import {
  CatalogCheckScheduler,
  type CatalogCheckLimits,
} from './catalog-check-scheduler';
import {
  catalogNotFoundResult,
  parseCatalogVariantResult,
  type CatalogVariantResult,
} from './catalog-variants';
import type { SpApiClient } from './client';
import {
  abortError,
  isCatalogItemNotFoundError,
  SpApiError,
  type FailureCode,
} from './errors';
import type { HtmlVariantClient } from './html-client';
import { normalizeProductAsin } from './html-variants';
import type { LegacySpApiClient } from './legacy-client';
import {
  getMarketplaceId,
  getRegionByCountry,
  normalizeCountry,
} from './request';
import type { SpApiRiskController } from './risk-controller';
import type { Country, Logger, Priority, Region } from './types';

export interface CatalogCheckIdentity {
  asin: string;
  country: Country;
  owner: 'primary' | 'competitor';
}
export interface DeferredCatalogCheck extends CatalogCheckIdentity {
  region: Region;
  error: string;
  deferredAt: number;
  retryCount: number;
}
/** Shared Redis adapter, not a process-local cache. Claim/write must atomically
 * fence older fetches and invalidation across API/Worker. Reads validate the
 * bounded result codec and identity before returning; corrupt data is a miss.
 * Every operation must bound actual I/O and honor the supplied signal.
 */
export interface CatalogCheckStore {
  read(
    identity: CatalogCheckIdentity,
    signal: AbortSignal,
  ): Promise<CatalogVariantResult | undefined>;
  claim(identity: CatalogCheckIdentity, signal: AbortSignal): Promise<string>;
  write(
    identity: CatalogCheckIdentity,
    claim: string,
    result: CatalogVariantResult,
    ttlSeconds: number,
    signal: AbortSignal,
  ): Promise<void>;
  defer(
    value: DeferredCatalogCheck,
    ttlSeconds: number,
    signal: AbortSignal,
  ): Promise<void>;
}
export type CatalogFallback =
  | 'ENABLE_LEGACY_CLIENT_FALLBACK'
  | 'ENABLE_HTML_SCRAPER_FALLBACK';
export interface CatalogCheckerOptions {
  standard: Pick<SpApiClient, 'call'>;
  legacy: Pick<LegacySpApiClient, 'call'>;
  html: Pick<HtmlVariantClient, 'checkVariants'>;
  isEnabled(key: CatalogFallback, signal: AbortSignal): Promise<boolean>;
  store: CatalogCheckStore;
  risk: Pick<SpApiRiskController, 'recordCheck'>;
  logger: Logger;
  limits?: CatalogCheckLimits;
}
export interface CatalogCheckOptions {
  forceRefresh?: boolean;
  priority?: Priority;
  owner?: 'primary' | 'competitor';
  signal?: AbortSignal;
}
export class CatalogDeferredError extends SpApiError {
  readonly isDeferred = true;
  constructor(failure: SpApiError) {
    super(failure.code, failure.statusCode, failure.amazonCodes);
    this.name = 'CatalogDeferredError';
    // This class is constructed only after a shared deferred write succeeds.
    this.message = 'ASIN检查失败，已加入延后队列';
  }
}
const lifecycleCodes = new Set([
  'CANCELLED',
  'CLOSED',
  'CAPACITY',
  'TIMEOUT',
  'DEPENDENCY_ERROR',
]);
const failureCodes = new Set<FailureCode>([
  'INVALID_INPUT',
  'INVALID_CONFIG',
  'HTTP_ERROR',
  'INVALID_RESPONSE',
  'BODY_TOO_LARGE',
  'TIMEOUT',
  'CANCELLED',
  'CAPACITY',
  'CLOSED',
  'DEPENDENCY_ERROR',
]);
function safeFailure(error: unknown): SpApiError {
  // Reconstruct, so an adapter cannot smuggle its payload through Error.message.
  if (!(error instanceof SpApiError) || !failureCodes.has(error.code))
    return new SpApiError('DEPENDENCY_ERROR');
  const status = error.statusCode;
  return new SpApiError(
    error.code,
    Number.isInteger(status) && status! >= 100 && status! <= 599
      ? status
      : undefined,
    Array.isArray(error.amazonCodes)
      ? error.amazonCodes
          .filter((code) =>
            ['NOT_FOUND', 'QuotaExceeded', 'TooManyRequests'].includes(code),
          )
          .slice(0, 3)
      : [],
  );
}
function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}
function immutable<T extends object>(value: T): T {
  const pending: object[] = [value];
  while (pending.length) {
    const current = pending.pop()!;
    if (Object.isFrozen(current)) continue;
    for (const child of Object.values(current))
      if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(current);
  }
  return value;
}

/** Fetch/parse stage used by both synchronous API and actual business Workers.
 * Persistence of effective manual/automatic status belongs to the next stage.
 */
export class CatalogVariantChecker {
  private readonly scheduler: CatalogCheckScheduler<CatalogVariantResult>;
  constructor(private readonly options: CatalogCheckerOptions) {
    this.scheduler = new CatalogCheckScheduler(options.limits);
  }
  async check(
    asin: string,
    country: string,
    options: CatalogCheckOptions = {},
  ): Promise<CatalogVariantResult> {
    const identity: CatalogCheckIdentity = {
      asin: normalizeProductAsin(asin),
      country: normalizeCountry(country),
      owner: options.owner ?? 'primary',
    };
    const priority = options.priority ?? 3;
    if (
      !['primary', 'competitor'].includes(identity.owner) ||
      ![1, 2, 3].includes(priority) ||
      (options.forceRefresh !== undefined &&
        typeof options.forceRefresh !== 'boolean')
    )
      throw new SpApiError('INVALID_INPUT');
    return this.scheduler.run(
      `${identity.owner}:${identity.country}:${identity.asin}`,
      priority,
      options.forceRefresh === true,
      options.signal,
      (signal, admittedPriority) =>
        this.execute(
          identity,
          options.forceRefresh === true,
          admittedPriority,
          signal,
        ),
    );
  }
  private warn(reason: string) {
    this.options.logger.warn('变体检查共享缓存不可用', { reason });
  }
  private async execute(
    identity: CatalogCheckIdentity,
    forceRefresh: boolean,
    priority: Priority,
    signal: AbortSignal,
  ): Promise<CatalogVariantResult> {
    const started = performance.now();
    let failure: SpApiError | undefined;
    try {
      const result = await this.cachedOrFetch(
        identity,
        forceRefresh,
        priority,
        signal,
      );
      ensureActive(signal);
      return immutable(result);
    } catch (error) {
      failure = safeFailure(error);
      if (error instanceof CatalogDeferredError) throw error;
      throw failure;
    } finally {
      // One metric per actual check; joined waiters do not inflate counts.
      const limited =
        failure?.statusCode === 429 ||
        !!failure?.amazonCodes.some((code) =>
          ['QuotaExceeded', 'TooManyRequests'].includes(code),
        );
      this.options.risk.recordCheck({
        success: !failure,
        isRateLimit: limited,
        isSpApiError: !!failure && !limited,
        responseTime: Math.min(
          86400,
          Math.max(0, (performance.now() - started) / 1000),
        ),
      });
    }
  }
  private async cachedOrFetch(
    identity: CatalogCheckIdentity,
    forceRefresh: boolean,
    priority: Priority,
    signal: AbortSignal,
  ): Promise<CatalogVariantResult> {
    const { store } = this.options;
    ensureActive(signal);
    if (!forceRefresh) {
      try {
        const cached = await store.read(identity, signal);
        ensureActive(signal);
        if (cached) return cached;
      } catch {
        ensureActive(signal);
        this.warn('read_failed');
      }
    }
    let claim: string | undefined;
    try {
      claim = await store.claim(identity, signal);
      ensureActive(signal);
    } catch {
      ensureActive(signal);
      this.warn('claim_failed');
    }
    const result = await this.fetch(identity, priority, signal);
    ensureActive(signal);
    if (claim !== undefined) {
      try {
        await store.write(identity, claim, result, 600, signal);
        ensureActive(signal);
      } catch {
        ensureActive(signal);
        this.warn('write_failed');
      }
    }
    return result;
  }
  private async enabled(
    key: CatalogFallback,
    signal: AbortSignal,
  ): Promise<boolean> {
    ensureActive(signal);
    const enabled = await this.options.isEnabled(key, signal);
    ensureActive(signal);
    if (typeof enabled !== 'boolean') throw new SpApiError('INVALID_CONFIG');
    return enabled;
  }
  private async fetch(
    identity: CatalogCheckIdentity,
    priority: Priority,
    signal: AbortSignal,
  ): Promise<CatalogVariantResult> {
    const { asin, country } = identity;
    const path = `/catalog/2022-04-01/items/${asin}`;
    const query = {
      marketplaceIds: [getMarketplaceId(country)],
      includedData: ['summaries', 'relationships'],
    };
    let response: unknown;
    let lastError = new SpApiError('INVALID_RESPONSE');
    try {
      const reply = await this.options.standard.call(
        'GET',
        path,
        country,
        query,
        null,
        { priority, maxRetries: 3, signal },
      );
      ensureActive(signal);
      response = reply.data;
    } catch (error) {
      ensureActive(signal);
      lastError = safeFailure(error);
      if (isCatalogItemNotFoundError(lastError))
        return catalogNotFoundResult(asin, country);
      // Legacy only falls back after HTTP 4xx; network/5xx are not disappearance.
      if (
        lastError.code !== 'HTTP_ERROR' ||
        !lastError.statusCode ||
        lastError.statusCode < 400 ||
        lastError.statusCode >= 500
      )
        throw lastError;
    }
    if (
      !response &&
      (await this.enabled('ENABLE_LEGACY_CLIENT_FALLBACK', signal))
    ) {
      try {
        response = await this.options.legacy.call(
          'GET',
          path,
          country,
          query,
          null,
          { priority, signal },
        );
        ensureActive(signal);
      } catch (error) {
        ensureActive(signal);
        lastError = safeFailure(error);
        if (isCatalogItemNotFoundError(lastError))
          return catalogNotFoundResult(asin, country, 'legacy_spapi');
        if (lifecycleCodes.has(lastError.code)) throw lastError;
      }
    }
    if (
      !response &&
      (await this.enabled('ENABLE_HTML_SCRAPER_FALLBACK', signal))
    ) {
      try {
        const html = await this.options.html.checkVariants(
          asin,
          country,
          signal,
        );
        ensureActive(signal);
        return {
          hasVariants: html.hasVariants,
          variantCount: html.details.variantAsins.length,
          details: {
            asin,
            title: '',
            brand: null,
            parentAsin: html.details.parentAsin,
            variations: html.details.variantAsins.map((asin) => ({
              asin,
              title: '',
            })),
            relationships: [],
          },
          meta: { source: 'html_scraper', apiVersion: null },
        };
      } catch (error) {
        ensureActive(signal);
        lastError = safeFailure(error);
        // HTML transport never establishes Amazon Catalog NOT_FOUND.
        if (lifecycleCodes.has(lastError.code)) throw lastError;
      }
    }
    if (!response) {
      ensureActive(signal);
      await this.options.store.defer(
        {
          ...identity,
          region: getRegionByCountry(country),
          error: lastError.message,
          deferredAt: Date.now(),
          retryCount: 0,
        },
        3600,
        signal,
      );
      ensureActive(signal);
      throw new CatalogDeferredError(lastError);
    }
    // A successful but malformed payload does not open another fallback route.
    return parseCatalogVariantResult(response, asin);
  }
  close(): void {
    this.scheduler.close();
  }
}
