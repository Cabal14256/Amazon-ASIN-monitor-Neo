import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/** Actual Legacy controller/model and DDL on a private MySQL database.
 * Cache misses are forced so comparisons always execute the real count SQL. */
export async function legacyMonitorHistoryFixture() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true'
  )
    throw new Error(
      'Disposable integration databases must be explicitly enabled',
    );
  const schema = `monitor_history_ci_${randomUUID().replace(/-/g, '')}`;
  const connection = await mysql.createConnection({
    host: process.env.INTEGRATION_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.INTEGRATION_MYSQL_PORT ?? 3306),
    user: process.env.INTEGRATION_MYSQL_USER ?? 'root',
    password: process.env.INTEGRATION_MYSQL_PASSWORD ?? '',
    connectTimeout: 2000,
    charset: 'utf8mb4',
    timezone: '+08:00', // server/src/config/database.js
  });
  let created = false;
  const close = async () => {
    try {
      if (created) {
        if (!/^monitor_history_ci_[0-9a-f]{32}$/.test(schema))
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
    const ddl = readFileSync(
      resolve(__dirname, '../../../../server/database/init.sql'),
      'utf8',
    );
    for (const table of ['variant_groups', 'asins', 'monitor_history']) {
      const statement = ddl.match(
        new RegExp(
          'CREATE TABLE IF NOT EXISTS `' +
            table +
            '`[\\s\\S]*?ENGINE=InnoDB[^;]*;',
        ),
      )?.[0];
      if (!statement) throw new Error('Legacy table DDL is missing');
      // Pin the source comparison contract used by migration 0001. An explicit
      // table charset can otherwise pick MySQL8's server default (0900_ai_ci).
      // This fixture is not evidence of an uninspected production collation.
      await connection.query(
        statement.replace(
          'DEFAULT CHARSET=utf8mb4',
          'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ),
      );
    }
    const query = async (sql: string, params: unknown[] = []) =>
      (await connection.query(sql, params))[0];
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    function load(path: string, dependencies: Record<string, unknown>) {
      const filename = resolve(__dirname, '../../../../server/src', path);
      const module = { exports: {} };
      vm.runInNewContext(
        readFileSync(filename, 'utf8'),
        {
          module,
          exports: module.exports,
          require: (name: string) => {
            if (Object.hasOwn(dependencies, name)) return dependencies[name];
            throw new Error('Unexpected Legacy history fixture dependency');
          },
        },
        { filename },
      );
      return module.exports;
    }
    const model = load('models/MonitorHistory.js', {
      '../config/database': { query },
      '../services/cacheService': {
        async getAsync() {
          return null;
        },
        async setAsync() {},
      },
      '../services/analyticsCacheService': {},
      '../services/analyticsAggService': {},
      '../utils/logger': log,
    });
    type Handler = (req: unknown, res: unknown) => Promise<void>;
    const controller = load('controllers/monitorController.js', {
      '../models/MonitorHistory': model,
      '../utils/logger': log,
      '../utils/analyticsBenchmark': {},
      '../services/analyticsViewService': {},
    }) as { getMonitorHistory: Handler; getMonitorHistoryById: Handler };
    const invoke = async (handler: Handler, request: unknown) => {
      let body: unknown,
        statusCode = 200;
      const response = {
        status(code: number) {
          statusCode = code;
          return response;
        },
        json(value: unknown) {
          body = value;
          return response;
        },
      };
      await handler(request, response);
      return { statusCode, body: JSON.parse(JSON.stringify(body)) };
    };
    return {
      query,
      close,
      list: (raw: Record<string, string>) =>
        invoke(controller.getMonitorHistory, { query: raw }),
      detail: (id: number) =>
        invoke(controller.getMonitorHistoryById, {
          params: { id: String(id) },
        }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
