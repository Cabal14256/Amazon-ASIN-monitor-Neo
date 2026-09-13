import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  type Env,
} from '@asin-monitor/config';
import { wsMessageSchema, type WsMessage } from '@asin-monitor/contracts';
import { RedisTaskRepository, taskNotificationChannel } from '@asin-monitor/db';
import type { HttpInput, HttpResponse } from '@asin-monitor/sp-api';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Queue, Worker } from 'bullmq';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { WebSocket } from 'ws';
import { ENV } from '../src/config/config.module';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import {
  SP_API_QUOTA_ENV,
  SpApiHtmlHttpTransport,
  SpApiHttpTransport,
} from '../src/sp-api-runtime/sp-api-runtime.module';
import { VariantCheckModule } from '../src/variant-check/variant-check.module';
import { WebSocketModule } from '../src/websocket/websocket.module';
import { WebSocketService } from '../src/websocket/websocket.service';
import { asinWriteApp } from './helpers/asin-write-app';

interface CheckRuntime {
  queues: Queue[];
  workers: Worker[];
  close(): Promise<void>;
}
const compiled = createRequire(resolve(__dirname, '../../worker/dist/main.js'));
const fullTitle = '完整检查结果'.repeat(50_000) + '-tail';
const parent = 'B999999999';
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
class Client {
  readonly socket: WebSocket;
  readonly messages: WsMessage[] = [];
  readonly connected: Promise<void>;
  readonly closed: Promise<void>;
  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(new URL('/ws', url.replace(/^http/, 'ws')), {
      headers,
    });
    this.socket.on('error', () => undefined);
    this.closed = new Promise((yes) => this.socket.once('close', () => yes()));
    this.connected = new Promise((yes) =>
      this.socket.on('message', (raw) => {
        const message = wsMessageSchema.parse(JSON.parse(raw.toString()));
        this.messages.push(message);
        if (message.type === 'connected') yes();
      }),
    );
  }
  task(id: string) {
    return this.messages.filter(
      (item) => 'taskId' in item && item.taskId === id,
    );
  }
}

