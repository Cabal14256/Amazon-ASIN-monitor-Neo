import { getNeoQueuePrefix, getPhysicalQueueName } from '@asin-monitor/config';
import type { VariantCheckJobData } from '@asin-monitor/contracts';
import {
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

/** Real compiled entry, two BullMQ consumers and PG completion storage. Empty
 * groups and a pre-existing parent receipt avoid contacting live Amazon in CI.
 * This suite does not prove HTTP submission or live Amazon integration. */
describe.skipIf(
  process.env.RUN_INTEGRATION_TESTS !== 'true' || process.platform === 'win32',
)('Compiled check consumers on isolated PostgreSQL and Redis', () => {
  let f: Awaited<ReturnType<typeof maintenanceFixture>>;
  let store: RedisTaskRepository, repository: PgVariantCheckRepository;
  const queues = new Map<'variant-check' | 'batch-check', Queue>();
  const events = new Map<'variant-check' | 'batch-check', QueueEvents>();
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
    } finally {
      connection.release();
    }
    await f.pool.query(
      "INSERT INTO variant_groups(id,name,country) VALUES('g1','Empty one','US'),('g2','Empty two','US')",
    );
    store = new RedisTaskRepository(f.redis, f.env);
    repository = new PgVariantCheckRepository(f.pool);
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
    } finally {
      child = undefined;
      queues.clear();
      events.clear();
      await f?.close();
    }
  });
  async function start() {
    child = spawn(process.execPath, [resolve(__dirname, '../dist/main.js')], {
      cwd: resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PROCESS_ROLE: 'worker',
        AUTH_DATA_AUTHORITY: 'postgresql',
        DATABASE_URL: f.env.DATABASE_URL,
        REDIS_URL: f.env.REDIS_URL,
        BULL_PREFIX: f.env.BULL_PREFIX,
        WORKER_ENABLED_QUEUES: 'variant-check,batch-check',
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
      return /registeredProcessors:\s*2/.test(output);
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
});
