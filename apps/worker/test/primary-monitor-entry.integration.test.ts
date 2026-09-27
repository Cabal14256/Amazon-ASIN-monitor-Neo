import { getNeoQueuePrefix, getPhysicalQueueName } from '@asin-monitor/config';
import type { PrimaryMonitorJob } from '@asin-monitor/contracts';
import { RedisTaskRepository } from '@asin-monitor/db';
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

describe.skipIf(
  process.env.RUN_INTEGRATION_TESTS !== 'true' || process.platform === 'win32',
)('compiled primary monitor consumer on isolated PostgreSQL and Redis', () => {
  let f: Awaited<ReturnType<typeof maintenanceFixture>>;
  let queue: Queue, events: QueueEvents, child: ChildProcess | undefined;
  let exited = false,
    output = '';
  const taskIds: string[] = [];
  beforeEach(async () => {
    f = await maintenanceFixture();
    const schema = (await f.pool.query('SELECT current_schema() AS schema'))
      .rows[0].schema as string;
    if (!/^auth_worker_67_[a-f0-9]{32}$/.test(schema))
      throw new Error('Unexpected monitor fixture schema');
    for (const table of [
      'variant_groups',
      'asins',
      'monitor_history',
      'sp_api_config',
      'feishu_config',
    ])
      await f.pool.query(
        `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    const connection = await f.pool.connect();
    try {
      for (const name of [
        '0004_asin_timestamp_policy.sql',
        '0006_variant_check_receipts.sql',
        '0012_primary_monitor.sql',
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
      "INSERT INTO variant_groups(id,name,country,site,brand) VALUES('g-us','US empty','US','amazon.com','Fixture'),('g-de','DE empty','DE','amazon.de','Fixture')",
    );
    queue = new Queue(
      getPhysicalQueueName('monitor'),
      getQueueOptions(
        'monitor',
        f.env,
        f.redis as unknown as ConnectionOptions,
      ),
    );
    events = new QueueEvents(getPhysicalQueueName('monitor'), {
      connection: parseRedisUrl(f.env.REDIS_URL),
      prefix: getNeoQueuePrefix(f.env),
    });
    queue.on('error', () => undefined);
    events.on('error', () => undefined);
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
    exited = false;
    output = '';
  });
  afterEach(async () => {
    try {
      if (child && !exited) {
        child.kill('SIGTERM');
        await eventually(async () => exited, 12_000);
      }
      await events?.close();
      if (queue) {
        if (queue.opts.prefix !== getNeoQueuePrefix(f.env))
          throw new Error('Unexpected monitor queue namespace');
        await queue.obliterate({ force: true });
        await queue.close();
      }
      await f.redis.del(
        ...taskIds.map(
          (id) =>
            `${getNeoQueuePrefix(f.env)}:task:meta:${encodeURIComponent(id)}`,
        ),
        `${getNeoQueuePrefix(f.env)}:task:user:${encodeURIComponent(
          'fixture-owner',
        )}`,
        `${getNeoQueuePrefix(f.env)}:monitor:consumer:ready`,
      );
    } finally {
      child = undefined;
      taskIds.length = 0;
      await f?.close();
    }
  });
  it('processes a six-country request through the real queue and writes only selected country history', async () => {
    child = spawn(process.execPath, [resolve(__dirname, '../dist/main.js')], {
      cwd: resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PROCESS_ROLE: 'worker',
        AUTH_DATA_AUTHORITY: 'postgresql',
        DATABASE_URL: f.env.DATABASE_URL,
        COMPETITOR_DATABASE_URL: f.env.COMPETITOR_DATABASE_URL,
        REDIS_URL: f.env.REDIS_URL,
        BULL_PREFIX: f.env.BULL_PREFIX,
        WORKER_ENABLED_QUEUES: 'monitor',
        SCHEDULER_ENABLED: 'false',
        LOG_LEVEL: 'INFO',
      },
    });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-64_000);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.once('exit', () => {
      exited = true;
    });
    await eventually(async () => {
      if (exited) throw new Error(`Fixture monitor worker exited: ${output}`);
      return (
        (await f.redis.get(
          `${getNeoQueuePrefix(f.env)}:monitor:consumer:ready`,
        )) === '1'
      );
    }, 15_000);
    const store = new RedisTaskRepository(f.redis, f.env);
    const task = await store.create({
      taskId: randomUUID(),
      userId: 'fixture-owner',
      taskType: 'monitor',
      taskSubType: 'primary',
      title: 'Fixture monitor',
    });
    taskIds.push(task.taskId);
    const job: PrimaryMonitorJob = {
      taskId: task.taskId,
      userId: task.userId,
      taskType: 'monitor',
      taskSubType: 'primary',
      createdAt: task.createdAt,
      expiresAt: new Date(Date.parse(task.createdAt) + 3600_000).toISOString(),
      countries: ['DE', 'US', 'UK', 'FR', 'IT', 'ES'],
    };
    const queued = await queue.add('primary-monitor', job, {
      jobId: task.taskId,
    });
    const result = await queued.waitUntilFinished(events, 20_000);
    expect(result).toMatchObject({ success: true, totalChecked: 2 });
    expect((await store.read(task.taskId))?.status).toBe('completed');
    const history = await f.pool.query(
      'SELECT country,check_type,monitor_task_id FROM monitor_history ORDER BY id',
    );
    expect(history.rows).toEqual([
      { country: 'DE', check_type: 'GROUP', monitor_task_id: task.taskId },
      { country: 'US', check_type: 'GROUP', monitor_task_id: task.taskId },
    ]);
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS count FROM variant_check_receipts',
        )
      ).rows[0].count,
    ).toBe(2);
  });
});
