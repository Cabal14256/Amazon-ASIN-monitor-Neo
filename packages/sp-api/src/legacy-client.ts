import { SpApiClient, type CallOptions } from './client';
import { snapshotConfig } from './config';
import { abortError, SpApiError } from './errors';
import { buildAmazonUrl, encode } from './request';
import type { ConfigSource, Query, SpApiConfig } from './types';

type SharedDependencies = ConstructorParameters<typeof SpApiClient>[0];
export interface LegacySpApiClientOptions extends SharedDependencies {
  /** Read the host's current ENABLE_LEGACY_CLIENT_FALLBACK; omitted is off. */
  isEnabled?: (signal: AbortSignal) => boolean | Promise<boolean>;
}
export type LegacyCallOptions = Omit<CallOptions, 'maxRetries'>;

/** Legacy arrays are repeated query keys. Keep validated fixed Amazon origins
 * and prebuilt-query behavior; never concatenate an unchecked base/path.
 */
export function buildLegacyAmazonUrl(
  country: string,
  path: string,
  query: Query = {},
): URL {
  const url = buildAmazonUrl(country, path);
  if (path.includes('?')) return url;
  if (
    !query ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(query))
  )
    throw new SpApiError('INVALID_INPUT');
  const entries = Object.entries(query);
  if (entries.length > 100) throw new SpApiError('INVALID_INPUT');
  const parts: string[] = [];
  let size = url.href.length,
    count = 0;
  for (const [key, raw] of entries) {
    if (!key || key.length > 256) throw new SpApiError('INVALID_INPUT');
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > 256) throw new SpApiError('INVALID_INPUT');
    for (const value of values) {
      if (value === null || value === undefined) continue;
      if (
        ++count > 1024 ||
        !['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        throw new SpApiError('INVALID_INPUT');
      const text = String(value);
      if (text.length > 4096) throw new SpApiError('INVALID_INPUT');
      const part = `${encode(key)}=${encode(text)}`;
      size += part.length + 1;
      if (size > 16384) throw new SpApiError('INVALID_INPUT');
      parts.push(part);
    }
  }
  url.search = parts.join('&');
  if (url.pathname.length + url.search.length > 8192)
    throw new SpApiError('INVALID_INPUT');
  return url;
}

/** A profile around the same bounded client/token/quota pipeline, not a second
 * HTTPS implementation. The host still owns config, transport and quota.
 */
export class LegacySpApiClient {
  private readonly client: SpApiClient;
  constructor(options: LegacySpApiClientOptions) {
    if (
      !options ||
      !options.config?.get ||
      !options.config.reload ||
      !options.transport?.request ||
      !options.quota?.execute ||
      !options.quota.observe ||
      (options.isEnabled !== undefined &&
        typeof options.isEnabled !== 'function')
    )
      throw new SpApiError('INVALID_CONFIG');
    const { config, transport, quota, logger, now, sleep } = options;
    const enabled = options.isEnabled ?? (() => false);
    const requireEnabled = async (signal: AbortSignal) => {
      if (signal.aborted) throw abortError(signal);
      const value = await enabled(signal);
      if (signal.aborted) throw abortError(signal);
      if (value !== true) throw new SpApiError('INVALID_CONFIG');
    };
    const unsigned = async (
      method: keyof ConfigSource,
      signal: AbortSignal,
    ): Promise<SpApiConfig> => {
      if (signal.aborted) throw abortError(signal);
      if (method === 'reload') await requireEnabled(signal);
      const current = snapshotConfig(await config[method](signal));
      if (signal.aborted) throw abortError(signal);
      return { ...current, useAwsSignature: false };
    };
    this.client = new SpApiClient({
      logger,
      now,
      sleep,
      config: {
        get: (signal) => unsigned('get', signal),
        reload: (signal) => unsigned('reload', signal),
      },
      quota: {
        execute: async (context, task) => {
          // This wait stays inside SpApiClient's admission/deadline. Disabled
          // calls and failed flag reads must not consume shared Amazon quota.
          await requireEnabled(context.signal);
          return quota.execute(context, task);
        },
        observe: (metadata) => quota.observe(metadata),
      },
      transport: {
        request: (input) => {
          if (input.url.hostname === 'api.amazon.com')
            return transport.request(input);
          const headers: Record<string, string> = {
            'x-amz-access-token': input.headers['x-amz-access-token'],
            'user-agent': 'Amazon-ASIN-Monitor/1.0 (Language=Node.js)',
          };
          if (input.body) headers['content-type'] = 'application/json';
          return transport.request({ ...input, headers });
        },
      },
    });
  }
  async call(
    method: string,
    path: string,
    country: string,
    query: Query = {},
    body: unknown = undefined,
    options: LegacyCallOptions = {},
  ): Promise<unknown> {
    const url = buildLegacyAmazonUrl(country, path, query);
    const result = await this.client.call(
      method,
      url.pathname + url.search,
      country,
      {},
      body,
      { ...options, timeoutMs: options.timeoutMs ?? 120000, maxRetries: 0 },
    );
    return result.data;
  }
  invalidateTokens(): void {
    this.client.invalidateTokens();
  }
  close(): void {
    this.client.close();
  }
}
