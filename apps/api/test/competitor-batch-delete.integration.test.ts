import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  type Env,
} from '@asin-monitor/config';
import { batchDeleteVariantGroupsResultSchema } from '@asin-monitor/contracts';
import { RedisTaskRepository } from '@asin-monitor/db';
import { Queue, type Worker } from 'bullmq';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
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
import { AppLogger } from '../src/logger/app-logger.service';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { legacyCompetitorQueryFixture } from './helpers/competitor-query-legacy';
import { competitorWriteApp } from './helpers/competitor-write-app';

interface BusinessRuntime {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}
const compiledRuntime = () =>
  createRequire(__filename)(
    '../../worker/dist/asin-batch-delete-runtime.js',
  ) as {
    startAsinBatchDeleteRuntime(
      env: Env,
      onFatal: () => void,
    ): Promise<BusinessRuntime>;
  };
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'competitor batch deletion / actual Legacy, dual PostgreSQL, Redis and shared compiled Worker',
  () => {
    const prefix = `fixture-competitor-delete127-${randomUUID()}`;
    let f: Awaited<ReturnType<typeof competitorWriteApp>>,
      env: Env,
      redis: Redis,
      queue: Queue,
      store: RedisTaskRepository,
      legacy: Awaited<ReturnType<typeof legacyCompetitorQueryFixture>>,
      runtime: BusinessRuntime | undefined;
    let headers: Record<string, string>, userId: string, sessionId: string;
    const fatal = vi.fn();
    beforeAll(async () => {
      f = await competitorWriteApp({
        primaryBusiness: true,
        configure: (builder) =>
          builder.overrideProvider(TaskQueryRuntime).useFactory({
            inject: [ENV, AppLogger],
            factory: (source: Env, logger: AppLogger) => {
              env = {
                ...source,
                BULL_PREFIX: prefix,
                BATCH_DELETE_CHUNK_SIZE: 1,
              };
              return new TaskQueryRuntime(env, logger);
            },
          }),
      });
      legacy = await legacyCompetitorQueryFixture();
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
      queue = new Queue(getPhysicalQueueName('batch-delete'), {
        connection: redis as any,
        prefix: getNeoQueuePrefix(env),
      });
      queue.on('error', () => undefined);
      await queue.waitUntilReady();
      await f.pools.competitorPool.query(
        'CREATE TABLE batch_delete_fail_fixture(id text PRIMARY KEY)',
      );
      await f.pools.competitorPool.query(
        'CREATE TABLE batch_delete_barrier_fixture(enabled boolean)',
      );
      await f.pools.competitorPool
        .query(`CREATE FUNCTION batch_delete_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS(SELECT 1 FROM batch_delete_fail_fixture WHERE id=OLD.id) THEN RAISE EXCEPTION 'private deletion fixture 127'; END IF;
      IF EXISTS(SELECT 1 FROM batch_delete_barrier_fixture WHERE enabled) THEN PERFORM pg_advisory_xact_lock_shared(1095977294,199127); END IF;
      RETURN OLD; END $$`);
      await f.pools.competitorPool.query(
        'CREATE TRIGGER batch_delete_fixture BEFORE DELETE ON competitor_asins FOR EACH ROW EXECUTE FUNCTION batch_delete_fixture()',
      );
      await f.pools.competitorPool
        .query(`CREATE FUNCTION fail_batch_parent_touch() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id='g-fail-touch' THEN RAISE EXCEPTION 'private deletion parent touch'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_batch_parent_touch AFTER UPDATE ON competitor_variant_groups FOR EACH ROW EXECUTE FUNCTION fail_batch_parent_touch()`);
      await f.pools.primaryPool.query(
        'CREATE TABLE audit_logs_archive (LIKE public.audit_logs_archive INCLUDING ALL)',
      );
    }, 20000);
    afterEach(async () => {
      if (runtime) {
        await runtime.close();
        runtime = undefined;
      }
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
                throw new Error('Fixture cleanup exceeded bound');
              const [next, keys] = await redis.scan(
                cursor,
                'MATCH',
                `${prefix}:*`,
                'COUNT',
                100,
              );
              cursor = next;
              if (keys.some((key) => !key.startsWith(`${prefix}:`)))
                throw new Error('Fixture namespace escaped');
              if (keys.length) await redis.del(...keys);
            } while (cursor !== '0');
          }
        } finally {
          redis?.disconnect(false);
          try {
            if (f) await f.close();
          } finally {
            await legacy?.close();
          }
        }
      }
    });
    beforeEach(async () => {
      fatal.mockClear();
      await queue.obliterate({ force: true });
      await f.pools.competitorPool.query(
        'TRUNCATE batch_delete_fail_fixture, batch_delete_barrier_fixture, competitor_monitor_history',
      );
      await f.pools.competitorPool.query('DELETE FROM competitor_asins');
      await f.pools.competitorPool.query(
        'DELETE FROM competitor_variant_groups',
      );
      for (const table of [
        'competitor_monitor_history',
        'competitor_asins',
        'competitor_variant_groups',
      ])
        await legacy.query(`DELETE FROM ${table}`);
      await f.pools.primaryPool.query(
        'DELETE FROM asins; DELETE FROM variant_groups',
      );
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:delete' ON CONFLICT DO NOTHING",
      );
      userId = randomUUID();
      sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u99-${userId}`, 'unused-fixture-hash'],
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
    const request = (payload: Record<string, unknown>) =>
      f.http.inject({
        method: 'POST',
        url: '/api/v1/competitor/variant-groups/batch-delete',
        headers,
        payload,
      });
    const queryTask = (taskId: string) =>
      f.http.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}`, headers });
    const cancel = (taskId: string) =>
      f.http.inject({
        method: 'POST',
        url: `/api/v1/tasks/${taskId}/cancel`,
        headers,
      });
    async function group(id: string, children = 1) {
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_variant_groups(id,name,country,brand,update_time) VALUES($1,$1,'US','Fixture','2020-01-01 08:00:00')",
        [id],
      );
      await legacy.query(
        "INSERT INTO competitor_variant_groups(id,name,country,brand,update_time) VALUES(?,?,'US','Fixture','2020-01-01 08:00:00')",
        [id, id],
      );
      for (let i = 0; i < children; i++) {
        await f.pools.competitorPool.query(
          "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id) VALUES($1,$2,'US','Fixture',$3)",
          [`${id}-a${i}`, `${id}-${i}`, id],
        );
        await legacy.query(
          "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id) VALUES(?,?,'US','Fixture',?)",
          [`${id}-a${i}`, `${id}-${i}`, id],
        );
      }
    }
    const rows = async (
      table: 'competitor_asins' | 'competitor_variant_groups',
    ) =>
      (
        await f.pools.competitorPool.query(
          `SELECT row_to_json(t) AS data FROM ${table} t ORDER BY id`,
        )
      ).rows.map((row) => row.data);
    async function accepted(payload: Record<string, unknown>) {
      const response = await request({ ...payload, useAsync: true });
      expect(response.statusCode).toBe(200);
      batchDeleteVariantGroupsResultSchema.parse(response.json());
      return response.json().data.taskId as string;
    }
    async function start(overrides: Partial<Env> = {}) {
      runtime = await compiledRuntime().startAsinBatchDeleteRuntime(
        { ...env, ...overrides },
        fatal,
      );
    }
    async function terminal(id: string, status = 'completed') {
      await vi.waitFor(
        async () => expect((await store.read(id))?.status).toBe(status),
        { timeout: 8000, interval: 20 },
      );
      await vi.waitFor(
        async () =>
          expect(await (await queue.getJob(id))?.getState()).toBe('completed'),
        { timeout: 3000, interval: 20 },
      );
      return (await queryTask(id)).json().data;
    }
    it('synchronously cascades selected groups, deletes direct targets, preserves history and touches remaining parents', async () => {
      await group('g1', 2);
      await group('g2', 2);
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_monitor_history(asin_id,country,is_broken,check_time) VALUES('g1-a0','US',false,'2026-01-01 08:00:00')",
      );
      const payload = {
        groupIds: [' g1 ', 'missing', 'g1'],
        asinIds: ['g1-a0', 'g2-a0', 'absent'],
        useAsync: false,
      };
      const response = await request(payload);
      const old = await legacy.batchDelete(payload);
      expect(response.statusCode).toBe(old.statusCode);
      expect(response.json()).toEqual(old.body);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        errorCode: 0,
        data: {
          mode: 'sync',
          totalRequested: 5,
          deletedGroupCount: 1,
          deletedDirectAsinCount: 1,
          deletedNestedAsinCount: 2,
          skipped: { groupIds: ['missing'], asinIds: ['absent'] },
        },
      });
      expect((await rows('competitor_asins')).map((row) => row.id)).toEqual([
        'g2-a1',
      ]);
      expect(
        (await legacy.query('SELECT id FROM competitor_asins ORDER BY id')).map(
          (row) => row.id,
        ),
      ).toEqual(['g2-a1']);
      expect(
        (await rows('competitor_variant_groups'))[0].update_time,
      ).not.toContain('2020');
      expect(
        (
          await f.pools.competitorPool.query(
            'SELECT count(*)::int AS n FROM competitor_monitor_history',
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        await queue.getJobCounts('wait', 'active', 'completed'),
      ).toMatchObject({ wait: 0, active: 0, completed: 0 });
    });
    it.each(['child-delete', 'parent-touch'])(
      'rolls back the entire synchronous transaction on %s failure',
      async (failure) => {
        await group('g1', 2);
        await group(failure === 'parent-touch' ? 'g-fail-touch' : 'g2', 2);
        if (failure === 'child-delete')
          await f.pools.competitorPool.query(
            "INSERT INTO batch_delete_fail_fixture VALUES('g1-a1')",
          );
        const before = [
          await rows('competitor_variant_groups'),
          await rows('competitor_asins'),
        ];
        expect(
          (
            await request({
              groupIds: ['g1'],
              asinIds: [
                failure === 'parent-touch' ? 'g-fail-touch-a0' : 'g2-a0',
              ],
              useAsync: false,
            })
          ).statusCode,
        ).toBe(500);
        expect([
          await rows('competitor_variant_groups'),
          await rows('competitor_asins'),
        ]).toEqual(before);
      },
    );
    it('returns missing-target counts without creating work', async () => {
      const response = await request({
        groupIds: ['missing'],
        asinIds: ['absent'],
      });
      expect(response.json().data).toMatchObject({
        mode: 'sync',
        totalRequested: 2,
        deletedGroupCount: 0,
        deletedDirectAsinCount: 0,
        deletedNestedAsinCount: 0,
        skipped: { groupIds: ['missing'], asinIds: ['absent'] },
      });
    });
    it.each([
      { groupIds: [], asinIds: [] },
      { groupIds: ['GROUP'], asinIds: ['group-A0'] },
      { groupIds: ['Gróup'], asinIds: ['Gróup-a0', 'missing'] },
      { groupIds: ['GROUP', 'Gróup'], asinIds: ['Gróup-a0', 'group-a0'] },
    ])(
      'matches the actual Legacy controller for empty, CI alias and overlapping targets: %#',
      async (payload) => {
        await group('Gróup', 2);
        const old = await legacy.batchDelete({ ...payload, useAsync: false });
        const response = await request({ ...payload, useAsync: false });
        expect(response.statusCode).toBe(old.statusCode);
        expect(response.json()).toEqual(old.body);
        for (const table of [
          'competitor_asins',
          'competitor_variant_groups',
        ] as const)
          expect((await rows(table)).map((row) => row.id)).toEqual(
            (await legacy.query(`SELECT id FROM ${table} ORDER BY id`)).map(
              (row) => row.id,
            ),
          );
      },
    );
    it('fails closed while 0011 is rolled back and recovers after reinstall', async () => {
      await group('g1');
      await f.applyPolicy(true);
      try {
        expect(
          (await request({ groupIds: ['g1'], useAsync: true })).statusCode,
        ).toBe(503);
        expect(await rows('competitor_asins')).toHaveLength(1);
        expect(await queue.getJobCounts('wait', 'active')).toMatchObject({
          wait: 0,
          active: 0,
        });
      } finally {
        await f.applyPolicy();
      }
      expect(
        (await request({ groupIds: ['g1'], useAsync: false })).statusCode,
      ).toBe(200);
      expect(await rows('competitor_asins')).toHaveLength(0);
    });
    it('bounds a real competitor row-lock timeout and recovers both database pools', async () => {
      await group('g1');
      const blocker = await f.pools.competitorPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM competitor_variant_groups WHERE id='g1' FOR UPDATE",
        );
        const started = Date.now();
        expect(
          (await request({ groupIds: ['g1'], useAsync: false })).statusCode,
        ).toBe(500);
        expect(Date.now() - started).toBeLessThan(4500);
        expect(await rows('competitor_asins')).toHaveLength(1);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(
        (await request({ groupIds: ['g1'], useAsync: false })).statusCode,
      ).toBe(200);
      expect(await rows('competitor_asins')).toHaveLength(0);
    });
    it('reports an uncertain commit without retrying a real committed deletion', async () => {
      await group('g1');
      const pool = f.pools.competitorPool,
        connect = pool.connect.bind(pool);
      const spy = vi
        .spyOn(pool, 'connect')
        .mockImplementationOnce((async () => {
          const client = await connect(),
            query = client.query;
          client.query = (async (...args: unknown[]) => {
            const result = await Reflect.apply(query, client, args);
            if (args[0] === 'COMMIT')
              throw new Error('private-delete-commit-ack');
            return result;
          }) as typeof client.query;
          return client;
        }) as typeof pool.connect);
      try {
        const response = await request({ groupIds: ['g1'], useAsync: false });
        expect(response.statusCode).toBe(503);
        expect(response.body).toContain('刷新数据后再操作');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(
          response.body + JSON.stringify(f.logger.error.mock.calls),
        ).not.toContain('private-delete-commit-ack');
      } finally {
        spy.mockRestore();
      }
      expect(await rows('competitor_asins')).toHaveLength(0);
      expect(await rows('competitor_variant_groups')).toHaveLength(0);
    });
    it('current permission revocation rejects a previously cached writer before enqueue or deletion', async () => {
      await group('g1');
      expect((await request({ groupIds: ['missing'] })).statusCode).toBe(200);
      await f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id IN (SELECT id FROM permissions WHERE code='asin:delete')",
      );
      expect(
        (await request({ groupIds: ['g1'], useAsync: true })).statusCode,
      ).toBe(403);
      expect(await rows('competitor_asins')).toHaveLength(1);
      expect(await queue.getJobCounts('wait', 'active')).toMatchObject({
        wait: 0,
        active: 0,
      });
    });
    it('executes the HTTP-created job in the compiled runtime and exposes its full result through task query', async () => {
      await group('g1', 2);
      await group('g2', 2);
      const id = await accepted({
        groupIds: ['g1', 'missing'],
        asinIds: ['g1-a0', 'g2-a0', 'absent'],
      });
      const job = await queue.getJob(id),
        task = await store.read(id);
      expect(job?.name).toBe('competitor-batch-delete');
      expect(job?.data).toMatchObject({
        domain: 'competitor',
        taskSubType: 'competitor-variant-group-delete',
        title: '批量删除竞品变体组',
        userId,
      });
      expect(job?.data.createdAt).toBe(task?.createdAt);
      expect(job?.opts).toMatchObject({
        attempts: 1,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      });
      await start();
      const result = await terminal(id);
      expect(result).toMatchObject({
        taskId: id,
        status: 'completed',
        progress: 100,
        result: {
          mode: 'async',
          totalRequested: 5,
          deletedGroupCount: 1,
          deletedDirectAsinCount: 1,
          deletedNestedAsinCount: 2,
          failedCount: 0,
          skippedCount: 2,
          verificationPassed: true,
        },
      });
      expect((await rows('competitor_asins')).map((row) => row.id)).toEqual([
        'g2-a1',
      ]);
    });
    it('one physical consumer handles interleaved domains without deleting their matching IDs in the other database', async () => {
      for (const id of ['g1', 'g2']) {
        await group(id);
        await f.pools.primaryPool.query(
          "INSERT INTO variant_groups(id,name,country,site,brand) VALUES($1,$1,'US','amazon.com','Fixture')",
          [id],
        );
        await f.pools.primaryPool.query(
          "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) VALUES($1,$1,'US','amazon.com','Fixture',$2)",
          [`${id}-a0`, id],
        );
      }
      const competitorId = await accepted({ groupIds: ['g1'] });
      const response = await f.http.inject({
        method: 'POST',
        url: '/api/v1/variant-groups/batch-delete',
        headers,
        payload: { groupIds: ['g2'], useAsync: true },
      });
      expect(response.statusCode).toBe(200);
      const primaryId = response.json().data.taskId;
      expect((await queue.getJob(primaryId))?.name).toBe('asin-batch-delete');
      await start();
      await terminal(competitorId);
      await terminal(primaryId);
      expect((await rows('competitor_asins')).map((row) => row.id)).toEqual([
        'g2-a0',
      ]);
      expect(
        (await f.pools.primaryPool.query('SELECT id FROM asins ORDER BY id'))
          .rows,
      ).toEqual([{ id: 'g1-a0' }]);
      expect(await queue.getWorkers()).toHaveLength(1);
    });
    it('bounds claimed Worker concurrency and leaves competitor availability lazy for primary jobs', async () => {
      await f.pools.primaryPool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand) VALUES('primary','primary','US','amazon.com','Fixture')",
      );
      const response = await f.http.inject({
        method: 'POST',
        url: '/api/v1/variant-groups/batch-delete',
        headers,
        payload: { groupIds: ['primary'], useAsync: true },
      });
      expect(response.statusCode).toBe(200);
      await start({
        BATCH_DELETE_QUEUE_WORKER_CONCURRENCY: 100,
        COMPETITOR_DATABASE_URL:
          'postgresql://fixture:fixture@127.0.0.1:1/unavailable',
      });
      expect(runtime?.worker.opts.concurrency).toBe(16);
      await terminal(response.json().data.taskId);
      expect(
        (await f.pools.primaryPool.query('SELECT id FROM variant_groups')).rows,
      ).toEqual([]);
    });
    it('keeps a real job queryable when enqueue succeeds but its acknowledgement is lost', async () => {
      await group('g1');
      const add = Queue.prototype.add;
      const spy = vi
        .spyOn(Queue.prototype, 'add')
        .mockImplementationOnce(async function (
          this: Queue,
          ...args: Parameters<typeof add>
        ) {
          await Reflect.apply(add, this, args);
          throw new Error('private-delete-enqueue-ack');
        });
      let id: string;
      try {
        const response = await request({ groupIds: ['g1'], useAsync: true });
        expect(response.statusCode).toBe(500);
        expect(response.json().data.status).toBe('unknown');
        id = response.json().data.taskId;
        expect(
          response.body + JSON.stringify(f.logger.error.mock.calls),
        ).not.toContain('private-delete-enqueue-ack');
      } finally {
        spy.mockRestore();
      }
      expect(await queue.getJob(id!)).toBeDefined();
      expect((await queryTask(id!)).statusCode).toBe(200);
      await start();
      await terminal(id!);
      expect(await rows('competitor_asins')).toHaveLength(0);
    });
    it('replays terminal metadata without deleting a newly recreated matching group', async () => {
      await group('g1');
      const id = await accepted({ groupIds: ['g1'] });
      await start();
      const original = await terminal(id),
        job = await queue.getJob(id);
      await runtime!.close();
      runtime = undefined;
      const payload = job!.data;
      await job!.remove();
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_variant_groups(id,name,country,brand) VALUES('g1','recreated','US','Fixture')",
      );
      await queue.add('competitor-batch-delete', payload, { jobId: id });
      await start();
      expect((await terminal(id)).result).toEqual(original.result);
      expect((await rows('competitor_variant_groups'))[0].name).toBe(
        'recreated',
      );
    });
    it('prevents a different authenticated user from querying or cancelling an owned competitor job', async () => {
      await group('g1');
      const id = await accepted({ groupIds: ['g1'] }),
        other = randomUUID(),
        session = randomUUID();
      f.userIds.add(other);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [other, 'unused-fixture-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'reader-71')",
        [other],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [session, other],
      );
      const foreign = {
        ...headers,
        authorization: `Bearer ${jwt.sign(
          { userId: other, sessionId: session },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
      for (const [method, url] of [
        ['GET', `/api/v1/tasks/${id}`],
        ['POST', `/api/v1/tasks/${id}/cancel`],
      ] as const)
        expect(
          (await f.http.inject({ method, url, headers: foreign })).statusCode,
        ).toBe(403);
      expect((await store.read(id))?.status).toBe('pending');
      expect(await queue.getJob(id)).toBeDefined();
    });
    it('accepted work continues after its submitting session is revoked', async () => {
      await group('g1');
      const id = await accepted({ groupIds: ['g1'] });
      await f.pools.primaryPool.query(
        "UPDATE sessions SET status='REVOKED' WHERE id=$1",
        [sessionId],
      );
      await start();
      await vi.waitFor(
        async () => expect((await store.read(id))?.status).toBe('completed'),
        { timeout: 8000, interval: 20 },
      );
      expect(await rows('competitor_asins')).toHaveLength(0);
    });
    it('queued cancellation removes the actual job and leaves database rows intact', async () => {
      await group('g1');
      const id = await accepted({ groupIds: ['g1'] });
      expect((await cancel(id)).statusCode).toBe(200);
      expect(await queue.getJob(id)).toBeUndefined();
      expect((await store.read(id))?.status).toBe('cancelled');
      await start();
      expect(await rows('competitor_asins')).toHaveLength(1);
    });
    it('one failed chunk rolls back only that chunk, then other chunks complete with visible warnings', async () => {
      await group('g1');
      await group('g2');
      await f.pools.competitorPool.query(
        "INSERT INTO batch_delete_fail_fixture VALUES('g1-a0')",
      );
      const id = await accepted({ groupIds: ['g1', 'g2'] });
      await start();
      const task = await terminal(id);
      expect(task.result).toMatchObject({
        failedCount: 1,
        deletedGroupCount: 1,
        deletedNestedAsinCount: 1,
        verificationPassed: false,
      });
      expect(JSON.stringify(task)).not.toContain('private deletion fixture');
      expect((await rows('competitor_asins')).map((row) => row.id)).toEqual([
        'g1-a0',
      ]);
    });
    it('running cancellation finishes the locked current chunk and skips the next one', async () => {
      await group('g1');
      await group('g2');
      const blocker = await f.pools.competitorPool.connect();
      let released = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(1095977294,199127)');
        await f.pools.competitorPool.query(
          'INSERT INTO batch_delete_barrier_fixture VALUES(true)',
        );
        const id = await accepted({ groupIds: ['g1', 'g2'] });
        await start();
        await vi.waitFor(
          async () =>
            expect(
              (
                await blocker.query(
                  "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype='advisory' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))",
                )
              ).rows[0].n,
            ).toBeGreaterThan(0),
          { timeout: 1000, interval: 10 },
        );
        expect((await cancel(id)).json().data.status).toBe('cancelling');
        await blocker.query('COMMIT');
        released = true;
        const result = await terminal(id, 'cancelled');
        expect(result.status).toBe('cancelled');
        expect((await rows('competitor_asins')).map((row) => row.id)).toEqual([
          'g2-a0',
        ]);
      } finally {
        if (!released) await blocker.query('ROLLBACK');
        blocker.release();
      }
    }, 15000);
    it('detects a concurrent parent move after planning and rolls back instead of deleting under stale parent locks', async () => {
      await group('g1');
      await group('g2', 0);
      const blocker = await f.pools.competitorPool.connect();
      let released = false;
      let pending: Promise<any> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM competitor_variant_groups WHERE id IN ('g1','g2') ORDER BY id FOR UPDATE",
        );
        pending = Promise.resolve(
          request({ asinIds: ['g1-a0'], useAsync: false }),
        );
        await vi.waitFor(
          async () =>
            expect(
              (
                await blocker.query(
                  'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
                )
              ).rows[0].n,
            ).toBeGreaterThan(0),
          { timeout: 1000, interval: 10 },
        );
        await blocker.query(
          "UPDATE competitor_asins SET variant_group_id='g2' WHERE id='g1-a0'",
        );
        await blocker.query('COMMIT');
        released = true;
        expect((await pending).statusCode).toBe(409);
        expect((await rows('competitor_asins'))[0].variant_group_id).toBe('g2');
      } finally {
        if (!released) await blocker.query('ROLLBACK');
        blocker.release();
        await pending;
      }
    });
    it
      .skipIf(process.platform === 'win32')
      .each(['batch-delete', 'batch-delete,maintenance'])(
      'compiled main registers %s, consumes the API job and shuts down normally',
      async (selection) => {
        await group('entry');
        const id = await accepted({ groupIds: ['entry'] });
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
              WORKER_ENABLED_QUEUES: selection,
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
          output = (output + chunk.toString('utf8')).slice(-32000);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('exit', (code, signal) => {
          outcome = { code, signal };
        });
        child.on('error', () => {
          output += '\nchild fixture start error';
        });
        try {
          await vi.waitFor(
            () => {
              expect(outcome, output).toBeUndefined();
              expect(output).toContain('Worker 已启动');
            },
            { timeout: 10000, interval: 20 },
          );
          const count = selection.includes('maintenance') ? 2 : 1;
          expect(output).toContain(`registeredProcessors: ${count}`);
          expect(output).toContain(`queueCount: ${count}`);
          expect(output).toContain("mode: 'business-worker'");
          expect((await terminal(id)).status).toBe('completed');
          expect(await rows('competitor_asins')).toHaveLength(0);
        } finally {
          if (!outcome) child.kill('SIGTERM');
          try {
            await vi.waitFor(() => expect(outcome).toBeDefined(), {
              timeout: 12000,
              interval: 25,
            });
          } catch {
            child.kill('SIGKILL');
            throw new Error('Compiled batch Worker shutdown exceeded bound');
          }
        }
        expect(outcome).toEqual({ code: 0, signal: null });
      },
      30000,
    );
  },
);
