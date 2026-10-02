import { getNeoQueuePrefix, getPhysicalQueueName } from '@asin-monitor/config';
import type { PrimaryMonitorJob } from '@asin-monitor/contracts';
import {
  PgVariantCheckRepository,
  RedisTaskRepository,
} from '@asin-monitor/db';
import {
  parseCatalogVariantResult,
  RedisCatalogCheckStore,
} from '@asin-monitor/sp-api';
import { VariantCheckPipeline } from '@asin-monitor/variant-check';
import { Queue, QueueEvents, type ConnectionOptions } from 'bullmq';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { legacyService } from '../../../packages/sp-api/test/catalog-legacy-fixture';
import { MonitorConsumerHeartbeat } from '../src/monitor-consumer-heartbeat';
import { monitorGroupOperation } from '../src/primary-monitor-processor';
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
  let webhook: Server | undefined;
  let certificateFiles:
    | { directory: string; certificate: string; key: string }
    | undefined;
  const sentCards: unknown[] = [];
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
    sentCards.length = 0;
  });
  afterEach(async () => {
    try {
      if (child && !exited) {
        child.kill('SIGTERM');
        await eventually(async () => exited, 12_000);
      }
      if (webhook)
        await new Promise<void>((resolve, reject) =>
          webhook!.close((error) => (error ? reject(error) : resolve())),
        );
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
        `${getNeoQueuePrefix(f.env)}:monitor:consumer:ready:owners`,
      );
    } finally {
      child = undefined;
      webhook = undefined;
      if (certificateFiles) {
        for (const path of [certificateFiles.certificate, certificateFiles.key])
          if (existsSync(path)) unlinkSync(path);
        rmdirSync(certificateFiles.directory);
        certificateFiles = undefined;
      }
      taskIds.length = 0;
      await f?.close();
    }
  });
  async function startWebhook() {
    const directory = mkdtempSync(join(tmpdir(), 'asin-monitor-webhook-'));
    const key = join(directory, 'key.pem');
    const certificate = join(directory, 'certificate.pem');
    certificateFiles = { directory, certificate, key };
    // The HTTPS fixture is trusted only by the spawned Worker. Production
    // transport continues to reject plain HTTP and untrusted certificates.
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        certificate,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore', timeout: 5000 },
    );
    webhook = createServer(
      { key: readFileSync(key), cert: readFileSync(certificate) },
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          sentCards.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"code":0}');
        });
      },
    );
    await new Promise<void>((resolve, reject) => {
      webhook!.once('error', reject);
      webhook!.listen(0, '127.0.0.1', resolve);
    });
    return `https://127.0.0.1:${(webhook.address() as AddressInfo).port}/hook`;
  }
  it('keeps another live consumer ready and removes the last owner immediately', async () => {
    const key = `${getNeoQueuePrefix(f.env)}:monitor:consumer:ready`;
    const a = new MonitorConsumerHeartbeat(f.redis, key);
    const b = new MonitorConsumerHeartbeat(f.redis, key);
    try {
      await a.start();
      await b.start();
      expect(await f.redis.zcard(`${key}:owners`)).toBe(2);
      const [seconds, microseconds] = await f.redis.time();
      await f.redis.zadd(
        `${key}:owners`,
        Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000) - 1,
        'expired-fixture-consumer',
      );
      await b.stop();
      expect(await f.redis.get(key)).toBe('1');
      expect(await f.redis.zcard(`${key}:owners`)).toBe(1);
      expect(await f.redis.pttl(key)).toBeLessThanOrEqual(10_000);
      await a.stop();
      expect(await f.redis.exists(key, `${key}:owners`)).toBe(0);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
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
    child.kill('SIGTERM');
    await eventually(async () => exited, 12_000);
    const key = `${getNeoQueuePrefix(f.env)}:monitor:consumer:ready`;
    expect(await f.redis.exists(key, `${key}:owners`)).toBe(0);
  });
  it('matches a fixed Legacy Catalog fixture through real ASIN checks, history, notification and receipt replay', async () => {
    const webhookUrl = await startWebhook();
    await f.pool.query(
      'INSERT INTO feishu_config(country,webhook_url,enabled) VALUES($1,$2,true)',
      ['US', webhookUrl],
    );
    await f.pool.query(
      `INSERT INTO asins(id,asin,name,country,site,brand,variant_group_id)
       VALUES ('a-normal','B000000001','Normal','US','amazon.com','Fixture','g-us'),
              ('a-broken','B000000002','Broken','US','amazon.com','Fixture','g-us')`,
    );
    const catalog = [
      {
        asin: 'B000000001',
        summaries: [{ itemName: 'Normal', brand: 'Fixture' }],
        relationships: [
          {
            relationships: [{ type: 'VARIATION', childAsins: ['B000000003'] }],
          },
        ],
      },
      {
        asin: 'B000000002',
        summaries: [{ itemName: 'Broken', brand: 'Fixture' }],
        relationships: [],
      },
    ];
    const cache = new RedisCatalogCheckStore(f.redis, getNeoQueuePrefix(f.env));
    try {
      for (const item of catalog) {
        const legacy = await legacyService(item).service.doCheckASINVariants(
          item.asin,
          'US',
          true,
        );
        const current = parseCatalogVariantResult(item, item.asin);
        expect(current).toEqual(legacy);
        const identity = {
          asin: item.asin,
          country: 'US' as const,
          owner: 'primary' as const,
        };
        const signal = new AbortController().signal;
        const claim = await cache.claim(identity, signal);
        await cache.write(identity, claim, current, 600, signal);
      }
    } finally {
      cache.close();
    }
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
        NODE_EXTRA_CA_CERTS: certificateFiles!.certificate,
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
      title: 'Catalog fixture monitor',
    });
    taskIds.push(task.taskId);
    const job: PrimaryMonitorJob = {
      taskId: task.taskId,
      userId: task.userId,
      taskType: 'monitor',
      taskSubType: 'primary',
      createdAt: task.createdAt,
      expiresAt: new Date(Date.parse(task.createdAt) + 3600_000).toISOString(),
      countries: ['US'],
    };
    const queued = await queue.add('primary-monitor', job, {
      jobId: task.taskId,
    });
    expect(await queued.waitUntilFinished(events, 20_000)).toMatchObject({
      success: true,
      totalChecked: 1,
      totalBroken: 1,
      notificationResults: { US: 'sent' },
    });
    expect((await store.read(task.taskId))?.status).toBe('completed');
    expect(sentCards).toHaveLength(1);
    expect(JSON.stringify(sentCards[0])).toContain('B000000002');
    expect(JSON.stringify(sentCards[0])).not.toContain('B000000001');
    const rows = (
      await f.pool.query(
        `SELECT check_type,asin_code,country,is_broken,notification_sent,
                check_result->>'errorType' AS error_type
         FROM monitor_history WHERE monitor_task_id=$1`,
        [task.taskId],
      )
    ).rows;
    expect(rows).toHaveLength(3);
    const byAsin = Object.fromEntries(
      rows.map((row) => [row.asin_code ?? 'GROUP', row]),
    );
    expect(byAsin.GROUP).toMatchObject({
      country: 'US',
      is_broken: true,
      notification_sent: true,
    });
    expect(byAsin.B000000001).toMatchObject({
      country: 'US',
      is_broken: false,
      notification_sent: false,
      error_type: null,
    });
    expect(byAsin.B000000002).toMatchObject({
      country: 'US',
      is_broken: true,
      notification_sent: true,
      error_type: 'NO_VARIANTS',
    });
    const replay = new VariantCheckPipeline(
      new PgVariantCheckRepository(f.pool),
      {
        check: async () => {
          throw new Error('A completed receipt must not fetch Catalog again');
        },
      },
      {
        invalidate: async () => undefined,
        clearDeferred: async () => undefined,
      },
      { info: () => undefined, warn: () => undefined },
    );
    try {
      const recovered = await replay.checkGroup('g-us', {
        operation: monitorGroupOperation(job, 'g-us'),
        authorize: async () => undefined,
        checkpoint: async () => undefined,
      });
      expect(recovered).toMatchObject({ isBroken: true });
      expect(
        (
          await f.pool.query(
            'SELECT count(*)::int AS count FROM monitor_history WHERE monitor_task_id=$1',
            [task.taskId],
          )
        ).rows[0].count,
      ).toBe(3);
      expect(sentCards).toHaveLength(1);
    } finally {
      replay.close();
    }
  }, 30_000);
});
