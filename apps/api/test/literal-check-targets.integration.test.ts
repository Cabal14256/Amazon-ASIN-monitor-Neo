import { getPhysicalQueueName, type Env } from '@asin-monitor/config';
import {
  PgPrimaryMonitorRepository,
  RedisTaskRepository,
} from '@asin-monitor/db';
import type { HttpInput, HttpResponse } from '@asin-monitor/sp-api';
import type { Queue, Worker } from 'bullmq';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { CompetitorCheckModule } from '../src/competitor/competitor-check.module';
import {
  SP_API_QUOTA_ENV,
  SpApiHtmlHttpTransport,
  SpApiHttpTransport,
} from '../src/sp-api-runtime/sp-api-runtime.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { VariantCheckModule } from '../src/variant-check/variant-check.module';
import { competitorWriteApp } from './helpers/competitor-write-app';
import { legacyLiteralCheckFixture } from './helpers/literal-check-legacy';

interface CheckRuntime {
  queues: Queue[];
  workers: Worker[];
  close(): Promise<void>;
}
const compiled = createRequire(resolve(__dirname, '../../worker/dist/main.js'));
const suite =
  process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;
const targets = [
  {
    domain: 'primary',
    kind: 'group',
    route: '/variant-groups',
    field: 'groupId',
  },
  { domain: 'primary', kind: 'asin', route: '/asins', field: 'asinId' },
  {
    domain: 'competitor',
    kind: 'group',
    route: '/competitor/variant-groups',
    field: 'groupId',
  },
  {
    domain: 'competitor',
    kind: 'asin',
    route: '/competitor/asins',
    field: 'asinId',
  },
] as const;
const literalIds = [' Leading Ś', 'Trailing Ś ', '   ', '😺'.repeat(50)];

/** Real Nest HTTP -> Redis/BullMQ -> compiled Worker -> private PostgreSQL.
 * Only external HTTP observations are replaced. Missing normalized neighbours
 * are additionally exercised through the actual frozen Legacy MySQL service. */
