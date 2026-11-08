import { getNeoQueuePrefix, type Env } from '@asin-monitor/config';
import {
  PgMonitorHistoryExportRepository,
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENV } from '../src/config/config.module';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationExportArtifacts } from '../src/tasks/export-storage.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { asinWriteApp } from './helpers/asin-write-app';
import {
  canonicalHistoryWorkbook,
  historyWorkbook,
  legacyHistoryWorkbook,
} from './helpers/monitor-history-export-oracle';
import { legacyMonitorHistoryFixture } from './helpers/monitor-history-legacy';

async function eventually<T>(
  read: () => Promise<T | null>,
  timeout = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw new Error('Monitor-history export fixture timed out');
}
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'monitor history XLSX / real Legacy MySQL, TimescaleDB, Redis and compiled Worker',
  () => {
    let f: Awaited<ReturnType<typeof asinWriteApp>>,
      legacy: Awaited<ReturnType<typeof legacyMonitorHistoryFixture>>,
      env: Env;
    let directory: string,
      artifacts: ExportArtifactStore,
      redis: Redis,
      store: RedisTaskRepository;
    let worker: { close(): Promise<void> } | undefined;
    let headers: Record<string, string>,
      other: Record<string, string>,
      asinOnly: Record<string, string>;
    const prefix = `history-export-174-${randomUUID()}`;
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
        const url = new URL(process.env[key]!);
        if (
          url.protocol !== protocol ||
          url.hostname !== '127.0.0.1' ||
          url.pathname !== path ||
          url.port !== port ||
          url.password ||
          url.search
        )
          throw new Error('Exact disposable loopback targets required');
      }
      if (
        process.env.INTEGRATION_MYSQL_HOST !== '127.0.0.1' ||
        process.env.INTEGRATION_MYSQL_PORT !== '3306' ||
        process.env.INTEGRATION_MYSQL_PASSWORD
      )
        throw new Error('Exact disposable loopback MySQL required');
      // Match the Legacy server's Shanghai host clock for Date formatting, while
      // Neo uses explicit D8 wall time regardless of this process setting.
      vi.stubEnv('TZ', 'Asia/Shanghai');
      legacy = await legacyMonitorHistoryFixture();
      directory = await mkdtemp(join(tmpdir(), 'neo-history-http-'));
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
              return new TaskQueryRuntime(env, logger);
            },
          }),
      );
      await f.pools.primaryPool.query(
        'CREATE TABLE monitor_history (LIKE public.monitor_history INCLUDING ALL)',
      );
      const relation = `${f.schema}.monitor_history`;
      const primary = await f.pools.primaryPool.query(
        "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND contype='p'",
        [relation],
      );
      for (const key of primary.rows) {
        if (!/^[a-z0-9_]+$/.test(key.conname))
          throw new Error('Unexpected fixture key');
        if (!String(key.definition).includes('check_time'))
          await f.pools.primaryPool.query(
            `ALTER TABLE monitor_history DROP CONSTRAINT "${key.conname}"`,
          );
      }
      if (
        !primary.rows.some((key) =>
          String(key.definition).includes('check_time'),
        )
      )
        await f.pools.primaryPool.query(
          'ALTER TABLE monitor_history ADD PRIMARY KEY(check_time,id)',
        );
      await f.pools.primaryPool.query(
        "SELECT public.create_hypertable($1::regclass,'check_time',if_not_exists=>true,create_default_indexes=>false)",
        [relation],
      );
      await f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='reader-71'",
      );
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code='monitor:read'",
      );
      redis = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        commandTimeout: 2000,
        connectTimeout: 2000,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      redis.on('error', () => undefined);
      await redis.connect();
      store = new RedisTaskRepository(redis, env);
      for (const identity of ['owner', 'other', 'asin-only']) {
        const userId = randomUUID(),
          sessionId = randomUUID();
        f.userIds.add(userId);
        await f.pools.primaryPool.query(
          'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
          [userId, 'unused-fixture'],
        );
        await f.pools.primaryPool.query(
          'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
          [userId, identity === 'asin-only' ? 'writer-71' : 'reader-71'],
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
        else if (identity === 'other') other = value;
        else asinOnly = value;
      }
      for (const [target, query] of [
        ['legacy', legacy.query],
        ['neo', f.pools.primaryPool.query.bind(f.pools.primaryPool)],
      ] as const) {
        const markers = target === 'legacy' ? '?,?' : '$1,$2';
        await query(
          `INSERT INTO variant_groups(id,name,country,site,brand) VALUES(${markers},'US','12','Fixture')`,
          ['g1', 'Current group'],
        );
        await query(
          `INSERT INTO asins(id,asin,name,asin_type,country,site,brand,variant_group_id) VALUES(${
            target === 'legacy' ? '?,?' : '$1,$2'
          },'Current product','1','US','12','Fixture','g1')`,
          ['a1', 'B000000001'],
        );
      }
      const payload = JSON.stringify({
        source: 'MANUAL_ACTION',
        action: 'MARK_BROKEN',
        statusSource: 'AUTO+MANUAL',
        reason: 'Fixture reason',
        operator: 'Fixture operator',
        nested: { z: 1, a: 2 },
      });
      const values: (string | number | null)[][] = Array.from(
        { length: 1001 },
        (_, index) => [
          String(index + 1),
          'g1',
          'a1',
          index % 2 ? 'ASIN' : 'GROUP',
          'US',
          index % 2,
          '2026-09-27 08:00:00',
          payload,
          'Snapshot group',
          `B${String(index).padStart(9, '0')}`,
          'Snapshot product',
        ],
      );
      values.push([
        '9223372036854775807',
        'g1',
        'a1',
        'ASIN',
        'US',
        1,
        '2026-09-27 09:00:00',
        JSON.stringify(
          JSON.stringify({
            source: 'MANUAL_ACTION',
            action: 'CLEAR',
            reason: 'Nested JSON text',
          }),
        ),
        'Snapshot max',
        'B999999999',
        'Max ID product',
      ]);
      for (let index = 0; index < 5; index++)
        values.push([
          String(2001 + index),
          'g1',
          'a1',
          'ASIN',
          ['UK', 'DE', 'FR', 'IT', 'ES'][index]!,
          index % 2,
          '2026-09-27 10:00:00',
          index === 0 ? 'null' : JSON.stringify({ fixture: index }),
          index === 1 ? null : 'EU snapshot',
          index === 1 ? null : `E${String(index).padStart(9, '0')}`,
          index === 1 ? null : 'EU product',
        ]);
      for (let offset = 0; offset < values.length; offset += 200) {
        const batch = values.slice(offset, offset + 200),
          columns =
            'id,variant_group_id,asin_id,check_type,country,is_broken,check_time,check_result,variant_group_name,asin_code,asin_name';
        await legacy.query(
          `INSERT INTO monitor_history(${columns}) VALUES ${batch
            .map(() => `(${Array(11).fill('?').join(',')})`)
            .join(',')}`,
          batch.flat(),
        );
        const params = batch.flatMap((row) =>
          row.map((value, index) => (index === 5 ? !!value : value)),
        );
        await f.pools.primaryPool.query(
          `INSERT INTO monitor_history(${columns}) OVERRIDING SYSTEM VALUE VALUES ${batch
            .map(
              (_, row) =>
                `(${Array.from(
                  { length: 11 },
                  (_, column) => '$' + (row * 11 + column + 1),
                ).join(',')})`,
            )
            .join(',')}`,
          params,
        );
      }
    }, 40_000);
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
              throw new Error('Unsafe fixture prefix');
            if (keys.length) await redis.del(...keys);
            cursor = next;
          } while (cursor !== '0');
        }
      } finally {
        redis?.disconnect();
        try {
          await f?.close();
        } finally {
          await legacy?.close();
          vi.unstubAllEnvs();
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      }
    }, 40_000);
    const post = (params: Record<string, unknown> = {}, auth = headers) =>
      f.http.inject({
        method: 'POST',
        url: '/api/v1/tasks/export',
        headers: auth,
        payload: { exportType: 'monitor-history', params },
      });
    const download = (id: string, auth = headers) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${id}/download`,
        headers: auth,
      });
    const revoke = () =>
      f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='reader-71' AND permission_id=(SELECT id FROM permissions WHERE code='monitor:read')",
      );
    const restore = () =>
      f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code='monitor:read' ON CONFLICT DO NOTHING",
      );
    it('uses monitor permission specifically and shares active admission before any Worker runs', async () => {
      expect((await post({}, asinOnly)).statusCode).toBe(403);
      expect(
        (
          await f.http.inject({
            method: 'POST',
            url: '/api/v1/tasks/export',
            headers,
            payload: { exportType: 'asin' },
          })
        ).statusCode,
      ).toBe(403);
      const first = await post(),
        second = await post();
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect((await post()).statusCode).toBe(429);
      for (const response of [first, second]) {
        const id = response.json().data.taskId as string;
        expect(
          (
            await f.http.inject({
              method: 'POST',
              url: `/api/v1/tasks/${id}/cancel`,
              headers,
            })
          ).json().data.status,
        ).toBe('cancelled');
      }
    });
    it('matches complete real Legacy MySQL workbook rows through HTTP, compiled Worker and authorized download', async () => {
      await start();
      let original: Buffer | undefined,
        lastId = '';
      for (const country of ['US', 'EU', 'us ', '']) {
        const params = {
          country,
          startTime: '2026-09-27',
          endTime: '2026-09-28',
        };
        const accepted = await post(params);
        expect(accepted.statusCode).toBe(200);
        const id = accepted.json().data.taskId as string;
        lastId = id;
        const task = await eventually(async () => {
          const value = await store.read(id);
          if (value?.status === 'failed')
            throw new Error('History export failed');
          return value?.status === 'completed' ? value : null;
        });
        const response = await download(id);
        expect(response.statusCode).toBe(200);
        expect(
          decodeURIComponent(String(response.headers['content-disposition'])),
        ).toContain('监控历史_');
        const actual = await historyWorkbook(Buffer.from(response.rawPayload)),
          expected = await legacyHistoryWorkbook(
            directory,
            legacy.model,
            params,
          );
        expect(canonicalHistoryWorkbook(actual)).toEqual(
          canonicalHistoryWorkbook(expected),
        );
        if (country === 'US') {
          expect(actual.rows).toHaveLength(1003);
          expect(actual.rows[1]?.[3]).toBe('B999999999');
        }
        expect(task.result).toMatchObject({
          exportType: 'monitor-history',
          rowCount: actual.rows.length - 1,
        });
        expect((await download(id, other)).statusCode).toBe(403);
        original = Buffer.from(response.rawPayload);
      }
      await f.pools.primaryPool.query(
        "UPDATE monitor_history SET variant_group_name='changed-after-publish' WHERE country='US'",
      );
      expect((await download(lastId)).rawPayload).toEqual(original);
      await revoke();
      expect((await download(lastId)).statusCode).toBe(403);
      await restore();
      const task = await store.read(lastId),
        artifact = (task!.result as { artifact: { key: string } }).artifact;
      await writeFile(join(directory, artifact.key), 'PKcorrupt');
      expect((await download(lastId)).statusCode).toBe(404);
      await worker!.close();
      worker = undefined;
    }, 60_000);
    it('keeps a native microsecond keyset in one Timescale snapshot while rows are deleted and authorization remains writable', async () => {
      await f.pools.primaryPool.query(
        `INSERT INTO monitor_history(id,country,check_time,check_type,asin_code) OVERRIDING SYSTEM VALUE SELECT 10000000+n,'JP','2026-09-27 07:00:00.123456'::timestamp,'ASIN','J'||lpad(n::text,9,'0') FROM generate_series(1,501)n`,
      );
      const repository = new PgMonitorHistoryExportRepository(
        f.pools.primaryPool,
      );
      await repository.read(async (unit) => {
        const params = { country: 'JP', endTime: '2026-09-28' };
        const first = await unit.page(params);
        expect(first).toHaveLength(500);
        expect(first.at(-1)?.cursor.checkTime).toBe(
          '2026-09-27 07:00:00.123456',
        );
        await f.pools.primaryPool.query(
          'DELETE FROM monitor_history WHERE id=10000001',
        );
        const lock = await f.pools.primaryPool.connect();
        try {
          await lock.query('BEGIN');
          const result = await lock.query(
            'SELECT pg_try_advisory_xact_lock(1095977294,1380073795) AS acquired',
          );
          expect(result.rows[0].acquired).toBe(true);
          await lock.query('ROLLBACK');
        } finally {
          lock.release();
        }
        const second = await unit.page(params, first.at(-1)!.cursor);
        expect(second.map((row) => row.cursor.id)).toEqual(['10000001']);
      });
    });
    it('fails queued work after monitor permission is revoked without publishing an artifact', async () => {
      const accepted = await post({ country: 'US' });
      expect(accepted.statusCode).toBe(200);
      const id = accepted.json().data.taskId as string;
      await revoke();
      try {
        await start();
        await eventually(async () =>
          (await store.read(id))?.status === 'failed' ? true : null,
        );
        expect(await artifacts.read(id)).toBeNull();
        expect((await download(id)).statusCode).toBe(409);
      } finally {
        await worker?.close();
        worker = undefined;
        await restore();
      }
    }, 40_000);
    it('cancels a real blocked PostgreSQL read and never publishes a late workbook after the lock releases', async () => {
      const blocker = await f.pools.primaryPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE monitor_history IN ACCESS EXCLUSIVE MODE',
        );
        await start();
        const accepted = await post({ country: 'US' });
        expect(accepted.statusCode).toBe(200);
        const id = accepted.json().data.taskId as string;
        await eventually(async () => {
          const result = await f.pools.primaryPool.query(
            'SELECT 1 FROM pg_locks WHERE relation=$1::regclass AND NOT granted',
            [`${f.schema}.monitor_history`],
          );
          return result.rows.length ? true : null;
        });
        const response = await f.http.inject({
          method: 'POST',
          url: `/api/v1/tasks/${id}/cancel`,
          headers,
        });
        expect(['cancelling', 'cancelled']).toContain(
          response.json().data.status,
        );
        await eventually(async () =>
          (await store.read(id))?.status === 'cancelled' ? true : null,
        );
        await blocker.query('ROLLBACK');
        expect(await artifacts.read(id)).toBeNull();
        expect((await download(id)).statusCode).toBe(409);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await worker?.close();
        worker = undefined;
      }
    }, 40_000);
  },
);
