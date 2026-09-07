import { performance } from 'node:perf_hooks';
import { abortError, SpApiError, waitFor, type FailureCode } from './errors';
import {
  buildProductUrl,
  MAX_PRODUCT_HTML_BYTES,
  normalizeProductAsin,
  parseHtmlVariantPage,
  productLanguage,
} from './html-variants';
import { normalizeCountry } from './request';
import { NodeHttpTransport } from './transport';
import type { HttpResponse, Logger, Transport } from './types';

export interface HtmlVariantClientOptions {
  logger: Logger;
  /** The host explicitly enables the fallback; omitted means disabled. */
  isEnabled?: (signal: AbortSignal) => boolean | Promise<boolean>;
  /** A supplied transport is caller-owned and must bound its own actual I/O. */
  transport?: Transport;
  maxActive?: number;
  timeoutMs?: number;
}
export interface HtmlVariantResult {
  hasVariants: boolean;
  variantCount: number;
  details: {
    asin: string;
    parentAsin: string | null;
    variantAsins: string[];
    source: 'html_scraper';
    duration: number;
  };
}
const safeCodes = new Set<FailureCode>([
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
function safeError(error: unknown): SpApiError {
  if (!(error instanceof SpApiError) || !safeCodes.has(error.code))
    return new SpApiError('DEPENDENCY_ERROR');
  // HTML errors never inherit Amazon API business codes or private messages.
  const status = error.statusCode;
  return new SpApiError(
    error.code,
    Number.isInteger(status) && status! >= 100 && status! <= 599
      ? status
      : undefined,
  );
}
function header(response: HttpResponse, name: string): string {
  const values = Object.entries(response.headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (
    values.length > 1 ||
    (values.length === 1 && typeof values[0][1] !== 'string')
  )
    throw new SpApiError('INVALID_RESPONSE');
  return (values[0]?.[1] as string | undefined) ?? '';
}
/** Independent HTML fallback, without SP-API quota charging, retries, redirects,
 * identity rotation or credentials. Importing/constructing it does no I/O.
 */
export class HtmlVariantClient {
  private readonly controllers = new Set<AbortController>();
  private readonly transport: Transport;
  private readonly ownedTransport?: NodeHttpTransport;
  private readonly maxActive: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly isEnabled: NonNullable<
    HtmlVariantClientOptions['isEnabled']
  >;
  private closed = false;
  constructor(options: HtmlVariantClientOptions) {
    this.maxActive = options?.maxActive ?? 2;
    this.timeoutMs = options?.timeoutMs ?? 15000;
    if (
      !options ||
      !options.logger ||
      typeof options.logger.info !== 'function' ||
      typeof options.logger.warn !== 'function' ||
      !Number.isInteger(this.maxActive) ||
      this.maxActive < 1 ||
      this.maxActive > 8 ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 15000 ||
      (options.isEnabled !== undefined &&
        typeof options.isEnabled !== 'function') ||
      (options.transport !== undefined &&
        typeof options.transport?.request !== 'function')
    )
      throw new SpApiError('INVALID_CONFIG');
    this.logger = options.logger;
    this.isEnabled = options.isEnabled ?? (() => false);
    this.transport =
      options.transport ??
      (this.ownedTransport = new NodeHttpTransport({
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_PRODUCT_HTML_BYTES,
        maxInFlight: this.maxActive,
      }));
  }
  async checkVariants(
    asin: string,
    country: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<HtmlVariantResult> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (!(signal instanceof AbortSignal)) throw new SpApiError('INVALID_INPUT');
    if (signal.aborted) throw new SpApiError('CANCELLED');
    const product = normalizeProductAsin(asin),
      normalizedCountry = normalizeCountry(country);
    const url = buildProductUrl(product, normalizedCountry);
    if (this.controllers.size >= this.maxActive)
      throw new SpApiError('CAPACITY');
    const started = performance.now();
    const controller = new AbortController();
    const abort = () => controller.abort(new SpApiError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      this.timeoutMs,
    );
    const ensureActive = () => {
      if (
        performance.now() - started >= this.timeoutMs &&
        !controller.signal.aborted
      )
        controller.abort(new SpApiError('TIMEOUT'));
      if (controller.signal.aborted) throw abortError(controller.signal);
    };
    const work = Promise.resolve()
      .then(async () => {
        ensureActive();
        const enabled = await this.isEnabled(controller.signal);
        ensureActive();
        if (enabled !== true) throw new SpApiError('INVALID_CONFIG');
        const response = await this.transport.request({
          url,
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Amazon-ASIN-monitor-Neo/1.0 (HTML fallback)',
            Accept: 'text/html',
            'Accept-Language': productLanguage(normalizedCountry),
            'Accept-Encoding': 'identity',
          },
        });
        ensureActive();
        if (
          !Number.isInteger(response.statusCode) ||
          response.statusCode < 100 ||
          response.statusCode > 599
        )
          throw new SpApiError('INVALID_RESPONSE');
        if (response.statusCode !== 200)
          throw new SpApiError('HTTP_ERROR', response.statusCode);
        if (
          header(response, 'content-type')
            .split(';', 1)[0]
            .trim()
            .toLowerCase() !== 'text/html' ||
          !['', 'identity'].includes(
            header(response, 'content-encoding').trim().toLowerCase(),
          )
        )
          throw new SpApiError('INVALID_RESPONSE');
        const relations = parseHtmlVariantPage(
          response.body,
          product,
          normalizedCountry,
        );
        ensureActive();
        const duration = Math.max(0, Math.round(performance.now() - started));
        this.logger.info('HTML variant check completed', {
          country: normalizedCountry,
          variantCount: relations.variantCount,
          duration,
        });
        return {
          hasVariants: relations.hasVariants,
          variantCount: relations.variantCount,
          details: {
            asin: product,
            parentAsin: relations.parentAsin,
            variantAsins: relations.variantAsins,
            source: 'html_scraper' as const,
            duration,
          },
        };
      })
      .catch((error: unknown) => {
        throw safeError(error);
      })
      .finally(() => {
        // Abort/deadline does not prove a supplied reader or transport has stopped.
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.controllers.delete(controller);
      });
    try {
      return await waitFor(work, controller.signal);
    } catch (error: unknown) {
      const failure = safeError(error);
      this.logger.warn('HTML variant check failed', {
        country: normalizedCountry,
        reason: failure.code,
      });
      throw failure;
    }
  }
  close(): void {
    this.closed = true;
    for (const controller of this.controllers)
      controller.abort(new SpApiError('CLOSED'));
    this.ownedTransport?.close();
  }
}