suite(
  'literal Neo check targets and documented Legacy safety difference',
  () => {
    const prefix = `fixture-literal-check227-${randomUUID()}`;
    let f: Awaited<ReturnType<typeof competitorWriteApp>>;
    let legacy: Awaited<ReturnType<typeof legacyLiteralCheckFixture>>;
    let runtime: CheckRuntime | undefined;
    let store: RedisTaskRepository;
    let headers: Record<string, string>;
    let userId: string;
    let counter = 0;
    const fatal = vi.fn();
    const fixtureEnv = {
      SP_API_LWA_CLIENT_ID: 'fixture-client-227',
      SP_API_LWA_CLIENT_SECRET: 'fixture-secret-227',
      SP_API_REFRESH_TOKEN: 'fixture-refresh-227',
      RATE_LIMITER_KEY_PREFIX: `${prefix}:quota`,
      SP_API_RATE_LIMIT_PER_MINUTE: '120',
      SP_API_RATE_LIMIT_PER_HOUR: '7200',
      SP_API_RATE_LIMIT_SAFETY_FACTOR: '1',
      ENABLE_HTML_SCRAPER_FALLBACK: 'false',
      ENABLE_LEGACY_CLIENT_FALLBACK: 'false',
    };
    const transport = {
      request: vi.fn(async (input: HttpInput): Promise<HttpResponse> => {
        if (input.url.hostname === 'api.amazon.com')
          return {
            statusCode: 200,
            headers: {},
            body: '{"access_token":"fixture-token-227","token_type":"bearer","expires_in":3600}',
          };
        const asin = input.url.pathname.match(
          /^\/catalog\/2022-04-01\/items\/(B\d{9})$/,
        )?.[1];
        if (input.url.hostname !== 'sellingpartnerapi-na.amazon.com' || !asin)
          throw new Error('Unexpected fixture upstream request');
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            asin,
            summaries: [{ itemName: 'Fixture title', brand: 'Fixture' }],
            relationships: [
              {
                relationships: [
                  { type: 'VARIATION', parentAsins: ['B999999999'] },
                ],
              },
            ],
          }),
        };
      }),
    };
    const migration = async (
      file: string,
      schema: string,
      competitor = false,
    ) => {
      let sql = readFileSync(
        resolve(__dirname, `../../../packages/db/migrations/${file}.sql`),
        'utf8',
      );
      sql = competitor
        ? sql
            .replaceAll(
              'public.competitor_variant_check_receipts',
              `"${schema}".competitor_variant_check_receipts`,
            )
            .replace(
              'SET LOCAL search_path TO pg_catalog, public;',
              `SET LOCAL search_path TO pg_catalog, "${schema}";`,
            )
        : sql.replaceAll('public', schema);
      const client = await (competitor
        ? f.pools.competitorPool
        : f.pools.primaryPool
      ).connect();
      try {
        await client.query(sql);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    beforeAll(async () => {
      f = await competitorWriteApp({
        primaryBusiness: true,
        imports: [VariantCheckModule, CompetitorCheckModule],
        env: {
          BULL_PREFIX: prefix,
          RATE_LIMITER_KEY_PREFIX: fixtureEnv.RATE_LIMITER_KEY_PREFIX,
          BATCH_CHECK_GROUP_CONCURRENCY: 1,
        },
        configure: (builder) =>
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
      });
      await f.pools.primaryPool.query(
        'CREATE TABLE monitor_history (LIKE public.monitor_history INCLUDING ALL); CREATE TABLE primary_monitor_runs (LIKE public.primary_monitor_runs INCLUDING ALL)',
      );
      await migration('0006_variant_check_receipts', f.schema);
      await migration(
        '0014_competitor_check_receipts',
        f.competitorSchema,
        true,
      );
      legacy = await legacyLiteralCheckFixture();
      store = new RedisTaskRepository(f.redis.client, f.env);
      userId = randomUUID();
      const sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `literal-${userId}`, 'unused-fixture-hash'],
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
    }, 30_000);
    beforeEach(async () => {
      await f.pools.primaryPool.query(
        'TRUNCATE variant_check_receipts,monitor_history,asins,variant_groups,primary_monitor_runs CASCADE',
      );
      await f.pools.competitorPool.query(
        'TRUNCATE competitor_variant_check_receipts,competitor_monitor_history,competitor_asins,competitor_variant_groups CASCADE',
      );
      await legacy.reset();
      transport.request.mockClear();
    });
    afterEach(async () => {
      await runtime?.close();
      runtime = undefined;
      expect(fatal).not.toHaveBeenCalled();
    });
    afterAll(async () => {
      try {
        await runtime?.close();
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
        try {
          await legacy?.close();
        } finally {
          await f?.close();
          vi.restoreAllMocks();
        }
      }
    });
    const post = (path: string, payload: Record<string, unknown>) =>
      f.http.inject({
        method: 'POST',
        url: `/api/v1${path}`,
        headers,
        payload,
      });
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
          selected: string[],
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
    }
    async function finish(taskId: string, status: 'completed' | 'failed') {
      await vi.waitFor(
        async () => expect((await store.read(taskId))?.status).toBe(status),
        { timeout: 15_000, interval: 50 },
      );
      const response = await f.http.inject({
        method: 'GET',
        url: `/api/v1/tasks/${taskId}`,
        headers,
      });
      expect(response.statusCode, response.body.slice(0, 500)).toBe(200);
      return (await store.read(taskId))!;
    }
    async function queuedParams(taskId: string) {
      const queue = runtime!.queues.find(
        (value) => value.name === getPhysicalQueueName('variant-check'),
      )!;
      const job = await queue.getJob(taskId);
      const task = (await store.read(taskId))!;
      expect(job!.data).toMatchObject({
        taskId,
        userId,
        createdAt: task.createdAt,
      });
      return job!.data.params as unknown;
    }
    async function seed(
      domain: 'primary' | 'competitor',
      groupId: string,
      asinId: string,
    ) {
      const primary = domain === 'primary';
      const pool = primary ? f.pools.primaryPool : f.pools.competitorPool;
      const g = primary ? 'variant_groups' : 'competitor_variant_groups';
      const a = primary ? 'asins' : 'competitor_asins';
      const asin = `B${String(++counter).padStart(9, '0')}`;
      await pool.query(
        `INSERT INTO ${g}(id,name,country,brand,is_broken,variant_status${
          primary ? ',site' : ''
        }) VALUES($1,'Fixture','US','Fixture',true,'BROKEN'${
          primary ? ",'amazon.com'" : ''
        })`,
        [groupId],
      );
      await pool.query(
        `INSERT INTO ${a}(id,asin,name,asin_type,country,brand,variant_group_id,is_broken,variant_status${
          primary ? ',site' : ''
        }) VALUES($1,$2,'Fixture','MAIN_LINK','US','Fixture',$3,true,'BROKEN'${
          primary ? ",'amazon.com'" : ''
        })`,
        [asinId, asin, groupId],
      );
      return { pool, g, a, asin };
    }
    describe.each(targets)('$domain $kind real target', (target) => {
      it.each(
        literalIds.flatMap((id) =>
          [false, true].map((useAsync) => ({ id, useAsync })),
        ),
      )(
        'keeps %j through HTTP, queue and physical write',
        async ({ id, useAsync }) => {
          const groupId = target.kind === 'group' ? id : 'fixture-parent';
          const asinId = target.kind === 'asin' ? id : 'fixture-child';
          const seeded = await seed(target.domain, groupId, asinId);
          if (useAsync) await start();
          const response = await post(
            `${target.route}/${encodeURIComponent(id)}/check`,
            { useAsync, forceRefresh: true },
          );
          expect(response.statusCode, response.body.slice(0, 500)).toBe(200);
          if (useAsync) {
            const task = await finish(response.json().data.taskId, 'completed');
            expect(await queuedParams(task.taskId)).toEqual({
              [target.field]: id,
              forceRefresh: true,
            });
            const receipt =
              target.domain === 'primary'
                ? 'variant_check_receipts'
                : 'competitor_variant_check_receipts';
            expect(
              (
                await seeded.pool.query(
                  `SELECT count(*)::integer AS n FROM ${receipt} WHERE task_id=$1`,
                  [task.taskId],
                )
              ).rows[0].n,
            ).toBe(1);
            const result = await f.http.inject({
              method: 'GET',
              url: `/api/v1/tasks/${task.taskId}/download`,
              headers,
            });
            expect(result.statusCode).toBe(200);
            if (target.kind === 'group')
              expect(result.json().groupSnapshot.id).toBe(id);
          } else if (target.kind === 'group')
            expect(response.json().data.groupSnapshot.id).toBe(id);
          const row = (
            await seeded.pool.query(
              `SELECT id,is_broken,last_check_time FROM ${seeded.a} WHERE id=$1`,
              [asinId],
            )
          ).rows[0];
          expect(row.id).toBe(asinId);
          expect(row.is_broken).toBe(false);
          expect(row.last_check_time).not.toBeNull();
          const history =
            target.domain === 'primary'
              ? 'monitor_history'
              : 'competitor_monitor_history';
          expect(
            (
              await seeded.pool.query(
                `SELECT DISTINCT variant_group_id,asin_id FROM ${history} WHERE check_type='ASIN'`,
              )
            ).rows,
          ).toEqual([{ variant_group_id: groupId, asin_id: asinId }]);
        },
        25_000,
      );
    });
    describe.each(['group', 'asin'] as const)(
      'missing literal competitor %s safety',
      (kind) => {
        it.each(
          [
            { stored: 'Tail', requested: 'Tail ' },
            { stored: 'Case', requested: 'case' },
            { stored: 'café', requested: 'cafe' },
          ].flatMap((value) =>
            [false, true].map((useAsync) => ({ ...value, useAsync })),
          ),
        )(
          'documents actual Legacy neighbour write and Neo rejection %j',
          async ({ stored, requested, useAsync }) => {
            const groupId = kind === 'group' ? stored : 'fixture-parent';
            const asinId = kind === 'asin' ? stored : 'fixture-child';
            const seeded = await seed('competitor', groupId, asinId);
            await legacy.query(
              "INSERT INTO competitor_variant_groups(id,name,country,brand,is_broken,variant_status) VALUES(?,'Fixture','US','Fixture',1,'BROKEN')",
              [groupId],
            );
            await legacy.query(
              "INSERT INTO competitor_asins(id,asin,name,asin_type,country,brand,variant_group_id,is_broken,variant_status) VALUES(?,?,'Fixture','MAIN_LINK','US','Fixture',?,1,'BROKEN')",
              [asinId, seeded.asin, groupId],
            );
            // BINARY proves no requested literal key exists before the frozen service
            // resolves it via the real utf8mb4_unicode_ci equality operator.
            const table = kind === 'group' ? seeded.g : seeded.a;
            expect(
              await legacy.query(
                `SELECT id FROM ${table} WHERE BINARY id=BINARY ?`,
                [requested],
              ),
            ).toEqual([]);
            await legacy.check(kind, requested);
            const changed = (
              await legacy.query(
                'SELECT id,is_broken,last_check_time FROM competitor_asins WHERE BINARY id=BINARY ?',
                [asinId],
              )
            )[0];
            expect(changed.id).toBe(asinId);
            expect(changed.is_broken).toBe(0);
            expect(changed.last_check_time).not.toBeNull();
            expect(
              (await legacy.query('SELECT id FROM competitor_monitor_history'))
                .length,
            ).toBeGreaterThan(0);
            if (useAsync) await start();
            const route =
              kind === 'group'
                ? '/competitor/variant-groups'
                : '/competitor/asins';
            const response = await post(
              `${route}/${encodeURIComponent(requested)}/check`,
              { useAsync, forceRefresh: true },
            );
            expect(response.statusCode, response.body.slice(0, 500)).toBe(404);
            expect(response.json().data?.taskId).toBeUndefined();
            if (useAsync) {
              // Admission already rejects the missing literal target. Also
              // exercise an explicitly seeded private job through the actual
              // producer and compiled consumer, as a pre-existing queued job.
              const port = f.app
                .get(TaskQueryRuntime)
                .openCheck(() => undefined);
              const prepared = await port.store.create({
                taskId: randomUUID(),
                userId,
                taskType: 'variant-check',
                taskSubType:
                  kind === 'group'
                    ? 'competitor-variant-group-check'
                    : 'competitor-asin-check',
              });
              const identity = {
                taskId: prepared.taskId,
                userId,
                createdAt: prepared.createdAt,
                expiresAt: new Date(
                  Date.parse(prepared.createdAt) +
                    f.env.TASK_META_TTL_SECONDS * 1000,
                ).toISOString(),
                taskType: 'variant-check' as const,
              };
              await port.enqueue(
                kind === 'group'
                  ? {
                      ...identity,
                      taskSubType: 'competitor-variant-group-check',
                      params: { groupId: requested, forceRefresh: true },
                    }
                  : {
                      ...identity,
                      taskSubType: 'competitor-asin-check',
                      params: { asinId: requested, forceRefresh: true },
                    },
              );
              const task = await finish(prepared.taskId, 'failed');
              expect(await queuedParams(task.taskId)).toEqual({
                [kind === 'group' ? 'groupId' : 'asinId']: requested,
                forceRefresh: true,
              });
            }
            const preserved = (
              await seeded.pool.query(
                'SELECT id,is_broken,last_check_time FROM competitor_asins WHERE id=$1',
                [asinId],
              )
            ).rows[0];
            expect(preserved).toEqual({
              id: asinId,
              is_broken: true,
              last_check_time: null,
            });
            expect(
              (
                await seeded.pool.query(
                  'SELECT id FROM competitor_monitor_history',
                )
              ).rows,
            ).toEqual([]);
            expect(
              (
                await seeded.pool.query(
                  'SELECT operation_key FROM competitor_variant_check_receipts',
                )
              ).rows,
            ).toEqual([]);
            expect(
              transport.request.mock.calls.filter(
                ([input]) =>
                  input.url.hostname === 'sellingpartnerapi-na.amazon.com',
              ),
            ).toEqual([]);
          },
          25_000,
        );
      },
    );
    it('replays a native primary monitor snapshot with 50-codepoint and whitespace IDs exactly', async () => {
      for (let i = 0; i < literalIds.length; i++)
        await seed('primary', literalIds[i], `monitor-child-${i}`);
      const repository = new PgPrimaryMonitorRepository(f.pools.primaryPool);
      const now = new Date();
      const job = {
        taskId: randomUUID(),
        userId,
        taskType: 'monitor' as const,
        taskSubType: 'primary' as const,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        countries: ['US'] as ['US'],
      };
      const frozen = await repository.groups(job);
      expect(new Set(frozen.map((value) => value.groupId))).toEqual(
        new Set(literalIds),
      );
      expect(await repository.groups(job)).toEqual(frozen);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT groups FROM primary_monitor_runs WHERE task_id=$1',
            [job.taskId],
          )
        ).rows[0].groups,
      ).toEqual(frozen);
    });
  },
);
