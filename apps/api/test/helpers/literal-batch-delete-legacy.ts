import type { BatchDeleteCounts, BatchDeleteIds } from '@asin-monitor/db';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

/** Actual frozen deletion service and DDL on an explicitly disposable MySQL DB.
 * SQL execution/transactions are real; only cache and logger boundaries are stubbed. */
export async function legacyLiteralBatchDeleteFixture() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true'
  )
    throw new Error(
      'Disposable integration databases must be explicitly enabled',
    );
  const name = `literal_delete_ci_${randomUUID().replace(/-/g, '')}`;
  const connection = await mysql.createConnection({
    host: process.env.INTEGRATION_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.INTEGRATION_MYSQL_PORT ?? 3306),
    user: process.env.INTEGRATION_MYSQL_USER ?? 'root',
    password: process.env.INTEGRATION_MYSQL_PASSWORD ?? '',
    connectTimeout: 2000,
    charset: 'utf8mb4',
  });
  let created = false;
  const close = async () => {
    try {
      if (created) {
        if (!/^literal_delete_ci_[0-9a-f]{32}$/.test(name))
          throw new Error('Unsafe literal deletion fixture database');
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
      resolve(__dirname, '../../../../server/database/init.sql'),
      'utf8',
    );
    for (const table of ['variant_groups', 'asins']) {
      const statement = ddl.match(
        new RegExp(
          'CREATE TABLE IF NOT EXISTS `' +
            table +
            '`[\\s\\S]*?ENGINE=InnoDB[^;]*;',
        ),
      )?.[0];
      if (!statement) throw new Error('Legacy deletion table DDL is missing');
      await connection.query(
        statement.replace(
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
          const result = await action({ query });
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      },
    };
    const forbidden = () => {
      throw new Error('Primary deletion fixture touched competitor data');
    };
    const dependencies: Record<string, unknown> = {
      uuid: { v4: randomUUID },
      '../config/database': database,
      '../config/competitor-database': {
        query: forbidden,
        withTransaction: forbidden,
      },
      '../models/VariantGroup': { clearCache() {} },
      '../models/CompetitorVariantGroup': { clearCache: forbidden },
      '../utils/logger': { info() {}, warn() {}, error() {} },
    };
    const filename = resolve(
      __dirname,
      '../../../../server/src/services/batchDeleteService.js',
    );
    const module = {
      exports: {} as {
        executeBatchDelete(
          input: BatchDeleteIds & { domain: 'asin' },
        ): Promise<BatchDeleteCounts>;
      },
    };
    runInNewContext(
      readFileSync(filename, 'utf8'),
      {
        module,
        exports: module.exports,
        process: { env: {} },
        require: (name: string) => {
          if (!Object.hasOwn(dependencies, name))
            throw new Error('Unexpected Legacy deletion dependency');
          return dependencies[name];
        },
      },
      { filename },
    );
    return {
      query,
      close,
      execute: (ids: BatchDeleteIds) =>
        module.exports.executeBatchDelete({ ...ids, domain: 'asin' }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
