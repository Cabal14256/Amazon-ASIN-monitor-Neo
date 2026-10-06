import { getNeoQueuePrefix, type Env } from '@asin-monitor/config';
import { RedisTaskRepository } from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENV } from '../src/config/config.module';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationExportArtifacts } from '../src/tasks/export-storage.module';
import {
  ExportEnqueueRejected,
  TaskQueryRuntime,
} from '../src/tasks/task-query.runtime';
import { asinWriteApp } from './helpers/asin-write-app';

interface ExportRuntime {
  close(): Promise<void>;
}
const compiled = () =>
  createRequire(__filename)('../../worker/dist/asin-export-runtime.js') as {
    startAsinExportRuntime(
      env: Env,
      onFatal: () => void,
    ): Promise<ExportRuntime>;
  };

async function eventually<T>(
  read: () => Promise<T | null>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('ASIN export fixture timed out');
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'ASIN export HTTP, isolated PostgreSQL/Redis, compiled BullMQ Worker',
  () => {
    const prefix = `fixture-export166-${randomUUID()}`;
    let f: Awaited<ReturnType<typeof asinWriteApp>>;
    let env: Env, redis: Redis, store: RedisTaskRepository;
    let artifacts: ExportArtifactStore, directory: string;
    let worker: ExportRuntime | undefined;
    let queryRuntime: TaskQueryRuntime;
    let appLogger: AppLogger;
    let ownerHeaders: Record<string, string>,
      otherHeaders: Record<string, string>;
    const fatal = vi.fn();
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'neo-export-integration-'));
      artifacts = new ExportArtifactStore(directory);
      f = await asinWriteApp((builder) =>
        builder
          .overrideProvider(ApplicationExportArtifacts)
          .useValue(artifacts)
          .overrideProvider(TaskQueryRuntime)
          .useFactory({
            inject: [ENV, AppLogger],
            factory: (source: Env, logger: AppLogger) => {
              env = {
                ...source,
                BULL_PREFIX: prefix,
                EXPORT_STORAGE_DIRECTORY: directory,
              };
              appLogger = logger;
              queryRuntime = new TaskQueryRuntime(env, logger);
              return queryRuntime;
            },
          }),
      );
      redis = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        connectTimeout: 2000,
        commandTimeout: 2000,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      redis.on('error', () => undefined);
      await redis.connect();
      store = new RedisTaskRepository(redis, env);
      const ownerId = randomUUID();
      const otherId = randomUUID();
      for (const userId of [ownerId, otherId]) {
        const sessionId = randomUUID();
        f.userIds.add(userId);
        await f.pools.primaryPool.query(
          'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
          [userId, `export-${userId}`, 'unused-fixture-hash'],
        );
        await f.pools.primaryPool.query(
          "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
          [userId],
        );
        await f.pools.primaryPool.query(
          "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
          [sessionId, userId],
        );
        const headers = {
          authorization: `Bearer ${jwt.sign(
            { userId, sessionId },
            env.JWT_SECRET,
            { expiresIn: '1h' },
          )}`,
          origin: env.CORS_ORIGIN,
        };
        if (userId === ownerId) ownerHeaders = headers;
        else otherHeaders = headers;
      }
      await f.pools.primaryPool
        .query(`INSERT INTO variant_groups(id,name,country,site,brand,is_broken,create_time)
        VALUES('g-broken','Broken','US','amazon.com','Fixture',true,'2026-09-27 00:00:00'),
              ('g-empty','Empty','US','amazon.com','Fixture',false,'2026-09-27 01:00:00'),
              ('g-other','Other','DE','amazon.de','Fixture',false,'2026-09-27 02:00:00')`);
      await f.pools.primaryPool
        .query(`INSERT INTO asins(id,asin,name,asin_type,country,site,brand,variant_group_id,is_broken,create_time,last_check_time)
        VALUES('a-one','B000000001','Item','1','US','amazon.com','Fixture','g-broken',true,'2026-09-27 00:00:00','2026-09-27 09:02:03')`);
      await f.pools.primaryPool
        .query(`INSERT INTO variant_groups(id,name,country,site,brand)
        SELECT 'g-bulk-' || n, 'Bulk-' || n, 'US', 'amazon.com', 'Fixture'
        FROM generate_series(1,120) AS n`);
      await f.pools.primaryPool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand) VALUES('g-dense','Dense','CA','amazon.ca','Fixture')",
      );
      await f.pools.primaryPool.query(`
        INSERT INTO asins(id,asin,name,asin_type,country,site,brand,variant_group_id,create_time)
        SELECT 'a-dense-' || n, 'D' || lpad(n::text, 9, '0'), 'Dense ' || n,
          '1', 'CA', 'amazon.ca', 'Fixture', 'g-dense', '2026-09-27 00:00:00'::timestamp
        FROM generate_series(1,5001) AS n
      `);
      worker = await compiled().startAsinExportRuntime(env, () => fatal());
    }, 30_000);

    afterAll(async () => {
      try {
        await worker?.close();
        if (redis?.status === 'ready') {
          let cursor = '0';
          do {
            const [next, keys] = await redis.scan(
              cursor,
              'MATCH',
              `${prefix}:*`,
              'COUNT',
              100,
            );
            if (keys.some((key) => !key.startsWith(`${prefix}:`)))
              throw new Error('Export fixture namespace escaped');
            if (keys.length) await redis.del(...keys);
            cursor = next;
          } while (cursor !== '0');
        }
      } finally {
        redis?.disconnect(false);
        await f?.close();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });

    it.each(['pre-add', 'create-ack-lost', 'late-create-ack'] as const)(
      'releases %s rejection through authenticated HTTP and a restarted compiled Worker using real Redis',
      async (mode) => {
        await worker!.close();
        worker = undefined;
        const open = queryRuntime.openExport.bind(queryRuntime);
        const reject = vi
          .spyOn(queryRuntime, 'openExport')
          .mockImplementation((ensureOpen, onWrite) => {
            const port = open(ensureOpen, onWrite);
            return {
              ...port,
              store: {
                createLimitedExport: async (...args) => {
                  const created = await port.store.createLimitedExport(...args);
                  if (mode === 'create-ack-lost')
                    throw new Error('fixture committed create response lost');
                  if (mode === 'late-create-ack') {
                    await new Promise((resolve) => setTimeout(resolve, 3100));
                    ensureOpen();
                  }
                  return created;
                },
                mutate: async () => {
                  throw new Error('fixture terminal Redis cleanup unavailable');
                },
              },
              enqueue: async () => {
                throw new ExportEnqueueRejected('unavailable');
              },
            };
          });
        const ids: string[] = [];
        try {
          for (let index = 0; index < 2; index++) {
            const response = await f.app.inject({
              method: 'POST',
              url: '/api/v1/tasks/export',
              headers: ownerHeaders,
              payload: { exportType: 'asin', params: { country: 'US' } },
            });
            expect(response.statusCode).toBe(503);
            expect(response.json().data.status).toBe('rejected');
            const id = response.json().data.taskId as string;
            ids.push(id);
            expect((await store.read(id))?.status).toBe('pending');
            expect(await artifacts.readRejectedSubmission(id)).not.toBeNull();
          }
        } finally {
          reject.mockRestore();
        }
        const recreated = new TaskQueryRuntime(env, appLogger);
        const read = vi
          .spyOn(queryRuntime, 'open')
          .mockImplementation((ensureOpen) => recreated.open(ensureOpen));
        try {
          const foreign = await f.app.inject({
            method: 'GET',
            url: `/api/v1/tasks/${ids[0]}`,
            headers: otherHeaders,
          });
          expect([403, 404]).toContain(foreign.statusCode);
          expect((await store.read(ids[0]!))?.status).toBe('pending');
          const response = await f.app.inject({
            method: 'GET',
            url: `/api/v1/tasks/${ids[0]}`,
            headers: ownerHeaders,
          });
          expect(response.statusCode).toBe(200);
          expect(response.json().data.status).toBe('failed');
          expect(await artifacts.readRejectedSubmission(ids[0]!)).toBeNull();
        } finally {
          read.mockRestore();
          await recreated.onModuleDestroy();
          worker = await compiled().startAsinExportRuntime(env, () => fatal());
        }
        const recovered = await eventually(async () => {
          const task = await store.read(ids[1]!);
          return task?.status === 'failed' ? task : null;
        });
        expect(recovered.taskId).toBe(ids[1]);
        await eventually(async () =>
          (await artifacts.readRejectedSubmission(ids[1]!)) === null
            ? true
            : null,
        );
        const next = await f.app.inject({
          method: 'POST',
          url: '/api/v1/tasks/export',
          headers: ownerHeaders,
          payload: { exportType: 'asin', params: { country: 'DE' } },
        });
        expect(next.statusCode).toBe(200);
        await eventually(async () => {
          const task = await store.read(next.json().data.taskId as string);
          return task?.status === 'completed' ? task : null;
        });
        expect(fatal).not.toHaveBeenCalled();
      },
      45_000,
    );

    it('exports one group with more than 5,000 child ASINs', async () => {
      const created = await f.app.inject({
        method: 'POST',
        url: '/api/v1/tasks/export',
        headers: ownerHeaders,
        payload: { exportType: 'asin', params: { country: 'CA' } },
      });
      expect(created.statusCode).toBe(200);
      const taskId = created.json().data.taskId as string;
      const task = await eventually(async () => {
        const current = await store.read(taskId);
        return current?.status === 'completed' ? current : null;
      }, 30_000);
      expect(task.result).toMatchObject({ exportType: 'asin', rowCount: 5001 });
      const download = await (async () => {
        const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        try {
          const response = await f.app.inject({
            method: 'GET',
            url: `/api/v1/tasks/${taskId}/download`,
            headers: ownerHeaders,
          });
          expect(timeoutSpy).toHaveBeenCalledWith(
            expect.any(Function),
            30 * 60_000,
          );
          return response;
        } finally {
          timeoutSpy.mockRestore();
        }
      })();
      expect(download.statusCode).toBe(200);
      const ExcelJS = createRequire(
        resolve(__dirname, '../../worker/package.json'),
      )('exceljs');
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(download.rawPayload);
      expect(book.worksheets[0].rowCount).toBe(5002);
      expect(book.worksheets[0].getRow(1).cellCount).toBe(12);
      expect(book.worksheets[0].getRow(2).getCell(11).value).toBeInstanceOf(
        Date,
      );
      expect(book.worksheets[0].getRow(2).getCell(11).value).toEqual(
        new Date('2026-09-26T16:00:00.000Z'),
      );
      expect(fatal).not.toHaveBeenCalled();
    }, 45_000);

    it('produces, tracks and streams a filtered Legacy-compatible workbook; denies other owners and revoked grants', async () => {
      const unsupported = await f.app.inject({
        method: 'POST',
        url: '/api/v1/tasks/export',
        headers: ownerHeaders,
        payload: { exportType: 'monitor-history' },
      });
      expect(unsupported.statusCode).toBe(501);
      const created = await f.app.inject({
        method: 'POST',
        url: '/api/v1/tasks/export',
        headers: ownerHeaders,
        payload: {
          exportType: 'asin',
          params: { country: 'US', layout: 'detailed' },
        },
      });
      expect(created.statusCode).toBe(200);
      const taskId = created.json().data.taskId as string;
      const task = await eventually(async () => {
        const current = await store.read(taskId);
        return current?.status === 'completed' ? current : null;
      });
      expect(task.result).toMatchObject({ exportType: 'asin', rowCount: 122 });
      const detail = await f.app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${taskId}`,
        headers: ownerHeaders,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data.status).toBe('completed');
      const foreign = await f.app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${taskId}/download`,
        headers: otherHeaders,
      });
      expect([403, 404]).toContain(foreign.statusCode);
      const download = await f.app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${taskId}/download`,
        headers: ownerHeaders,
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(download.headers['content-disposition']).toContain('asin-export-');
      const ExcelJS = createRequire(
        resolve(__dirname, '../../worker/package.json'),
      )('exceljs');
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(download.rawPayload);
      expect(book.worksheets[0].getRow(1).cellCount).toBe(15);
      const rows: unknown[][] = book.worksheets[0]
        .getSheetValues()
        .slice(2)
        .map((row: unknown) => (row as unknown[]).slice(1));
      expect(rows).toHaveLength(122);
      expect(
        rows.some(
          (row) => row[0] === 'Empty' && row[6] === 'NORMAL' && !row[7],
        ),
      ).toBe(true);
      expect(
        rows.some(
          (row) =>
            row[0] === 'Broken' && row[6] === 'AUTO' && row[7] === 'B000000001',
        ),
      ).toBe(true);
      expect(rows.some((row) => row[0] === 'Other')).toBe(false);
      const broken = rows.find((row) => row[7] === 'B000000001')!;
      expect(broken[13]).toEqual(new Date('2026-09-26T16:00:00.000Z'));
      expect(broken[14]).toEqual(new Date('2026-09-27T01:02:03.000Z'));
      expect(
        (await readdir(directory)).filter((name) => name.endsWith('.part')),
      ).toEqual([]);
      await f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id=(SELECT id FROM permissions WHERE code='asin:read')",
      );
      const revoked = await f.app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${taskId}/download`,
        headers: ownerHeaders,
      });
      expect(revoked.statusCode).toBe(403);
      expect(fatal).not.toHaveBeenCalled();
      expect(getNeoQueuePrefix(env)).toBe(`${prefix}:neo`);
    }, 30_000);
  },
);
