import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  type Env,
  type QueueName,
} from '@asin-monitor/config';
import {
  taskInfoResultSchema,
  taskListResultSchema,
} from '@asin-monitor/contracts';
import { RedisTaskRepository, type TaskState } from '@asin-monitor/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ENV } from '../src/config/config.module';
import { AppLogger } from '../src/logger/app-logger.service';
import { TaskQueryModule } from '../src/tasks/task-query.module';
import {
  TASK_QUERY_QUEUES,
  TaskQueryRuntime,
} from '../src/tasks/task-query.runtime';
import { spApiConfigApp } from './helpers/sp-api-config-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'own task queries / real PostgreSQL, Redis and BullMQ',
  () => {
    const prefix = `fixture-task-query95-${randomUUID()}`;
    let f: Awaited<ReturnType<typeof spApiConfigApp>>,
      env: Env,
      redis: Redis,
      store: RedisTaskRepository,
      runtime: TaskQueryRuntime;
    let owner: {
      userId: string;
      sessionId: string;
      headers: { authorization: string };
    };
    const queues = new Map<QueueName, Queue>();
    const metaKey = (id: string) =>
      `${prefix}:neo:task:meta:${encodeURIComponent(id)}`;
    beforeAll(async () => {
      f = await spApiConfigApp({
        imports: [TaskQueryModule],
        configure: (builder) =>
          builder.overrideProvider(TaskQueryRuntime).useFactory({
            inject: [ENV, AppLogger],
            factory: (source: Env, logger: AppLogger) => {
              env = { ...source, BULL_PREFIX: prefix };
              return new TaskQueryRuntime(env, logger);
            },
          }),
      });
      runtime = f.app.get(TaskQueryRuntime);
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
      store = new RedisTaskRepository(redis, env);
    });
    afterAll(async () => {
      try {
        if (f) await f.close();
      } finally {
        try {
          for (const queue of queues.values()) {
            expect(queue.opts.prefix).toBe(`${prefix}:neo`);
            await queue.obliterate({ force: true });
            await queue.close();
          }
          if (redis?.status === 'ready') {
            const keys = new Set<string>();
            let cursor = '0',
              pages = 0;
            do {
              if (++pages > 100)
                throw new Error('Unexpected task fixture scan size');
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
                  throw new Error('Fixture key escaped namespace');
                keys.add(key);
              }
              if (keys.size > 1000)
                throw new Error('Unexpected task fixture key count');
            } while (cursor !== '0');
            if (keys.size) await redis.del(...keys);
          }
        } finally {
          redis?.disconnect(false);
          vi.restoreAllMocks();
        }
      }
    });
    async function login() {
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u95-${userId}`, 'unused-fixture-hash'],
      );
      // Task center is login-only: deliberately grant no role/permission.
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
        },
      };
    }
    beforeEach(async () => {
      for (const queue of queues.values())
        await queue.obliterate({ force: true });
      owner = await login();
    });
    async function queueFor(type: QueueName) {
      let queue = queues.get(type);
      if (!queue) {
        queue = new Queue(getPhysicalQueueName(type), {
          prefix: getNeoQueuePrefix(env),
          connection: {
            url: env.REDIS_URL,
            connectTimeout: 2000,
            commandTimeout: 2000,
            maxRetriesPerRequest: 1,
          },
        });
        queue.on('error', () => undefined);
        queues.set(type, queue);
        await queue.waitUntilReady();
      }
      return queue;
    }
    const create = (id: string, taskType = 'export', userId = owner.userId) =>
      store.create({ taskId: id, userId, taskType });
    const get = (id: string, headers = owner.headers) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${encodeURIComponent(id)}`,
        headers,
      });
    const list = (query = '') =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks${query}`,
        headers: owner.headers,
      });
    async function queued(
      id: string,
      type: QueueName = 'export',
      userId: string | null = owner.userId,
    ) {
      return (await queueFor(type)).add(
        'fixture',
        {
          userId,
          title: 'Fixture task',
          exportType: 'asin',
          createdAt: '2026-09-01T00:00:00.000Z',
        },
        { jobId: id, removeOnComplete: false, removeOnFail: false },
      );
    }
    async function complete(id: string, result: unknown, fail = false) {
      const queue = await queueFor('export');
      await queued(id);
      const worker = new Worker(queue.name, undefined, {
        autorun: false,
        prefix: getNeoQueuePrefix(env),
        connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      });
      worker.on('error', () => undefined);
      try {
        await worker.waitUntilReady();
        const job = await worker.getNextJob('fixture-lock-95', {
          block: false,
        });
        expect(job?.id).toBe(id);
        if (fail)
          await job!.moveToFailed(
            new Error('private-driver-failure-95'),
            'fixture-lock-95',
            false,
          );
        else await job!.moveToCompleted(result, 'fixture-lock-95', false);
      } finally {
        await worker.close(true);
      }
    }
    it('returns only current owner and filters the complete index before limit', async () => {
      await create('active-old');
      await create('foreign', 'export', (await login()).userId);
      for (let index = 0; index < 5; index++) {
        const id = `done-${index}`;
        await create(id);
        await store.mutate(id, { kind: 'completed', result: { total: index } });
      }
      const response = await list('?status=active&limit=1');
      expect(response.statusCode).toBe(200);
      taskListResultSchema.parse(response.json());
      expect(
        response.json().data.map((task: TaskState) => task.taskId),
      ).toEqual(['active-old']);
      expect((await list()).json().data).toHaveLength(6);
      expect(response.headers['cache-control']).toBe('no-store');
    });
    it('observes committed session and account revocation without a permission cache', async () => {
      await create('revoked');
      expect((await get('revoked')).statusCode).toBe(200);
      await f.pools.primaryPool.query(
        "UPDATE sessions SET status='REVOKED' WHERE id=$1",
        [owner.sessionId],
      );
      expect((await get('revoked')).statusCode).toBe(403);
      owner = await login();
      await create('suspended');
      await f.pools.primaryPool.query(
        "UPDATE users SET status='SUSPENDED' WHERE id=$1",
        [owner.userId],
      );
      expect((await get('suspended')).statusCode).toBe(403);
    });
    it.each(TASK_QUERY_QUEUES)(
      'reads an owned %s job when registry is absent without recreating metadata',
      async (type) => {
        const id = `fallback-${type}`;
        await queued(id, type);
        const response = await get(id);
        expect(response.statusCode).toBe(200);
        taskInfoResultSchema.parse(response.json());
        expect(response.json().data).toMatchObject({
          taskId: id,
          taskType: type,
          status: 'pending',
        });
        expect(await store.read(id)).toBeNull();
      },
    );
    it('denies foreign/ownerless queue jobs and foreign metadata without mutation', async () => {
      await queued('foreign-queue', 'export', 'other-owner');
      await queued('no-owner', 'import', null);
      expect((await get('foreign-queue')).statusCode).toBe(403);
      expect((await get('no-owner')).statusCode).toBe(403);
      await create('foreign-meta', 'export', 'other-owner');
      const before = await redis.get(metaKey('foreign-meta'));
      expect((await get('foreign-meta')).statusCode).toBe(403);
      expect(await redis.get(metaKey('foreign-meta'))).toBe(before);
    });
    it('atomically reconciles a real completed job across independent API reads and hides private result paths', async () => {
      const id = 'completed';
      await create(id);
      await complete(id, {
        summary: '共2条',
        total: 2,
        filepath: '/private/report.csv',
        filename: 'report.csv',
        downloadUrl: '/api/v1/tasks/completed/download',
        nested: { token: 'private-token-95' },
      });
      const second = await login();
      // Two sessions for the SAME owner avoid authentication touch serialization on one session row.
      await f.pools.primaryPool.query(
        'UPDATE sessions SET user_id=$1 WHERE id=$2',
        [owner.userId, second.sessionId],
      );
      const headers = {
        authorization: `Bearer ${jwt.sign(
          { userId: owner.userId, sessionId: second.sessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
      const responses = await Promise.all([get(id), get(id, headers)]);
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json().data).toMatchObject({
          status: 'completed',
          progress: 100,
          result: { total: 2, nested: {} },
        });
        expect(response.body).not.toContain('/private');
        expect(response.body).not.toContain('private-token');
      }
      expect(await store.read(id)).toMatchObject({
        revision: 1,
        result: { filepath: '/private/report.csv' },
      });
    });
    it('keeps the first terminal cancellation despite a later real completed job', async () => {
      const id = 'cancel-wins';
      await create(id);
      await store.mutate(id, { kind: 'cancelled' });
      const before = await redis.get(metaKey(id));
      await complete(id, { total: 2 });
      expect((await get(id)).json().data.status).toBe('cancelled');
      expect(await redis.get(metaKey(id))).toBe(before);
    });
    it('reconciles a real failed job with a fixed public error', async () => {
      await create('failed');
      await complete('failed', null, true);
      const response = await get('failed');
      expect(response.statusCode).toBe(200);
      expect(response.json().data.error).toBe('任务执行失败');
      expect(response.body).not.toContain('private-driver');
      expect(await store.read('failed')).toMatchObject({
        status: 'failed',
        error: '任务执行失败',
      });
    });
    it('never reads bare Legacy task metadata or the Legacy queue prefix', async () => {
      const id = 'legacy-only',
        bare = `task:meta:${prefix}-${id}`;
      await redis.set(
        bare,
        JSON.stringify({
          taskId: `${prefix}-${id}`,
          userId: owner.userId,
          status: 'completed',
        }),
        'EX',
        60,
      );
      const legacyJob = `${prefix}:${getPhysicalQueueName('export')}:${id}`;
      await redis.hset(legacyJob, {
        name: 'legacy',
        data: JSON.stringify({ userId: owner.userId }),
        returnvalue: '{"total":99}',
      });
      try {
        expect((await get(`${prefix}-${id}`)).statusCode).toBe(404);
        expect((await get(id)).statusCode).toBe(404);
        expect(await redis.hget(legacyJob, 'returnvalue')).toBe('{"total":99}');
      } finally {
        await redis.del(bare);
      }
    });
    it('does not resurrect expired metadata and rechecks identity against a real replacement', async () => {
      const task = await create('reused');
      await redis.del(metaKey(task.taskId));
      await create(task.taskId, 'import', 'replacement-owner');
      await expect(
        store.mutate(
          task.taskId,
          { kind: 'completed', result: { total: 100 } },
          task,
        ),
      ).rejects.toMatchObject({ code: 'TASK_IDENTITY_CHANGED' });
      expect(await store.read(task.taskId)).toMatchObject({
        userId: 'replacement-owner',
        status: 'pending',
        result: null,
      });
      expect((await get(task.taskId)).statusCode).toBe(403);
    });
    it('recovers the dedicated Redis connection on the next request and prevents new work after shutdown', async () => {
      const id = 'reconnect';
      await create(id);
      await queued(id);
      expect((await get(id)).statusCode).toBe(200);
      const client = (runtime as unknown as { redis: Redis }).redis;
      client.disconnect(false);
      await vi.waitFor(() => expect(client.status).toBe('end'));
      const response = await get(id);
      expect(response.statusCode).toBe(200);
      expect(client.status).toBe('ready');
      expect(client.options).toMatchObject({
        commandTimeout: 1000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
      });
      const isolated = new TaskQueryRuntime(
        env,
        f.logger as unknown as AppLogger,
      );
      await isolated.onModuleDestroy();
      await expect(
        isolated.open(() => undefined).store.read(id),
      ).rejects.toThrow('TASK_RUNTIME_CLOSED');
    });
  },
);
