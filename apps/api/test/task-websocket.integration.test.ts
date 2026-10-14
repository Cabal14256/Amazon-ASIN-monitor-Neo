import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  type Env,
} from '@asin-monitor/config';
import { wsMessageSchema, type WsMessage } from '@asin-monitor/contracts';
import {
  createPgPool,
  encodeTaskNotification,
  monitorEventChannel,
  RedisMonitorEventRepository,
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
import { readFileSync } from 'node:fs';
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
    const competitorSchema = `monitor_ws252_${randomUUID().replace(/-/g, '')}`;
    let competitorBootstrap: ReturnType<typeof createPgPool>;
    let competitorInstalled = false;
    beforeAll(async () => {
      competitorBootstrap = createPgPool(process.env.COMPETITOR_DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 2000,
      });
      await competitorBootstrap.query(`CREATE SCHEMA ${competitorSchema}`);
      competitorInstalled = true;
      const competitorUrl = new URL(process.env.COMPETITOR_DATABASE_URL!);
      competitorUrl.searchParams.set(
        'options',
        `-c search_path=${competitorSchema} -c timezone=UTC`,
      );
      f = await asinWriteApp(
        (builder) =>
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
        { env: { COMPETITOR_DATABASE_URL: competitorUrl.toString() } },
      );
      const primaryIdentity = await f.pools.primaryPool.query(
        'SELECT current_database() AS database, current_schema() AS schema',
      );
      const competitorIdentity = await f.pools.competitorPool.query(
        'SELECT current_database() AS database, current_schema() AS schema',
      );
      expect(competitorIdentity.rows[0].database).not.toBe(
        primaryIdentity.rows[0].database,
      );
      expect(primaryIdentity.rows[0].schema).toBe(f.schema);
      expect(competitorIdentity.rows[0].schema).toBe(competitorSchema);
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
        'CREATE TABLE feishu_config (LIKE public.feishu_config INCLUDING ALL)',
      );
      const primary = await f.pools.primaryPool.connect();
      try {
        for (const name of [
          '0006_variant_check_receipts.sql',
          '0012_primary_monitor.sql',
        ])
          await primary.query(
            readFileSync(
              resolve(__dirname, '../../../packages/db/migrations', name),
              'utf8',
            ).replaceAll('public', f.schema),
          );
        await primary.query(`SET search_path TO ${f.schema}`);
      } finally {
        primary.release();
      }
      for (const table of [
        'competitor_variant_groups',
        'competitor_asins',
        'competitor_monitor_history',
        'competitor_feishu_config',
      ])
        await competitorBootstrap.query(
          `CREATE TABLE ${competitorSchema}.${table} (LIKE public.${table} INCLUDING ALL)`,
        );
      const competitor = await f.pools.competitorPool.connect();
      try {
        // LIKE does not copy the timestamp triggers or policy index comments.
        // Install the real write policy in this private schema; the shared
        // imported matching collation remains read-only in public.
        let policy = readFileSync(
          resolve(
            __dirname,
            '../../../packages/db/migrations/0011_competitor_write_policy.sql',
          ),
          'utf8',
        );
        for (const name of [
          'competitor_variant_groups',
          'competitor_asins',
          'set_competitor_update_timestamp',
          'idx_neo_competitor_write_asin_country',
        ])
          policy = policy.replaceAll(
            `public.${name}`,
            `${competitorSchema}.${name}`,
          );
        await competitor.query(policy);
        for (const name of [
          '0014_competitor_check_receipts.sql',
          '0015_competitor_monitor.sql',
        ])
          await competitor.query(
            readFileSync(
              resolve(__dirname, '../../../packages/db/migrations', name),
              'utf8',
            ).replaceAll('public', competitorSchema),
          );
        await competitor.query(`SET search_path TO ${competitorSchema}`);
      } finally {
        competitor.release();
      }
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='monitor:write' ON CONFLICT DO NOTHING",
      );
      await f.pools.primaryPool.query(
        'CREATE FUNCTION slow_ws_monitor_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$',
      );
      await f.pools.primaryPool.query(
        'CREATE TRIGGER slow_ws_monitor_fixture BEFORE INSERT ON monitor_history FOR EACH ROW EXECUTE FUNCTION slow_ws_monitor_fixture()',
      );
      await f.pools.competitorPool.query(
        'CREATE FUNCTION slow_ws_monitor_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$',
      );
      await f.pools.competitorPool.query(
        'CREATE TRIGGER slow_ws_monitor_fixture BEFORE INSERT ON competitor_monitor_history FOR EACH ROW EXECUTE FUNCTION slow_ws_monitor_fixture()',
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
        try {
          if (second) await second.close();
        } finally {
          try {
            if (f) await f.close();
          } finally {
            try {
              if (competitorInstalled)
                await competitorBootstrap.query(
                  `DROP SCHEMA ${competitorSchema} CASCADE`,
                );
            } finally {
              await competitorBootstrap?.end();
            }
          }
        }
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

    it
      .skipIf(process.platform === 'win32')
      .each(['primary', 'competitor'] as const)(
      'broadcasts the compiled %s manual monitor through Redis to both API instances and rechecks each receiver session',
      async (domain) => {
        const a = await connect(),
          b = await connect(1),
          foreign = await connect(1, await login());
        const revokedAccount = await login(),
          revoked = await connect(1, revokedAccount);
        await f.pools.primaryPool.query(
          "UPDATE sessions SET status='REVOKED' WHERE id=$1",
          [revokedAccount.sessionId],
        );
        const competitor = domain === 'competitor',
          queueName = competitor ? 'competitor-monitor' : 'monitor';
        const table = competitor
          ? 'competitor_variant_groups'
          : 'variant_groups';
        const pool = competitor ? f.pools.competitorPool : f.pools.primaryPool;
        const count = competitor ? 3 : 11;
        const groupIds = Array.from({ length: count }, () =>
          randomUUID(),
        ).sort();
        for (const id of groupIds)
          await pool.query(
            competitor
              ? "INSERT INTO competitor_variant_groups(id,name,country,brand,feishu_notify_enabled) VALUES($1,$1,'US','fixture',false)"
              : "INSERT INTO variant_groups(id,name,country,site,brand,feishu_notify_enabled) VALUES($1,$1,'US','amazon.com','fixture',false)",
            [id],
          );
        const monitorQueue = new Queue(getPhysicalQueueName(queueName), {
          prefix: getNeoQueuePrefix(env),
          connection: redis as any,
        });
        monitorQueue.on('error', () => undefined);
        await monitorQueue.waitUntilReady();
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
              COMPETITOR_DATABASE_URL: env.COMPETITOR_DATABASE_URL,
              REDIS_URL: env.REDIS_URL,
              BULL_PREFIX: prefix,
              WORKER_ENABLED_QUEUES: queueName,
              COMPETITOR_MONITOR_ENABLED: 'true',
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
          const task = await store.create({
            taskId: randomUUID(),
            userId: owner.userId,
            taskType: queueName,
            taskSubType: domain,
          });
          const job = {
            taskId: task.taskId,
            userId: task.userId,
            taskType: queueName,
            taskSubType: domain,
            createdAt: task.createdAt,
            expiresAt: new Date(
              Date.parse(task.createdAt) + 604800000,
            ).toISOString(),
            countries: ['US'],
          };
          await monitorQueue.add(
            competitor ? 'competitor-monitor' : 'primary-monitor',
            job,
            { jobId: task.taskId, attempts: 1 },
          );
          const monitor = (client: Client) =>
            client.messages.filter(
              (
                m,
              ): m is Extract<
                WsMessage,
                { type: 'monitor_progress' | 'monitor_complete' }
              > =>
                (m.type === 'monitor_progress' ||
                  m.type === 'monitor_complete') &&
                !!m.isCompetitor === competitor,
            );
          await vi.waitFor(
            async () => {
              expect((await store.read(task.taskId))?.status, output).toBe(
                'completed',
              );
              for (const client of [a, b, foreign]) {
                const messages = monitor(client);
                expect(
                  messages.filter((m) => m.type === 'monitor_complete'),
                ).toHaveLength(1);
                expect(
                  messages.find(
                    (m) =>
                      m.type === 'monitor_progress' && m.status === 'started',
                  ),
                ).toMatchObject({ countries: ['US'], batchInfo: null });
                const progress = messages.filter(
                  (m) =>
                    m.type === 'monitor_progress' && m.status === 'progress',
                );
                expect(
                  progress.map((m) => (m as { current: number }).current),
                ).toEqual(competitor ? [1, 2, 3] : [10, 11]);
                expect(
                  messages.find((m) => m.type === 'monitor_complete'),
                ).toMatchObject({
                  success: true,
                  totalChecked: count,
                  totalBroken: count,
                  totalNormal: 0,
                  duration: expect.stringMatching(/^\d+\.\d{2}$/),
                  countryResults: {
                    US: {
                      country: 'US',
                      totalGroups: count,
                      brokenGroups: count,
                      brokenGroupNames: groupIds,
                      checkedGroupKeys: groupIds.map((id) => `group:${id}`),
                      brokenASINs: [],
                      asinClassifications: {},
                      brokenByType: {
                        SP_API_ERROR: 0,
                        NOT_FOUND: 0,
                        NO_VARIANTS: 0,
                      },
                      checkTime: expect.stringMatching(/Z$/),
                    },
                  },
                });
                expect(
                  messages.every(
                    (m) => 'timestamp' in m && m.timestamp.endsWith('+08:00'),
                  ),
                ).toBe(true);
              }
            },
            { timeout: 15000, interval: 20 },
          );
          expect(await revoked.closed).toBe(4403);
          expect(monitor(revoked)).toEqual([]);
          expect(foreign.task(task.taskId)).toEqual([]);
          expect((await store.read(task.taskId))?.status).toBe('completed');
          const committed = await pool.query(
            `SELECT count(*)::int AS count FROM ${
              competitor ? 'competitor_monitor_history' : 'monitor_history'
            } WHERE monitor_task_id=$1 AND check_type='GROUP'`,
            [task.taskId],
          );
          expect(committed.rows[0].count).toBe(count);
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
              'Compiled monitor WS Worker shutdown exceeded bound',
            );
          }
          await monitorQueue.obliterate({ force: true });
          await monitorQueue.close();
          await pool.query(`DELETE FROM ${table} WHERE id=ANY($1::varchar[])`, [
            groupIds,
          ]);
        }
        expect(outcome).toEqual({ code: 0, signal: null });
      },
      45000,
    );

    it('requires a stored monitor proof and drops duplicates, cancelled progress, replaced incarnations and oversized proofs on real Redis', async () => {
      const a = await connect(),
        b = await connect(1, await login());
      const repository = new RedisMonitorEventRepository(redis, env);
      const task = await store.create({
        taskId: randomUUID(),
        userId: owner.userId,
        taskType: 'monitor',
        taskSubType: 'primary',
      });
      const active = (await store.mutate(task.taskId, { kind: 'processing' }))!;
      const started = {
        type: 'monitor_progress' as const,
        status: 'started' as const,
        countries: ['US' as const],
        batchInfo: null,
        timestamp: new Date(Date.now() + 8 * 3600_000)
          .toISOString()
          .replace('Z', '+08:00'),
      };
      const raw = JSON.stringify({
        version: 1,
        type: 'monitor_changed',
        taskId: active.taskId,
        userId: active.userId,
        taskType: active.taskType,
        taskSubType: active.taskSubType,
        createdAt: active.createdAt,
        revision: active.revision,
        slot: 'started',
        sequence: 0,
      });
      const channel = monitorEventChannel(prefix);
      await redis.publish(channel, raw); // Valid hint, absent proof must not broadcast.
      await redis.publish(
        channel,
        JSON.stringify({ ...JSON.parse(raw), payload: started }),
      );
      await redis.publish(channel, 'x'.repeat(4097));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(a.messages.filter((m) => m.type === 'monitor_progress')).toEqual(
        [],
      );
      await repository.publish(active, 0, started);
      await vi.waitFor(() => {
        for (const client of [a, b])
          expect(
            client.messages.filter((m) => m.type === 'monitor_progress'),
          ).toHaveLength(1);
      });
      const notice = JSON.parse(raw);
      expect((await repository.read(notice))?.task.taskId).toBe(active.taskId);
      await repository.publish(active, 0, started);
      for (let index = 0; index < 3; index++) await redis.publish(channel, raw);
      const cancelled = (await store.mutate(task.taskId, {
        kind: 'cancel-request',
      }))!;
      const progress = {
        type: 'monitor_progress' as const,
        timestamp: started.timestamp,
        status: 'progress' as const,
        country: 'US' as const,
        current: 1,
        total: 1,
        progress: 100,
      };
      await expect(
        repository.publish(cancelled, 1, progress),
      ).rejects.toThrow();
      expect(await repository.read(notice)).toBeNull();
      const proofKey = `${prefix}:neo:monitor:proof:${encodeURIComponent(
        task.taskId,
      )}:${encodeURIComponent(task.createdAt)}`;
      const originalProof = (await redis.hget(proofKey, 'started'))!;
      await redis.hset(proofKey, 'started', 'x'.repeat(1024 * 1024 + 2049));
      expect(await repository.read(notice)).toBeNull();
      await redis.hset(proofKey, 'started', originalProof);
      await redis.set(
        `${prefix}:neo:task:meta:${task.taskId}`,
        JSON.stringify({ ...active, userId: 'replaced-owner', revision: 100 }),
        'EX',
        60,
      );
      expect(await repository.read(notice)).toBeNull();
      await redis.set(
        `${prefix}:neo:task:meta:${task.taskId}`,
        'x'.repeat(262145),
        'EX',
        60,
      );
      expect(await repository.read(notice)).toBeNull();
      await repository.publish(active, 0, started);
      expect(await redis.hget(proofKey, 'started')).toBe(originalProof);
      await redis.publish(channel, raw);
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const client of [a, b])
        expect(
          client.messages.filter((m) => m.type === 'monitor_progress'),
        ).toHaveLength(1);
    });

    it('reserves completion capacity after 1000 progress hints and preserves a complete payload larger than 256KiB', async () => {
      const repository = new RedisMonitorEventRepository(redis, env);
      const task = await store.create({
        taskId: randomUUID(),
        userId: owner.userId,
        taskType: 'monitor',
        taskSubType: 'primary',
      });
      const active = (await store.mutate(task.taskId, { kind: 'processing' }))!;
      const timestamp = new Date(Date.now() + 8 * 3600_000)
        .toISOString()
        .replace('Z', '+08:00');
      // Preserve the Worker operation order at half boundaries (145 => 14).
      for (let current = 1; current <= 1000; current++)
        await repository.publish(active, current, {
          type: 'monitor_progress',
          status: 'progress',
          country: 'US',
          current,
          total: 1000,
          progress: Math.round((current / 1000) * 100),
          timestamp,
        });
      const result = {
        success: true,
        totalChecked: 1000,
        totalBroken: 150,
        totalNormal: 850,
        countryResults: { US: { totalGroups: 1000, brokenGroups: 150 } },
      };
      const finished = (await store.mutate(task.taskId, {
        kind: 'completed',
        result,
      }))!;
      const completion = {
        type: 'monitor_complete' as const,
        success: true as const,
        totalChecked: 1000,
        totalBroken: 150,
        totalNormal: 850,
        duration: '2.00',
        timestamp,
        countryResults: {
          US: {
            country: 'US' as const,
            totalGroups: 1000,
            brokenGroups: 150,
            brokenGroupNames: Array.from({ length: 150 }, () =>
              'n'.repeat(2048),
            ),
            brokenGroupDetails: Array.from({ length: 150 }, (_, i) => ({
              variantGroupId: `g-${i}`,
              groupName: 'n'.repeat(2048),
            })),
            brokenASINs: [],
            brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
            checkedGroupKeys: Array.from(
              { length: 1000 },
              (_, i) => `group:${i}`,
            ),
            asinClassifications: {},
            checkTime: task.createdAt,
          },
        },
      };
      expect(Buffer.byteLength(JSON.stringify(completion))).toBeGreaterThan(
        256 * 1024,
      );
      await repository.publish(finished, 7000, completion);
      const proofKey = `${prefix}:neo:monitor:proof:${encodeURIComponent(
        task.taskId,
      )}:${encodeURIComponent(task.createdAt)}`;
      expect(await redis.hlen(proofKey)).toBe(4); // progress+complete and their watermarks, no append.
      const raw = await redis.hget(proofKey, 'complete');
      const storedCompletion = JSON.parse(raw!).message;
      // Zod reconstructs object keys in schema order. Check every field and
      // array value without treating insertion order as payload corruption.
      expect(storedCompletion).toStrictEqual(completion);
      expect(
        Buffer.byteLength(JSON.stringify(storedCompletion)),
      ).toBeGreaterThan(256 * 1024);
      expect(await redis.ttl(proofKey)).toBeGreaterThan(0);
      await expect(
        repository.publish(finished, 7000, {
          ...completion,
          countryResults: {
            US: {
              ...completion.countryResults.US,
              brokenGroupNames: Array.from({ length: 1000 }, () =>
                'n'.repeat(2048),
              ),
            },
          },
        }),
      ).rejects.toThrow('MONITOR_EVENT_TOO_LARGE');
      expect(await redis.hget(proofKey, 'complete')).toBe(raw);
    }, 20000);

    it.skipIf(process.platform === 'win32')(
      'delivers business progress and one terminal result from a separate compiled Worker to both API instances',
      async () => {
        const a = await connect(0),
          b = await connect(1),
          foreign = await connect(1, await login());
        const groupIds = Array.from({ length: 5 }, () => randomUUID());
        for (const [index, id] of groupIds.entries()) {
          await f.pools.primaryPool.query(
            "INSERT INTO variant_groups(id,name,country,site,brand) VALUES($1,$1,'US','amazon.com','fixture')",
            [id],
          );
          await f.pools.primaryPool.query(
            "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) VALUES($1,$2,'US','amazon.com','fixture',$3)",
            [randomUUID(), `B${String(index).padStart(9, '0')}`, id],
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
