import mysql, { type RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

/** Actual frozen competitor check service/models/history and original MySQL DDL.
 * Only upstream observations, cache/config and logging boundaries are replaced;
 * no SQL result or mutation is fabricated. This demonstrates a safety difference,
 * not equality with Legacy's dangerous CI-key selection. */
export async function legacyLiteralCheckFixture() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true'
  )
    throw new Error(
      'Disposable integration databases must be explicitly enabled',
    );
  const name = `literal_check_ci_${randomUUID().replaceAll('-', '')}`;
  const connection = await mysql.createConnection({
    host: process.env.INTEGRATION_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.INTEGRATION_MYSQL_PORT ?? 3306),
    user: process.env.INTEGRATION_MYSQL_USER ?? 'root',
    password: process.env.INTEGRATION_MYSQL_PASSWORD ?? '',
    charset: 'utf8mb4',
    connectTimeout: 2000,
  });
  let created = false;
  const close = async () => {
    try {
      if (created) {
        if (!/^literal_check_ci_[a-f0-9]{32}$/.test(name))
          throw new Error('Unsafe check fixture database');
        await connection.query(`DROP DATABASE \`${name}\``);
      }
    } finally {
      await connection.end();
    }
  };
  try {
    await connection.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    created = true;
    await connection.query(`USE \`${name}\``);
    const ddl = readFileSync(
      resolve(__dirname, '../../../../server/database/competitor-init.sql'),
      'utf8',
    );
    for (const table of [
      'competitor_variant_groups',
      'competitor_asins',
      'competitor_monitor_history',
    ]) {
      const sql = ddl.match(
        new RegExp(
          'CREATE TABLE IF NOT EXISTS `' +
            table +
            '`[\\s\\S]*?ENGINE=InnoDB[^;]*;',
        ),
      )?.[0];
      if (!sql) throw new Error('Original Legacy competitor DDL missing');
      // Pin the source comparison contract, as the existing Legacy comparators
      // do. An explicit table charset otherwise uses MySQL's charset default
      // collation, even though this private database selected unicode_ci.
      // This fixture does not establish an uninspected production collation.
      await connection.query(
        sql.replace(
          'DEFAULT CHARSET=utf8mb4',
          'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ),
      );
    }
    const query = async (statement: string, values: unknown[] = []) =>
      (await connection.query<RowDataPacket[]>(statement, values))[0];
    const database = {
      query,
      withTransaction: async <T>(
        action: (unit: { query: typeof query }) => Promise<T>,
      ) => {
        await connection.beginTransaction();
        try {
          const value = await action({ query });
          await connection.commit();
          return value;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      },
    };
    const cache = {
      getAsync: async () => null,
      setAsync: async () => undefined,
      deleteByPrefix() {},
      deleteByPrefixAsync: async () => undefined,
    };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const load = (relative: string, dependencies: Record<string, unknown>) => {
      const filename = resolve(
        __dirname,
        `../../../../server/src/${relative}.js`,
      );
      const module = { exports: {} as unknown };
      runInNewContext(
        readFileSync(filename, 'utf8'),
        {
          module,
          exports: module.exports,
          process: { env: {} },
          Date,
          require: (key: string) => {
            if (!Object.hasOwn(dependencies, key))
              throw new Error('Unexpected Legacy check dependency');
            return dependencies[key];
          },
        },
        { filename },
      );
      return module.exports;
    };
    const common = {
      '../config/competitor-database': database,
      uuid: { v4: randomUUID },
      '../services/cacheService': cache,
      '../utils/logger': logger,
    };
    const group = load('models/CompetitorVariantGroup', common);
    const asin = load('models/CompetitorASIN', {
      ...common,
      './CompetitorVariantGroup': group,
    });
    const history = load('models/CompetitorMonitorHistory', common);
    const service = load('services/competitorVariantCheckService', {
      '../config/sp-api': {},
      './legacySPAPIClient': {},
      '../models/CompetitorVariantGroup': group,
      '../models/CompetitorASIN': asin,
      '../models/CompetitorMonitorHistory': history,
      './cacheService': cache,
      './htmlScraperService': {},
      '../models/SPAPIConfig': { findByKey: async () => null },
      '../utils/logger': logger,
      './variantCheckService': {
        checkASINVariants: async () => ({
          hasVariants: true,
          variantCount: 1,
          details: { parentAsin: 'B999999999' },
        }),
      },
    }) as {
      checkCompetitorVariantGroup(
        id: string,
        forceRefresh: boolean,
      ): Promise<unknown>;
      checkSingleCompetitorASIN(
        id: string,
        forceRefresh: boolean,
      ): Promise<unknown>;
    };
    return {
      query,
      close,
      reset: async () => {
        await query('DELETE FROM competitor_monitor_history');
        await query('DELETE FROM competitor_asins');
        await query('DELETE FROM competitor_variant_groups');
      },
      check: (kind: 'group' | 'asin', id: string) =>
        kind === 'group'
          ? service.checkCompetitorVariantGroup(id, true)
          : service.checkSingleCompetitorASIN(id, true),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
