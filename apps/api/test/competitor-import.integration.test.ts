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
import { competitorWriteApp } from './helpers/competitor-write-app';

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
const header = ['变体组名称', '国家', '品牌', 'ASIN', 'ASIN类型', 'ASIN名称'];
async function contents(rows: string[][], extension: 'csv' | 'xlsx') {
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
  book.addWorksheet('竞品').addRows([header, ...rows]);
  book.addWorksheet('忽略第二页').addRow(['invalid']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'competitor import / Legacy MySQL, dual PostgreSQL, Redis and shared compiled Worker',
  () => {
    const prefix = `fixture-competitor-import129-${randomUUID()}`;
    let f: Awaited<ReturnType<typeof competitorWriteApp>>;
    let legacy: Awaited<ReturnType<typeof legacyImportFixture>>;
    let env: Env, redis: Redis, queue: Queue, store: RedisTaskRepository;
    let runtime: ImportRuntime | undefined, directory: string;
    let files: ImportFileStore, reports: ImportResultStore;
    let headers: Record<string, string>;
    const fatal = vi.fn();
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'neo-competitor-import-'));
      files = new ImportFileStore(directory);
      reports = new ImportResultStore(directory);
      f = await competitorWriteApp({
        primaryBusiness: true,
        configure: (builder) =>
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
      });
      const primaryImportCollation = readFileSync(
        resolve(
          __dirname,
          '../../../packages/db/migrations/0005_import_group_collation.sql',
        ),
        'utf8',
      ).replaceAll('public', f.schema);
      const connection = await f.pools.primaryPool.connect();
      try {
        await connection.query(primaryImportCollation);
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
      legacy = await legacyImportFixture('competitor');
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
    }, 20000);
    afterEach(async () => {
      await runtime?.close();
      runtime = undefined;
      expect(fatal).not.toHaveBeenCalled();
      expect(
        (
          await f.pools.primaryPool.query(
            "SELECT name FROM competitor_variant_groups WHERE id='g1'",
          )
        ).rows,
      ).toEqual([{ name: 'wrong-primary-data' }]);
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
      await f.pools.competitorPool.query('DELETE FROM competitor_asins');
      await f.pools.competitorPool.query(
        'DELETE FROM competitor_variant_groups',
      );
      await legacy.query('DELETE FROM competitor_asins');
      await legacy.query('DELETE FROM competitor_variant_groups');
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u129-${userId}`, 'unused-fixture-hash'],
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
    function request(
      buffer: Buffer,
      extension: 'csv' | 'xlsx',
      synchronous = false,
    ) {
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
        url: '/api/v1/competitor/variant-groups/import-excel',
        headers: {
          ...headers,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
    }
    async function compareRecords() {
      const groupSql =
        'SELECT name,country,brand FROM competitor_variant_groups ORDER BY name,country,brand';
      const asinSql =
        'SELECT a.asin,a.name,a.asin_type,a.country,a.brand,g.name AS group_name FROM competitor_asins a JOIN competitor_variant_groups g ON g.id=a.variant_group_id ORDER BY a.asin,a.country';
      const canonical = (rows: unknown) =>
        JSON.parse(JSON.stringify(rows)).sort((a: unknown, b: unknown) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'),
        );
      expect(
        canonical((await f.pools.competitorPool.query(groupSql)).rows),
      ).toEqual(canonical(await legacy.query(groupSql)));
      expect(
        canonical((await f.pools.competitorPool.query(asinSql)).rows),
      ).toEqual(canonical(await legacy.query(asinSql)));
    }
    const sample = (index: number, group = '竞品组') => [
      group,
      'US',
      '品牌',
      `B${String(index).padStart(9, '0')}`,
      '1',
      '产品',
    ];
    it.each(['csv', 'xlsx'] as const)(
      'matches Legacy competitor %s import and complete task result',
      async (extension) => {
        const buffer = await contents(
          [
            sample(1),
            sample(2),
            sample(1),
            sample(2, '另一组'),
            ['无ASIN', 'US', '品牌', '', '1', ''],
          ],
          extension,
        );
        const expected = await legacy.run(buffer, `fixture.${extension}`);
        const legacyAccepted = await legacy.controller!(
          buffer,
          `fixture.${extension}`,
          true,
        );
        expect(legacyAccepted.statusCode).toBe(200);
        expect(legacyAccepted.body).toMatchObject({
          success: true,
          errorCode: 0,
          data: { status: 'pending' },
        });
        const response = await request(buffer, extension);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          success: true,
          errorCode: 0,
          data: { status: 'pending' },
        });
        importExcelResultSchema.parse(response.json());
        const id = response.json().data.taskId as string;
        expect((await queue.getJob(id))?.name).toBe('competitor-import');
        runtime = await compiled().startAsinImportRuntime(env, fatal);
        await vi.waitFor(
          async () => expect((await store.read(id))?.status).toBe('completed'),
          { timeout: 15000, interval: 25 },
        );
        const detail = await f.http.inject({
          method: 'GET',
          url: `/api/v1/tasks/${id}`,
          headers,
        });
        expect(detail.statusCode).toBe(200);
        const task = detail.json().data;
        expect(task.taskSubType).toBe('competitor-asin');
        const download = await f.http.inject({
          method: 'GET',
          url: task.downloadUrl,
          headers,
        });
        expect(download.statusCode).toBe(200);
        expect(download.json()).toEqual(expected);
        await compareRecords();
      },
      25000,
    );
    it('keeps synchronous writes in the competitor database and rejects unauthenticated uploads', async () => {
      const buffer = await contents([sample(1)], 'csv');
      const denied = await f.http.inject({
        method: 'POST',
        url: '/api/v1/competitor/variant-groups/import-excel',
      });
      expect(denied.statusCode).toBe(401);
      const expected = await legacy.controller!(buffer, 'fixture.csv');
      const response = await request(buffer, 'csv', true);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected.body);
      await compareRecords();
    });
  },
);