/** Only the HTTP transport is replaced. Nest providers, catalog pipeline,
 * transactions, Redis admission, compiled BullMQ processors and WS are real. */
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'variant checks / HTTP, compiled Worker, PostgreSQL, Redis and two API gateways',
  () => {
    const prefix = `fixture-check105-${randomUUID()}`;
    let f: Awaited<ReturnType<typeof asinWriteApp>>;
    let second: NestFastifyApplication | undefined;
    let runtime: CheckRuntime | undefined;
    let store: RedisTaskRepository;
    let owner: Awaited<ReturnType<typeof login>>;
    let counter = 0;
    const clients: Client[] = [];
    const fatal = vi.fn();
    const fixtureEnv = {
      SP_API_LWA_CLIENT_ID: 'fixture-client-105',
      SP_API_LWA_CLIENT_SECRET: 'fixture-secret-105',
      SP_API_REFRESH_TOKEN: 'fixture-refresh-105',
      RATE_LIMITER_KEY_PREFIX: `${prefix}:quota`,
      SP_API_RATE_LIMIT_PER_MINUTE: '120',
      SP_API_RATE_LIMIT_PER_HOUR: '7200',
      SP_API_RATE_LIMIT_SAFETY_FACTOR: '1',
    };
    const transport = {
      request: vi.fn(async (input: HttpInput): Promise<HttpResponse> => {
        if (input.url.hostname === 'api.amazon.com')
          return {
            statusCode: 200,
            headers: {},
            body: '{"access_token":"fixture-token-105","token_type":"bearer","expires_in":3600}',
          };
        if (input.url.hostname !== 'sellingpartnerapi-na.amazon.com')
          throw new Error('Unexpected fixture upstream host');
        const asin = input.url.pathname.match(
          /^\/catalog\/2022-04-01\/items\/(B\d{9})$/,
        )?.[1];
        if (!asin) throw new Error('Unexpected fixture upstream path');
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            asin,
            summaries: [{ itemName: fullTitle, brand: 'Fixture brand' }],
            relationships: [
              {
                relationships: [
                  {
                    type: 'VARIATION',
                    ...(asin === parent
                      ? { childAsins: ['B000000001'] }
                      : { parentAsins: [parent] }),
                  },
                ],
              },
            ],
          }),
        };
      }),
    };
    beforeAll(async () => {
      f = await asinWriteApp(
        (builder) =>
          builder
            .overrideProvider(SP_API_QUOTA_ENV)
            .useValue(fixtureEnv)
            .overrideProvider(SpApiHttpTransport)
            .useValue(transport)
            .overrideProvider(SpApiHtmlHttpTransport)
            .useValue({
              request: async () => {
                throw new Error('Unexpected HTML fallback');
              },
            }),
        {
          imports: [VariantCheckModule, WebSocketModule],
          env: {
            BULL_PREFIX: prefix,
            RATE_LIMITER_KEY_PREFIX: fixtureEnv.RATE_LIMITER_KEY_PREFIX,
            BATCH_CHECK_GROUP_CONCURRENCY: 1,
          },
        },
      );
      await f.pools.primaryPool.query(
        'CREATE TABLE monitor_history (LIKE public.monitor_history INCLUDING ALL)',
      );
      const connection = await f.pools.primaryPool.connect();
      try {
        await connection.query(
          readFileSync(
            resolve(
              __dirname,
              '../../../packages/db/migrations/0006_variant_check_receipts.sql',
            ),
            'utf8',
          ).replaceAll('public', f.schema),
        );
      } finally {
        connection.release();
      }
      store = new RedisTaskRepository(f.redis.client, f.env);
      f.app.get(WebSocketService).init(f.app.getHttpServer());
      await f.app.listen(0, '127.0.0.1');
      const module = await Test.createTestingModule({
        imports: [WebSocketModule],
      })
        .overrideProvider(ENV)
        .useValue(f.env)
        .overrideProvider(AppLogger)
        .useValue(f.logger)
        .compile();
      second = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      configureHttpApp(second, { logger: f.logger as unknown as AppLogger });
      second.get(WebSocketService).init(second.getHttpServer());
      await second.listen(0, '127.0.0.1');
      await vi.waitFor(
        async () =>
          expect(
            await f.redis.client.pubsub(
              'NUMSUB',
              taskNotificationChannel(prefix),
            ),
          ).toEqual([taskNotificationChannel(prefix), 2]),
        { timeout: 5000 },
      );
      owner = await login();
    }, 20_000);
    afterEach(async () => {
      await runtime?.close();
      runtime = undefined;
      for (const client of clients) client.socket.terminate();
      await Promise.all(clients.map((client) => client.closed));
      clients.length = 0;
      expect(fatal).not.toHaveBeenCalled();
      // Keep the fixture's tracked auth cache spy installed until f.close().
      transport.request.mockClear();
    });
    afterAll(async () => {
      try {
        await runtime?.close();
        await second?.close();
        if (f) {
          let cursor = '0',
            pages = 0;
          do {
            if (++pages > 100)
              throw new Error('Fixture cleanup bound exceeded');
            const [next, keys] = await f.redis.client.scan(
              cursor,
              'MATCH',
              `${prefix}:*`,
              'COUNT',
              100,
            );
            cursor = next;
            if (keys.some((key) => !key.startsWith(`${prefix}:`)))
              throw new Error('Fixture namespace escaped');
            if (keys.length) await f.redis.del(...keys);
          } while (cursor !== '0');
        }
      } finally {
        if (f) await f.close();
        vi.restoreAllMocks();
      }
    });
    async function login() {
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u105-${userId}`, 'unused-fixture-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
        [userId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      return {
        userId,
        sessionId,
        headers: {
          authorization: `Bearer ${jwt.sign(
            { userId, sessionId },
            f.env.JWT_SECRET,
            { expiresIn: '1h' },
          )}`,
          origin: f.env.CORS_ORIGIN,
        },
      };
    }
    async function group(count = 1) {
      const id = randomUUID();
      await f.pools.primaryPool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand) VALUES($1,$1,'US','amazon.com','Fixture')",
        [id],
      );
      const children: { id: string; asin: string }[] = [];
      for (let i = 0; i < count; i++) {
        const child = {
          id: randomUUID(),
          asin: `B${String(++counter).padStart(9, '0')}`,
        };
        await f.pools.primaryPool.query(
          "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) VALUES($1,$2,'US','amazon.com','Fixture',$3)",
          [child.id, child.asin, id],
        );
        children.push(child);
      }
      return { id, children };
    }
    const post = (
      path: string,
      payload: Record<string, unknown> = {},
      headers: Record<string, string> = owner.headers,
    ) =>
      f.http.inject({
        method: 'POST',
        url: `/api/v1${path}`,
        headers,
        payload,
      });
    const get = (id: string, suffix = '', headers = owner.headers) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${id}${suffix}`,
        headers,
      });
    const history = async (id: string) =>
      (
        await f.pools.primaryPool.query(
          'SELECT * FROM monitor_history WHERE asin_id=$1',
          [id],
        )
      ).rows;
    async function start() {
      const spApi = compiled(
        '@asin-monitor/sp-api',
      ) as typeof import('@asin-monitor/sp-api');
      vi.spyOn(spApi.NodeHttpTransport.prototype, 'request').mockImplementation(
        transport.request,
      );
      const worker = compiled('./variant-check-runtime.js') as {
        startVariantCheckRuntime(
          env: Env,
          queues: string[],
          fatal: () => void,
          environment: Record<string, unknown>,
        ): Promise<CheckRuntime>;
      };
      runtime = await worker.startVariantCheckRuntime(
        f.env,
        ['variant-check', 'batch-check'],
        fatal,
        fixtureEnv,
      );
      expect(
        runtime.queues.every(
          (queue) => queue.opts.prefix === getNeoQueuePrefix(f.env),
        ),
      ).toBe(true);
    }
    async function submitted(
      path: string,
      payload: Record<string, unknown> = {},
    ) {
      const response = await post(path, payload);
      expect(response.statusCode, response.body.slice(0, 1000)).toBe(200);
      const id = response.json().data.taskId as string;
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      return id;
    }
    async function complete(id: string) {
      await vi.waitFor(
        async () => expect((await store.read(id))?.status).toBe('completed'),
        { timeout: 15_000, interval: 50 },
      );
      const response = await get(id);
      expect(response.statusCode, response.body.slice(0, 1000)).toBe(200);
      const result = response.json().data.result;
      const download = await get(id, '/download');
      expect(download.statusCode).toBe(200);
      expect(digest(download.json())).toBe(digest(result));
      expect(
        Buffer.byteLength(JSON.stringify((await store.read(id))!.result)),
      ).toBeLessThan(1000);
      return result;
    }
    async function connect(index: number, account = owner) {
      const client = new Client(
        await (index === 0 ? f.app : second!).getUrl(),
        account.headers,
      );
      clients.push(client);
      await client.connected;
      return client;
    }
    it('executes anonymous sync and owned async single checks, preserves full output and notifies both gateways', async () => {
      const g = await group(),
        child = g.children[0];
      const sync = await post(`/asins/${child.id}/check`, {}, {});
      expect(sync.statusCode).toBe(200);
      expect(sync.body.includes(fullTitle)).toBe(true);
      expect(await history(child.id)).toHaveLength(1);
      const a = await connect(0),
        b = await connect(1),
        foreign = await connect(1, await login());
      await start();
      const id = await submitted(`/asins/${child.id}/check`);
      const result = await complete(id);
      expect(JSON.stringify(result).includes(fullTitle)).toBe(true);
      expect(await history(child.id)).toHaveLength(2);
      await vi.waitFor(() => {
        for (const client of [a, b])
          expect(
            client.task(id).filter((m) => m.type === 'task_complete'),
          ).toHaveLength(1);
      });
      expect(foreign.task(id)).toEqual([]);
      expect((await get(id, '', (await login()).headers)).statusCode).toBe(403);
    }, 25_000);
    it('executes group and batch HTTP jobs with complete group snapshots and per-group results', async () => {
      const first = await group(2),
        secondGroup = await group(1);
      await start();
      const groupId = await submitted(`/variant-groups/${first.id}/check`);
      const groupResult = await complete(groupId);
      expect(groupResult.groupSnapshot.children).toHaveLength(2);
      expect(groupResult.details.results).toHaveLength(2);
      const batchId = await submitted('/variant-groups/batch-check', {
        groupIds: [first.id, secondGroup.id],
        forceRefresh: true,
      });
      const batch = await complete(batchId);
      expect(batch).toMatchObject({
        total: 2,
        successCount: 2,
        failedCount: 0,
      });
      expect(
        batch.results.map((item: { groupId: string }) => item.groupId),
      ).toEqual([first.id, secondGroup.id]);
      expect(JSON.stringify(batch).includes(fullTitle)).toBe(true);
      for (const child of [...first.children, ...secondGroup.children])
        expect(await history(child.id)).toEqual([]);
    }, 30_000);
    it('executes parent lookup with duplicates and the complete second-pass parent title', async () => {
      const g = await group(),
        asin = g.children[0].asin;
      await start();
      const id = await submitted('/variant-check/batch-query-parent-asin', {
        asins: [asin.toLowerCase(), asin],
        country: 'us',
      });
      const result = await complete(id);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        asin,
        hasParentAsin: true,
        parentAsin: parent,
      });
      expect(digest(result[0].title)).toBe(digest(fullTitle));
      expect(digest(result[0].parentTitle)).toBe(digest(fullTitle));
      expect(digest(result[1])).toBe(digest(result[0]));
      expect(await history(g.children[0].id)).toEqual([]);
    }, 25_000);
    it('recovers an exhausted Redis completion acknowledgement without repeating the upstream check or history', async () => {
      const g = await group(),
        child = g.children[0];
      const db = compiled(
        '@asin-monitor/db',
      ) as typeof import('@asin-monitor/db');
      const original = db.RedisTaskRepository.prototype.mutate;
      const mutation = vi
        .spyOn(db.RedisTaskRepository.prototype, 'mutate')
        .mockImplementation(function (
          this: RedisTaskRepository,
          id,
          change,
          identity,
        ) {
          if (change.kind === 'check-completed')
            return Promise.reject(
              new Error('Fixture lost Redis completion acknowledgement'),
            );
          return original.call(this, id, change, identity);
        });
      try {
        await start();
        const id = await submitted(`/asins/${child.id}/check`);
        const queue = runtime!.queues.find(
          (queue) => queue.name === getPhysicalQueueName('variant-check'),
        )!;
        await vi.waitFor(
          async () =>
            expect(await (await queue.getJob(id))?.getState()).toBe('failed'),
          { timeout: 15_000, interval: 50 },
        );
        expect(await history(child.id)).toHaveLength(1);
        const catalogCalls = transport.request.mock.calls.filter(([input]) =>
          input.url.pathname.endsWith(child.asin),
        );
        expect(catalogCalls).toHaveLength(1);
        mutation.mockRestore();
        const recovered = await get(id);
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json().data.status).toBe('completed');
        await complete(id);
        expect(await history(child.id)).toHaveLength(1);
      } finally {
        mutation.mockRestore();
      }
    }, 25_000);
    it('cancels a submitted batch before execution without producing receipts or history', async () => {
      const g = await group();
      const id = await submitted('/variant-groups/batch-check', {
        groupIds: [g.id],
      });
      expect((await post(`/tasks/${id}/cancel`)).statusCode).toBe(200);
      await start();
      expect((await get(id)).json().data.status).toBe('cancelled');
      expect((await get(id, '/download')).statusCode).toBe(409);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT operation_key FROM variant_check_receipts WHERE task_id=$1',
            [id],
          )
        ).rows,
      ).toEqual([]);
      expect(await history(g.children[0].id)).toEqual([]);
    }, 20_000);
  },
);
