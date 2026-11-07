import { getNeoQueuePrefix, type Env } from '@asin-monitor/config';
import {
  PgCompetitorExportRepository,
  RedisTaskRepository,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV } from '../src/config/config.module';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationExportArtifacts } from '../src/tasks/export-storage.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { competitorWriteApp } from './helpers/competitor-write-app';

async function eventually<T>(
  read: () => Promise<T | null>,
  timeout = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value !== null) return value;
    await new Promise((done) => setTimeout(done, 30));
  } while (Date.now() < deadline);
  throw new Error('Competitor export fixture timed out');
}
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'competitor XLSX real dual PostgreSQL/Redis and compiled Worker',
  () => {
    let f: Awaited<ReturnType<typeof competitorWriteApp>>,
      env: Env,
      redis: Redis,
      store: RedisTaskRepository;
    let directory: string,
      artifacts: ExportArtifactStore,
      worker: { close(): Promise<void> } | undefined;
    let headers: Record<string, string>, other: Record<string, string>;
    const prefix = `competitor-export-230-${randomUUID()}`;
    const start = async () => {
      const compiled = createRequire(__filename)(
        '../../worker/dist/asin-export-runtime.js',
      ) as {
        startAsinExportRuntime(
          env: Env,
          fatal: () => void,
        ): Promise<{ close(): Promise<void> }>;
      };
      worker = await compiled.startAsinExportRuntime(env, () => {
        throw new Error('Compiled export consumer stopped');
      });
    };
    beforeAll(async () => {
      if (process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true')
        throw new Error('Disposable opt-in required');
      for (const [key, protocol, path, port] of [
        ['DATABASE_URL', 'postgresql:', '/amazon_asin_monitor_ci', '5432'],
        [
          'COMPETITOR_DATABASE_URL',
          'postgresql:',
          '/amazon_competitor_monitor_ci',
          '5432',
        ],
        ['REDIS_URL', 'redis:', '/15', '6379'],
      ]) {
        const value = new URL(process.env[key]!);
        if (
          value.protocol !== protocol ||
          value.hostname !== '127.0.0.1' ||
          value.pathname !== path ||
          value.port !== port ||
          value.password ||
          value.search
        )
          throw new Error('Exact disposable loopback targets required');
      }
      directory = await mkdtemp(join(tmpdir(), 'neo-competitor-export-http-'));
      artifacts = new ExportArtifactStore(directory);
      f = await competitorWriteApp({
        primaryBusiness: true,
        configure: (builder) =>
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
                return new TaskQueryRuntime(env, logger);
              },
            }),
      });
      // SQL functions/collation are in public; both business table namespaces are
      // random and fully isolated. Primary competitor sentinel stays untouched.
      redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      redis.on('error', () => undefined);
      await eventually(async () => (redis.status === 'ready' ? true : null));
      store = new RedisTaskRepository(redis, env);
      for (const identity of ['owner', 'other']) {
        const userId = randomUUID(),
          sessionId = randomUUID();
        f.userIds.add(userId);
        await f.pools.primaryPool.query(
          'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
          [userId, 'unused-fixture'],
        );
        await f.pools.primaryPool.query(
          "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
          [userId],
        );
        await f.pools.primaryPool.query(
          "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
          [sessionId, userId],
        );
        const value = {
          authorization: `Bearer ${jwt.sign(
            { userId, sessionId },
            env.JWT_SECRET,
            { expiresIn: '1h' },
          )}`,
          origin: env.CORS_ORIGIN,
        };
        if (identity === 'owner') headers = value;
        else other = value;
      }
      await f.pools.competitorPool
        .query(`INSERT INTO competitor_variant_groups(id,name,country,brand,is_broken,create_time) VALUES
      ('rival','Rival fixture','US','Fixture',false,'2026-09-27 04:00:00.123456'),
      ('empty','Empty fixture','US','Fixture',true,'2026-09-27 03:00:00'),
      (' padded ','Padded','DE','Fixture',false,'2026-09-27 02:00:00'),
      ('padded','Neighbour','DE','Fixture',false,'2026-09-27 01:00:00')`);
      await f.pools.competitorPool
        .query(`INSERT INTO competitor_asins(id,asin,name,asin_type,country,brand,variant_group_id,is_broken,create_time)
      VALUES('a1','B000000001','Fixture ASIN','MAIN_LINK','US','Fixture','rival',true,'2026-09-27 00:00:00')`);
    }, 30_000);
    afterAll(async () => {
      try {
        await worker?.close();
        if (redis?.status === 'ready') {
          let cursor = '0',
            pages = 0;
          do {
            if (++pages > 100) throw new Error('Bounded cleanup exceeded');
            const [next, keys] = await redis.scan(
              cursor,
              'MATCH',
              `${getNeoQueuePrefix(env)}:*`,
              'COUNT',
              100,
            );
            if (
              keys.some((key) => !key.startsWith(`${getNeoQueuePrefix(env)}:`))
            )
              throw new Error('Unsafe namespace');
            if (keys.length) await redis.del(...keys);
            cursor = next;
          } while (cursor !== '0');
        }
      } finally {
        redis?.disconnect();
        await f?.close();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }, 30_000);
    const post = (exportType: string, params: object = {}) =>
      f.http.inject({
        method: 'POST',
        url: '/api/v1/tasks/export',
        headers,
        payload: { exportType, params },
      });
    const get = (id: string, suffix = '', auth = headers) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${id}${suffix}`,
        headers: auth,
      });
    it('shares the two-export user limit across primary and competitor kinds and cancels queued jobs', async () => {
      const first = await post('competitor-asin'),
        second = await post('asin');
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect((await post('competitor-variant-group')).statusCode).toBe(429);
      for (const response of [first, second]) {
        const id = response.json().data.taskId as string;
        const cancelled = await f.http.inject({
          method: 'POST',
          url: `/api/v1/tasks/${id}/cancel`,
          headers,
          payload: {},
        });
        expect(cancelled.statusCode).toBe(200);
        expect(cancelled.json().data.status).toBe('cancelled');
      }
    });
    it.each(['competitor-asin', 'competitor-variant-group'])(
      'exports %s only from competitor snapshot and authorizes its own download',
      async (exportType) => {
        if (!worker) await start();
        const submitted = await post(exportType, { country: 'us' });
        expect(submitted.statusCode).toBe(200);
        const id = submitted.json().data.taskId as string;
        const task = await eventually(async () => {
          const value = await store.read(id);
          return value?.status === 'completed' ? value : null;
        });
        expect(task.taskSubType).toBe(exportType);
        const download = await get(id, '/download');
        expect(download.statusCode).toBe(200);
        const ExcelJS = createRequire(
          join(__dirname, '../../worker/package.json'),
        )('exceljs') as {
          Workbook: new () => {
            xlsx: { load(bytes: Buffer): Promise<unknown> };
            worksheets: {
              name: string;
              columnCount: number;
              rowCount: number;
              getCell(address: string): { value: unknown };
            }[];
          };
        };
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(download.rawPayload as never);
        const sheet = workbook.worksheets[0]!;
        expect(sheet.name).toBe(
          exportType === 'competitor-asin' ? '竞品ASIN数据' : '竞品变体组数据',
        );
        expect(sheet.columnCount).toBe(
          exportType === 'competitor-asin' ? 11 : 10,
        );
        expect(sheet.rowCount).toBe(3);
        expect(sheet.getCell('A2').value).toBe('Rival fixture');
        expect(sheet.getCell('E2').value).toBe('异常');
        expect(sheet.getCell('A3').value).toBe('Empty fixture');
        expect(sheet.getCell('E3').value).toBe('正常');
        expect((await get(id, '/download', other)).statusCode).toBe(403);
        const original = Buffer.from(download.rawPayload);
        await worker!.close();
        worker = undefined;
        await f.pools.competitorPool.query(
          "UPDATE competitor_variant_groups SET name='changed-after-publish' WHERE id='rival'",
        );
        expect((await get(id, '/download')).rawPayload).toEqual(original);
        await f.pools.competitorPool.query(
          "UPDATE competitor_variant_groups SET name='Rival fixture' WHERE id='rival'",
        );
        await f.pools.primaryPool.query(
          "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id=(SELECT id FROM permissions WHERE code='asin:read')",
        );
        expect((await get(id, '/download')).statusCode).toBe(403);
        await f.pools.primaryPool.query(
          "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:read'",
        );
        const artifact = (task.result as { artifact: { key: string } })
          .artifact;
        await writeFile(join(directory, artifact.key), 'PKcorrupt');
        expect((await get(id, '/download')).statusCode).toBe(404);
        expect(
          (
            await f.pools.primaryPool.query(
              "SELECT name FROM competitor_variant_groups WHERE id='g1'",
            )
          ).rows,
        ).toEqual([{ name: 'wrong-primary-data' }]);
      },
      40_000,
    );
    it('streams more than 50 groups and 5000 members without losing the original child snapshot', async () => {
      await f.pools.competitorPool
        .query(`INSERT INTO competitor_variant_groups(id,name,country,brand,create_time)
        SELECT 'dense-'||lpad(n::text,3,'0'),'Dense '||n,'GB','Fixture','2026-09-28 00:00:00.123456' FROM generate_series(0,50) n`);
      await f.pools.competitorPool
        .query(`INSERT INTO competitor_asins(id,asin,name,asin_type,country,brand,variant_group_id,create_time)
        SELECT 'dense-child-'||lpad(n::text,5,'0'),'B'||lpad(n::text,9,'0'),'Dense child '||n,'MAIN_LINK','GB','Fixture','dense-050',
          CASE WHEN n=0 THEN NULL ELSE '2026-09-28 00:00:00.123456'::timestamp END FROM generate_series(0,5000) n`);
      const repository = new PgCompetitorExportRepository(
        f.pools.competitorPool,
      );
      await repository.read(async (unit) => {
        const first = await unit.listExportChildrenPage(['dense-050']);
        expect(first).toHaveLength(5000);
        expect(first[0]?.id).toBe('dense-child-00000');
        expect(first[0]?.exportCursorTime).toBeNull();
        const last = first.at(-1)!;
        expect(last.id).toBe('dense-child-04999');
        await f.pools.competitorPool.query(
          "DELETE FROM competitor_asins WHERE id='dense-child-05000'",
        );
        const second = await unit.listExportChildrenPage(['dense-050'], {
          groupId: 'dense-050',
          id: last.id,
          createTime: last.exportCursorTime,
        });
        expect(second.map((row) => row.id)).toEqual(['dense-child-05000']);
      });
      await f.pools.competitorPool
        .query(`INSERT INTO competitor_asins(id,asin,name,asin_type,country,brand,variant_group_id,create_time)
        VALUES('dense-child-05000','B000005000','Dense child 5000','MAIN_LINK','GB','Fixture','dense-050','2026-09-28 00:00:00.123456')`);
      if (!worker) await start();
      const submitted = await post('competitor-asin', { country: 'GB' });
      expect(submitted.statusCode).toBe(200);
      const id = submitted.json().data.taskId as string;
      const task = await eventually(async () => {
        const value = await store.read(id);
        if (value?.status === 'failed')
          throw new Error('Dense competitor export failed');
        return value?.status === 'completed' ? value : null;
      });
      expect(task.result).toMatchObject({
        exportType: 'competitor-asin',
        rowCount: 5051,
      });
      const download = await get(id, '/download');
      expect(download.statusCode).toBe(200);
      const ExcelJS = createRequire(
        join(__dirname, '../../worker/package.json'),
      )('exceljs') as {
        Workbook: new () => {
          xlsx: { load(bytes: Buffer): Promise<unknown> };
          worksheets: {
            rowCount: number;
            getCell(address: string): { value: unknown };
          }[];
        };
      };
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(download.rawPayload as never);
      const sheet = workbook.worksheets[0]!;
      expect(sheet.rowCount).toBe(5052);
      expect(sheet.getCell('F2').value).toBe('B000000000');
      expect(sheet.getCell('F5002').value).toBe('B000005000');
      expect(sheet.getCell('B5003').value).toBe('dense-049');
      expect(sheet.getCell('B5052').value).toBe('dense-000');
      await worker!.close();
      worker = undefined;
    }, 40_000);
    it('rejects a queued competitor export when primary asin:read authority is revoked', async () => {
      const submitted = await post('competitor-variant-group', {
        country: 'US',
      });
      expect(submitted.statusCode).toBe(200);
      const id = submitted.json().data.taskId as string;
      await f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id=(SELECT id FROM permissions WHERE code='asin:read')",
      );
      try {
        await start();
        await eventually(async () =>
          (await store.read(id))?.status === 'failed' ? true : null,
        );
        expect(await artifacts.read(id)).toBeNull();
        // The Worker rejected this task before publishing. Preserve the shared
        // download contract: a failed task is 409 before completed-artifact
        // authorization. Revoked access to an existing artifact is 403 above.
        const download = await get(id, '/download');
        expect(download.statusCode).toBe(409);
        expect(download.json()).toMatchObject({
          success: false,
          errorCode: 409,
        });
      } finally {
        await worker?.close();
        worker = undefined;
        await f.pools.primaryPool.query(
          "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:read'",
        );
      }
    }, 40_000);
    it('keeps every keyset page in one snapshot while competitor rows change and leaves primary authorization free', async () => {
      const repository = new PgCompetitorExportRepository(
        f.pools.competitorPool,
      );
      await repository.read(async (unit) => {
        const first = await unit.listExportGroups({
          current: 1,
          pageSize: 1,
          country: 'DE',
        });
        expect(first.groups[0]?.id).toBe(' padded ');
        await f.pools.competitorPool.query(
          "DELETE FROM competitor_variant_groups WHERE id='padded'",
        );
        await f.pools.primaryPool.query(
          'SELECT pg_advisory_lock(1095977294,1380073795);SELECT pg_advisory_unlock(1095977294,1380073795)',
        );
        const last = first.groups[0]!;
        const next = await unit.listExportGroups(
          { current: 1, pageSize: 1, country: 'DE' },
          { id: last.id, createTime: last.exportCursorTime! },
          false,
        );
        expect(next.groups.map((row) => row.id)).toEqual(['padded']);
      });
    });
  },
);
