import { createHash } from 'node:crypto';
import { snapshotConfig } from './config';
import {
  abortError,
  amazonCodes,
  parseJson,
  SpApiError,
  waitFor,
} from './errors';
import type {
  ConfigSource,
  Logger,
  Region,
  SpApiConfig,
  Transport,
} from './types';

interface Token {
  token: string;
  config: SpApiConfig;
  expiresAt: number;
  key: string;
}
interface Flight {
  key: string;
  controller: AbortController;
  promise: Promise<Token>;
}
function keyFor(config: SpApiConfig, region: Region) {
  return createHash('sha256')
    .update(JSON.stringify([config.useAwsSignature, config.regions[region]]))
    .digest('hex');
}
export class LwaTokenService {
  private readonly cache = new Map<Region, Token>();
  private readonly flights = new Map<Region, Flight>();
  private closed = false;
  constructor(
    private readonly source: ConfigSource,
    private readonly transport: Transport,
    private readonly logger: Logger,
    private readonly now = Date.now,
  ) {}
  async get(
    region: Region,
    signal: AbortSignal,
  ): Promise<{ token: string; config: SpApiConfig }> {
    for (;;) {
      if (this.closed) throw new SpApiError('CLOSED');
      if (signal.aborted) throw abortError(signal);
      const config = snapshotConfig(await this.source.get(signal));
      if (this.closed) throw new SpApiError('CLOSED');
      if (signal.aborted) throw abortError(signal);
      const key = keyFor(config, region);
      const cached = this.cache.get(region);
      if (cached?.key === key && this.now() < cached.expiresAt)
        return { token: cached.token, config };
      const flight = this.flights.get(region);
      if (flight) {
        try {
          const result = await waitFor(flight.promise, signal);
          if (flight.key === key) return result;
        } catch (error) {
          if (signal.aborted || flight.key === key) throw error;
          // Failure of old credentials must not poison a queued config rotation.
        }
        continue; // Config rotated while the old, bounded request was in flight.
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new SpApiError('TIMEOUT')),
        10000,
      );
      const current = {} as Flight;
      current.key = key;
      current.controller = controller;
      current.promise = this.fetch(region, config, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted && !this.closed)
            this.cache.set(region, result);
          return result;
        })
        .finally(() => {
          clearTimeout(timer);
          if (this.flights.get(region) === current) this.flights.delete(region);
        });
      this.flights.set(region, current);
      // One caller cancelling does not cancel a refresh shared by other callers.
      return waitFor(current.promise, signal);
    }
  }
  private async fetch(
    region: Region,
    initial: SpApiConfig,
    signal: AbortSignal,
  ): Promise<Token> {
    let config = initial;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw abortError(signal);
      const credentials = config.regions[region];
      if (
        ![
          credentials.lwaClientId,
          credentials.lwaClientSecret,
          credentials.refreshToken,
        ].every((value) => value && !/^your_|^example|placeholder/i.test(value))
      )
        throw new SpApiError('INVALID_CONFIG');
      const response = await this.transport.request({
        url: new URL('https://api.amazon.com/auth/o2/token'),
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: credentials.lwaClientId,
          client_secret: credentials.lwaClientSecret,
          refresh_token: credentials.refreshToken,
        }).toString(),
      });
      if (signal.aborted) throw abortError(signal);
      const codes = amazonCodes(response.body);
      if (response.statusCode !== 200) {
        if (
          attempt === 0 &&
          (response.statusCode === 401 ||
            (response.statusCode === 400 &&
              codes.some((code) =>
                ['invalid_client', 'invalid_grant'].includes(code),
              )))
        ) {
          this.logger.warn('LWA 凭据失败，重载配置后重试一次', {
            region,
            statusCode: response.statusCode,
          });
          config = snapshotConfig(await this.source.reload(signal));
          continue;
        }
        throw new SpApiError('HTTP_ERROR', response.statusCode, codes);
      }
      const payload = parseJson(response.body) as
        | { access_token?: unknown; expires_in?: unknown; token_type?: unknown }
        | undefined;
      const token = payload?.access_token;
      const expiresIn =
        payload?.expires_in === undefined ? 3600 : Number(payload.expires_in);
      if (
        typeof token !== 'string' ||
        !/^[\x21-\x7e]{1,2048}$/.test(token) ||
        !Number.isSafeInteger(expiresIn) ||
        expiresIn < 1 ||
        expiresIn > 86400 ||
        (payload?.token_type !== undefined && payload.token_type !== 'bearer')
      )
        throw new SpApiError('INVALID_RESPONSE');
      this.logger.info('LWA 令牌刷新完成', { region });
      return {
        token,
        config,
        expiresAt: this.now() + Math.max(0, expiresIn - 60) * 1000,
        key: keyFor(config, region),
      };
    }
    throw new SpApiError('HTTP_ERROR');
  }
  invalidate(): void {
    this.cache.clear();
    for (const flight of this.flights.values())
      flight.controller.abort(new SpApiError('CANCELLED'));
  }
  close(): void {
    this.closed = true;
    this.invalidate();
  }
}
