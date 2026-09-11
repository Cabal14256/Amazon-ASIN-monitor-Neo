import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  type Env,
} from '@asin-monitor/config';
import { wsMessageSchema, type WsMessage } from '@asin-monitor/contracts';
import {
  encodeTaskNotification,
  RedisTaskRepository,
  taskNotificationChannel,
} from '@asin-monitor/db';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { RedisWebSocketEventBus } from '../src/websocket/redis-websocket-events';
import { WS_EVENT_BUS } from '../src/websocket/websocket-events';
import { WebSocketModule } from '../src/websocket/websocket.module';
import { WebSocketService } from '../src/websocket/websocket.service';
import { asinWriteApp } from './helpers/asin-write-app';

class Client {
  readonly socket: WebSocket;
  readonly messages: WsMessage[] = [];
  readonly connected: Promise<void>;
  readonly closed: Promise<number>;
  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url + '/ws', { headers });
    this.socket.on('error', () => undefined);
    this.closed = new Promise((resolve) => this.socket.once('close', resolve));
    this.connected = new Promise((resolve) =>
      this.socket.on('message', (raw) => {
        const message = wsMessageSchema.parse(JSON.parse(raw.toString()));
        this.messages.push(message);
        if (message.type === 'connected') resolve();
      }),
    );
  }
  task(id: string) {
    return this.messages.filter(
      (message) => 'taskId' in message && message.taskId === id,
    );
  }
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'task Pub/Sub / real Redis, PostgreSQL, two API gateways and compiled Worker',
  () => {
    const prefix = `fixture-task-ws103-${randomUUID()}`;
    let f: Awaited<ReturnType<typeof asinWriteApp>>,
      second: NestFastifyApplication,
      env: Env;
    let redis: Redis, store: RedisTaskRepository, queue: Queue;
    const buses: RedisWebSocketEventBus[] = [];
    const urls: string[] = [];
    const clients: Client[] = [];
    const keys = new Set<string>();
    let owner: {
      userId: string;
      sessionId: string;
      headers: Record<string, string>;
    };
    const channel = taskNotificationChannel(prefix);
    beforeAll(async () => {
      f = await asinWriteApp((builder) =>
        builder
          .overrideProvider(TaskQueryRuntime)
          .useFactory({
            inject: [ENV, AppLogger],
            factory: (source: Env, logger: AppLogger) => {
              env = {
                ...source,
                BULL_PREFIX: prefix,
                BATCH_DELETE_CHUNK_SIZE: 1,
              };
              return new TaskQueryRuntime(env, logger);
            },
          })
          .overrideProvider(WS_EVENT_BUS)
          .useFactory({
            inject: [ENV, AppLogger],
            factory: (source: Env, logger: AppLogger) =>
              new RedisWebSocketEventBus(
                { ...source, BULL_PREFIX: prefix },
                logger,
              ),
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
      queue = new Queue(getPhysicalQueueName('batch-delete'), {
        prefix: getNeoQueuePrefix(env),
        connection: redis as any,
      });
      queue.on('error', () => undefined);
      await queue.waitUntilReady();
      for (const table of ['monitor_history', 'audit_logs_archive'])
        await f.pools.primaryPool.query(
          `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
        );
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:delete' ON CONFLICT DO NOTHING",
      );
      await f.pools.primaryPool.query(
        'CREATE FUNCTION slow_ws_delete_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN OLD; END $$',
      );
      await f.pools.primaryPool.query(
        'CREATE TRIGGER slow_ws_delete_fixture BEFORE DELETE ON asins FOR EACH ROW EXECUTE FUNCTION slow_ws_delete_fixture()',
      );
      f.app.get(WebSocketService).init(f.app.getHttpServer());
      await f.app.listen(0, '127.0.0.1');
      buses.push(f.app.get(WS_EVENT_BUS));
      urls.push((await f.app.getUrl()).replace(/^http/, 'ws'));
      const module = await Test.createTestingModule({
        imports: [WebSocketModule],
      })
        .overrideProvider(ENV)
        .useValue(env)
        .overrideProvider(AppLogger)
        .useValue(f.logger)
        .compile();
      second = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      configureHttpApp(second, { logger: f.logger as unknown as AppLogger });
      second.get(WebSocketService).init(second.getHttpServer());
      await second.listen(0, '127.0.0.1');
      buses.push(second.get(WS_EVENT_BUS));
      urls.push((await second.getUrl()).replace(/^http/, 'ws'));
      await subscribed(2);
      owner = await login();
    }, 20_000);
    async function subscribed(count: number) {
      await vi.waitFor(
        async () =>
          expect(await redis.pubsub('NUMSUB', channel)).toEqual([
            channel,
            count,
          ]),
        { timeout: 5000, interval: 20 },
      );
      if (count)
        await vi.waitFor(() =>
          expect(buses.every((bus) => bus['reader']?.status === 'ready')).toBe(
            true,
          ),
        );
    }
    async function login() {
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `ws103-${userId}`, 'unused-fixture-hash'],
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
            env.JWT_SECRET,
            { expiresIn: '1h' },
          )}`,
          origin: env.CORS_ORIGIN,
        },
      };
    }
    async function connect(index = 0, account = owner) {
      const client = new Client(urls[index], account.headers);
      clients.push(client);
      await client.connected;
      return client;
    }
    async function create(account = owner) {
      const taskId = randomUUID();
      keys.add(`${prefix}:neo:task:meta:${taskId}`);
      keys.add(`${prefix}:neo:task:user:${account.userId}`);
      return store.create({
        taskId,
        userId: account.userId,
        taskType: 'batch-delete',
      });
    }
    const query = (id: string, account = owner) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${id}`,
        headers: account.headers,
      });
    afterEach(async () => {
      for (const client of clients) client.socket.terminate();
      await Promise.all(clients.map((client) => client.closed));
      clients.length = 0;
    });
    afterAll(async () => {
      try {
        if (second) await second.close();
        if (f) await f.close();
      } finally {
        try {
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
                throw new Error('Unexpected task WS fixture cleanup size');
              const [next, found] = await redis.scan(
                cursor,
                'MATCH',
                `${prefix}:*`,
                'COUNT',
                100,
              );
              cursor = next;
              for (const key of found) {
                if (!key.startsWith(`${prefix}:`))
                  throw new Error('Fixture namespace escaped');
                keys.add(key);
              }
            } while (cursor !== '0');
            if (keys.size) await redis.del(...keys);
          }
        } finally {
          redis?.disconnect(false);
        }
      }
    });

    it.skipIf(process.platform === 'win32')(
      'delivers business progress and one terminal result from a separate compiled Worker to both API instances',
      async () => {
        const a = await connect(0),
          b = await connect(1),
          foreign = await connect(1, await login());
        const groupIds = Array.from({ length: 5 }, () => randomUUID());
        for (const id of groupIds) {
          await f.pools.primaryPool.query(
            "INSERT INTO variant_groups(id,name,country,site,brand) VALUES($1,$1,'US','amazon.com','fixture')",
            [id],
          );
          await f.pools.primaryPool.query(
            "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) VALUES($1,$1,'US','amazon.com','fixture',$2)",
            [randomUUID(), id],
          );
        }
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
              WORKER_ENABLED_QUEUES: 'batch-delete',
              BATCH_DELETE_CHUNK_SIZE: '1',
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
          output = (output + chunk.toString()).slice(-32000);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('exit', (code, signal) => {
          outcome = { code, signal };
        });
        child.on('error', () => {
          output += 'fixture child start failed';
        });
        try {
          await vi.waitFor(
            () => {
              expect(outcome, output).toBeUndefined();
              expect(output).toContain('Worker 已启动');
            },
            { timeout: 10000, interval: 20 },
          );
          const response = await f.http.inject({
            method: 'POST',
            url: '/api/v1/variant-groups/batch-delete',
            headers: owner.headers,
            payload: { groupIds, useAsync: true },
          });
          expect(response.statusCode).toBe(200);
          const id = response.json().data.taskId as string;
          await vi.waitFor(
            () => {
              for (const client of [a, b]) {
                expect(
                  client.task(id).filter((m) => m.type === 'task_complete'),
                ).toHaveLength(1);
                expect(
                  client
                    .task(id)
                    .some(
                      (m) =>
                        m.type === 'task_progress' &&
                        m.progress > 0 &&
                        m.progress < 100,
                    ),
                ).toBe(true);
              }
            },
            { timeout: 10000, interval: 20 },
          );
          expect(foreign.task(id)).toEqual([]);
          expect((await query(id)).json().data.status).toBe('completed');
          expect(
            (
              await f.pools.primaryPool.query(
                'SELECT id FROM variant_groups WHERE id=ANY($1::varchar[])',
                [groupIds],
              )
            ).rows,
          ).toEqual([]);
        } finally {
          if (!outcome) child.kill('SIGTERM');
          try {
            await vi.waitFor(() => expect(outcome).toBeDefined(), {
              timeout: 12000,
              interval: 25,
            });
          } catch {
            child.kill('SIGKILL');
            throw new Error(
              'Compiled WS fixture Worker shutdown exceeded bound',
            );
          }
        }
        expect(outcome).toEqual({ code: 0, signal: null });
      },
      30000,
    );

    it.each(['failed', 'cancelled'] as const)(
      'publishes committed %s without raw failures or duplicate terminal events',
      async (status) => {
        const a = await connect(),
          b = await connect(1);
        const task = await create();
        await store.mutate(
          task.taskId,
          status === 'failed'
            ? { kind: 'failed', message: 'private-token-fixture' }
            : { kind: 'cancelled', message: '任务已取消' },
        );
        const terminal = status === 'failed' ? 'task_error' : 'task_cancelled';
        await vi.waitFor(() => {
          for (const client of [a, b])
            expect(
              client.task(task.taskId).filter((m) => m.type === terminal),
            ).toHaveLength(1);
        });
        const current = (await store.read(task.taskId))!;
        for (let i = 0; i < 5; i++)
          await redis.publish(
            channel,
            encodeTaskNotification(i % 2 ? task : current),
          );
        await store.mutate(task.taskId, { kind: 'completed' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        for (const client of [a, b]) {
          expect(
            client.task(task.taskId).filter((m) => m.type === terminal),
          ).toHaveLength(1);
          expect(JSON.stringify(client.task(task.taskId))).not.toContain(
            'private-token-fixture',
          );
        }
      },
    );

    it('ignores other environments, malformed messages, expired tasks and replaced identities', async () => {
      const client = await connect(),
        stranger = await login();
      const task = await create();
      await vi.waitFor(() =>
        expect(client.task(task.taskId).length).toBeGreaterThan(0),
      );
      client.messages.length = 0;
      const key = `${prefix}:neo:task:meta:${task.taskId}`;
      await redis.del(key);
      await redis.publish(channel, encodeTaskNotification(task));
      await redis.set(
        key,
        JSON.stringify({ ...task, userId: stranger.userId, revision: 100 }),
        'EX',
        60,
      );
      await redis.publish(
        channel,
        encodeTaskNotification({ ...task, revision: 99 }),
      );
      await redis.publish(channel, '{');
      await redis.publish(channel, 'x'.repeat(4097));
      await redis.publish(
        channel,
        JSON.stringify({
          ...JSON.parse(encodeTaskNotification(task)),
          version: 2,
        }),
      );
      await redis.publish(
        channel + '-other',
        encodeTaskNotification({ ...task, revision: 200 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.task(task.taskId)).toEqual([]);
      expect((await query(task.taskId)).statusCode).toBe(403);
    });

    it('recovers authoritative HTTP state after an outage and resubscribes both API instances', async () => {
      const a = await connect(),
        b = await connect(1),
        task = await create();
      await vi.waitFor(() =>
        expect(
          [a, b].every((client) => client.task(task.taskId).length > 0),
        ).toBe(true),
      );
      const subscribers = buses.map((bus) => bus['subscriber']!);
      for (const subscriber of subscribers)
        subscriber.options.retryStrategy = () => 1500;
      try {
        const closed = subscribers.map((subscriber) =>
          once(subscriber, 'close'),
        );
        subscribers.forEach((subscriber) => subscriber.disconnect(true));
        await Promise.all(closed);
        await subscribed(0);
        await store.mutate(task.taskId, {
          kind: 'completed',
          result: { count: 1 },
        });
        const snapshot = await query(task.taskId);
        expect(snapshot.statusCode).toBe(200);
        expect(snapshot.json().data).toMatchObject({
          status: 'completed',
          result: { count: 1 },
        });
        expect(
          [a, b].every(
            (client) =>
              !client.task(task.taskId).some((m) => m.type === 'task_complete'),
          ),
        ).toBe(true);
        await subscribed(2);
        const next = await create();
        await store.mutate(next.taskId, { kind: 'completed' });
        await vi.waitFor(() =>
          expect(
            [a, b].every((client) =>
              client.task(next.taskId).some((m) => m.type === 'task_complete'),
            ),
          ).toBe(true),
        );
      } finally {
        for (const subscriber of subscribers)
          subscriber.options.retryStrategy = (attempt) =>
            Math.min(200 * attempt, 1000);
      }
    });

    it.each(['session', 'account'] as const)(
      'rejects committed %s revocation on both established gateways',
      async (kind) => {
        const account = await login(),
          a = await connect(0, account),
          b = await connect(1, account);
        if (kind === 'session')
          await f.pools.primaryPool.query(
            "UPDATE sessions SET status='REVOKED' WHERE id=$1",
            [account.sessionId],
          );
        else
          await f.pools.primaryPool.query(
            "UPDATE users SET status='SUSPENDED' WHERE id=$1",
            [account.userId],
          );
        const task = await create(account);
        await store.mutate(task.taskId, { kind: 'completed' });
        expect(await Promise.all([a.closed, b.closed])).toEqual([4403, 4403]);
        expect(a.task(task.taskId)).toEqual([]);
        expect(b.task(task.taskId)).toEqual([]);
        expect((await query(task.taskId, account)).statusCode).toBe(403);
      },
    );
  },
);
