import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/** Execute the frozen service itself; stub only database/cache/logger boundaries. */
export async function legacyAsinBatch(
  items: unknown[],
  options: {
    domain?: 'asin' | 'competitor';
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
    if (
      sql.includes('INSERT INTO asins') ||
      sql.includes('INSERT INTO competitor_asins')
    ) {
      const width = 10;
      const chunk = Array.from({ length: params.length / width }, (_, index) =>
        params.slice(index * width, (index + 1) * width),
      );
      if (chunk.some((row) => row[1] === options.failAsin))
        throw new Error('创建失败');
      inserts.push(...chunk);
      return [];
    }
    if (
      sql.includes('UPDATE variant_groups') ||
      sql.includes('UPDATE competitor_variant_groups')
    ) {
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
        domain?: 'asin' | 'competitor';
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
      JSON.stringify(
        await module.exports.batchCreateASINs({
          items,
          domain: options.domain,
        }),
      ),
    ) as BatchCreateAsinsData,
    inserts,
    touched,
  };
}
