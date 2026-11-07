import { getNeoQueuePrefix } from '@asin-monitor/config';
import { competitorBatchCheckResultSchema } from '@asin-monitor/contracts';
import {
  PgCatalogOperationRepository,
  PgCompetitorCheckRepository,
  RedisTaskRepository,
  withCatalogOperationExecution,
  type CompetitorCheckRepositoryPort,
} from '@asin-monitor/db';
import { parseCatalogVariantResult } from '@asin-monitor/sp-api';
import {
  CompetitorBatchCheckExecutor,
  CompetitorCheckPipeline,
  VariantCheckCommitUncertainError,
  variantCheckJobOperation,
} from '@asin-monitor/variant-check';
import { Queue, QueueEvents, type ConnectionOptions } from 'bullmq';
import jwt from 'jsonwebtoken';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { COMPETITOR_CHECK_REPOSITORY } from '../src/competitor/competitor-check-storage.module';
import { CompetitorCheckModule } from '../src/competitor/competitor-check.module';
import { ApplicationCompetitorCheckRuntime } from '../src/competitor/competitor-check.runtime';
import { ApplicationSpApiRuntime } from '../src/sp-api-runtime/sp-api-runtime';
import { competitorWriteApp } from './helpers/competitor-write-app';

function assertDisposable() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true'
  )
    throw new Error('Explicit disposable integration opt-in is required');
  for (const [key, protocol, port, pathname] of [
    ['DATABASE_URL', 'postgresql:', '5432', '/amazon_asin_monitor_ci'],
    [
      'COMPETITOR_DATABASE_URL',
      'postgresql:',
      '5432',
      '/amazon_competitor_monitor_ci',
    ],
    ['REDIS_URL', 'redis:', '6379', '/15'],
  ]) {
    const value = new URL(process.env[key] ?? '');
    if (
      value.protocol !== protocol ||
      value.hostname !== '127.0.0.1' ||
      value.port !== port ||
      value.pathname !== pathname ||
      value.password ||
      value.search ||
      value.hash
    )
      throw new Error(
        'Competitor batch integration requires exact loopback CI targets',
      );
  }
}
async function eventually(check: () => Promise<boolean>, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Competitor batch integration condition timed out');
}

