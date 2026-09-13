import mysql, { type RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

type Rows = Record<string, unknown>[];
type LegacyModel = Record<string, (params: object) => Promise<Rows>>;
export async function legacyAnalyticsFixture() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true'
  )
    throw new Error(
      'Disposable integration databases must be explicitly enabled',
    );
  const schema = `monitor_analytics_ci_${randomUUID().replace(/-/g, '')}`;
  const connection = await mysql.createConnection({
    host: process.env.INTEGRATION_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.INTEGRATION_MYSQL_PORT ?? 3306),
    user: process.env.INTEGRATION_MYSQL_USER ?? 'root',
    password: process.env.INTEGRATION_MYSQL_PASSWORD ?? '',
    connectTimeout: 2000,
    charset: 'utf8mb4',
    timezone: '+08:00',
  });
  let created = false;
  const close = async () => {
    try {
      if (created) {
        if (!/^monitor_analytics_ci_[0-9a-f]{32}$/.test(schema))
          throw new Error('Unsafe fixture database');
        await connection.query(`DROP DATABASE \`${schema}\``);
      }
    } finally {
      await connection.end();
    }
  };
  try {
    await connection.query(
      `CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    created = true;
    await connection.query(`USE \`${schema}\``);
    const root = resolve(__dirname, '../../../..');
    const ddl = readFileSync(resolve(root, 'server/database/init.sql'), 'utf8');
    for (const table of [
      'variant_groups',
      'asins',
      'monitor_history',
      'monitor_history_agg',
      'monitor_history_agg_dim',
      'monitor_history_agg_variant_group',
      'monitor_history_status_interval',
      'analytics_refresh_watermark',
    ]) {
      const statement = ddl.match(
        new RegExp(
          'CREATE TABLE IF NOT EXISTS `' +
            table +
            '`[\\s\\S]*?ENGINE=InnoDB[^;]*;',
        ),
      )?.[0];
      if (!statement) throw new Error('Legacy table DDL is missing');
      await connection.query(
        statement.replace(
          'DEFAULT CHARSET=utf8mb4',
          'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ),
      );
    }
    const query = async (
      statement: string,
      params: unknown[] = [],
    ): Promise<Rows> =>
      (await connection.query<RowDataPacket[]>(statement, params))[0];
    let captured: Rows[] = [];
    const dependencies: Record<string, unknown> = {
      '../config/database': {
        getPoolStatus: () => ({}),
        query: async (statement: string, params: unknown[]) => {
          const rows = await query(statement, params);
          captured.push(rows);
          return rows;
        },
      },
      '../services/cacheService': {
        async getAsync() {
          return null;
        },
        async setAsync() {},
      },
      '../services/analyticsCacheService': {
        async get() {
          return null;
        },
        async getLatest() {
          return null;
        },
        async set() {},
        async rememberLatest() {},
      },
      '../services/analyticsAggService': { getAggStatus: () => ({}) },
      '../utils/logger': { debug() {}, info() {}, warn() {}, error() {} },
    };
    const filename = resolve(root, 'server/src/models/MonitorHistory.js');
    const module = { exports: {} };
    vm.runInNewContext(
      readFileSync(filename, 'utf8') +
        '\nmodule.exports = { model: MonitorHistory, getAggBucketHoursSqlExpr, getAggDurationCtesSql, getDurationMetricsSqlSelect };',
      {
        module,
        process: { env: { ANALYTICS_AGG_ENABLED: '0' } },
        require: (name: string) => {
          if (!Object.hasOwn(dependencies, name))
            throw new Error('Unexpected Legacy analytics fixture dependency');
          return dependencies[name];
        },
      },
      { filename },
    );
    const loaded = module.exports as {
      model: LegacyModel;
      getAggBucketHoursSqlExpr: (granularity: string, alias?: string) => string;
      getAggDurationCtesSql: (base: string) => string;
      getDurationMetricsSqlSelect: (prefix?: string) => string;
    };
    return {
      ...loaded,
      query,
      close,
      /** Only the source-selection guard is forced for arithmetic comparisons
       * on explicitly seeded aggregate tables. The actual leaf SQL and mapping
       * remain untouched; Timescale coverage is tested independently. */
      async aggregate(method: string, params: object) {
        if (
          ![
            'getAllCountriesSummaryFromAgg',
            'getStatisticsByTimeFromAgg',
            'getRegionSummaryFromAgg',
            'getASINStatisticsByCountryFromAgg',
            'getASINStatisticsByVariantGroupFromAgg',
          ].includes(method)
        )
          throw new Error('Unexpected Legacy aggregate fixture operation');
        const model = loaded.model as unknown as Record<string, unknown>;
        const normal = model.isAggTableCoveringRange,
          variant = model.isVariantGroupAggTableCoveringRange;
        model.isAggTableCoveringRange = async () => true;
        model.isVariantGroupAggTableCoveringRange = async () => true;
        try {
          return await loaded.model[method](params);
        } finally {
          model.isAggTableCoveringRange = normal;
          model.isVariantGroupAggTableCoveringRange = variant;
        }
      },
      async capture(method: string, params: object) {
        captured = [];
        await loaded.model[method](params);
        return captured;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
