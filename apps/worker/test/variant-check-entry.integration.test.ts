import { getNeoQueuePrefix, getPhysicalQueueName } from '@asin-monitor/config';
import type {
  PrimaryMonitorJob,
  VariantCheckJobData,
} from '@asin-monitor/contracts';
import {
  createPgPool,
  PgCompetitorCheckRepository,
  PgVariantCheckRepository,
  RedisTaskRepository,
} from '@asin-monitor/db';
import {
  variantCheckJobOperation,
  variantCheckResultOperation,
} from '@asin-monitor/variant-check';
import { Queue, QueueEvents, type ConnectionOptions } from 'bullmq';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getQueueOptions } from '../src/queue-policy';
import { parseRedisUrl } from '../src/redis-options';
import {
  eventually,
  maintenanceFixture,
} from './helpers/auth-maintenance-fixture';

/** Real compiled entry, combined BullMQ consumers and isolated PG completion storage.
 * Empty groups and pre-existing receipts avoid contacting live Amazon in CI.
 * This suite does not prove HTTP submission or live Amazon integration. */
describe.skipIf(
  process.env.RUN_INTEGRATION_TESTS !== 'true' || process.platform === 'win32',
)('Compiled check consumers on isolated PostgreSQL and Redis', () => {
  let f: Awaited<ReturnType<typeof maintenanceFixture>>;
  let store: RedisTaskRepository, repository: PgVariantCheckRepository;
  let competitorPool: ReturnType<typeof createPgPool> | undefined;
  let competitorBootstrap: ReturnType<typeof createPgPool> | undefined;
  let competitorRepository: PgCompetitorCheckRepository;
  let competitorSchema = '';
  let competitorDatabaseUrl = '';
  let competitorInstalled = false;
  type FixtureQueue = 'variant-check' | 'batch-check' | 'monitor';
  const queues = new Map<FixtureQueue, Queue>();
  const events = new Map<FixtureQueue, QueueEvents>();
  let child: ChildProcess | undefined,
    exited = false,
    output = '';
  beforeEach(async () => {
    f = await maintenanceFixture();
    const schema = (await f.pool.query('SELECT current_schema() AS schema'))
      .rows[0].schema as string;
    if (!/^auth_worker_67_[a-f0-9]{32}$/.test(schema))
      throw new Error('Unexpected fixture schema');
    for (const table of [
      'variant_groups',
      'asins',
      'monitor_history',
      'sp_api_config',
    ])
      await f.pool.query(
        `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    const connection = await f.pool.connect();
    try {
      for (const name of [
        '0004_asin_timestamp_policy.sql',
        '0006_variant_check_receipts.sql',
      ])
        await connection.query(
          readFileSync(
            resolve(__dirname, '../../../packages/db/migrations', name),
            'utf8',
          ).replaceAll('public', schema),
        );
      // 0004 changes the session search_path to pg_catalog first. Restore the
      // owned schema before returning this connection to the fixture pool.
      await connection.query(`SET search_path TO ${schema}`);
      if (
        (await connection.query('SELECT current_schema() AS schema')).rows[0]
          ?.schema !== schema
      )
        throw new Error('Fixture migration changed primary schema ownership');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    await f.pool.query(
      "INSERT INTO variant_groups(id,name,country,site,brand) VALUES('g1','Empty one','US','amazon.com','Fixture'),('g2','Empty two','US','amazon.com','Fixture')",
    );
    competitorSchema = `competitor_worker_178_${randomUUID().replace(
      /-/g,
      '',
    )}`;
    if (!/^competitor_worker_178_[a-f0-9]{32}$/.test(competitorSchema))
      throw new Error('Unexpected competitor fixture schema');
    competitorBootstrap = createPgPool(process.env.COMPETITOR_DATABASE_URL!, {
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    const competitorUrl = new URL(process.env.COMPETITOR_DATABASE_URL!);
    competitorUrl.searchParams.set(
      'options',
      `-c search_path=${competitorSchema} -c timezone=UTC`,
    );
    competitorDatabaseUrl = competitorUrl.toString();
    competitorPool = createPgPool(competitorDatabaseUrl, {
      max: 4,
      connectionTimeoutMillis: 2000,
    });
    const [primaryDatabase, competitorDatabase] = await Promise.all([
      f.pool.query('SELECT current_database() AS name'),
      competitorPool.query('SELECT current_database() AS name'),
    ]);
    if (primaryDatabase.rows[0]?.name === competitorDatabase.rows[0]?.name)
      throw new Error('Competitor fixture must use a distinct database');
    await competitorBootstrap.query(`CREATE SCHEMA ${competitorSchema}`);
    competitorInstalled = true;
    if (
      (await competitorPool.query('SELECT current_schema() AS name')).rows[0]
        ?.name !== competitorSchema
    )
      throw new Error('Competitor fixture escaped private schema');
    await competitorBootstrap.query(
      `CREATE TABLE ${competitorSchema}.competitor_variant_groups (LIKE public.competitor_variant_groups INCLUDING ALL)`,
    );
    await competitorBootstrap.query(
      `CREATE TABLE ${competitorSchema}.competitor_asins (LIKE public.competitor_asins INCLUDING ALL EXCLUDING INDEXES)`,
    );
    await competitorBootstrap.query(
      `CREATE TABLE ${competitorSchema}.competitor_monitor_history (LIKE public.competitor_monitor_history INCLUDING ALL)`,
    );
    await competitorBootstrap.query(
      `ALTER TABLE ${competitorSchema}.competitor_asins ADD PRIMARY KEY(id), ADD CONSTRAINT uk_competitor_asins_asin_country UNIQUE(asin,country), ADD CONSTRAINT fk_competitor_asins_variant_group FOREIGN KEY(variant_group_id) REFERENCES ${competitorSchema}.competitor_variant_groups(id) ON DELETE CASCADE`,
    );
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
    const competitorConnection = await competitorPool.connect();
    try {
      await competitorConnection.query(policy);
    } catch (error) {
      await competitorConnection.query('ROLLBACK');
      throw error;
    } finally {
      competitorConnection.release();
    }
    await competitorPool.query(
      readFileSync(
        resolve(
          __dirname,
          '../../../packages/db/migrations/0014_competitor_check_receipts.sql',
        ),
        'utf8',
      ).replaceAll('public', competitorSchema),
    );
    store = new RedisTaskRepository(f.redis, f.env);
    repository = new PgVariantCheckRepository(f.pool);
    competitorRepository = new PgCompetitorCheckRepository(
      f.pool,
      competitorPool,
    );
    for (const name of ['variant-check', 'batch-check'] as const) {
      const queue = new Queue(
        getPhysicalQueueName(name),
        getQueueOptions(name, f.env, f.redis as unknown as ConnectionOptions),
      );
      const event = new QueueEvents(getPhysicalQueueName(name), {
        connection: parseRedisUrl(f.env.REDIS_URL),
        prefix: getNeoQueuePrefix(f.env),
      });
      queue.on('error', () => undefined);
      event.on('error', () => undefined);
      queues.set(name, queue);
      events.set(name, event);
      await Promise.all([queue.waitUntilReady(), event.waitUntilReady()]);
    }
    exited = false;
    output = '';
  });
  afterEach(async () => {
    try {
      if (child && !exited) {
        child.kill('SIGTERM');
        try {
          await eventually(async () => exited, 12_000);
        } catch {
          child.kill('SIGKILL');
          await eventually(async () => exited, 2000);
          throw new Error('Fixture check worker required forced shutdown');
        }
      }
      for (const event of events.values()) await event.close();
      for (const queue of queues.values()) {
        if (queue.opts.prefix !== getNeoQueuePrefix(f.env))
          throw new Error('Unexpected check fixture namespace');
        await queue.obliterate({ force: true });
        await queue.close();
      }
      let cursor = '0',
        pages = 0;
      do {
        if (++pages > 100)
          throw new Error('Fixture metadata cleanup exceeded bound');
        const [next, keys] = await f.redis.scan(
          cursor,
          'MATCH',
          `${getNeoQueuePrefix(f.env)}:task:*`,
          'COUNT',
          100,
        );
        if (
          keys.some(
            (key) => !key.startsWith(`${getNeoQueuePrefix(f.env)}:task:`),
          )
        )
          throw new Error('Unsafe fixture metadata cleanup');
        if (keys.length) await f.redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
      const readyKey = `${getNeoQueuePrefix(f.env)}:monitor:consumer:ready`;
      await f.redis.del(readyKey, `${readyKey}:owners`);
    } finally {
      child = undefined;
      queues.clear();
      events.clear();
      try {
        await competitorPool?.end();
      } finally {
        try {
          if (competitorInstalled)
            await competitorBootstrap?.query(
              `DROP SCHEMA ${competitorSchema} CASCADE`,
            );
        } finally {
          await competitorBootstrap?.end();
          await f?.close();
          competitorPool = undefined;
          competitorBootstrap = undefined;
          competitorDatabaseUrl = '';
          competitorInstalled = false;
        }
      }
    }
  });
  async function start(selected = 'variant-check,batch-check') {
    child = spawn(process.execPath, [resolve(__dirname, '../dist/main.js')], {
      cwd: resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PROCESS_ROLE: 'worker',
        AUTH_DATA_AUTHORITY: 'postgresql',
        DATABASE_URL: f.env.DATABASE_URL,
        COMPETITOR_DATABASE_URL: competitorDatabaseUrl,
        REDIS_URL: f.env.REDIS_URL,
        BULL_PREFIX: f.env.BULL_PREFIX,
        WORKER_ENABLED_QUEUES: selected,
        SCHEDULER_ENABLED: 'false',
        LOG_LEVEL: 'INFO',
      },
    });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-64_000);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.on('error', () => {
      output += '\nFixture worker failed to start';
    });
    child.once('exit', () => {
      exited = true;
    });
    await eventually(async () => {
      if (exited)
        throw new Error(`Fixture worker exited before ready: ${output}`);
      return new RegExp(
        `registeredProcessors:\\s*${selected.split(',').length}`,
      ).test(output);
    }, 15_000);
  }
  async function data(
    type: 'variant-check' | 'batch-check',
    subtype: string,
    params: unknown,
  ): Promise<VariantCheckJobData> {
    const task = await store.create({
      taskId: randomUUID(),
      userId: 'fixture-owner',
      taskType: type,
      taskSubType: subtype,
      title: 'Fixture check',
    });
    return {
      taskId: task.taskId,
      userId: task.userId,
      taskType: type,
      taskSubType: subtype,
      createdAt: task.createdAt,
      expiresAt: new Date(Date.parse(task.createdAt) + 3600_000).toISOString(),
      params,
    } as VariantCheckJobData;
  }
  async function enqueue(job: VariantCheckJobData) {
    return (
      await queues
        .get(job.taskType)!
        .add(job.taskType, job, { jobId: job.taskId })
    ).waitUntilFinished(events.get(job.taskType)!, 15_000);
  }
  it('consumes group and batch jobs with the real entry and keeps full results in PostgreSQL', async () => {
    await start();
    const jobs = [
      await data('variant-check', 'variant-group-check', {
        groupId: 'g1',
        forceRefresh: true,
      }),
      await data('batch-check', 'variant-group', {
        groupIds: ['g1', 'g2'],
        forceRefresh: true,
      }),
    ];
    for (const job of jobs) {
      const result = await enqueue(job);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
      const task = (await store.read(job.taskId))!;
      expect(task.status).toBe('completed');
      const full = await repository.transaction((unit) =>
        unit.readReceipt(variantCheckResultOperation(task, result)),
      );
      if (job.taskType === 'variant-check')
        expect(full).toMatchObject({
          isBroken: true,
          groupSnapshot: { id: 'g1' },
        });
      else
        expect(full).toMatchObject({
          total: 2,
          successCount: 2,
          results: [{ groupId: 'g1' }, { groupId: 'g2' }],
        });
    }
    expect(
      (await f.pool.query('SELECT count(*)::int AS count FROM monitor_history'))
        .rows[0].count,
    ).toBe(0);
    expect(
      (
        await f.pool.query('SELECT last_check_time FROM variant_groups')
      ).rows.every((row) => row.last_check_time === null),
    ).toBe(true);
    expect(await f.redis.lrange(f.legacyKey, 0, -1)).toEqual([
      'legacy-fixture',
    ]);
    expect(output).toContain("mode: 'business-worker'");
  }, 30_000);
  it('recovers a complete parent result larger than Redis metadata without replaying Amazon requests', async () => {
    const job = await data('variant-check', 'parent-asin-query', {
      asins: ['B000000001'],
      country: 'US',
    });
    const complete = [
      {
        asin: 'B000000001',
        hasParentAsin: false,
        parentAsin: null,
        parentTitle: '',
        title: 'x'.repeat(400_000),
        brand: null,
        hasVariants: false,
        variantCount: 0,
        error: null,
      },
    ];
    await repository.transaction((unit) =>
      unit.saveReceipt(variantCheckJobOperation(job), complete),
    );
    await store.mutate(job.taskId, { kind: 'processing' }, job);
    await start();
    const reference = await enqueue(job);
    expect((await store.read(job.taskId))?.status).toBe('completed');
    expect(
      await repository.transaction((unit) =>
        unit.readReceipt(variantCheckResultOperation(job, reference)),
      ),
    ).toEqual(complete);
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS count FROM variant_check_receipts',
        )
      ).rows[0].count,
    ).toBe(1);
  }, 30_000);
  it('routes competitor group checks and completed ASIN retries to the isolated competitor database', async () => {
    await competitorPool!.query(
      "INSERT INTO competitor_variant_groups(id,name,country,brand) VALUES('cg1','Empty competitor group','US','Fixture')",
    );
    const groupJob = await data(
      'variant-check',
      'competitor-variant-group-check',
      {
        groupId: 'cg1',
        forceRefresh: true,
      },
    );
    const asinJob = await data('variant-check', 'competitor-asin-check', {
      asinId: 'ca1',
      forceRefresh: true,
    });
    const completedAsin = {
      isBroken: false,
      details: {
        asin: 'B000000001',
        result: { hasVariants: true, variantCount: 1 },
      },
    };
    await competitorRepository.transaction((unit) =>
      unit.saveReceipt(variantCheckJobOperation(asinJob), completedAsin),
    );
    await store.mutate(asinJob.taskId, { kind: 'processing' }, asinJob);
    await start();
    const groupReference = await enqueue(groupJob);
    const asinReference = await enqueue(asinJob);
    expect(groupReference).toMatchObject({ resultKind: 'competitor-group' });
    expect(asinReference).toMatchObject({ resultKind: 'competitor-asin' });
    expect((await store.read(groupJob.taskId))?.status).toBe('completed');
    expect((await store.read(asinJob.taskId))?.status).toBe('completed');
    const groupResult = await competitorRepository.transaction((unit) =>
      unit.readReceipt(variantCheckResultOperation(groupJob, groupReference)),
    );
    expect(groupResult).toMatchObject({
      isBroken: true,
      groupSnapshot: { id: 'cg1' },
      details: { message: '竞品变体组中没有ASIN' },
    });
    expect(
      await competitorRepository.transaction((unit) =>
        unit.readReceipt(variantCheckResultOperation(asinJob, asinReference)),
      ),
    ).toEqual(completedAsin);
    expect(
      (
        await competitorPool!.query(
          'SELECT count(*)::int AS count FROM competitor_variant_check_receipts',
        )
      ).rows[0].count,
    ).toBe(2);
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS count FROM variant_check_receipts',
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await competitorPool!.query(
          'SELECT count(*)::int AS count FROM competitor_monitor_history',
        )
      ).rows[0].count,
    ).toBe(0);
    expect(await f.redis.lrange(f.legacyKey, 0, -1)).toEqual([
      'legacy-fixture',
    ]);
  }, 30_000);
  it('starts monitor and both check queues together, routes each database receipt and removes readiness on shutdown', async () => {
    const schema = (await f.pool.query('SELECT current_schema() AS schema'))
      .rows[0].schema as string;
    if (!/^auth_worker_67_[a-f0-9]{32}$/.test(schema))
      throw new Error('Unexpected combined worker fixture schema');
    await f.pool.query(
      'CREATE TABLE feishu_config (LIKE public.feishu_config INCLUDING ALL)',
    );
    await f.pool.query(
      readFileSync(
        resolve(
          __dirname,
          '../../../packages/db/migrations/0012_primary_monitor.sql',
        ),
        'utf8',
      ).replaceAll('public', schema),
    );
    await competitorPool!.query(
      "INSERT INTO competitor_variant_groups(id,name,country,brand) VALUES('cg1','Combined competitor group','US','Fixture')",
    );
    const queue = new Queue(
      getPhysicalQueueName('monitor'),
      getQueueOptions(
        'monitor',
        f.env,
        f.redis as unknown as ConnectionOptions,
      ),
    );
    const event = new QueueEvents(getPhysicalQueueName('monitor'), {
      connection: parseRedisUrl(f.env.REDIS_URL),
      prefix: getNeoQueuePrefix(f.env),
    });
    queue.on('error', () => undefined);
    event.on('error', () => undefined);
    queues.set('monitor', queue);
    events.set('monitor', event);
    await Promise.all([queue.waitUntilReady(), event.waitUntilReady()]);
    await start('variant-check,batch-check,monitor');
    const readyKey = `${getNeoQueuePrefix(f.env)}:monitor:consumer:ready`;
    expect(await f.redis.get(readyKey)).toBe('1');
    expect(await f.redis.zcard(`${readyKey}:owners`)).toBe(1);
    const task = await store.create({
      taskId: randomUUID(),
      userId: 'fixture-owner',
      taskType: 'monitor',
      taskSubType: 'primary',
      title: 'Combined fixture monitor',
    });
    const monitor: PrimaryMonitorJob = {
      taskId: task.taskId,
      userId: task.userId,
      taskType: 'monitor',
      taskSubType: 'primary',
      createdAt: task.createdAt,
      expiresAt: new Date(Date.parse(task.createdAt) + 3600_000).toISOString(),
      countries: ['US'],
    };
    const jobs = [
      await data('variant-check', 'variant-group-check', {
        groupId: 'g1',
        forceRefresh: true,
      }),
      await data('variant-check', 'competitor-variant-group-check', {
        groupId: 'cg1',
        forceRefresh: true,
      }),
      await data('batch-check', 'variant-group', {
        groupIds: ['g1', 'g2'],
        forceRefresh: true,
      }),
    ];
    const queuedMonitor = await queue.add('primary-monitor', monitor, {
      jobId: monitor.taskId,
    });
    const [monitorResult, ...references] = await Promise.all([
      queuedMonitor.waitUntilFinished(event, 15_000),
      ...jobs.map(enqueue),
    ]);
    expect(monitorResult).toMatchObject({ success: true, totalChecked: 2 });
    expect(references.map((value) => value.resultKind)).toEqual([
      'group',
      'competitor-group',
      'batch',
    ]);
    for (const job of [monitor, ...jobs])
      expect((await store.read(job.taskId))?.status).toBe('completed');
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS count FROM monitor_history WHERE monitor_task_id=$1 AND country=$2',
          [monitor.taskId, 'US'],
        )
      ).rows[0].count,
    ).toBe(2);
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS count FROM variant_check_receipts WHERE task_id=$1 AND task_type=$2',
          [monitor.taskId, 'monitor'],
        )
      ).rows[0].count,
    ).toBe(2);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS count FROM variant_check_receipts WHERE task_sub_type LIKE 'competitor-%'",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await competitorPool!.query(
          'SELECT task_id,result_kind FROM competitor_variant_check_receipts',
        )
      ).rows,
    ).toEqual([{ task_id: jobs[1].taskId, result_kind: 'competitor-group' }]);
    expect(
      (
        await competitorPool!.query(
          'SELECT count(*)::int AS count FROM competitor_monitor_history',
        )
      ).rows[0].count,
    ).toBe(0);
    expect(await f.redis.lrange(f.legacyKey, 0, -1)).toEqual([
      'legacy-fixture',
    ]);
    child!.kill('SIGTERM');
    await eventually(async () => exited, 12_000);
    expect(await f.redis.exists(readyKey, `${readyKey}:owners`)).toBe(0);
  }, 30_000);
});
