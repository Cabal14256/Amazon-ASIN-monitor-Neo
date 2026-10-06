import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import mysql, { type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/** Actual current Legacy batch service, original DDL and pooled transactions.
 * Logging/cache are isolated; every SQL statement uses real MySQL. */
export async function legacyAsinBatchDatabase() {
  const host = process.env.INTEGRATION_MYSQL_HOST ?? '127.0.0.1';
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
    !['127.0.0.1', 'localhost', '::1'].includes(host)
  )
    throw new Error('Explicit disposable loopback MySQL services are required');
  const name = `asin_batch_ci_${randomUUID().replace(/-/g, '')}`;
  const connectionOptions = {
    host,
    port: Number(process.env.INTEGRATION_MYSQL_PORT ?? 3306),
    user: process.env.INTEGRATION_MYSQL_USER ?? 'root',
    password: process.env.INTEGRATION_MYSQL_PASSWORD ?? '',
    connectTimeout: 2000,
    charset: 'utf8mb4',
    timezone: '+08:00',
  };
  const control = await mysql.createConnection(connectionOptions);
  const pool = mysql.createPool({
    ...connectionOptions,
    database: name,
    connectionLimit: 4,
  });
  let created = false;
  let beforeInsert: (() => Promise<void>) | undefined;
  const close = async () => {
    await pool.end();
    try {
      if (created) {
        if (!/^asin_batch_ci_[0-9a-f]{32}$/.test(name))
          throw new Error('Unsafe owned fixture database');
        await control.query(`DROP DATABASE \`${name}\``);
      }
    } finally {
      await control.end();
    }
  };
  try {
    await control.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    created = true;
    await control.query(`USE \`${name}\``);
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
      if (!statement)
        throw new Error('Actual Legacy batch table DDL is missing');
      await control.query(
        statement.replace(
          'DEFAULT CHARSET=utf8mb4',
          'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ),
      );
    }
    const queryOn = async (
      connection: PoolConnection,
      sql: string,
      values: unknown[] = [],
    ) => {
      if (sql.startsWith('INSERT INTO asins') && beforeInsert) {
        const pause = beforeInsert;
        beforeInsert = undefined;
        await pause();
      }
      return (await connection.query({ sql, values, timeout: 5000 }))[0];
    };
    const database = {
      withTransaction: async (
        action: (unit: {
          query: (sql: string, values?: unknown[]) => Promise<unknown>;
        }) => Promise<unknown>,
      ) => {
        const connection = await pool.getConnection();
        try {
          await connection.query(
            'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
          );
          await connection.beginTransaction();
          // Establish an old MVCC snapshot before the parent wait. The service's
          // child count must use a locking current read after obtaining its lock.
          await connection.query('SELECT COUNT(*) FROM asins');
          const result = await action({
            query: (sql, values) => queryOn(connection, sql, values),
          });
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      },
    };
    const filename = resolve(
      __dirname,
      '../../../../server/src/services/asinBatchCreateService.js',
    );
    const module = {
      exports: {} as {
        batchCreateASINs(input: {
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
        require: (dependency: string) => {
          if (dependency === 'uuid') return { v4: randomUUID };
          if (
            dependency === '../config/database' ||
            dependency === '../config/competitor-database'
          )
            return database;
          if (
            dependency === '../models/VariantGroup' ||
            dependency === '../models/CompetitorVariantGroup'
          )
            return { clearCache() {} };
          if (dependency === '../utils/logger') return { info() {}, warn() {} };
          throw new Error('Unexpected actual Legacy batch fixture dependency');
        },
      },
      { filename },
    );
    return {
      close,
      query: async (sql: string, values: unknown[] = []) =>
        (
          await control.query<RowDataPacket[]>({ sql, values, timeout: 5000 })
        )[0],
      batch: (items: unknown[]) => module.exports.batchCreateASINs({ items }),
      pauseFirstInsert() {
        let release!: () => void, reached!: () => void;
        const waiting = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          reached = resolve;
        });
        beforeInsert = async () => {
          reached();
          await waiting;
        };
        return { ready, release };
      },
      async parentIsBlocked() {
        const rows = (
          await control.query<RowDataPacket[]>(
            "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w INNER JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='variant_groups'",
            [name],
          )
        )[0];
        return Number(rows[0].n) > 0;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
