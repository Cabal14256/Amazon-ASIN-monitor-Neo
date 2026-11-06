import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/client';
import { parseMonitorAnalyticsQuery } from '../src/domain/monitor-analytics-query';
import { monitorRawDurationSourceSelect } from '../src/repositories/monitor-analytics-sql';
import { readMonitorDurationQuery } from '../src/repositories/monitor-duration-query';

function legacyFixture() {
  const statements: string[] = [];
  const module = { exports: {} };
  vm.runInNewContext(
    readFileSync(
      resolve(__dirname, '../../../server/src/models/MonitorHistory.js'),
      'utf8',
    ),
    {
      module,
      process: { env: { ANALYTICS_AGG_ENABLED: '0' } },
      require(name: string) {
        if (name === '../config/database')
          return {
            getPoolStatus: () => ({}),
            async query(statement: string) {
              statements.push(statement);
              return [];
            },
          };
        if (name === '../services/analyticsCacheService')
          return {
            async get() {
              return null;
            },
            async getLatest() {
              return null;
            },
            async set() {},
            async rememberLatest() {},
          };
        if (name === '../services/cacheService') return {};
        if (name === '../services/analyticsAggService')
          return { getAggStatus: () => ({}) };
        if (name === '../utils/logger')
          return { debug() {}, info() {}, warn() {}, error() {} };
        throw new Error('Unexpected Legacy spelling fixture dependency');
      },
    },
  );
  return {
    model: module.exports as Record<
      string,
      (params: object) => Promise<unknown>
    >,
    statements,
  };
}

describe('explicit summary ASIN spelling contract', () => {
  it.each(['getAllCountriesSummary', 'getRegionSummary'])(
    '%s requests a binary-byte minimum without changing the CI/PAD grouping',
    async (method) => {
      const f = legacyFixture();
      await f.model[method]({
        startTime: '1997-10-01',
        endTime: '1997-10-31 23:59:59',
      });
      const statement = f.statements.find((value) =>
        value.includes('as asin_key'),
      );
      expect(statement).toContain(
        "CONVERT(MIN(CAST(COALESCE(NULLIF(mh.asin_code, ''), CONCAT('ID#', mh.asin_id)) AS BINARY)) USING utf8mb4) as asin_key",
      );
      const grouping = statement!.split('GROUP BY')[1].split('ORDER BY')[0];
      expect(grouping).toContain(
        "COALESCE(NULLIF(mh.asin_code, ''), CONCAT('ID#', mh.asin_id))",
      );
      expect(grouping).not.toContain('BINARY');
      await f.model.getDurationSourceRowsFromRaw({ sourceGranularity: 'hour' });
      expect(f.statements.at(-1)).not.toContain('MIN(CAST(');
    },
  );

  it.each(['all-countries-summary', 'region-summary'] as const)(
    'selects the binary minimum only for explicit %s raw source and retains original identity partitions',
    (operation) => {
      const query = parseMonitorAnalyticsQuery(operation, {
        startTime: '1997-10-01',
        endTime: '1997-10-31 23:59:59',
      });
      const dialect = new PgDialect();
      const stable = dialect.sqlToQuery(
        monitorRawDurationSourceSelect(
          query,
          'dim',
          'hour',
          undefined,
          'binary-min',
        ),
      ).sql;
      expect(stable).toContain(
        "min(coalesce(CASE WHEN nullif(rtrim(mh.asin_code), '') IS NOT NULL THEN mh.asin_code END, 'ID#' || mh.asin_id) COLLATE \"C\") AS asin_key",
      );
      const grouping = stable.split('GROUP BY')[1].split('ORDER BY')[0];
      expect(grouping).toContain(
        "rtrim(coalesce(nullif(rtrim(mh.asin_code), ''), 'ID#' || rtrim(mh.asin_id))) COLLATE public.legacy_utf8mb4_unicode_ci",
      );
      expect(grouping).not.toContain('COLLATE "C"');
      expect(
        dialect.sqlToQuery(monitorRawDurationSourceSelect(query, 'dim', 'hour'))
          .sql,
      ).not.toContain('min(coalesce(CASE');
    },
  );

  it.each(['all-countries-summary', 'region-summary'] as const)(
    'opts the real %s raw reader into stable representative selection',
    async (operation) => {
      const statements: string[] = [];
      const db = {
        async execute(statement: Parameters<Db['execute']>[0]) {
          statements.push(
            new PgDialect().sqlToQuery(
              statement as Parameters<PgDialect['sqlToQuery']>[0],
            ).sql,
          );
          return { rows: [] };
        },
      } as unknown as Db;
      await readMonitorDurationQuery(
        db,
        parseMonitorAnalyticsQuery(operation, {
          startTime: '1997-10-01',
          endTime: '1997-10-31 23:59:59',
        }),
        () => {},
        { aggregateEnabled: false, onAggregateFallback: () => {} },
      );
      const select = statements.find((value) => value.startsWith('DECLARE'));
      expect(select).toContain('min(coalesce(CASE');
      expect(select).toContain('COLLATE "C") AS asin_key');
    },
  );
});
