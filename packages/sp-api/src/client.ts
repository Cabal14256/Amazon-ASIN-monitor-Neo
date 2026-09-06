import {
  abortError,
  amazonCodes,
  parseJson,
  pause,
  retryDelayMs,
  SpApiError,
  waitFor,
} from './errors';
import { LwaTokenService } from './lwa';
import {
  buildAmazonUrl,
  getRegionByCountry,
  identifyOperation,
  REGION_SETTINGS,
} from './request';
import { amzDate, signRequest } from './signature';
import type {
  ConfigSource,
  Logger,
  Priority,
  Query,
  QuotaExecutor,
  ResponseMetadata,
  Transport,
} from './types';

export interface CallOptions {
  priority?: Priority;
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export class SpApiClient {
  private readonly tokens: LwaTokenService;
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly dependencies: {
      config: ConfigSource;
      transport: Transport;
      quota: QuotaExecutor;
      logger: Logger;
      now?: () => number;
      sleep?: typeof pause;
    },
  ) {
    if (!dependencies.quota?.execute || !dependencies.quota?.observe)
      throw new SpApiError('INVALID_CONFIG');
    this.tokens = new LwaTokenService(
      dependencies.config,
      dependencies.transport,
      dependencies.logger,
      dependencies.now,
    );
  }
  async call(
    method: string,
    path: string,
    country: string,
    query: Query = {},
    body: unknown = undefined,
    options: CallOptions = {},
  ): Promise<{ data: unknown; metadata: ResponseMetadata }> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (this.controllers.size >= 64) throw new SpApiError('CAPACITY');
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method))
      throw new SpApiError('INVALID_INPUT');
    const url = buildAmazonUrl(country, path, query);
    const priority = options.priority ?? 2;
    const maxRetries = options.maxRetries ?? 5;
    const initialDelay = options.initialDelayMs ?? 2000;
    const timeout = options.timeoutMs ?? 900000;
    if (
      ![1, 2, 3].includes(priority) ||
      !Number.isInteger(maxRetries) ||
      maxRetries < 0 ||
      maxRetries > 5 ||
      !Number.isInteger(initialDelay) ||
      initialDelay < 1 ||
      initialDelay > 30000 ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 900000
    )
      throw new SpApiError('INVALID_INPUT');
    let payload: string;
    try {
      payload = body === undefined || body === null ? '' : JSON.stringify(body);
    } catch {
      throw new SpApiError('INVALID_INPUT');
    }
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > 1024 * 1024)
      throw new SpApiError('BODY_TOO_LARGE');
    const controller = new AbortController();
    const abort = () => controller.abort(new SpApiError('CANCELLED'));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      timeout,
    );
    this.controllers.add(controller);
    const region = getRegionByCountry(country);
    const operation = identifyOperation(method, url.pathname);
    const signal = controller.signal;
    const work = (async () => {
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw abortError(signal);
        try {
          return await this.dependencies.quota.execute(
            { region, operation, priority, signal },
            async () => {
              if (signal.aborted) throw abortError(signal);
              const { token, config } = await this.tokens.get(region, signal);
              if (signal.aborted) throw abortError(signal);
              let headers: Record<string, string> = {
                host: url.host,
                'x-amz-access-token': token,
                'user-agent': 'Amazon-ASIN-Monitor-Neo/0.1 (Language=Node.js)',
                accept: 'application/json',
                'x-amz-date': amzDate(new Date(this.now())),
              };
              if (payload) headers['content-type'] = 'application/json';
              if (config.useAwsSignature)
                headers = signRequest(
                  method,
                  url,
                  headers,
                  payload,
                  config.regions[region],
                  REGION_SETTINGS[region].awsRegion,
                  new Date(this.now()),
                );
              const response = await this.dependencies.transport.request({
                url,
                method,
                headers,
                body: payload || undefined,
                signal,
              });
              if (signal.aborted) throw abortError(signal);
              const header = (name: string) => {
                const entry = Object.entries(response.headers).find(
                  ([key]) => key.toLowerCase() === name,
                )?.[1];
                return typeof entry === 'string' ? entry : undefined;
              };
              const rawRate = header('x-amzn-ratelimit-limit');
              const rate =
                rawRate && /^\d+(?:\.\d+)?$/.test(rawRate)
                  ? Number(rawRate)
                  : NaN;
              const requestId = header('x-amzn-requestid');
              const metadata: ResponseMetadata = {
                region,
                operation,
                statusCode: response.statusCode,
                ...(Number.isFinite(rate) && rate > 0 && rate <= 10000
                  ? { rateLimit: rate }
                  : {}),
                ...(requestId && /^[a-z\d-]{1,128}$/i.test(requestId)
                  ? { requestId }
                  : {}),
              };
              // Exactly one observation per actual response, including each 429.
              try {
                await this.dependencies.quota.observe(metadata);
              } catch {
                this.dependencies.logger.warn('SP-API 配额观察失败', {
                  region,
                  operation,
                });
              }
              if (signal.aborted) throw abortError(signal);
              if (response.statusCode < 200 || response.statusCode >= 300) {
                const retryAfter = header('retry-after');
                throw new SpApiError(
                  'HTTP_ERROR',
                  response.statusCode,
                  amazonCodes(response.body),
                  retryAfter && retryAfter.length <= 128
                    ? retryAfter
                    : undefined,
                );
              }
              const data = response.body ? parseJson(response.body) : {};
              if (data === undefined) throw new SpApiError('INVALID_RESPONSE');
              this.dependencies.logger.debug('SP-API 请求完成', {
                region,
                operation,
                statusCode: response.statusCode,
              });
              return { data, metadata };
            },
          );
        } catch (error) {
          if (signal.aborted) throw abortError(signal);
          const limited =
            error instanceof SpApiError &&
            (error.statusCode === 429 ||
              error.amazonCodes.some((code) =>
                ['QuotaExceeded', 'TooManyRequests'].includes(code),
              ));
          if (!limited || attempt >= maxRetries) throw error;
          const delay = retryDelayMs(
            (error as SpApiError).retryAfter,
            attempt,
            initialDelay,
            this.now(),
          );
          this.dependencies.logger.warn('SP-API 限流退避', {
            region,
            operation,
            attempt: attempt + 1,
            waitMs: delay,
          });
          await (this.dependencies.sleep ?? pause)(delay, signal);
        }
      }
    })()
      .catch((error) => {
        const safe =
          error instanceof SpApiError
            ? error
            : new SpApiError('DEPENDENCY_ERROR');
        this.dependencies.logger.error('SP-API 请求失败', {
          region,
          operation,
          code: safe.code,
          statusCode: safe.statusCode,
        });
        throw safe;
      })
      .finally(() => {
        // Retain admission if an injected dependency ignores cancellation and is
        // still executing. Returning a timeout is not proof underlying work ended.
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        this.controllers.delete(controller);
      });
    return waitFor(work, signal);
  }
  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }
  invalidateTokens(): void {
    this.tokens.invalidate();
  }
  close(): void {
    this.closed = true;
    this.tokens.close();
    for (const controller of this.controllers)
      controller.abort(new SpApiError('CLOSED'));
  }
}
