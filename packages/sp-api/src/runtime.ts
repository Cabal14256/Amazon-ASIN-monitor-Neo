import type { CatalogFallback } from './catalog-checker';
import { SpApiClient } from './client';
import { SpApiErrorStatistics } from './error-statistics';
import { abortError, SpApiError } from './errors';
import { HtmlVariantClient } from './html-client';
import { LegacySpApiClient } from './legacy-client';
import { ObservedSpApiTransport } from './observed-transport';
import { SpApiQuotaExecutor } from './quota-executor';
import { resolveQuotaSettings } from './quota-policy';
import type { QuotaRedisPort } from './quota-redis';
import { SpApiRedisReadiness } from './redis-readiness';
import { SpApiRiskController } from './risk-controller';
import type {
  ConfigSource,
  Logger,
  QuotaExecutor,
  Region,
  Transport,
} from './types';

export interface SpApiRuntimeOptions {
  env: {
    AUTH_DATA_AUTHORITY: 'postgresql' | 'legacy-mysql';
    HEALTH_PROBE_TIMEOUT_MS: number;
  };
  configEnv: Readonly<Record<string, unknown>>;
  quotaEnv: Readonly<Record<string, unknown>>;
  repository: {
    readConfiguration(
      signal: AbortSignal,
    ): Promise<readonly { configKey: string; configValue: unknown }[]>;
  };
  source: ConfigSource;
  redis: { client: QuotaRedisPort; ping(): Promise<void> };
  logger: Logger;
  transport: Transport;
  htmlTransport: Transport;
}
/** Shared API/Worker runtime; calls remain explicit. External configuration pools,
 * Redis and native transport providers own their application shutdown hooks.
 */
export class SpApiRuntime {
  readonly standard: SpApiClient;
  readonly legacy: LegacySpApiClient;
  readonly html: HtmlVariantClient;
  readonly errors: SpApiErrorStatistics;
  readonly risk: SpApiRiskController;
  private readonly quota: SpApiQuotaExecutor;
  private readonly readiness: SpApiRedisReadiness;
  private readonly lifetime = new AbortController();
  private readonly fallbackEnvironment: Readonly<Record<string, unknown>>;
  private closed = false;
  constructor(private readonly options: SpApiRuntimeOptions) {
    const { logger, source, redis, transport, htmlTransport } = options;
    this.fallbackEnvironment = Object.freeze(
      Object.fromEntries(
        ['ENABLE_HTML_SCRAPER_FALLBACK', 'ENABLE_LEGACY_CLIENT_FALLBACK'].map(
          (key) => [key, options.configEnv[key]],
        ),
      ),
    );
    this.errors = new SpApiErrorStatistics({ logger });
    this.risk = new SpApiRiskController({ logger });
    this.readiness = new SpApiRedisReadiness(
      redis,
      logger,
      Math.min(options.env.HEALTH_PROBE_TIMEOUT_MS, 500),
    );
    this.quota = new SpApiQuotaExecutor({
      logger,
      redis: redis.client,
      settings: resolveQuotaSettings(options.quotaEnv),
      redisTimeoutMs: Math.min(options.env.HEALTH_PROBE_TIMEOUT_MS, 500),
    });
    const sharedQuota: QuotaExecutor = {
      execute: async (context, task) => {
        this.ensureAvailable();
        await this.readiness.ensure(context.signal);
        return this.quota.execute(context, task);
      },
      observe: (metadata) => this.quota.observe(metadata),
    };
    const observed = new ObservedSpApiTransport(transport, this.errors);
    const dependencies = {
      config: source,
      transport: observed,
      quota: sharedQuota,
      logger,
    };
    this.standard = new SpApiClient(dependencies);
    this.legacy = new LegacySpApiClient({
      ...dependencies,
      isEnabled: (signal) =>
        this.isFallbackEnabled('ENABLE_LEGACY_CLIENT_FALLBACK', signal),
    });
    this.html = new HtmlVariantClient({
      logger,
      transport: htmlTransport,
      isEnabled: (signal) =>
        this.isFallbackEnabled('ENABLE_HTML_SCRAPER_FALLBACK', signal),
    });
  }
  private ensureAvailable(): void {
    if (this.closed) throw new SpApiError('CLOSED');
    if (this.options.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      throw new SpApiError('DEPENDENCY_ERROR');
  }
  async isFallbackEnabled(
    key: CatalogFallback,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.ensureAvailable();
    if (signal.aborted) throw abortError(signal);
    const rows = await this.options.repository.readConfiguration(signal);
    this.ensureAvailable();
    if (signal.aborted) throw abortError(signal);
    if (!Array.isArray(rows) || rows.length > 200)
      throw new SpApiError('INVALID_CONFIG');
    const matches = rows.filter(
      (row) =>
        typeof row.configKey === 'string' &&
        row.configKey.toUpperCase() === key,
    );
    if (matches.length > 1) throw new SpApiError('INVALID_CONFIG');
    const value = matches[0]?.configValue ?? this.fallbackEnvironment[key];
    return value === true || value === 'true' || value === '1';
  }
  async initialize(): Promise<void> {
    if (this.options.env.AUTH_DATA_AUTHORITY === 'postgresql')
      await this.readiness.ensure(this.lifetime.signal);
  }
  async getQuotaStatus(
    region: Region,
    operation?: string,
    signal: AbortSignal = this.lifetime.signal,
  ) {
    this.ensureAvailable();
    await this.readiness.ensure(signal);
    return this.quota.snapshot(region, operation, signal);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new SpApiError('CLOSED'));
    this.standard.close();
    this.legacy.close();
    this.html.close();
    this.quota.close();
    this.readiness.close();
  }
}
