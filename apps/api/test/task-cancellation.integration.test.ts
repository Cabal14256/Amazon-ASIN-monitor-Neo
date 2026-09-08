import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  type Env,
  type QueueName,
} from '@asin-monitor/config';
import { taskInfoResultSchema } from '@asin-monitor/contracts';
import { RedisTaskRepository, type TaskState } from '@asin-monitor/db';
import { FlowProducer, Queue, Worker, type JobsOptions } from 'bullmq';
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
import { CANCELLABLE_TASK_TYPES } from '../src/tasks/task-cancellation-script';
import { TaskQueryModule } from '../src/tasks/task-query.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import {
  WS_EVENT_BUS,
  type WebSocketEvent,
  type WebSocketEventBus,
} from '../src/websocket/websocket-events';
import { spApiConfigApp } from './helpers/sp-api-config-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'task cancellation / real PostgreSQL, Redis and BullMQ',
  () => {
    const prefix = `fixture-task-cancel97-${randomUUID()}`;
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
    const queues = new Map<QueueName, Queue>(),
      workers = new Set<Worker>();
    const events: WebSocketEvent[] = [];
    let unsubscribe: (() => void) | undefined;
    let restoreAtomic: (() => void) | undefined;
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
      unsubscribe = f.app
        .get<WebSocketEventBus>(WS_EVENT_BUS)
        .subscribe((event) => events.push(event));
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
    async function closeWorkers() {
      const results = await Promise.allSettled(
        [...workers].map((worker) => worker.close(true)),
      );
      workers.clear();
      expect(results.filter((result) => result.status === 'rejected')).toEqual(
        [],
      );
    }
    afterAll(async () => {
      unsubscribe?.();
      try {
        await closeWorkers();
      } finally {
        try {
          if (f) await f.close();
        } finally {
          try {
            const results = await Promise.allSettled(
              [...queues.values()].map(async (queue) => {
                try {
                  expect(queue.opts.prefix).toBe(`${prefix}:neo`);
                  await queue.obliterate({ force: true });
                } finally {
                  await queue.close();
                }
              }),
            );
            if (redis?.status === 'ready') {
              const keys = new Set<string>();
              let cursor = '0',
                pages = 0;
              do {
                if (++pages > 100)
                  throw new Error('Unexpected cancellation fixture scan size');
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
                if (keys.size > 2000)
                  throw new Error('Unexpected cancellation fixture key count');
              } while (cursor !== '0');
              if (keys.size) await redis.del(...keys);
            }
            expect(
              results.filter((result) => result.status === 'rejected'),
            ).toEqual([]);
          } finally {
            redis?.disconnect(false);
            vi.restoreAllMocks();
          }
        }
      }
    });
    async function login(existingUserId?: string) {
      const userId = existingUserId ?? randomUUID(),
        sessionId = randomUUID();
      if (!existingUserId) {
        f.userIds.add(userId);
        await f.pools.primaryPool.query(
          'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
          [userId, `u97-${userId}`, 'unused-fixture-hash'],
        );
      }
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
      restoreAtomic?.();
      restoreAtomic = undefined;
      await closeWorkers();
      for (const queue of queues.values())
        await queue.obliterate({ force: true });
      events.length = 0;
      owner = await login();
    });
    async function queueFor(type: QueueName = 'export') {
      let queue = queues.get(type);
      if (!queue) {
        queue = new Queue(getPhysicalQueueName(type), {
          prefix: getNeoQueuePrefix(env),
          connection: {
            url: env.REDIS_URL,
            commandTimeout: 2000,
            connectTimeout: 2000,
            maxRetriesPerRequest: 1,
          },
        });
        queue.on('error', () => undefined);
        queues.set(type, queue);
        await queue.waitUntilReady();
      }
      return queue;
    }
    async function enqueued(
      type: (typeof CANCELLABLE_TASK_TYPES)[number] = 'export',
      options: JobsOptions = {},
    ) {
      const task = await store.create({
        taskId: `job97-${randomUUID()}`,
        userId: owner.userId,
        taskType: type,
      });
      const queue = await queueFor(type);
      const job = await queue.add(
        'fixture',
        {
          userId: task.userId,
          createdAt: task.createdAt,
          groups: [],
          nested: { ids: ['id-a'] },
        },
        {
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
          ...options,
          jobId: task.taskId,
        },
      );
      return { task, queue, job };
    }
    const cancel = (id: string, headers = owner.headers) =>
      f.http.inject({
        method: 'POST',
        url: `/api/v1/tasks/${encodeURIComponent(id)}/cancel`,
        headers,
      });
    async function activate(queue: Queue, id: string) {
      const worker = new Worker(queue.name, undefined, {
        autorun: false,
        prefix: getNeoQueuePrefix(env),
        connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      });
      worker.on('error', () => undefined);
      workers.add(worker);
      await worker.waitUntilReady();
      const job = await worker.getNextJob('fixture-lock-97', { block: false });
      expect(job?.id).toBe(id);
      return job!;
    }
    function beforeAtomic(action: (task: TaskState) => Promise<void>) {
      const open = runtime.openCancellation.bind(runtime);
      const spy = vi
        .spyOn(runtime, 'openCancellation')
        .mockImplementation((ensureOpen) => {
          const port = open(ensureOpen);
          return {
            ...port,
            cancelJob: async (task) => {
              await action(task);
              return port.cancelJob(task);
            },
          };
        });
      restoreAtomic = () => spy.mockRestore();
    }
    // DUMP is not a canonical hash representation: even a read can advance
    // Redis dictionary rehashing. Compare every logical field/value instead.
    async function snapshot(key: string): Promise<unknown> {
      const type = await redis.type(key);
      switch (type) {
        case 'none':
          return { type };
        case 'hash':
          return { type, value: await redis.hgetall(key) };
        case 'string':
          return { type, value: await redis.get(key) };
        case 'list':
          return { type, value: await redis.lrange(key, 0, -1) };
        case 'set':
          return { type, value: (await redis.smembers(key)).sort() };
        case 'zset':
          return { type, value: await redis.zrange(key, 0, -1, 'WITHSCORES') };
        case 'stream':
          return { type, value: await redis.xrange(key, '-', '+') };
        default:
          throw new Error('Unexpected fixture Redis type');
      }
    }

    it.each(CANCELLABLE_TASK_TYPES)(
      'removes an owned waiting %s job with its logs and emits only to its owner',
      async (type) => {
        const { task, queue, job } = await enqueued(type);
        await job.log('fixture-log');
        const response = await cancel(task.taskId);
        expect(response.statusCode).toBe(200);
        taskInfoResultSchema.parse(response.json());
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json().data).toMatchObject({
          status: 'cancelled',
          canCancel: false,
        });
        expect(await queue.getJob(task.taskId)).toBeUndefined();
        expect(await redis.exists(queue.toKey(`${task.taskId}:logs`))).toBe(0);
        expect(await store.read(task.taskId)).toMatchObject({
          status: 'cancelled',
          revision: 1,
        });
        expect(events).toEqual([
          expect.objectContaining({
            audience: 'user',
            userId: owner.userId,
            message: expect.objectContaining({
              type: 'task_cancelled',
              taskId: task.taskId,
            }),
          }),
        ]);
        const stream = await redis.xrange(queue.keys.events, '-', '+');
        expect(JSON.stringify(stream)).toContain('removed');
      },
    );
    it.each(['delayed', 'paused', 'prioritized'] as const)(
      'removes an owned %s job',
      async (state) => {
        const queue = await queueFor();
        if (state === 'paused') await queue.pause();
        try {
          const { task, job } = await enqueued(
            'export',
            state === 'delayed'
              ? { delay: 60000 }
              : state === 'prioritized'
              ? { priority: 1 }
              : {},
          );
          if (state !== 'paused') expect(await job.getState()).toBe(state);
          expect((await cancel(task.taskId)).statusCode).toBe(200);
          expect(await queue.getJob(task.taskId)).toBeUndefined();
          expect((await store.read(task.taskId))?.status).toBe('cancelled');
        } finally {
          if (state === 'paused') await queue.resume();
        }
      },
    );
    it('requests running cancellation without overwriting payload, keeps progress sticky and accepts Worker acknowledgement', async () => {
      const { task, queue } = await enqueued();
      const job = await activate(queue, task.taskId),
        data = await redis.hget(queue.toKey(task.taskId), 'data');
      await store.mutate(task.taskId, { kind: 'processing' });
      const first = await cancel(task.taskId),
        second = await cancel(task.taskId);
      expect(first.statusCode).toBe(200);
      expect(first.json().data.status).toBe('cancelling');
      expect(second.json().data.cancelRequestedAt).toBe(
        first.json().data.cancelRequestedAt,
      );
      expect(await job.getState()).toBe('active');
      expect(await redis.hget(queue.toKey(task.taskId), 'data')).toBe(data);
      expect(
        (await store.mutate(task.taskId, { kind: 'progress', progress: 20 }))
          ?.status,
      ).toBe('cancelling');
      expect(events).toEqual([]);
      await store.mutate(task.taskId, { kind: 'cancelled' });
      await job.moveToCompleted({ cancelled: true }, 'fixture-lock-97', false);
      const detail = await f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${task.taskId}`,
        headers: owner.headers,
      });
      expect(detail.json().data.status).toBe('cancelled');
    });
    it.each(['completed', 'failed'] as const)(
      'preserves a %s result when execution wins after the HTTP metadata read',
      async (state) => {
        const { task, queue } = await enqueued();
        let finishedHash: unknown;
        beforeAtomic(async () => {
          const job = await activate(queue, task.taskId);
          if (state === 'completed')
            await job.moveToCompleted({ count: 3 }, 'fixture-lock-97', false);
          else
            await job.moveToFailed(
              new Error('private-fixture-failure'),
              'fixture-lock-97',
              false,
            );
          finishedHash = await snapshot(queue.toKey(task.taskId));
        });
        expect((await cancel(task.taskId)).statusCode).toBe(400);
        expect(await snapshot(queue.toKey(task.taskId))).toEqual(finishedHash);
        expect(await queue.getJobState(task.taskId)).toBe(state);
        expect(await store.read(task.taskId)).toMatchObject({
          status: 'pending',
          revision: 0,
        });
        expect(events).toEqual([]);
      },
    );
    it('prevents execution when removal wins before a Worker acquires the job', async () => {
      const { task, queue } = await enqueued();
      expect((await cancel(task.taskId)).statusCode).toBe(200);
      const worker = new Worker(queue.name, undefined, {
        autorun: false,
        prefix: getNeoQueuePrefix(env),
        connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      });
      worker.on('error', () => undefined);
      workers.add(worker);
      await worker.waitUntilReady();
      expect(
        await worker.getNextJob('fixture-lock-97', { block: false }),
      ).toBeUndefined();
    });
    it('keeps one terminal revision across concurrent cancellation from two owned sessions', async () => {
      const { task, queue } = await enqueued(),
        other = await login(owner.userId);
      const responses = await Promise.all([
        cancel(task.taskId),
        cancel(task.taskId, other.headers),
      ]);
      expect(responses.some((response) => response.statusCode === 200)).toBe(
        true,
      );
      expect(
        responses.every((response) => [200, 400].includes(response.statusCode)),
      ).toBe(true);
      expect(await store.read(task.taskId)).toMatchObject({
        status: 'cancelled',
        revision: 1,
      });
      expect(await queue.getJob(task.taskId)).toBeUndefined();
      expect(
        events.every(
          (event) => event.audience === 'user' && event.userId === owner.userId,
        ),
      ).toBe(true);
    });
    it.each(['session', 'account'])(
      'observes committed %s revocation before any queue mutation',
      async (kind) => {
        const { task, queue } = await enqueued();
        const original = await snapshot(queue.toKey(task.taskId));
        if (kind === 'session')
          await f.pools.primaryPool.query(
            "UPDATE sessions SET status='REVOKED' WHERE id=$1",
            [owner.sessionId],
          );
        else
          await f.pools.primaryPool.query(
            "UPDATE users SET status='SUSPENDED' WHERE id=$1",
            [owner.userId],
          );
        expect((await cancel(task.taskId)).statusCode).toBe(403);
        expect(await snapshot(queue.toKey(task.taskId))).toEqual(original);
        expect((await store.read(task.taskId))?.revision).toBe(0);
      },
    );
    it.each(['foreign', 'ownerless', 'createdAt'])(
      'refuses a queue identity with mismatched %s before removal',
      async (kind) => {
        const { task, queue, job } = await enqueued();
        await job.updateData({
          ...job.data,
          ...(kind === 'createdAt'
            ? { createdAt: '2026-01-01T00:00:00.000Z' }
            : { userId: kind === 'foreign' ? (await login()).userId : null }),
        });
        const original = await snapshot(queue.toKey(task.taskId));
        expect((await cancel(task.taskId)).statusCode).toBe(
          kind === 'createdAt' ? 409 : 403,
        );
        expect(await snapshot(queue.toKey(task.taskId))).toEqual(original);
        expect((await store.read(task.taskId))?.revision).toBe(0);
      },
    );
    it('rechecks replaced metadata identity inside the same Redis script as removal', async () => {
      const { task, queue } = await enqueued();
      const other = await login();
      beforeAtomic(async () => {
        await redis.del(metaKey(task.taskId));
        await store.create({
          taskId: task.taskId,
          userId: other.userId,
          taskType: 'export',
        });
      });
      expect((await cancel(task.taskId)).statusCode).toBe(409);
      expect(await queue.getJob(task.taskId)).toBeDefined();
      expect(await store.read(task.taskId)).toMatchObject({
        userId: other.userId,
        revision: 0,
      });
      expect(events).toEqual([]);
    });
    it('does not remove a job if metadata expires between HTTP read and atomic validation', async () => {
      const { task, queue } = await enqueued();
      beforeAtomic(async () => {
        await redis.del(metaKey(task.taskId));
      });
      expect((await cancel(task.taskId)).statusCode).toBe(404);
      expect(await queue.getJob(task.taskId)).toBeDefined();
      expect(await store.read(task.taskId)).toBeNull();
    });
    it('does not remove a job if a registry terminal state wins before atomic validation', async () => {
      const { task, queue } = await enqueued();
      beforeAtomic(async () => {
        await store.mutate(task.taskId, {
          kind: 'completed',
          result: { count: 3 },
        });
      });
      expect((await cancel(task.taskId)).statusCode).toBe(400);
      expect(await queue.getJob(task.taskId)).toBeDefined();
      expect(await store.read(task.taskId)).toMatchObject({
        status: 'completed',
        result: { count: 3 },
      });
    });
    it('requires metadata and never falls back to an owner-bearing queue job', async () => {
      const { task, queue } = await enqueued();
      await redis.del(metaKey(task.taskId));
      expect((await cancel(task.taskId)).statusCode).toBe(404);
      expect(await queue.getJob(task.taskId)).toBeDefined();
    });
    it('marks missing Neo jobs cancelled while preserving the Legacy prefix and bare registry', async () => {
      const task = await store.create({
        taskId: `job97-${randomUUID()}`,
        userId: owner.userId,
        taskType: 'export',
      });
      const legacy = new Queue(getPhysicalQueueName('export'), {
        prefix,
        connection: { url: env.REDIS_URL, maxRetriesPerRequest: 1 },
      });
      legacy.on('error', () => undefined);
      const bare = `task:meta:${task.taskId}`;
      try {
        await legacy.add(
          'fixture',
          { userId: owner.userId, createdAt: task.createdAt },
          { jobId: task.taskId },
        );
        await redis.set(bare, 'legacy-fixture', 'EX', 120);
        const original = await snapshot(legacy.toKey(task.taskId));
        expect((await cancel(task.taskId)).json().data.status).toBe(
          'cancelled',
        );
        expect(await snapshot(legacy.toKey(task.taskId))).toEqual(original);
        expect(await redis.get(bare)).toBe('legacy-fixture');
      } finally {
        await redis.del(bare);
        try {
          expect(legacy.opts.prefix).toBe(prefix);
          await legacy.obliterate({ force: true });
        } finally {
          await legacy.close();
        }
      }
    });
    it('does not interpret reserved queue keys as cancellable job hashes', async () => {
      const queue = await queueFor();
      await enqueued();
      for (const id of ['meta', 'completed', 'events', 'id', 'wait']) {
        await store.create({
          taskId: id,
          userId: owner.userId,
          taskType: 'export',
        });
        const original = await snapshot(queue.toKey(id));
        expect((await cancel(id)).statusCode).toBe(400);
        expect(await snapshot(queue.toKey(id))).toEqual(original);
        expect((await store.read(id))?.revision).toBe(0);
      }
    });
    it('refuses real flow children without changing a foreign parent or its dependencies', async () => {
      const task = await store.create({
        taskId: `job97-${randomUUID()}`,
        userId: owner.userId,
        taskType: 'export',
      });
      const queue = await queueFor();
      const flow = new FlowProducer({
        prefix: getNeoQueuePrefix(env),
        connection: { url: env.REDIS_URL, maxRetriesPerRequest: 1 },
      });
      flow.on('error', () => undefined);
      try {
        const parent = await flow.add({
          name: 'parent',
          queueName: queue.name,
          data: { userId: (await login()).userId },
          children: [
            {
              name: 'child',
              queueName: queue.name,
              data: { userId: task.userId, createdAt: task.createdAt },
              opts: { jobId: task.taskId },
            },
          ],
        });
        const parentKey = queue.toKey(parent.job.id!),
          original = await snapshot(parentKey),
          dependencies = await snapshot(`${parentKey}:dependencies`);
        expect((await cancel(task.taskId)).statusCode).toBe(400);
        expect(await snapshot(parentKey)).toEqual(original);
        expect(await snapshot(`${parentKey}:dependencies`)).toEqual(
          dependencies,
        );
        expect(await queue.getJob(task.taskId)).toBeDefined();
      } finally {
        await flow.close();
      }
    });
    it('removes only the matching deduplication key using the upstream BullMQ script', async () => {
      const dedupId = randomUUID();
      const { task, queue } = await enqueued('export', {
        deduplication: { id: dedupId },
      });
      const otherId = randomUUID();
      const other = await enqueued('export', {
        deduplication: { id: otherId },
      });
      expect(await redis.get(queue.toKey(`de:${dedupId}`))).toBe(task.taskId);
      expect((await cancel(task.taskId)).statusCode).toBe(200);
      expect(await redis.exists(queue.toKey(`de:${dedupId}`))).toBe(0);
      expect(await redis.get(queue.toKey(`de:${otherId}`))).toBe(
        other.task.taskId,
      );
      expect(await queue.getJob(other.task.taskId)).toBeDefined();
    });
    it.each(['events-type', 'events-limit'])(
      'validates %s before deletion so a Lua error cannot leave partial removals',
      async (kind) => {
        const { task, queue } = await enqueued();
        const originalJob = await snapshot(queue.toKey(task.taskId));
        const originalEvents = await redis.dumpBuffer(queue.keys.events),
          previousLimit = await redis.hget(
            queue.keys.meta,
            'opts.maxLenEvents',
          );
        try {
          if (kind === 'events-type') {
            await redis.del(queue.keys.events);
            await redis.set(queue.keys.events, 'private-corrupt-fixture');
          } else await redis.hset(queue.keys.meta, 'opts.maxLenEvents', '1e2');
          const response = await cancel(task.taskId);
          expect(response.statusCode).toBe(500);
          expect(response.body).not.toContain('private-corrupt-fixture');
          expect(await snapshot(queue.toKey(task.taskId))).toEqual(originalJob);
          expect(await queue.getJobState(task.taskId)).toBe('waiting');
          expect((await store.read(task.taskId))?.revision).toBe(0);
        } finally {
          await redis.del(queue.keys.events);
          if (originalEvents)
            await redis.restore(queue.keys.events, 0, originalEvents);
          if (previousLimit === null)
            await redis.hdel(queue.keys.meta, 'opts.maxLenEvents');
          else
            await redis.hset(
              queue.keys.meta,
              'opts.maxLenEvents',
              previousLimit,
            );
        }
      },
    );
    it('rejects new cancellation commands after the shared request runtime closes', async () => {
      const { task, queue } = await enqueued();
      await runtime.onModuleDestroy();
      expect((await cancel(task.taskId)).statusCode).toBe(500);
      expect(await queue.getJob(task.taskId)).toBeDefined();
      expect((await store.read(task.taskId))?.revision).toBe(0);
    });
  },
);
