import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { vi } from 'vitest';
const nativeRequire = createRequire(__filename);
const legacyParser = nativeRequire(
  '../../../server/src/utils/variantParser.js',
);
const legacyNotFound = nativeRequire('../../../server/src/utils/spApiError.js');
export function legacyService(response: unknown) {
  const module = {
    exports: {} as {
      batchQueryParentAsin(
        asins: string[],
        country: string,
        options?: {
          concurrency?: number;
          onProgress?(value: {
            asin: string;
            completed: number;
            total: number;
          }): void;
        },
      ): Promise<unknown>;
      doCheckASINVariants(
        asin: string,
        country: string,
        force: boolean,
      ): Promise<unknown>;
    },
  };
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const setAsync = vi.fn(async () => undefined);
  const call = vi.fn(async (_method: string, path: string) =>
    typeof response === 'function'
      ? response(path.split('/').at(-1))
      : response,
  );
  const dependencies: Record<string, unknown> = {
    '../config/sp-api': {
      callSPAPI: call,
      getMarketplaceId: () => 'ATVPDKIKX0DER',
    },
    './legacySPAPIClient': { callLegacySPAPI: vi.fn() },
    '../models/VariantGroup': {},
    '../models/ASIN': {},
    '../models/MonitorHistory': {},
    './cacheService': { getAsync: async () => null, setAsync },
    './htmlScraperService': {},
    '../models/SPAPIConfig': { findByKey: async () => null },
    './riskControlService': { recordCheck: vi.fn() },
    './rateLimiter': { PRIORITY: { MANUAL: 1, RETRY: 2, SCHEDULED: 3 } },
    './spApiOperationIdentifier': { identifyOperation: () => 'getCatalogItem' },
    './batchVariantCheckService': { batchCheckASINsHybrid: vi.fn() },
    '../utils/logger': logger,
    '../utils/variantParser': legacyParser,
    '../utils/variantStatus': nativeRequire(
      '../../../server/src/utils/variantStatus.js',
    ),
    '../utils/spApiError': legacyNotFound,
  };
  runInNewContext(
    readFileSync(
      resolve(__dirname, '../../../server/src/services/variantCheckService.js'),
      'utf8',
    ),
    {
      module,
      process: { env: {} },
      Buffer,
      require: (name: string) => {
        if (!(name in dependencies))
          throw new Error('Unexpected Legacy catalog fixture dependency');
        return dependencies[name];
      },
    },
  );
  return { service: module.exports, call, setAsync };
}
