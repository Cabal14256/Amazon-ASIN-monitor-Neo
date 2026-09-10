import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

/** Actual frozen Worker -> import service -> parser/group model/batch service,
 * against a private MySQL schema. Only queues, cache, WS and logging are stubbed. */
export async function legacyImportFixture() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true'
  )
    throw new Error(
      'Disposable integration databases must be explicitly enabled',
    );
  const schema = `asin_import_ci_${randomUUID().replace(/-/g, '')}`;
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
        if (!/^asin_import_ci_[0-9a-f]{32}$/.test(schema))
          throw new Error('Unsafe fixture schema');
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
    for (const table of ['variant_groups', 'asins']) {
      const statement = ddl.match(
        new RegExp(
          'CREATE TABLE IF NOT EXISTS `' +
            table +
            '`[\\s\\S]*?ENGINE=InnoDB[^;]*;',
        ),
      )?.[0];
      if (!statement) throw new Error('Legacy table DDL is missing');
      await connection.query(statement);
    }
    const query = async (sql: string, params: unknown[] = []) =>
      (await connection.query(sql, params))[0];
    const database = {
      query,
      withTransaction: async (
        operation: (port: { query: typeof query }) => Promise<unknown>,
      ) => {
        await connection.beginTransaction();
        try {
          const result = await operation({ query });
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      },
    };
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    function load(path: string, dependencies: Record<string, unknown>) {
      const filename = resolve(__dirname, '../../../../server/src', path);
      const requireActual = createRequire(filename);
      const module = { exports: {} as any };
      vm.runInNewContext(
        readFileSync(filename, 'utf8'),
        {
          module,
          exports: module.exports,
          __dirname: dirname(filename),
          Buffer,
          process: { env: { IMPORT_PARSE_WORKER_ENABLED: 'false' } },
          require: (id: string) => {
            if (Object.hasOwn(dependencies, id)) return dependencies[id];
            if (
              [
                'path',
                'fs',
                'worker_threads',
                'uuid',
                '../utils/variantStatus',
                './importParserService',
              ].includes(id)
            )
              return requireActual(id);
            throw new Error(`Unexpected Legacy import dependency: ${id}`);
          },
        },
        { filename },
      );
      return module.exports;
    }
    const group = load('models/VariantGroup.js', {
      '../config/database': database,
      '../services/cacheService': {
        deleteByPrefix() {},
        async deleteByPrefixAsync() {},
      },
      '../utils/logger': log,
      './MonitorHistory': {},
    });
    const batch = load('services/asinBatchCreateService.js', {
      '../config/database': database,
      '../config/competitor-database': database,
      '../models/VariantGroup': group,
      '../models/CompetitorVariantGroup': group,
      '../utils/logger': log,
    });
    const cancellation = {
      async throwIfTaskCancelled() {},
      isTaskCancelledError: () => false,
    };
    const service = load('services/importService.js', {
      '../models/VariantGroup': group,
      '../models/CompetitorVariantGroup': group,
      '../utils/logger': log,
      './taskCancellationService': cancellation,
      './asinBatchCreateService': batch,
    });
    const normalizer = load('services/taskResultService.js', {
      '../config/database': database,
    });
    const processor = load('services/importTaskProcessor.js', {
      '../utils/logger': log,
      './importService': service,
      './taskCancellationService': cancellation,
      './taskResultService': normalizer,
      './websocketService': {
        sendTaskProgress() {},
        sendTaskComplete() {},
        sendTaskCancelled() {},
        sendTaskError() {},
      },
      './taskRegistryService': {
        async markTaskProcessing() {},
        async updateTaskProgress() {},
        async markTaskCompleted() {},
        async markTaskCancelled() {},
        async markTaskFailed() {},
      },
    });
    return {
      query,
      close,
      run: async (buffer: Buffer, originalFilename: string) =>
        JSON.parse(
          JSON.stringify(
            await processor.processImportTask({
              data: {
                taskId: randomUUID(),
                taskSubType: 'asin',
                userId: 'legacy-import-fixture',
                fileBuffer: buffer,
                originalFilename,
              },
              progress() {},
            }),
          ),
        ),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
