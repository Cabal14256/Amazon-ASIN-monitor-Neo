import { type Env } from '@asin-monitor/config';
import { RedisTaskRepository } from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import type { HttpInput, NodeHttpTransport } from '@asin-monitor/sp-api';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENV } from '../src/config/config.module';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationExportArtifacts } from '../src/tasks/export-storage.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { asinWriteApp } from './helpers/asin-write-app';

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
  throw new Error('Parent export fixture timed out');
}
/** Actual HTTP to a loopback upstream protocol server, with the signed Amazon
 * destination mapped only at the final transport boundary. No live credentials
 * or external Amazon connections; API/auth/Redis/quota/compiled Worker/XLSX real. */
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'parent XLSX HTTP, isolated PostgreSQL/Redis, compiled Worker and loopback SP-API',
  () => {
    let f: Awaited<ReturnType<typeof asinWriteApp>>,
      env: Env,
      redis: Redis,
      store: RedisTaskRepository;
    let directory: string, artifacts: ExportArtifactStore;
    let worker: { close(): Promise<void> } | undefined;
    let upstream: Server | undefined, transport: NodeHttpTransport | undefined;
    let headers: Record<string, string>, other: Record<string, string>;
    const prefix = `parent-export-231-${randomUUID()}`;
    const quotaPrefix = `${prefix}:quota`;
    const held = new Set<ServerResponse>();
    const calls: string[] = [];
    let signedCalls = 0,
      tokenCalls = 0;
    const fixtureEnvironment = {
      SP_API_LWA_CLIENT_ID: 'fixture-parent-client',
      SP_API_LWA_CLIENT_SECRET: 'fixture-parent-secret',
      SP_API_REFRESH_TOKEN: 'fixture-parent-refresh',
      SP_API_ACCESS_KEY_ID: 'AKIAFIXTURE0000000231',
      SP_API_SECRET_ACCESS_KEY: 'fixture-parent-signing-key',
      SP_API_USE_AWS_SIGNATURE: 'true',
      ENABLE_HTML_SCRAPER_FALLBACK: 'false',
      ENABLE_LEGACY_CLIENT_FALLBACK: 'false',
      RATE_LIMITER_KEY_PREFIX: quotaPrefix,
      SP_API_RATE_LIMIT_PER_MINUTE: '120',
      SP_API_RATE_LIMIT_PER_HOUR: '7200',
      SP_API_RATE_LIMIT_SAFETY_FACTOR: '1',
    };
    const start = async () => {
      const compiled = createRequire(__filename)(
        '../../worker/dist/asin-export-runtime.js',
      ) as {
        startAsinExportRuntime(
          env: Env,
          fatal: () => void,
          environment: Record<string, unknown>,
        ): Promise<{ close(): Promise<void> }>;
      };
      worker = await compiled.startAsinExportRuntime(
        env,
        () => {
          throw new Error('Export consumer stopped');
        },
        fixtureEnvironment,
      );
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
      upstream = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/auth/o2/token') {
          tokenCalls++;
          request.resume();
          response.end(
            JSON.stringify({
              access_token: 'fixture-parent-access',
              expires_in: 3600,
              token_type: 'bearer',
            }),
          );
          return;
        }
        const asin = request.url?.match(
          /^\/catalog\/2022-04-01\/items\/(B\d{9})\?/u,
        )?.[1];
        if (!asin) {
          response.writeHead(400);
          response.end('{}');
          return;
        }
        calls.push(asin);
        if (
          String(request.headers.authorization).startsWith(
            'AWS4-HMAC-SHA256 ',
          ) &&
          request.headers['x-amz-access-token'] === 'fixture-parent-access'
        )
          signedCalls++;
        if (asin === 'B000000009') {
          held.add(response);
          response.once('close', () => held.delete(response));
          return;
        }
        if (asin === 'B000000002') {
          response.writeHead(400);
          response.end(
            JSON.stringify({
              errors: [
                {
                  code: 'InvalidInput',
                  message: 'synthetic protocol rejection',
                },
              ],
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            asin,
            summaries: [
              { itemName: '=literal ' + asin, brand: 'Fixture brand' },
            ],
            relationships:
              asin === 'B000000004'
                ? []
                : [
                    {
                      relationships: [
                        {
                          type: 'VARIATION',
                          ...(asin === 'B000000003'
                            ? { childAsins: ['B000000001'] }
                            : { parentAsins: ['B000000003'] }),
                        },
                      ],
                    },
                  ],
          }),
        );
      });
      await new Promise<void>((resolve) =>
        upstream!.listen(0, '127.0.0.1', resolve),
      );
      const origin = `http://127.0.0.1:${
        (upstream.address() as AddressInfo).port
      }`;
      const compiledSpApi = createRequire(__filename)(
        '@asin-monitor/sp-api',
      ) as typeof import('@asin-monitor/sp-api');
      const send = compiledSpApi.NodeHttpTransport.prototype.request;
      transport = new compiledSpApi.NodeHttpTransport({ allowLocalHttp: true });
      vi.spyOn(
        compiledSpApi.NodeHttpTransport.prototype,
        'request',
      ).mockImplementation((input: HttpInput) => {
        if (
          ![
            'api.amazon.com',
            'sellingpartnerapi-na.amazon.com',
            'sellingpartnerapi-eu.amazon.com',
          ].includes(input.url.hostname)
        )
          throw new Error('Unexpected upstream host');
        return send.call(transport!, {
          ...input,
          url: new URL(input.url.pathname + input.url.search, origin),
        });
      });
      directory = await mkdtemp(join(tmpdir(), 'neo-parent-http-'));
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
                RATE_LIMITER_KEY_PREFIX: quotaPrefix,
                EXPORT_STORAGE_DIRECTORY: directory,
              };
              return new TaskQueryRuntime(env, logger);
            },
          }),
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
    }, 30_000);
    afterAll(async () => {
      try {
        await worker?.close();
        transport?.close();
        for (const response of held) response.destroy();
        await new Promise<void>((resolve) => {
          if (upstream) upstream.close(() => resolve());
          else resolve();
        });
        if (redis?.status === 'ready') {
          let cursor = '0',
            pages = 0;
          do {
            if (++pages > 100) throw new Error('Bounded cleanup exceeded');
            const [next, keys] = await redis.scan(
              cursor,
              'MATCH',
              `${prefix}:*`,
              'COUNT',
              100,
            );
            if (keys.some((key) => !key.startsWith(`${prefix}:`)))
              throw new Error('Unsafe fixture namespace');
            if (keys.length) await redis.del(...keys);
            cursor = next;
          } while (cursor !== '0');
        }
      } finally {
        redis?.disconnect();
        await f?.close();
        vi.restoreAllMocks();
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }, 30_000);
    const post = (asins = 'b000000001,B000000004\nB000000002,B000000001') =>
      f.http.inject({
        method: 'POST',
        url: '/api/v1/tasks/export',
        headers,
        payload: {
          exportType: 'parent-asin-query',
          params: { asins, country: 'US' },
        },
      });
    const get = (id: string, auth = headers) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${id}/download`,
        headers: auth,
      });
    const revoke = () =>
      f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id=(SELECT id FROM permissions WHERE code='asin:read')",
      );
    const restore = () =>
      f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:read' ON CONFLICT DO NOTHING",
      );
    it('shares admission with catalog exports and cancels queued work without upstream calls', async () => {
      const first = await post();
      const second = await f.http.inject({
        method: 'POST',
        url: '/api/v1/tasks/export',
        headers,
        payload: { exportType: 'competitor-asin' },
      });
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
      expect(calls).toEqual([]);
    });
    it('queries the actual shared signed pipeline and downloads the complete eleven-column workbook only for the authorized owner', async () => {
      await start();
      const accepted = await post();
      expect(accepted.statusCode).toBe(200);
      const id = accepted.json().data.taskId as string;
      const task = await eventually(async () => {
        const value = await store.read(id);
        if (value?.status === 'failed') throw new Error('Parent export failed');
        return value?.status === 'completed' ? value : null;
      });
      expect(task.result).toMatchObject({
        exportType: 'parent-asin-query',
        rowCount: 4,
      });
      const download = await get(id);
      expect(download.statusCode).toBe(200);
      expect(
        decodeURIComponent(String(download.headers['content-disposition'])),
      ).toContain('ASIN父变体查询结果_');
      const ExcelJS = createRequire(
        join(__dirname, '../../worker/package.json'),
      )('exceljs') as {
        Workbook: new () => {
          xlsx: { load(bytes: Buffer): Promise<unknown> };
          worksheets: {
            columnCount: number;
            rowCount: number;
            getCell(address: string): { value: unknown };
          }[];
        };
      };
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(download.rawPayload as never);
      const sheet = workbook.worksheets[0]!;
      expect(sheet.columnCount).toBe(11);
      expect(sheet.rowCount).toBe(5);
      expect(sheet.getCell('A2').value).toBe('B000000001');
      expect(sheet.getCell('A5').value).toBe('B000000001');
      expect(sheet.getCell('D2').value).toBe('B000000003');
      expect(sheet.getCell('E2').value).toBe('=literal B000000003');
      expect(sheet.getCell('C3').value).toBe('否');
      expect(sheet.getCell('K4').value).toEqual(expect.any(String));
      expect(String(sheet.getCell('K4').value).length).toBeGreaterThan(0);
      expect(sheet.getCell('J2').value).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      );
      expect(tokenCalls).toBeGreaterThan(0);
      expect(signedCalls).toBe(calls.length);
      expect(calls).toContain('B000000003');
      expect((await get(id, other)).statusCode).toBe(403);
      await revoke();
      expect((await get(id)).statusCode).toBe(403);
      await restore();
      const artifact = (task.result as { artifact: { key: string } }).artifact;
      await writeFile(join(directory, artifact.key), 'PKcorrupt');
      expect((await get(id)).statusCode).toBe(404);
    }, 40_000);
    it('cancels an in-flight real protocol request without publishing a workbook', async () => {
      const accepted = await post('B000000009');
      expect(accepted.statusCode).toBe(200);
      const id = accepted.json().data.taskId as string;
      await eventually(async () => (held.size ? true : null));
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
      await eventually(async () => (held.size === 0 ? true : null));
      expect(await artifacts.read(id)).toBeNull();
      await worker!.close();
      worker = undefined;
    }, 40_000);
    it('fails queued work after primary read authority is revoked, without calling the upstream', async () => {
      const accepted = await post('B000000008');
      expect(accepted.statusCode).toBe(200);
      const id = accepted.json().data.taskId as string,
        count = calls.length;
      await revoke();
      try {
        await start();
        await eventually(async () =>
          (await store.read(id))?.status === 'failed' ? true : null,
        );
        expect(calls).toHaveLength(count);
        expect(await artifacts.read(id)).toBeNull();
        expect((await get(id)).statusCode).toBe(409);
      } finally {
        await worker?.close();
        worker = undefined;
        await restore();
      }
    }, 40_000);
  },
);
