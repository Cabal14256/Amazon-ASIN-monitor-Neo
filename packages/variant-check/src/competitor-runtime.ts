import type { CompetitorCheckRepositoryPort } from '@asin-monitor/db';
import {
  CatalogVariantChecker,
  RedisCatalogCheckStore,
  type Logger,
  type QuotaRedisPort,
  type SpApiRuntime,
} from '@asin-monitor/sp-api';
import { CompetitorCheckPipeline } from './competitor-pipeline';
import type { CheckExecutionContext } from './executor';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
  variantCheckResultReference,
} from './task';
import { VariantCheckError } from './types';

export interface CompetitorCheckRuntimeOptions {
  repository: CompetitorCheckRepositoryPort;
  spApi: Pick<
    SpApiRuntime,
    'standard' | 'legacy' | 'html' | 'risk' | 'isFallbackEnabled'
  >;
  redis: Pick<QuotaRedisPort, 'status' | 'eval'>;
  prefix: string;
  logger: Logger;
}
/** Dedicated competitor identity, with the same shared Catalog and quota
 * primitives used by primary checks. */
export class CompetitorCheckRuntime {
  readonly pipeline: CompetitorCheckPipeline;
  readonly executor: {
    execute: (
      raw: unknown,
      context: CheckExecutionContext,
    ) => Promise<ReturnType<typeof variantCheckResultReference>>;
  };
  private readonly checker: CatalogVariantChecker;
  private readonly store: RedisCatalogCheckStore;
  constructor(options: CompetitorCheckRuntimeOptions) {
    this.store = new RedisCatalogCheckStore(options.redis, options.prefix);
    this.checker = new CatalogVariantChecker({
      standard: options.spApi.standard,
      legacy: options.spApi.legacy,
      html: options.spApi.html,
      isEnabled: (key, signal) => options.spApi.isFallbackEnabled(key, signal),
      risk: options.spApi.risk,
      logger: options.logger,
      store: this.store,
    });
    this.pipeline = new CompetitorCheckPipeline(
      options.repository,
      this.checker,
      this.store,
      options.logger,
    );
    this.executor = {
      execute: async (raw, context) => {
        const data = parseVariantCheckJob(raw);
        if (
          data.taskSubType !== 'competitor-asin-check' &&
          data.taskSubType !== 'competitor-variant-group-check'
        )
          throw new VariantCheckError('invalid-input');
        const operation = variantCheckJobOperation(data);
        const options = {
          forceRefresh: data.params.forceRefresh,
          signal: context.signal,
          operation,
          checkpoint: context.checkpoint,
          authorize: async () => context.checkpoint(),
          onProgress: context.onProgress,
        };
        if (data.taskSubType === 'competitor-asin-check')
          await this.pipeline.checkSingle(data.params.asinId, options);
        else await this.pipeline.checkGroup(data.params.groupId, options);
        return variantCheckResultReference(operation);
      },
    };
  }
  close() {
    this.pipeline.close();
    this.checker.close();
    this.store.close();
  }
}
