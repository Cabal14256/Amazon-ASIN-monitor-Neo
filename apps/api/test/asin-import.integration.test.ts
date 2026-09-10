import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  type Env,
} from '@asin-monitor/config';
import { importExcelResultSchema } from '@asin-monitor/contracts';
import { RedisTaskRepository } from '@asin-monitor/db';
import { ImportFileStore, ImportResultStore } from '@asin-monitor/import';
import { Queue, type Worker } from 'bullmq';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ENV } from '../src/config/config.module';
import {
  ApplicationImportResults,
  ApplicationImportStorage,
} from '../src/import/import-storage.module';
import { AppLogger } from '../src/logger/app-logger.service';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { legacyImportFixture } from './helpers/asin-import-legacy';
import { asinWriteApp } from './helpers/asin-write-app';

interface ImportRuntime {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}
const compiled = () =>
  createRequire(__filename)('../../worker/dist/asin-import-runtime.js') as {
    startAsinImportRuntime(
      env: Env,
      onFatal: () => void,
    ): Promise<ImportRuntime>;
  };
const header = [
  '变体组名称',
  '国家',
  '站点',
  '品牌',
  'ASIN',
  'ASIN类型',
  'ASIN名称',
];
async function contents(rows: string[][], extension = 'csv'): Promise<Buffer> {
  if (extension === 'csv')
    return Buffer.from(
      [header, ...rows]
        .map((row) =>
          row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(','),
        )
        .join('\r\n'),
    );
  const ExcelJS = createRequire(
    resolve(__dirname, '../../../server/package.json'),
  )('exceljs');
  const book = new ExcelJS.Workbook();
  book.addWorksheet('主营').addRows([header, ...rows]);
  book.addWorksheet('忽略第二页').addRow(['invalid']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'real Legacy MySQL Worker vs Neo HTTP/PostgreSQL/BullMQ import',
  () => {
    const prefix = `fixture-import101-${randomUUID()}`;
    let f: Awaited<ReturnType<typeof asinWriteApp>>,
      legacy: Awaited<ReturnType<typeof legacyImportFixture>>;
    let env: Env,
      redis: Redis,
      queue: Queue,
      store: RedisTaskRepository,
      runtime: ImportRuntime | undefined;
    let directory: string, files: ImportFileStore, reports: ImportResultStore;
    let headers: Record<string, string>;
    const fatal = vi.fn();
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'neo-import-integration-'));
      files = new ImportFileStore(directory);
      reports = new ImportResultStore(directory);
      f = await asinWriteApp((builder) =>
        builder
          .overrideProvider(ApplicationImportStorage)
          .useValue(files)
          .overrideProvider(ApplicationImportResults)
          .useValue(reports)
          .overrideProvider(TaskQueryRuntime)
          .useFactory({
            inject: [ENV, AppLogger],
            factory: (source: Env, logger: AppLogger) => {
              env = {
                ...source,
                BULL_PREFIX: prefix,
                IMPORT_STORAGE_DIRECTORY: directory,
              };
              return new TaskQueryRuntime(env, logger);
            },
          }),
      );
      const migration = readFileSync(
        resolve(
          __dirname,
          '../../../packages/db/migrations/0005_import_group_collation.sql',
        ),
        'utf8',
      ).replaceAll('public', f.schema);
      const connection = await f.pools.primaryPool.connect();
      try {
        await connection.query(migration);
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
      redis = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        commandTimeout: 2000,
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      redis.on('error', () => undefined);
      await redis.connect();
      queue = new Queue(getPhysicalQueueName('import'), {
        connection: redis as any,
        prefix: getNeoQueuePrefix(env),
      });
      queue.on('error', () => undefined);
      await queue.waitUntilReady();
      store = new RedisTaskRepository(redis, env);
      legacy = await legacyImportFixture();
    }, 20000);
    afterEach(async () => {
      if (runtime) {
        await runtime.close();
        runtime = undefined;
      }
      expect(fatal).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      try {
        await runtime?.close();
        if (queue) {
          expect(queue.opts.prefix).toBe(`${prefix}:neo`);
          await queue.obliterate({ force: true });
          await queue.close();
        }
        if (redis?.status === 'ready') {
          let cursor = '0',
            pages = 0;
          do {
            if (++pages > 100)
              throw new Error('Import fixture cleanup exceeded bound');
            const [next, keys] = await redis.scan(
              cursor,
              'MATCH',
              `${prefix}:*`,
              'COUNT',
              100,
            );
            cursor = next;
            if (keys.some((key) => !key.startsWith(`${prefix}:`)))
              throw new Error('Import fixture namespace escaped');
            if (keys.length) await redis.del(...keys);
          } while (cursor !== '0');
        }
      } finally {
        redis?.disconnect(false);
        await legacy?.close();
        await f?.close();
        await files?.close();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });
    beforeEach(async () => {
      fatal.mockClear();
      await queue.obliterate({ force: true });
      await f.pools.primaryPool.query('DELETE FROM asins');
      await f.pools.primaryPool.query('DELETE FROM variant_groups');
      await legacy.query('DELETE FROM asins');
      await legacy.query('DELETE FROM variant_groups');
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u101-${userId}`, 'unused-fixture-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
        [userId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      headers = {
        authorization: `Bearer ${jwt.sign(
          { userId, sessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
        origin: f.env.CORS_ORIGIN,
      };
    });
    const sample = (index: number, group = '主营组') => [
      group,
      'US',
      '店铺',
      '品牌',
      `B${String(index).padStart(9, '0')}`,
      '1',
      '产品',
    ];
    function request(buffer: Buffer, extension = 'csv', synchronous = false) {
      const boundary = `import-${randomUUID()}`;
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.${extension}"\r\nContent-Type: ${
            extension === 'csv'
              ? 'text/csv'
              : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }\r\n\r\n`,
        ),
        buffer,
        Buffer.from(
          `\r\n${
            synchronous
              ? `--${boundary}\r\nContent-Disposition: form-data; name="useAsync"\r\n\r\nfalse\r\n`
              : ''
          }--${boundary}--\r\n`,
        ),
      ]);
      return f.http.inject({
        method: 'POST',
        url: '/api/v1/variant-groups/import-excel',
        headers: {
          ...headers,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
    }
    async function accept(buffer: Buffer, extension = 'csv') {
      const response = await request(buffer, extension);
      expect(response.statusCode).toBe(200);
      importExcelResultSchema.parse(response.json());
      return response.json().data.taskId as string;
    }
    const start = async () => {
      runtime = await compiled().startAsinImportRuntime(env, fatal);
    };
    async function terminal(taskId: string) {
      await vi.waitFor(
        async () =>
          expect((await store.read(taskId))?.status).toBe('completed'),
        { timeout: 15000, interval: 25 },
      );
      await vi.waitFor(
        async () =>
          expect(await (await queue.getJob(taskId))?.getState()).toBe(
            'completed',
          ),
        { timeout: 3000, interval: 25 },
      );
      const detail = await f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${taskId}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      return detail.json().data;
    }
    const canonical = (value: unknown) =>
      (JSON.parse(JSON.stringify(value)) as unknown[]).sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'),
      );
    async function compareRecords() {
      // Generated IDs/timestamps differ; every imported business field and parent
      // group association must agree, including groups left by duplicate ASINs.
      const groupSql =
        'SELECT name,country,site,brand FROM variant_groups ORDER BY name,country,site,brand';
      const asinSql =
        'SELECT a.asin,a.name,a.asin_type,a.country,a.site,a.brand,g.name AS group_name FROM asins a JOIN variant_groups g ON g.id=a.variant_group_id ORDER BY a.asin,a.country';
      expect(
        canonical((await f.pools.primaryPool.query(groupSql)).rows),
      ).toEqual(canonical(await legacy.query(groupSql)));
      expect(
        canonical((await f.pools.primaryPool.query(asinSql)).rows),
      ).toEqual(canonical(await legacy.query(asinSql)));
    }
    it.each(['csv', 'xlsx'])(
      'matches complete Legacy Worker results and records for the same %s bytes across chunks',
      async (extension) => {
        const buffer = await contents(
          [
            ...Array.from({ length: 1001 }, (_, i) => sample(i)),
            sample(0),
            sample(2, '另一组'),
            ['缺少ASIN', 'US', '店铺', '品牌', '', '1', ''],
            ['国家错误', 'CA', '店铺', '品牌', 'B000009999', '2', ''],
          ],
          extension,
        );
        const expected = await legacy.run(buffer, `fixture.${extension}`);
        const id = await accept(buffer, extension);
        await start();
        const task = await terminal(id);
        const download = await f.http.inject({
          method: 'GET',
          url: task.downloadUrl,
          headers,
        });
        expect(download.statusCode).toBe(200);
        expect(download.json()).toEqual(expected);
        expect(task.result.successCount).toBe(1001);
        expect(task.result.failedCount).toBe(4);
        await compareRecords();
      },
      25000,
    );
    it('matches Legacy Unicode case/accent group reuse and keeps the first group spelling', async () => {
      const buffer = await contents([
        ['Café', 'US', 'Shöp', 'Bränd', 'B000000001', '1', ''],
        ['CAFE', 'US', 'shop', 'brand', 'B000000002', '2', ''],
        ['Café', 'US', 'SHOP', 'BRAND', 'B000000003', '1', ''],
      ]);
      const expected = await legacy.run(buffer, 'fixture.csv');
      const response = await request(buffer, 'csv', true);
      expect(response.statusCode).toBe(200);
      expect(response.json().data.successCount).toBe(expected.successCount);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT count(*)::int AS n FROM variant_groups',
          )
        ).rows[0].n,
      ).toBe(1);
      await compareRecords();
    });
    it('serializes concurrent imports of case/accent-equivalent groups', async () => {
      const buffers = await Promise.all([
        contents([['Café', 'US', 'Shop', 'Brand', 'B000000001', '1', '']]),
        contents([['CAFE', 'US', 'shop', 'brand', 'B000000002', '1', '']]),
      ]);
      const responses = await Promise.all(
        buffers.map((buffer) => request(buffer, 'csv', true)),
      );
      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);
      expect(
        responses.map((response) => response.json().data.successCount),
      ).toEqual([1, 1]);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT count(*)::int AS n FROM variant_groups',
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it('keeps a bounded task preview while downloading every invalid row', async () => {
      const buffer = await contents(
        Array.from({ length: 1500 }, (_, i) => [
          String(i),
          'CA',
          'Shop',
          'Brand',
          'B000000001',
          '1',
          '',
        ]),
      );
      const expected = await legacy.run(buffer, 'fixture.csv');
      const id = await accept(buffer);
      await start();
      const task = await terminal(id);
      expect(task.result).toMatchObject({
        errorsTruncated: true,
        errorCount: 1500,
        failedCount: 1500,
      });
      expect(task.result.errors.length).toBeLessThanOrEqual(100);
      expect(
        (
          await f.http.inject({ method: 'GET', url: task.downloadUrl, headers })
        ).json(),
      ).toEqual(expected);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT count(*)::int AS n FROM asins',
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('classifies a rejected group safely and continues the following group', async () => {
      await f.pools.primaryPool
        .query(`CREATE FUNCTION reject_import_group_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.name='Reject' THEN RAISE EXCEPTION 'password=private-import101'; END IF; RETURN NEW; END $$`);
      await f.pools.primaryPool.query(
        'CREATE TRIGGER reject_import_group_fixture BEFORE INSERT ON variant_groups FOR EACH ROW EXECUTE FUNCTION reject_import_group_fixture()',
      );
      try {
        const response = await request(
          await contents([
            sample(1, 'Reject'),
            sample(2, 'Reject'),
            sample(3, 'Accepted'),
          ]),
          'csv',
          true,
        );
        expect(response.statusCode).toBe(200);
        expect(response.json().data).toMatchObject({
          total: 3,
          successCount: 1,
          failedCount: 2,
          processedCount: 3,
        });
        expect(response.json().data.errors).toHaveLength(1);
        expect(response.body).not.toContain('private-import101');
        expect(
          (await f.pools.primaryPool.query('SELECT asin FROM asins')).rows,
        ).toEqual([{ asin: 'B000000003' }]);
      } finally {
        await f.pools.primaryPool.query(
          'DROP TRIGGER reject_import_group_fixture ON variant_groups',
        );
        await f.pools.primaryPool.query(
          'DROP FUNCTION reject_import_group_fixture()',
        );
      }
    });
    it('requires 0005, leaves records intact on rollback and resumes after reapplying', async () => {
      const upgrade = readFileSync(
        resolve(
          __dirname,
          '../../../packages/db/migrations/0005_import_group_collation.sql',
        ),
        'utf8',
      ).replaceAll('public', f.schema);
      const rollback = readFileSync(
        resolve(
          __dirname,
          '../../../packages/db/migrations/0005_import_group_collation.rollback.sql',
        ),
        'utf8',
      ).replaceAll('public', f.schema);
      expect(
        (await request(await contents([sample(1)]), 'csv', true)).statusCode,
      ).toBe(200);
      await f.pools.primaryPool.query(rollback);
      try {
        expect(
          (await request(await contents([sample(2)]), 'csv', true)).statusCode,
        ).toBe(500);
        await expect(
          compiled().startAsinImportRuntime(env, fatal),
        ).rejects.toThrow('initialization failed');
        expect(
          (await f.pools.primaryPool.query('SELECT asin FROM asins')).rows,
        ).toEqual([{ asin: 'B000000001' }]);
      } finally {
        await f.pools.primaryPool.query(upgrade);
      }
      expect(
        (await request(await contents([sample(2)]), 'csv', true)).json().data
          .successCount,
      ).toBe(1);
    });
    it.skipIf(process.platform === 'win32')(
      'compiled main consumes import jobs and shuts down normally',
      async () => {
        const id = await accept(await contents([sample(1)]));
        const child = spawn(
          process.execPath,
          [resolve(__dirname, '../../worker/dist/main.js')],
          {
            cwd: resolve(__dirname, '../../worker'),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PROCESS_ROLE: 'worker',
              AUTH_DATA_AUTHORITY: 'postgresql',
              DATABASE_URL: env.DATABASE_URL,
              REDIS_URL: env.REDIS_URL,
              BULL_PREFIX: prefix,
              IMPORT_STORAGE_DIRECTORY: directory,
              WORKER_ENABLED_QUEUES: 'import',
              SCHEDULER_ENABLED: 'false',
              LOG_LEVEL: 'INFO',
            },
          },
        );
        let output = '',
          outcome:
            | { code: number | null; signal: NodeJS.Signals | null }
            | undefined;
        const collect = (chunk: Buffer) => {
          output = (output + chunk.toString('utf8')).slice(-32000);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('exit', (code, signal) => {
          outcome = { code, signal };
        });
        child.on('error', () => {
          output += '\nchild start failed';
        });
        try {
          await vi.waitFor(
            () => {
              expect(outcome, output).toBeUndefined();
              expect(output).toContain('Worker 已启动');
            },
            { timeout: 10000, interval: 25 },
          );
          expect(output).toContain('registeredProcessors: 1');
          expect(output).toContain("mode: 'business-worker'");
          expect((await terminal(id)).result.successCount).toBe(1);
        } finally {
          if (!outcome) child.kill('SIGTERM');
          try {
            await vi.waitFor(() => expect(outcome).toBeDefined(), {
              timeout: 12000,
              interval: 25,
            });
          } catch {
            child.kill('SIGKILL');
            throw new Error('Import Worker shutdown exceeded bound');
          }
        }
        expect(outcome).toEqual({ code: 0, signal: null });
      },
      30000,
    );
  },
);
