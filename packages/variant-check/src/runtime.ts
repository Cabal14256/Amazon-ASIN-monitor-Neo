import {
  CatalogParentQuery,
  CatalogVariantChecker,
  RedisCatalogCheckStore,
  type Logger,
  type QuotaRedisPort,
  type SpApiRuntime,
} from '@asin-monitor/sp-api';
import { VariantCheckExecutor } from './executor';
import { CatalogHybridChecker } from './hybrid';
import { VariantCheckPipeline } from './pipeline';
import type { VariantCheckRepositoryPort } from './types';

export interface VariantCheckRuntimeOptions {
  spApi: Pick<
    SpApiRuntime,
    'standard' | 'legacy' | 'html' | 'risk' | 'isFallbackEnabled'
  >;
  redis: Pick<QuotaRedisPort, 'status' | 'eval'>;
  repository: VariantCheckRepositoryPort;
  logger: Logger;
  prefix: string;
  batchThreshold?: number;
  batchConcurrency?: number;
  redisTimeoutMs?: number;
}

/** One composition for HTTP and actual BullMQ processors. The application owns
 * the initialized SP-API runtime, PostgreSQL pool and non-replaying Redis client.
 */
export class VariantCheckRuntime {
  readonly pipeline: VariantCheckPipeline;
  readonly parents: CatalogParentQuery;
  readonly executor: VariantCheckExecutor;
  private readonly store: RedisCatalogCheckStore;
  private readonly checker: CatalogVariantChecker;
  private readonly hybrid: CatalogHybridChecker;
  constructor(options: VariantCheckRuntimeOptions) {
    const { spApi, logger } = options;
    this.store = new RedisCatalogCheckStore(
      options.redis,
      options.prefix,
      options.redisTimeoutMs,
    );
    this.checker = new CatalogVariantChecker({
      standard: spApi.standard,
      legacy: spApi.legacy,
      html: spApi.html,
      isEnabled: (key, signal) => spApi.isFallbackEnabled(key, signal),
      risk: spApi.risk,
      logger,
      store: this.store,
    });
    this.hybrid = new CatalogHybridChecker(
      spApi.standard,
      this.checker,
      logger,
    );
    this.pipeline = new VariantCheckPipeline(
      options.repository,
      this.checker,
      this.store,
      logger,
      { hybrid: this.hybrid, batchThreshold: options.batchThreshold },
    );
    this.parents = new CatalogParentQuery(this.checker);
    this.executor = new VariantCheckExecutor(
      options.repository,
      this.pipeline,
      this.parents,
      options.batchConcurrency,
    );
  }
  close(): void {
    this.executor.close();
    this.pipeline.close();
    this.parents.close();
    this.hybrid.close();
    this.checker.close();
    this.store.close();
  }
}
