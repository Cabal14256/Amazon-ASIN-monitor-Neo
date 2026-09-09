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
import { asinWriteApp } from './helpers/asin-write-app';

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
  'ASIN batch deletion / real HTTP, PostgreSQL, Redis and compiled business Worker',
  () => {
    const prefix = `fixture-batch-delete99-${randomUUID()}`;
    let f: Awaited<ReturnType<typeof asinWriteApp>>,
      env: Env,
      redis: Redis,
      queue: Queue,
      store: RedisTaskRepository,
      runtime: BusinessRuntime | undefined;
    let headers: Record<string, string>, userId: string, sessionId: string;
    const fatal = vi.fn();
    beforeAll(async () => {
      f = await asinWriteApp((builder) =>
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
      );
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
      await f.pools.primaryPool.query(
        'CREATE TABLE monitor_history (LIKE public.monitor_history INCLUDING ALL)',
      );
      await f.pools.primaryPool.query(
        'CREATE TABLE audit_logs_archive (LIKE public.audit_logs_archive INCLUDING ALL)',
      );
      await f.pools.primaryPool.query(
        'CREATE TABLE batch_delete_fail_fixture(id text PRIMARY KEY)',
      );
      await f.pools.primaryPool.query(
        'CREATE TABLE batch_delete_barrier_fixture(enabled boolean)',
      );
      await f.pools.primaryPool
        .query(`CREATE FUNCTION batch_delete_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS(SELECT 1 FROM batch_delete_fail_fixture WHERE id=OLD.id) THEN RAISE EXCEPTION 'private deletion fixture 99'; END IF;
      IF EXISTS(SELECT 1 FROM batch_delete_barrier_fixture WHERE enabled) THEN PERFORM pg_advisory_xact_lock_shared(1095977294,199001); END IF;
      RETURN OLD; END $$`);
      await f.pools.primaryPool.query(
        'CREATE TRIGGER batch_delete_fixture BEFORE DELETE ON asins FOR EACH ROW EXECUTE FUNCTION batch_delete_fixture()',
      );
    }, 20000);
    afterEach(async () => {
      if (runtime) {
        await runtime.close();
        runtime = undefined;
      }
      expect(fatal).not.toHaveBeenCalled();
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
          if (f) await f.close();
        }
      }
    });
    beforeEach(async () => {
      fatal.mockClear();
      await queue.obliterate({ force: true });
      await f.pools.primaryPool.query(
        'TRUNCATE batch_delete_fail_fixture, batch_delete_barrier_fixture, monitor_history',
      );
      await f.pools.primaryPool.query('DELETE FROM asins');
      await f.pools.primaryPool.query('DELETE FROM variant_groups');
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
        url: '/api/v1/variant-groups/batch-delete',
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
      await f.pools.primaryPool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand,update_time) VALUES($1,$1,'US','amazon.com','Fixture','2020-01-01 08:00:00')",
        [id],
      );
      for (let i = 0; i < children; i++)
        await f.pools.primaryPool.query(
          "INSERT INTO asins(id,asin,country,variant_group_id) VALUES($1,$2,'US',$3)",
          [`${id}-a${i}`, `${id}-${i}`, id],
        );
    }
    const rows = async (table: 'asins' | 'variant_groups') =>
      (
        await f.pools.primaryPool.query(
          `SELECT row_to_json(t) AS data FROM ${table} t ORDER BY id`,
        )
      ).rows.map((row) => row.data);
    async function accepted(payload: Record<string, unknown>) {
      const response = await request({ ...payload, useAsync: true });
      expect(response.statusCode).toBe(200);
      batchDeleteVariantGroupsResultSchema.parse(response.json());
      return response.json().data.taskId as string;
    }
    async function start() {
      runtime = await compiledRuntime().startAsinBatchDeleteRuntime(env, fatal);
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
      await f.pools.primaryPool.query(
        "INSERT INTO monitor_history(asin_id,country,is_broken,check_time) VALUES('g1-a0','US',false,'2026-01-01 08:00:00')",
      );
      const response = await request({
        groupIds: [' g1 ', 'missing', 'g1'],
        asinIds: ['g1-a0', 'g2-a0', 'absent'],
        useAsync: false,
      });
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
      expect((await rows('asins')).map((row) => row.id)).toEqual(['g2-a1']);
      expect((await rows('variant_groups'))[0].update_time).not.toContain(
        '2020',
      );
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT count(*)::int AS n FROM monitor_history',
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
          await f.pools.primaryPool.query(
            "INSERT INTO batch_delete_fail_fixture VALUES('g1-a1')",
          );
        const before = [await rows('variant_groups'), await rows('asins')];
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
        expect([await rows('variant_groups'), await rows('asins')]).toEqual(
          before,
        );
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
    it('current permission revocation rejects a previously cached writer before enqueue or deletion', async () => {
      await group('g1');
      expect((await request({ groupIds: ['missing'] })).statusCode).toBe(200);
      await f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id IN (SELECT id FROM permissions WHERE code='asin:delete')",
      );
      expect(
        (await request({ groupIds: ['g1'], useAsync: true })).statusCode,
      ).toBe(403);
      expect(await rows('asins')).toHaveLength(1);
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
      expect((await rows('asins')).map((row) => row.id)).toEqual(['g2-a1']);
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
      expect(await rows('asins')).toHaveLength(0);
    });
    it('queued cancellation removes the actual job and leaves database rows intact', async () => {
      await group('g1');
      const id = await accepted({ groupIds: ['g1'] });
      expect((await cancel(id)).statusCode).toBe(200);
      expect(await queue.getJob(id)).toBeUndefined();
      expect((await store.read(id))?.status).toBe('cancelled');
      await start();
      expect(await rows('asins')).toHaveLength(1);
    });
    it('one failed chunk rolls back only that chunk, then other chunks complete with visible warnings', async () => {
      await group('g1');
      await group('g2');
      await f.pools.primaryPool.query(
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
      expect((await rows('asins')).map((row) => row.id)).toEqual(['g1-a0']);
    });
    it('running cancellation finishes the locked current chunk and skips the next one', async () => {
      await group('g1');
      await group('g2');
      const blocker = await f.pools.primaryPool.connect();
      let released = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(1095977294,199001)');
        await f.pools.primaryPool.query(
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
        expect((await rows('asins')).map((row) => row.id)).toEqual(['g2-a0']);
      } finally {
        if (!released) await blocker.query('ROLLBACK');
        blocker.release();
      }
    }, 15000);
    it('detects a concurrent parent move after planning and rolls back instead of deleting under stale parent locks', async () => {
      await group('g1');
      await group('g2', 0);
      const blocker = await f.pools.primaryPool.connect();
      let released = false;
      let pending: Promise<any> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM variant_groups WHERE id IN ('g1','g2') ORDER BY id FOR UPDATE",
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
          "UPDATE asins SET variant_group_id='g2' WHERE id='g1-a0'",
        );
        await blocker.query('COMMIT');
        released = true;
        expect((await pending).statusCode).toBe(409);
        expect((await rows('asins'))[0].variant_group_id).toBe('g2');
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
          expect(await rows('asins')).toHaveLength(0);
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
