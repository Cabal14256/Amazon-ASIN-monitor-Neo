import { getNeoQueuePrefix, type Env } from '@asin-monitor/config';
import {
  PgSpApiConfigurationRepository,
  type createPgPool,
} from '@asin-monitor/db';
import {
  CatalogParentQuery,
  CatalogVariantChecker,
  DatabaseConfigSource,
  NodeHttpTransport,
  RedisCatalogCheckStore,
  SpApiRuntime,
  trackWorkSettlement,
  type ParentAsinQueryOptions,
} from '@asin-monitor/sp-api';
import type { Redis } from 'ioredis';
import { logger } from './logger';

/** Lazily compose the same signed, quota-controlled catalog pipeline used by
 * variant checks. Catalog-only exports remain independent of SP-API readiness.
 * Redis namespaces and five-window quotas are shared with all API/Workers. */
export function createParentAsinExportQuery(
  env: Env,
  pool: ReturnType<typeof createPgPool>,
  control: Redis,
  environment: Readonly<Record<string, unknown>> = process.env,
) {
  let closed = false;
  const create = () => {
    const repository = new PgSpApiConfigurationRepository(pool);
    const source = new DatabaseConfigSource(environment, async (signal) =>
      Object.fromEntries(
        (
          await repository.readConfiguration(signal, (work) =>
            trackWorkSettlement(signal, work),
          )
        ).map((row) => [row.configKey.toUpperCase(), row.configValue]),
      ),
    );
    const transport = new NodeHttpTransport({
      timeoutMs: 30_000,
      maxResponseBytes: 8 * 1024 * 1024,
      maxInFlight: 64,
    });
    const htmlTransport = new NodeHttpTransport({
      timeoutMs: 15_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxInFlight: 2,
    });
    const spApi = new SpApiRuntime({
      env,
      source,
      repository,
      logger,
      transport,
      htmlTransport,
      configEnv: environment,
      quotaEnv: {
        ...environment,
        RATE_LIMITER_KEY_PREFIX: env.RATE_LIMITER_KEY_PREFIX,
      },
      redis: {
        client: control,
        ping: async () => {
          await control.ping();
        },
      },
    });
    const store = new RedisCatalogCheckStore(control, getNeoQueuePrefix(env));
    const checker = new CatalogVariantChecker({
      standard: spApi.standard,
      legacy: spApi.legacy,
      html: spApi.html,
      isEnabled: (key, signal) => spApi.isFallbackEnabled(key, signal),
      risk: spApi.risk,
      logger,
      store,
    });
    const parents = new CatalogParentQuery(checker);
    return {
      parents,
      close() {
        parents.close();
        checker.close();
        store.close();
        spApi.close();
        source.close();
        transport.close();
        htmlTransport.close();
      },
    };
  };
  let active: ReturnType<typeof create> | undefined;
  return {
    query(
      asins: unknown[],
      country: string,
      options: ParentAsinQueryOptions = {},
    ) {
      if (closed) return Promise.reject(new Error('EXPORT_QUERY_CLOSED'));
      options.signal?.throwIfAborted();
      active ??= create();
      return active.parents.query(asins, country, options);
    },
    close() {
      closed = true;
      active?.close();
    },
  };
}