describe.skipIf(
  process.env.RUN_INTEGRATION_TESTS !== 'true' || process.platform === 'win32',
)(
  'competitor batch real HTTP, dual PostgreSQL, Redis and compiled Worker',
  () => {
    let f: Awaited<ReturnType<typeof competitorWriteApp>>;
    let queue: Queue, events: QueueEvents, store: RedisTaskRepository;
    let runtime: {
      pipeline: CompetitorCheckPipeline;
      batch: CompetitorBatchCheckExecutor;
    };
    let repository: PgCompetitorCheckRepository;
    let userId: string, sessionId: string, headers: Record<string, string>;
    let child: ChildProcess | undefined,
      exited = false,
      output = '';
    const prefix = `competitor-batch-251-${randomUUID().replaceAll('-', '')}`;
    const checker = {
      check: vi.fn(async (asin: string) =>
        parseCatalogVariantResult(
          {
            asin,
            relationships: [
              {
                relationships: [
                  { type: 'VARIATION', parentAsins: ['B000000099'] },
                ],
              },
            ],
          },
          asin,
        ),
      ),
    };
    const apply = async (name: string, competitor = true) => {
      const pool = competitor ? f.pools.competitorPool : f.pools.primaryPool;
      const schema = competitor ? f.competitorSchema : f.schema;
      const sql = readFileSync(
        resolve(__dirname, '../../../packages/db/migrations', name),
        'utf8',
      ).replaceAll('public', schema);
      const client = await pool.connect();
      try {
        await client.query(sql);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        await client.query(`SET search_path TO ${schema}`);
        client.release();
      }
    };
    beforeAll(async () => {
      assertDisposable();
      f = await competitorWriteApp({
        primaryBusiness: true,
        imports: [CompetitorCheckModule],
        env: { BULL_PREFIX: prefix },
        configure: (builder) =>
          builder
            .overrideProvider(ApplicationSpApiRuntime)
            .useValue({})
            .overrideProvider(ApplicationCompetitorCheckRuntime)
            .useFactory({
              inject: [COMPETITOR_CHECK_REPOSITORY],
              factory: (repo: CompetitorCheckRepositoryPort) => {
                const pipeline = new CompetitorCheckPipeline(
                  repo,
                  checker,
                  {
                    invalidate: async () => undefined,
                    clearDeferred: async () => undefined,
                  },
                  { info() {}, warn() {} },
                );
                const batch = new CompetitorBatchCheckExecutor(repo, pipeline);
                runtime = { pipeline, batch };
                return {
                  pipeline,
                  batch,
                  onModuleDestroy() {
                    batch.close();
                    pipeline.close();
                  },
                };
              },
            }),
      });
      await apply('0006_variant_check_receipts.sql', false);
      await apply('0014_competitor_check_receipts.sql');
      await apply('0018_competitor_batch_check_receipts.sql');
      await apply('0018_competitor_batch_check_receipts.sql');
      repository = new PgCompetitorCheckRepository(
        f.pools.primaryPool,
        f.pools.competitorPool,
      );
      queue = new Queue('batch-check-task-queue', {
        connection: f.redis.client as unknown as ConnectionOptions,
        prefix: getNeoQueuePrefix(f.env),
      });
      events = new QueueEvents('batch-check-task-queue', {
        connection: { host: '127.0.0.1', port: 6379, db: 15 },
        prefix: getNeoQueuePrefix(f.env),
      });
      await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
      store = new RedisTaskRepository(f.redis.client, f.env);
    }, 30_000);
    const stopWorker = async () => {
      if (child && !exited) {
        child.kill('SIGTERM');
        try {
          await eventually(async () => exited, 12_000);
        } catch {
          child.kill('SIGKILL');
          await eventually(async () => exited, 2000);
          throw new Error('Batch fixture Worker required forced shutdown');
        }
      }
      child = undefined;
    };
    afterEach(async () => {
      await stopWorker();
      checker.check.mockClear();
    });
    afterAll(async () => {
      await stopWorker();
      await events?.close();
      if (queue) {
        expect(queue.opts.prefix).toBe(`${prefix}:neo`);
        await queue.obliterate({ force: true });
        await queue.close();
      }
      if (f) {
        let cursor = '0',
          pages = 0;
        do {
          if (++pages > 100)
            throw new Error('Bounded fixture Redis cleanup exceeded its limit');
          const [next, keys] = await f.redis.client.scan(
            cursor,
            'MATCH',
            `${prefix}:neo:*`,
            'COUNT',
            100,
          );
          if (keys.some((key) => !key.startsWith(`${prefix}:neo:`)))
            throw new Error('Fixture Redis ownership changed');
          if (keys.length) await f.redis.client.del(...keys);
          cursor = next;
        } while (cursor !== '0');
      }
      repository?.close();
      await f?.close();
    }, 30_000);
    beforeEach(async () => {
      userId = randomUUID();
      sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
        [userId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:read' ON CONFLICT DO NOTHING",
      );
      headers = {
        authorization: `Bearer ${jwt.sign(
          { userId, sessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
        origin: f.env.CORS_ORIGIN,
      };
      await f.pools.competitorPool.query(
        'TRUNCATE competitor_variant_check_receipts,competitor_monitor_history,competitor_asins,competitor_variant_groups CASCADE',
      );
      for (const id of [
        'g1',
        ' padded ',
        'padded',
        '.',
        '   ',
        '😺'.repeat(50),
      ])
        await f.pools.competitorPool.query(
          "INSERT INTO competitor_variant_groups(id,name,country,brand) VALUES($1,$1,'US','Fixture')",
          [id],
        );
    });
    const post = (body: object, requestHeaders = headers) =>
      f.http.inject({
        method: 'POST',
        url: '/api/v1/competitor/variant-groups/batch-check',
        headers: requestHeaders,
        payload: body,
      });
    const get = (id: string, suffix = '', requestHeaders = headers) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${id}${suffix}`,
        headers: requestHeaders,
      });
    const count = async (table: string, competitor = true) =>
      Number(
        (
          await (competitor
            ? f.pools.competitorPool
            : f.pools.primaryPool
          ).query(`SELECT count(*)::int AS n FROM ${table}`)
        ).rows[0].n,
      );
    const startWorker = async () => {
      exited = false;
      output = '';
      child = spawn(
        process.execPath,
        [resolve(__dirname, '../../worker/dist/main.js')],
        {
          cwd: resolve(__dirname, '../../worker'),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PROCESS_ROLE: 'worker',
            AUTH_DATA_AUTHORITY: 'postgresql',
            DATABASE_URL: f.env.DATABASE_URL,
            COMPETITOR_DATABASE_URL: f.env.COMPETITOR_DATABASE_URL,
            REDIS_URL: f.env.REDIS_URL,
            BULL_PREFIX: prefix,
            WORKER_ENABLED_QUEUES: 'batch-check',
            SCHEDULER_ENABLED: 'false',
            LOG_LEVEL: 'INFO',
          },
        },
      );
      const collect = (value: Buffer) => {
        const safe = value
          .toString()
          .replaceAll(f.env.DATABASE_URL, '[primary-ci-database]')
          .replaceAll(f.env.COMPETITOR_DATABASE_URL, '[competitor-ci-database]')
          .replaceAll(f.env.REDIS_URL, '[redis-db-15]')
          .replaceAll(f.env.JWT_SECRET, '[fixture-jwt-key]');
        output = (output + safe).slice(-64_000);
      };
      child.stdout!.on('data', collect);
      child.stderr!.on('data', collect);
      child.on('error', () => {
        output += '\nWorker startup failed';
      });
      child.once('exit', () => {
        exited = true;
      });
      await eventually(async () => {
        if (exited)
          throw new Error(
            `Compiled batch fixture Worker exited before readiness: ${output}`,
          );
        return /registeredProcessors:\s*1/.test(output);
      }, 15_000);
    };

    it('uses real HTTP current authority, literal IDs, per-group failures and atomic competitor history without changing primary sentinels', async () => {
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_asins(id,asin,variant_group_id,asin_type,country,brand) VALUES('a1','B000000001','g1','MAIN_LINK','US','Fixture')",
      );
      const before = await f.pools.primaryPool.query(
        'SELECT * FROM competitor_variant_groups ORDER BY id',
      );
      const ids = [
        'g1',
        'missing',
        ' padded ',
        'padded',
        '.',
        '   ',
        '😺'.repeat(50),
      ];
      const response = await post({
        groupIds: ids,
        useAsync: false,
        forceRefresh: false,
      });
      expect(response.statusCode).toBe(200);
      competitorBatchCheckResultSchema.parse(response.json());
      expect(
        response
          .json()
          .data.results.map((row: { groupId: string }) => row.groupId),
      ).toEqual(ids);
      expect(response.json().data.results[1]).toMatchObject({ success: false });
      expect(response.json().data.results[2].groupSnapshot.id).toBe(' padded ');
      expect(response.json().data.results[3].groupSnapshot.id).toBe('padded');
      expect(await count('competitor_monitor_history')).toBe(2);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT * FROM competitor_variant_groups ORDER BY id',
          )
        ).rows,
      ).toEqual(before.rows);
      expect(await count('variant_check_receipts', false)).toBe(0);
      expect(checker.check).toHaveBeenCalledOnce();
    });
    it('checks duplicate nonempty groups in order with one history pair per position', async () => {
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_asins(id,asin,variant_group_id,asin_type,country,brand) VALUES('duplicate-a1','B000000001','g1','MAIN_LINK','US','Fixture')",
      );
      const response = await post({
        groupIds: ['g1', 'g1', ' padded ', 'g1'],
        useAsync: false,
        forceRefresh: true,
      });
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json()
          .data.results.map((row: { success: boolean }) => row.success),
      ).toEqual([true, true, true, true]);
      expect(checker.check).toHaveBeenCalledTimes(3);
      expect(await count('competitor_monitor_history')).toBe(6);
      expect(await count('competitor_variant_check_receipts')).toBe(0);
      expect(await count('variant_check_receipts', false)).toBe(0);
      expect(
        await new PgCatalogOperationRepository(f.pools.primaryPool).read(
          userId,
          'competitor',
        ),
      ).toBeNull();
    });
    it('queues and cancels the maximum-width Unicode batch without stranding its catalog reservation', async () => {
      const groupIds = Array<string>(1000).fill('😺'.repeat(50));
      const submitted = await post({ groupIds });
      expect(submitted.statusCode).toBe(200);
      const id = submitted.json().data.taskId as string;
      expect((await queue.getJob(id))?.data.params.groupIds).toEqual(groupIds);
      const cancelled = await f.http.inject({
        method: 'POST',
        url: `/api/v1/tasks/${id}/cancel`,
        headers,
        payload: {},
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().data.status).toBe('cancelled');
      expect(
        await new PgCatalogOperationRepository(f.pools.primaryPool).read(
          userId,
          'competitor',
        ),
      ).toBeNull();
    });
    it('keeps a pending real BullMQ task fenced after a lost client response and removes it through authenticated cancellation', async () => {
      const submitted = await post({ groupIds: ['g1'] });
      expect(submitted.statusCode).toBe(200);
      const id = submitted.json().data.taskId as string;
      expect((await queue.getJob(id))?.data.taskSubType).toBe(
        'competitor-variant-group',
      );
      expect(
        await new PgCatalogOperationRepository(f.pools.primaryPool).read(
          userId,
          'competitor',
        ),
      ).toMatchObject({ state: 'open', task: { taskId: id } });
      expect((await post({ groupIds: ['g1'] })).statusCode).toBe(409);
      const cancelled = await f.http.inject({
        method: 'POST',
        url: `/api/v1/tasks/${id}/cancel`,
        headers,
        payload: {},
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(cancelled.json().data.status).toBe('cancelled');
      expect(await queue.getJob(id)).toBeUndefined();
      expect((await get(id, '/download')).statusCode).toBe(409);
      expect(await count('competitor_variant_check_receipts')).toBe(0);
    });
    it('submits through real HTTP and the compiled batch-only Worker, downloads the owned competitor root and never writes a primary receipt', async () => {
      const submitted = await post({
        groupIds: [' padded ', 'padded', ' padded '],
        forceRefresh: false,
      });
      expect(submitted.statusCode).toBe(200);
      const id = submitted.json().data.taskId as string,
        job = await queue.getJob(id);
      expect(job).toBeDefined();
      await startWorker();
      const reference = await job!.waitUntilFinished(events, 25_000);
      expect(reference.resultKind).toBe('competitor-batch');
      const detail = await get(id);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data.status).toBe('completed');
      expect(detail.json().data.result).toMatchObject({
        total: 3,
        successCount: 3,
        results: [
          { groupId: ' padded ' },
          { groupId: 'padded' },
          { groupId: ' padded ' },
        ],
      });
      const download = await get(id, '/download');
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toContain('application/json');
      expect(JSON.parse(download.body)).toEqual(detail.json().data.result);
      expect(await count('competitor_variant_check_receipts')).toBe(4);
      expect(await count('variant_check_receipts', false)).toBe(0);
      const before = await f.pools.competitorPool.query(
        'SELECT operation_key,completed_at,result FROM competitor_variant_check_receipts ORDER BY operation_key',
      );
      await stopWorker();
      await startWorker();
      await job!.retry('completed');
      await job!.waitUntilFinished(events, 10_000);
      expect(
        (
          await f.pools.competitorPool.query(
            'SELECT operation_key,completed_at,result FROM competitor_variant_check_receipts ORDER BY operation_key',
          )
        ).rows,
      ).toEqual(before.rows);
      await f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id=(SELECT id FROM permissions WHERE code='asin:read')",
      );
      expect((await get(id, '/download')).statusCode).toBe(403);
    }, 60_000);
    it('rolls 0018 back twice when empty, blocks destructive rollback while a batch receipt exists, and retains real committed recovery evidence', async () => {
      await apply('0018_competitor_batch_check_receipts.rollback.sql');
      await apply('0018_competitor_batch_check_receipts.rollback.sql');
      await apply('0018_competitor_batch_check_receipts.sql');
      const now = new Date(),
        data = {
          taskId: randomUUID(),
          userId,
          taskType: 'batch-check' as const,
          taskSubType: 'competitor-variant-group' as const,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
          params: { groupIds: ['g1'], forceRefresh: false },
        };
      const operations = new PgCatalogOperationRepository(f.pools.primaryPool);
      const identity = await operations.reserve(
        { ownerId: userId, domain: 'competitor', kind: 'check' },
        async () => undefined,
      );
      const ctx = {
        forceRefresh: false,
        checkpoint: async () => undefined,
        authorize: async () => undefined,
      };
      const service = new CompetitorCheckPipeline(
        repository,
        checker,
        {
          invalidate: async () => undefined,
          clearDeferred: async () => undefined,
        },
        { info() {}, warn() {} },
      );
      const original = repository.transaction.bind(repository);
      let lose = true;
      repository.transaction = async (action, signal, onWork) => {
        const value = await original(action, signal, onWork);
        if (
          lose &&
          value &&
          typeof value === 'object' &&
          'total' in value &&
          'results' in value
        ) {
          lose = false;
          throw new Error('fault after actual root COMMIT');
        }
        return value;
      };
      const executor = new CompetitorBatchCheckExecutor(repository, service);
      try {
        await expect(
          withCatalogOperationExecution(operations, identity, () =>
            executor.execute(data, ctx),
          ),
        ).rejects.toBeInstanceOf(VariantCheckCommitUncertainError);
        expect(await count('competitor_variant_check_receipts')).toBe(2);
        const reference = await withCatalogOperationExecution(
          operations,
          identity,
          () => executor.execute(data, ctx),
        );
        expect(reference.operationKey).toBe(
          variantCheckJobOperation(data).operationKey,
        );
        await expect(
          apply('0018_competitor_batch_check_receipts.rollback.sql'),
        ).rejects.toBeInstanceOf(Error);
        expect(await count('competitor_variant_check_receipts')).toBe(2);
        expect(await count('variant_check_receipts', false)).toBe(0);
      } finally {
        executor.close();
        service.close();
        repository.transaction = original;
        await operations.close(identity, {
          source: 'sync',
          status: 'completed',
        });
        await operations.release(identity);
      }
    }, 20_000);
  },
);
