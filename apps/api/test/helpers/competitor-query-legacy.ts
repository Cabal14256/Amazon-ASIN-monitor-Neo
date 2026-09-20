import mysql, { type RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/** Actual Legacy controller/model/DDL, pinned to the frozen source collation. */
export async function legacyCompetitorQueryFixture() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true'
  )
    throw new Error(
      'Disposable integration databases must be explicitly enabled',
    );
  const name = `competitor_query_ci_${randomUUID().replace(/-/g, '')}`;
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
        if (!/^competitor_query_ci_[0-9a-f]{32}$/.test(name))
          throw new Error('Unsafe Legacy fixture database');
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
    await connection.query("SET SESSION time_zone='+08:00'");
    const ddl = readFileSync(
      resolve(__dirname, '../../../../server/database/competitor-init.sql'),
      'utf8',
    );
    for (const table of ['competitor_variant_groups', 'competitor_asins']) {
      const statement = ddl.match(
        new RegExp(
          'CREATE TABLE IF NOT EXISTS `' +
            table +
            '`[\\s\\S]*?ENGINE=InnoDB[^;]*;',
        ),
      )?.[0];
      if (!statement) throw new Error('Legacy competitor DDL is missing');
      await connection.query(
        statement.replace(
          'DEFAULT CHARSET=utf8mb4',
          'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ),
      );
    }
    const query = async (statement: string, values: unknown[] = []) =>
      (await connection.query<RowDataPacket[]>(statement, values))[0] as Record<
        string,
        unknown
      >[];
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    function load(path: string, dependencies: Record<string, unknown>) {
      const filename = resolve(__dirname, '../../../../server/src', path);
      const module = { exports: {} };
      vm.runInNewContext(
        readFileSync(filename, 'utf8'),
        {
          module,
          exports: module.exports,
          process: { env: { NODE_ENV: 'test' } },
          require: (name: string) => {
            if (!Object.hasOwn(dependencies, name))
              throw new Error('Unexpected Legacy competitor dependency');
            return dependencies[name];
          },
        },
        { filename },
      );
      return module.exports;
    }
    const model = load('models/CompetitorVariantGroup.js', {
      '../config/competitor-database': { query },
      uuid: { v4: () => 'unused-fixture' },
      '../services/cacheService': {
        getAsync: async () => null,
        setAsync: async () => {},
      },
      '../utils/logger': logger,
    });
    const shared = load('services/sharedService.js', {
      '../utils/logger': logger,
    });
    type Handler = (request: unknown, response: unknown) => Promise<void>;
    const controller = load('controllers/competitorAsinController.js', {
      '../models/CompetitorVariantGroup': model,
      '../models/CompetitorASIN': {},
      '../utils/logger': logger,
      '../services/importService': {},
      '../services/taskRegistryService': {},
      '../services/batchDeleteTaskQueue': {},
      '../services/batchDeleteService': {},
      '../services/asinBatchCreateService': {},
      '../services/sharedService': shared,
    }) as {
      getCompetitorVariantGroups: Handler;
      getCompetitorVariantGroupById: Handler;
    };
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
      list: (query: Record<string, string>) =>
        invoke(controller.getCompetitorVariantGroups, { query }),
      detail: (groupId: string) =>
        invoke(controller.getCompetitorVariantGroupById, {
          params: { groupId },
        }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
