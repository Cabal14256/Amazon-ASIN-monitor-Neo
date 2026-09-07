import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/** Execute the frozen service itself; stub only database/cache/logger boundaries. */
export async function legacyAsinBatch(
  items: unknown[],
  options: {
    groups?: { id: string; country: string }[];
    existing?: { asin: string; country: string }[];
    failAsin?: string;
  } = {},
) {
  const filename = resolve(
    __dirname,
    '../../../../server/src/services/asinBatchCreateService.js',
  );
  const inserts: unknown[][] = [],
    touched: string[] = [];
  let counter = 0;
  const query = async (sql: string, params: any[] = []) => {
    if (sql.includes('SELECT id, country FROM'))
      return options.groups ?? [{ id: 'g', country: 'US' }];
    if (sql.includes('SELECT asin, country FROM'))
      return options.existing ?? [];
    if (sql.includes('INSERT INTO asins')) {
      const chunk = Array.from({ length: params.length / 10 }, (_, index) =>
        params.slice(index * 10, (index + 1) * 10),
      );
      if (chunk.some((row) => row[1] === options.failAsin))
        throw new Error('创建失败');
      inserts.push(...chunk);
      return [];
    }
    if (sql.includes('UPDATE variant_groups')) {
      touched.push(...params);
      return [];
    }
    throw new Error('Unexpected Legacy batch fixture query');
  };
  const database = {
    withTransaction: async (
      operation: (connection: { query: typeof query }) => Promise<unknown>,
    ) => operation({ query }),
  };
  const module = {
    exports: {} as {
      batchCreateASINs(options: {
        items: unknown[];
      }): Promise<BatchCreateAsinsData>;
    },
  };
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      process: { env: {} },
      require: (name: string) => {
        if (name === 'uuid') return { v4: () => `new-${counter++}` };
        if (
          name === '../config/database' ||
          name === '../config/competitor-database'
        )
          return database;
        if (
          name === '../models/VariantGroup' ||
          name === '../models/CompetitorVariantGroup'
        )
          return { clearCache() {} };
        if (name === '../utils/logger') return { info() {}, warn() {} };
        throw new Error('Unexpected Legacy batch fixture dependency');
      },
    },
    { filename },
  );
  return {
    result: JSON.parse(
      JSON.stringify(await module.exports.batchCreateASINs({ items })),
    ) as BatchCreateAsinsData,
    inserts,
    touched,
  };
}
