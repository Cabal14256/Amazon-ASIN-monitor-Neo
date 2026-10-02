import { getNeoQueuePrefix, getPhysicalQueueName } from '@asin-monitor/config';
import type { CompetitorMonitorJob } from '@asin-monitor/contracts';
import { createPgPool, RedisTaskRepository } from '@asin-monitor/db';
import {
  parseCatalogVariantResult,
  RedisCatalogCheckStore,
} from '@asin-monitor/sp-api';
import { Queue, QueueEvents, type ConnectionOptions, type Job } from 'bullmq';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { legacyService } from '../../../packages/sp-api/test/catalog-legacy-fixture';
import { getQueueOptions } from '../src/queue-policy';
import { parseRedisUrl } from '../src/redis-options';
import {
  eventually,
  maintenanceFixture,
} from './helpers/auth-maintenance-fixture';

/** Real compiled entry, private primary/competitor schemas and BullMQ/Redis.
 * Fixed Catalog responses are prewarmed; US/DE deferred tests inject only the
 * Catalog checker boundary. HTTPS delivery is local and rejects every other
 * transport destination. This suite never contacts live Amazon or Feishu. */
describe.skipIf(
  process.env.RUN_INTEGRATION_TESTS !== 'true' || process.platform === 'win32',
)('compiled competitor monitor with owned receipts and country claims', () => {
  let f: Awaited<ReturnType<typeof maintenanceFixture>>;
  let competitorPool: ReturnType<typeof createPgPool> | undefined;
  let competitorBootstrap: ReturnType<typeof createPgPool> | undefined;
  let competitorSchema = '',
    competitorDatabaseUrl = '',
    competitorInstalled = false;
  let queue: Queue, events: QueueEvents, store: RedisTaskRepository;
  let child: ChildProcess | undefined,
    exited = true,
    output = '';
  let webhook: Server | undefined,
    webhookUrl = '',
    certificate = '',
    directory = '';
  const artifacts = new Set<string>();
  const cards: unknown[] = [];
  const ready = () =>
    `${getNeoQueuePrefix(f.env)}:competitor-monitor:consumer:ready`;
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
  const artifact = (name: string) => {
    if (!directory || basename(name) !== name)
      throw new Error('Unsafe fixture file');
    const path = join(directory, name);
    artifacts.add(path);
    return path;
  };
  const migration = (name: string) =>
    readFileSync(
      resolve(__dirname, '../../../packages/db/migrations', name),
      'utf8',
    );

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'neo-competitor-monitor-entry-'));
    cards.length = 0;
    f = await maintenanceFixture();
    const primarySchema = (
      await f.pool.query('SELECT current_schema() AS name')
    ).rows[0]?.name as string;
    if (!/^auth_worker_67_[a-f0-9]{32}$/.test(primarySchema))
      throw new Error('Unexpected primary monitor fixture schema');
    for (const table of [
      'variant_groups',
      'asins',
      'monitor_history',
      'sp_api_config',
      'feishu_config',
      'roles',
      'permissions',
      'user_roles',
      'role_permissions',
    ])
      await f.pool.query(
        `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    const primaryConnection = await f.pool.connect();
    try {
      for (const name of [
        '0004_asin_timestamp_policy.sql',
        '0006_variant_check_receipts.sql',
      ])
        await primaryConnection.query(
          migration(name).replaceAll('public', primarySchema),
        );
      // 0004 can leave pg_catalog first on this session; restore the verified
      // private schema before releasing the same migrated connection.
      await primaryConnection.query(`SET search_path TO ${primarySchema}`);
      if (
        (await primaryConnection.query('SELECT current_schema() AS name'))
          .rows[0]?.name !== primarySchema
      )
        throw new Error('Primary migration escaped private fixture schema');
    } catch (error) {
      await primaryConnection.query('ROLLBACK');
      throw error;
    } finally {
      primaryConnection.release();
    }
    await f.pool.query(
      "UPDATE users SET force_password_change=false,status='ACTIVE' WHERE id='fixture-owner'",
    );
    await f.pool.query(
      "INSERT INTO roles(id,code,name) VALUES('monitor-fixture','monitor-fixture','Monitor fixture')",
    );
    await f.pool.query(
      "INSERT INTO permissions(id,code,name) VALUES('monitor-write-fixture','monitor:write','Monitor write')",
    );
    await f.pool.query(
      "INSERT INTO user_roles(user_id,role_id) VALUES('fixture-owner','monitor-fixture')",
    );
    await f.pool.query(
      "INSERT INTO role_permissions(role_id,permission_id) VALUES('monitor-fixture','monitor-write-fixture')",
    );

    competitorSchema = `competitor_worker_187_${randomUUID().replace(
      /-/g,
      '',
    )}`;
    if (!/^competitor_worker_187_[a-f0-9]{32}$/.test(competitorSchema))
      throw new Error('Unexpected competitor monitor fixture schema');
    competitorBootstrap = createPgPool(process.env.COMPETITOR_DATABASE_URL!, {
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    const url = new URL(process.env.COMPETITOR_DATABASE_URL!);
    url.searchParams.set(
      'options',
      `-c search_path=${competitorSchema} -c timezone=UTC`,
    );
    competitorDatabaseUrl = url.toString();
    competitorPool = createPgPool(competitorDatabaseUrl, {
      max: 4,
      connectionTimeoutMillis: 2000,
    });
    const primaryDatabase = (
      await f.pool.query('SELECT current_database() AS name')
    ).rows[0]?.name;
    const competitorDatabase = (
      await competitorPool.query('SELECT current_database() AS name')
    ).rows[0]?.name;
    if (primaryDatabase === competitorDatabase)
      throw new Error('Competitor fixture must use a distinct database');
    await competitorBootstrap.query(`CREATE SCHEMA ${competitorSchema}`);
    competitorInstalled = true;
    if (
      (await competitorPool.query('SELECT current_schema() AS name')).rows[0]
        ?.name !== competitorSchema
    )
      throw new Error('Competitor connection escaped private fixture schema');
    for (const table of [
      'competitor_variant_groups',
      'competitor_monitor_history',
      'competitor_feishu_config',
    ])
      await competitorBootstrap.query(
        `CREATE TABLE ${competitorSchema}.${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    await competitorBootstrap.query(
      `CREATE TABLE ${competitorSchema}.competitor_asins (LIKE public.competitor_asins INCLUDING ALL EXCLUDING INDEXES)`,
    );
    await competitorBootstrap.query(
      `ALTER TABLE ${competitorSchema}.competitor_asins ADD PRIMARY KEY(id), ADD CONSTRAINT uk_competitor_asins_asin_country UNIQUE(asin,country), ADD CONSTRAINT fk_competitor_asins_group FOREIGN KEY(variant_group_id) REFERENCES ${competitorSchema}.competitor_variant_groups(id) ON DELETE CASCADE`,
    );
    let policy = migration('0011_competitor_write_policy.sql');
    // The shared imported collation is read-only. Rewrite only the explicitly
    // owned relations/functions, retaining public.neo_competitor_query_ci.
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
      for (const name of [
        '0014_competitor_check_receipts.sql',
        '0015_competitor_monitor.sql',
      ])
        await competitorConnection.query(
          migration(name).replaceAll('public', competitorSchema),
        );
      await competitorConnection.query(
        `SET search_path TO ${competitorSchema}`,
      );
      if (
        (await competitorConnection.query('SELECT current_schema() AS name'))
          .rows[0]?.name !== competitorSchema
      )
        throw new Error('Competitor migration escaped private fixture schema');
    } catch (error) {
      await competitorConnection.query('ROLLBACK');
      throw error;
    } finally {
      competitorConnection.release();
    }
    await competitorPool.query(
      "INSERT INTO competitor_variant_groups(id,name,country,brand,create_time,update_time) VALUES('c-one','Competitor one','US','Fixture','2026-01-01','2026-01-01')",
    );
    await competitorPool.query(
      "INSERT INTO competitor_asins(id,asin,name,country,brand,variant_group_id,create_time,update_time) VALUES('a-normal','B000000001','Normal','US','Fixture','c-one','2026-01-01','2026-01-01'),('a-broken','B000000002','Broken','US','Fixture','c-one','2026-01-01','2026-01-01')",
    );
    const cache = new RedisCatalogCheckStore(f.redis, getNeoQueuePrefix(f.env));
    try {
      const signal = new AbortController().signal;
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
          owner: 'competitor' as const,
        };
        const claim = await cache.claim(identity, signal);
        await cache.write(identity, claim, current, 600, signal);
      }
    } finally {
      cache.close();
    }
    store = new RedisTaskRepository(f.redis, f.env);
    queue = new Queue(
      getPhysicalQueueName('competitor-monitor'),
      getQueueOptions(
        'competitor-monitor',
        f.env,
        f.redis as unknown as ConnectionOptions,
      ),
    );
    events = new QueueEvents(getPhysicalQueueName('competitor-monitor'), {
      connection: parseRedisUrl(f.env.REDIS_URL),
      prefix: getNeoQueuePrefix(f.env),
    });
    queue.on('error', () => undefined);
    events.on('error', () => undefined);
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
  });

  async function stop() {
    if (child && !exited) {
      child.kill('SIGTERM');
      try {
        await eventually(async () => exited, 12_000);
      } catch {
        child.kill('SIGKILL');
        await eventually(async () => exited, 2000);
        throw new Error('Competitor fixture required forced Worker shutdown');
      }
      expect(await f.redis.exists(ready(), `${ready()}:owners`)).toBe(0);
    }
    child = undefined;
  }
  afterEach(async () => {
    try {
      await stop();
      if (webhook)
        await new Promise<void>((resolve, reject) =>
          webhook!.close((error) => (error ? reject(error) : resolve())),
        );
      await events?.close();
      if (queue) {
        if (queue.opts.prefix !== getNeoQueuePrefix(f.env))
          throw new Error('Unexpected competitor fixture queue namespace');
        await queue.obliterate({ force: true });
        await queue.close();
      }
      if (f) {
        let cursor = '0',
          pages = 0;
        do {
          if (++pages > 100)
            throw new Error('Fixture Redis cleanup exceeded bound');
          const [next, keys] = await f.redis.scan(
            cursor,
            'MATCH',
            `${getNeoQueuePrefix(f.env)}:*`,
            'COUNT',
            100,
          );
          if (keys.length) await f.redis.del(...keys);
          cursor = next;
        } while (cursor !== '0');
      }
    } finally {
      webhook = undefined;
      webhookUrl = '';
      certificate = '';
      try {
        await competitorPool?.end();
        if (competitorInstalled) {
          if (!/^competitor_worker_187_[a-f0-9]{32}$/.test(competitorSchema))
            throw new Error('Unsafe competitor fixture cleanup');
          await competitorBootstrap!.query(
            `DROP SCHEMA ${competitorSchema} CASCADE`,
          );
        }
      } finally {
        await competitorBootstrap?.end();
        competitorPool = undefined;
        competitorBootstrap = undefined;
        competitorSchema = '';
        competitorDatabaseUrl = '';
        competitorInstalled = false;
        try {
          await f?.close();
        } finally {
          if (directory) {
            if (
              dirname(directory) !== tmpdir() ||
              !basename(directory).startsWith('neo-competitor-monitor-entry-')
            )
              throw new Error('Unsafe fixture artifact cleanup');
            for (const path of artifacts) {
              if (dirname(path) !== directory)
                throw new Error('Unsafe fixture file cleanup');
              if (existsSync(path)) unlinkSync(path);
            }
            artifacts.clear();
            rmdirSync(directory);
            directory = '';
          }
        }
      }
    }
  });

  async function hookServer(loseAcknowledgement = false) {
    const key = artifact('key.pem');
    certificate = artifact('certificate.pem');
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
          cards.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (loseAcknowledgement) {
            request.socket.destroy();
            return;
          }
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"code":0}');
        });
      },
    );
    await new Promise<void>((resolve, reject) => {
      webhook!.once('error', reject);
      webhook!.listen(0, '127.0.0.1', resolve);
    });
    webhookUrl = `https://127.0.0.1:${
      (webhook.address() as AddressInfo).port
    }/hook`;
    await competitorPool!.query(
      'INSERT INTO competitor_feishu_config(country,webhook_url,enabled) VALUES($1,$2,true)',
      ['US', webhookUrl],
    );
  }
  function preload(extra = '') {
    const path = artifact('fixture-preload.cjs');
    const blocked = artifact('unexpected-transport.marker');
    // Every child is constrained to the local TLS hook, including injected
    // failure runs. A cache miss can never contact a real credential endpoint.
    writeFileSync(
      path,
      `
const fs = require('node:fs');
const spApi = require(${JSON.stringify(
        resolve(__dirname, '../../../packages/sp-api/dist/index.js'),
      )});
const db = require(${JSON.stringify(
        resolve(__dirname, '../../../packages/db/dist/index.js'),
      )});
const pipeline = require(${JSON.stringify(
        resolve(__dirname, '../../../packages/variant-check/dist/index.js'),
      )});
const request = spApi.NodeHttpTransport.prototype.request;
spApi.NodeHttpTransport.prototype.request = function(input) {
  const allowed = ${JSON.stringify(
    webhookUrl ? new URL(webhookUrl).origin : '',
  )};
  if (allowed && new URL(input.url).origin === allowed && input.method === 'POST') return request.call(this,input);
  fs.writeFileSync(${JSON.stringify(blocked)},'blocked');
  return Promise.reject(new spApi.SpApiError('DEPENDENCY_ERROR'));
};
${extra}
`,
    );
    return path;
  }
  async function start(extra = '') {
    if (child) throw new Error('Fixture Worker already started');
    output = '';
    exited = false;
    child = spawn(
      process.execPath,
      ['--require', preload(extra), resolve(__dirname, '../dist/main.js')],
      {
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
          RATE_LIMITER_KEY_PREFIX: `${getNeoQueuePrefix(f.env)}:quota`,
          WORKER_ENABLED_QUEUES: 'competitor-monitor',
          COMPETITOR_MONITOR_ENABLED: 'true',
          SCHEDULER_ENABLED: 'false',
          LOG_LEVEL: 'INFO',
          ...(certificate ? { NODE_EXTRA_CA_CERTS: certificate } : {}),
        },
      },
    );
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-64_000);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.once('error', () => {
      exited = true;
    });
    child.once('exit', () => {
      exited = true;
    });
    await eventually(async () => {
      if (exited)
        throw new Error(
          `Competitor fixture Worker exited before ready: ${output}`,
        );
      return (
        (await f.redis.get(ready())) === '1' &&
        /registeredProcessors:\s*1/.test(output)
      );
    }, 15_000);
    expect(await f.redis.zcard(`${ready()}:owners`)).toBe(1);
  }
  async function job(
    country: 'US' | 'DE' = 'US',
  ): Promise<CompetitorMonitorJob> {
    const task = await store.create({
      taskId: randomUUID(),
      userId: 'fixture-owner',
      taskType: 'competitor-monitor',
      taskSubType: 'competitor',
      title: 'Fixture competitor monitor',
    });
    return {
      taskId: task.taskId,
      userId: task.userId,
      taskType: 'competitor-monitor',
      taskSubType: 'competitor',
      createdAt: task.createdAt,
      expiresAt: new Date(Date.parse(task.createdAt) + 3600_000).toISOString(),
      countries: [country],
    };
  }
  const enqueue = (data: CompetitorMonitorJob, attempts?: number) =>
    queue.add('competitor-monitor', data, {
      jobId: data.taskId,
      ...(attempts ? { attempts } : {}),
    });
  async function history(taskId: string) {
    return (
      await competitorPool!.query(
        "SELECT country,asin_code,check_type,is_broken,notification_sent,check_time AT TIME ZONE 'Asia/Shanghai' AS checked_at,check_result->>'errorType' AS error_type FROM competitor_monitor_history WHERE monitor_task_id=$1 ORDER BY check_type,asin_code",
        [taskId],
      )
    ).rows;
  }
  async function counts(taskId: string) {
    const result = await competitorPool!.query(
      'SELECT (SELECT count(*)::int FROM competitor_monitor_runs WHERE task_id=$1) AS runs,(SELECT count(*)::int FROM competitor_variant_check_receipts WHERE task_id=$1) AS receipts,(SELECT count(*)::int FROM competitor_monitor_history WHERE monitor_task_id=$1) AS history,(SELECT count(*)::int FROM competitor_monitor_notifications WHERE task_id=$1) AS claims',
      [taskId],
    );
    return result.rows[0];
  }
  async function finish(queued: Job, timeout = 20_000) {
    const result = await queued.waitUntilFinished(events, timeout);
    expect(existsSync(artifact('unexpected-transport.marker'))).toBe(false);
    return result;
  }
  async function enableNotifications() {
    await competitorPool!.query(
      'UPDATE competitor_variant_groups SET feishu_notify_enabled=true',
    );
    await competitorPool!.query(
      'UPDATE competitor_asins SET feishu_notify_enabled=true',
    );
  }

  it('runs the real competitor consumer, commits one timestamped history/receipt and defaults notifications off', async () => {
    await start();
    const data = await job();
    expect(await finish(await enqueue(data))).toMatchObject({
      success: true,
      totalChecked: 1,
      totalBroken: 1,
      notificationResults: { US: 'skipped' },
      countryResults: {
        US: {
          checkTime: data.createdAt,
          brokenByType: { NO_VARIANTS: 1, NOT_FOUND: 0, SP_API_ERROR: 0 },
        },
      },
    });
    expect((await store.read(data.taskId))?.status).toBe('completed');
    expect(await counts(data.taskId)).toEqual({
      runs: 1,
      receipts: 1,
      history: 3,
      claims: 0,
    });
    expect(cards).toHaveLength(0);
    const rows = await history(data.taskId);
    expect(rows.map((row) => row.checked_at.toISOString())).toEqual([
      data.createdAt,
      data.createdAt,
      data.createdAt,
    ]);
    expect(rows.find((row) => row.asin_code === 'B000000001')).toMatchObject({
      is_broken: false,
      error_type: null,
      notification_sent: false,
    });
    expect(rows.find((row) => row.asin_code === 'B000000002')).toMatchObject({
      is_broken: true,
      error_type: 'NO_VARIANTS',
      notification_sent: false,
    });
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS count FROM variant_check_receipts',
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await f.pool.query('SELECT count(*)::int AS count FROM monitor_history'))
        .rows[0].count,
    ).toBe(0);
    await stop();
  }, 35_000);

  it.each(['cancelled', 'revoked', 'disabled', 'wrong-owner'] as const)(
    'rejects %s before a competitor snapshot or business write',
    async (reason) => {
      const data = await job();
      if (reason === 'cancelled')
        await store.mutate(data.taskId, { kind: 'cancel-request' }, data);
      if (reason === 'revoked')
        await f.pool.query(
          "DELETE FROM role_permissions WHERE role_id='monitor-fixture'",
        );
      if (reason === 'disabled')
        await f.pool.query(
          "INSERT INTO sp_api_config(config_key,config_value) VALUES('COMPETITOR_MONITOR_ENABLED','false')",
        );
      await start();
      const queued = await enqueue(
        reason === 'wrong-owner' ? { ...data, userId: 'another-owner' } : data,
        1,
      );
      if (reason === 'cancelled')
        expect(await finish(queued)).toEqual({ cancelled: true });
      else
        await expect(
          queued.waitUntilFinished(events, 20_000),
        ).rejects.toThrow();
      expect(await counts(data.taskId)).toEqual({
        runs: 0,
        receipts: 0,
        history: 0,
        claims: 0,
      });
      expect((await store.read(data.taskId))?.status).toBe(
        reason === 'cancelled'
          ? 'cancelled'
          : reason === 'wrong-owner'
          ? 'pending'
          : 'failed',
      );
      expect(cards).toHaveLength(0);
      expect(existsSync(artifact('unexpected-transport.marker'))).toBe(false);
    },
    30_000,
  );

  it.each(['US', 'DE'] as const)(
    'rechecks a deferred %s ASIN with force refresh in the compiled pipeline before committing its final history',
    async (country) => {
      if (country === 'DE') {
        await competitorPool!.query(
          "UPDATE competitor_variant_groups SET country='DE' WHERE id='c-one'",
        );
        await competitorPool!.query(
          "UPDATE competitor_asins SET country='DE' WHERE variant_group_id='c-one'",
        );
        const cache = new RedisCatalogCheckStore(
          f.redis,
          getNeoQueuePrefix(f.env),
        );
        try {
          const signal = new AbortController().signal;
          for (const item of catalog) {
            const current = parseCatalogVariantResult(item, item.asin);
            expect(current).toEqual(
              await legacyService(item).service.doCheckASINVariants(
                item.asin,
                country,
                true,
              ),
            );
            const identity = {
              asin: item.asin,
              country,
              owner: 'competitor' as const,
            };
            const claim = await cache.claim(identity, signal);
            await cache.write(identity, claim, current, 600, signal);
          }
        } finally {
          cache.close();
        }
      }
      const trace = artifact('deferred-checks.json');
      const fixtureResult = parseCatalogVariantResult(
        catalog[1],
        catalog[1].asin,
      );
      await start(`
const checker = spApi.CatalogVariantChecker.prototype.check;
const checks=[];
spApi.CatalogVariantChecker.prototype.check=async function(asin,country,options) {
  if(asin!=='B000000002') return checker.call(this,asin,country,options);
  checks.push({country,forceRefresh:options.forceRefresh,priority:options.priority,owner:options.owner,at:Date.now()});
  fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(checks));
  if(checks.length===1) throw new spApi.CatalogDeferredError(new spApi.SpApiError('HTTP_ERROR',503));
  return ${JSON.stringify(fixtureResult)};
};`);
      const data = await job(country);
      expect(await finish(await enqueue(data))).toMatchObject({
        success: true,
        totalBroken: 1,
        countryResults: {
          [country]: { brokenByType: { NO_VARIANTS: 1, SP_API_ERROR: 0 } },
        },
      });
      const checks = JSON.parse(readFileSync(trace, 'utf8')) as {
        country: string;
        forceRefresh: boolean;
        priority: number;
        owner: string;
        at: number;
      }[];
      expect(checks).toHaveLength(2);
      expect(checks[0]).toMatchObject({
        country,
        forceRefresh: false,
        priority: 1,
        owner: 'competitor',
      });
      expect(checks[1]).toMatchObject({
        country,
        forceRefresh: true,
        priority: 1,
        owner: 'competitor',
      });
      expect(checks[1].at - checks[0].at).toBeGreaterThanOrEqual(1900);
      expect(await counts(data.taskId)).toEqual({
        runs: 1,
        receipts: 1,
        history: 3,
        claims: 0,
      });
      expect(
        (await history(data.taskId)).find(
          (row) => row.asin_code === 'B000000002',
        ),
      ).toMatchObject({ country, is_broken: true, error_type: 'NO_VARIANTS' });
    },
    35_000,
  );

  it.each([{ foreignBroken: false }, { foreignBroken: true }])(
    'keeps identical ASIN codes in different countries bound to their own notification country (foreignBroken=$foreignBroken)',
    async ({ foreignBroken }) => {
      await hookServer();
      await enableNotifications();
      const foreignId = foreignBroken ? 'a-de-broken' : 'a-de-normal';
      const foreignName = foreignBroken ? 'German broken' : 'German normal';
      await competitorPool!.query(
        "INSERT INTO competitor_asins(id,asin,name,country,brand,variant_group_id,feishu_notify_enabled,create_time,update_time) VALUES($1,'B000000002',$2,'DE','Foreign-only brand','c-one',$3,'2026-01-01','2026-01-01')",
        [foreignId, foreignName, foreignBroken],
      );
      const germanItem = {
        ...catalog[foreignBroken ? 1 : 0],
        asin: 'B000000002',
      };
      const germanResult = parseCatalogVariantResult(
        germanItem,
        germanItem.asin,
      );
      expect(germanResult.hasVariants).toBe(!foreignBroken);
      expect(germanResult).toEqual(
        await legacyService(germanItem).service.doCheckASINVariants(
          germanItem.asin,
          'DE',
          true,
        ),
      );
      const cache = new RedisCatalogCheckStore(
        f.redis,
        getNeoQueuePrefix(f.env),
      );
      try {
        const signal = new AbortController().signal;
        const identity = {
          asin: germanItem.asin,
          country: 'DE' as const,
          owner: 'competitor' as const,
        };
        const claim = await cache.claim(identity, signal);
        await cache.write(identity, claim, germanResult, 600, signal);
      } finally {
        cache.close();
      }
      await start();
      const data = await job();
      expect(await finish(await enqueue(data))).toMatchObject({
        success: true,
        totalBroken: 1,
        notificationResults: { US: 'sent' },
      });
      expect(await counts(data.taskId)).toEqual({
        runs: 1,
        receipts: 1,
        history: 4,
        claims: 1,
      });
      const rows = (
        await competitorPool!.query(
          "SELECT asin_id,country,is_broken,notification_sent,check_result->'currentResult' AS current_result FROM competitor_monitor_history WHERE monitor_task_id=$1 AND check_type='ASIN' AND asin_code='B000000002' ORDER BY asin_id",
          [data.taskId],
        )
      ).rows;
      expect(rows).toEqual([
        expect.objectContaining({
          asin_id: 'a-broken',
          country: 'US',
          is_broken: true,
          notification_sent: true,
          current_result: expect.objectContaining({ hasVariants: false }),
        }),
        expect.objectContaining({
          asin_id: foreignId,
          country: 'DE',
          is_broken: foreignBroken,
          notification_sent: false,
          current_result: expect.objectContaining({
            hasVariants: !foreignBroken,
          }),
        }),
      ]);
      expect(
        (
          await competitorPool!.query(
            'SELECT country,state FROM competitor_monitor_notifications WHERE task_id=$1',
            [data.taskId],
          )
        ).rows,
      ).toEqual([{ country: 'US', state: 'sent' }]);
      expect(cards).toHaveLength(1);
      expect(JSON.stringify(cards[0])).toContain('B000000002');
      expect(JSON.stringify(cards[0])).not.toContain('B000000001');
      expect(JSON.stringify(cards[0])).not.toContain('German normal');
      expect(JSON.stringify(cards[0])).not.toContain('German broken');
      expect(JSON.stringify(cards[0])).not.toContain('Foreign-only brand');
      expect((await store.read(data.taskId))?.status).toBe('completed');
    },
    35_000,
  );

  it.each(['cancelled', 'revoked'] as const)(
    'keeps a committed first group when %s interrupts the next group',
    async (reason) => {
      await competitorPool!.query(
        "INSERT INTO competitor_variant_groups(id,name,country,brand) VALUES('z-second','Empty second','US','Fixture')",
      );
      const data = await job(),
        committed = artifact('group-committed.marker'),
        release = artifact('release.marker');
      await start(`
const checkGroup = pipeline.CompetitorCheckPipeline.prototype.checkGroup;
pipeline.CompetitorCheckPipeline.prototype.checkGroup=async function(id,context) {
  const result=await checkGroup.call(this,id,context);
  if(id==='c-one' && context.operation?.taskId===${JSON.stringify(
    data.taskId,
  )}) {
    fs.writeFileSync(${JSON.stringify(committed)},'committed');
    const deadline=Date.now()+8000;
    while(!fs.existsSync(${JSON.stringify(release)})) {
      if(Date.now()>deadline) throw new Error('Fixture cancellation release missing');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  return result;
};`);
      const queued = await enqueue(data, 1);
      await eventually(async () => existsSync(committed), 20_000);
      expect(await counts(data.taskId)).toEqual({
        runs: 1,
        receipts: 1,
        history: 3,
        claims: 0,
      });
      if (reason === 'cancelled')
        await store.mutate(data.taskId, { kind: 'cancel-request' }, data);
      else
        await f.pool.query(
          "DELETE FROM role_permissions WHERE role_id='monitor-fixture'",
        );
      writeFileSync(release, 'release');
      if (reason === 'cancelled')
        expect(await finish(queued)).toEqual({ cancelled: true });
      else
        await expect(
          queued.waitUntilFinished(events, 20_000),
        ).rejects.toThrow();
      expect((await store.read(data.taskId))?.status).toBe(
        reason === 'cancelled' ? 'cancelled' : 'failed',
      );
      expect(await counts(data.taskId)).toEqual({
        runs: 1,
        receipts: 1,
        history: 3,
        claims: 0,
      });
    },
    35_000,
  );

  it('survives two completion ACK failures, disabled/deleted original candidates and Worker restarts without duplicate history or an uncertain HTTPS send', async () => {
    await hookServer(true);
    await enableNotifications();
    const data = await job(),
      failures = artifact('completion-failures.txt');
    const injection = `
const mutate=db.RedisTaskRepository.prototype.mutate;
db.RedisTaskRepository.prototype.mutate=async function(taskId,change,...args) {
  if(taskId===${JSON.stringify(data.taskId)} && change.kind==='completed') {
    const count=fs.existsSync(${JSON.stringify(
      failures,
    )}) ? Number(fs.readFileSync(${JSON.stringify(failures)},'utf8')) : 0;
    if(count<2) {fs.writeFileSync(${JSON.stringify(
      failures,
    )},String(count+1));throw new Error('Fixture registry completion acknowledgement lost');}
  }
  return mutate.call(this,taskId,change,...args);
};`;
    await start(injection);
    const queued = await enqueue(data);
    expect(await finish(queued, 35_000)).toMatchObject({
      success: true,
      notificationResults: { US: 'unconfirmed' },
    });
    expect((await store.read(data.taskId))?.status).toBe('processing');
    expect(readFileSync(failures, 'utf8')).toBe('1');
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0])).toContain('B000000002');
    expect(JSON.stringify(cards[0])).not.toContain('B000000001');
    expect(await counts(data.taskId)).toEqual({
      runs: 1,
      receipts: 1,
      history: 3,
      claims: 1,
    });
    const firstHistory = await history(data.taskId);
    await stop();
    // Changed current membership must not replace the already committed
    // immutable receipt on a retry of this same monitor incarnation.
    await competitorPool!.query(
      "INSERT INTO competitor_asins(id,asin,name,country,brand,variant_group_id) VALUES('new-member','B000000009','Later member','US','Fixture','c-one')",
    );
    // A persisted country claim proves this send was already attempted. Later
    // notification settings cannot turn replay into another external attempt.
    await competitorPool!.query(
      "UPDATE competitor_asins SET feishu_notify_enabled=false WHERE id='a-broken'",
    );
    await queued.retry('completed');
    await start(injection);
    expect(await finish(queued)).toMatchObject({
      success: true,
      notificationResults: { US: 'unconfirmed' },
    });
    expect(readFileSync(failures, 'utf8')).toBe('2');
    expect((await store.read(data.taskId))?.status).toBe('processing');
    await stop();
    // The same immutable receipt/claim must remain replayable after the
    // original candidate disappears; only a new claim requires current rows.
    await competitorPool!.query(
      "DELETE FROM competitor_asins WHERE id='a-broken'",
    );
    await queued.retry('completed');
    await start();
    expect(await finish(queued)).toMatchObject({
      success: true,
      totalChecked: 1,
      totalBroken: 1,
      notificationResults: { US: 'unconfirmed' },
    });
    expect((await store.read(data.taskId))?.status).toBe('completed');
    expect(await history(data.taskId)).toEqual(firstHistory);
    expect(await counts(data.taskId)).toEqual({
      runs: 1,
      receipts: 1,
      history: 3,
      claims: 1,
    });
    expect(
      (
        await competitorPool!.query(
          'SELECT state FROM competitor_monitor_notifications WHERE task_id=$1',
          [data.taskId],
        )
      ).rows,
    ).toEqual([{ state: 'claimed' }]);
    expect(cards).toHaveLength(1);
    expect(
      (
        await competitorPool!.query(
          "SELECT last_check_time FROM competitor_asins WHERE id='new-member'",
        )
      ).rows[0].last_check_time,
    ).toBeNull();
    await stop();
  }, 70_000);

  it('rejects a persisted run from another owner without attaching its receipt or history', async () => {
    const data = await job();
    await competitorPool!.query(
      'INSERT INTO competitor_monitor_runs(task_id,user_id,task_created_at,countries,groups,expires_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::timestamptz)',
      [
        data.taskId,
        'another-owner',
        data.createdAt,
        JSON.stringify(data.countries),
        '[]',
        data.expiresAt,
      ],
    );
    await start();
    const queued = await enqueue(data, 1);
    await expect(queued.waitUntilFinished(events, 20_000)).rejects.toThrow();
    expect((await store.read(data.taskId))?.status).toBe('failed');
    expect(await counts(data.taskId)).toEqual({
      runs: 1,
      receipts: 0,
      history: 0,
      claims: 0,
    });
    expect(cards).toHaveLength(0);
    expect(existsSync(artifact('unexpected-transport.marker'))).toBe(false);
  }, 30_000);

  it.each([
    [true, false],
    [false, true],
  ] as const)(
    'requires both notification flags (group=%s, ASIN=%s) before any HTTPS attempt',
    async (group, asin) => {
      await hookServer();
      await competitorPool!.query(
        'UPDATE competitor_variant_groups SET feishu_notify_enabled=$1',
        [group],
      );
      await competitorPool!.query(
        'UPDATE competitor_asins SET feishu_notify_enabled=$1',
        [asin],
      );
      await start();
      const data = await job();
      expect(await finish(await enqueue(data))).toMatchObject({
        success: true,
        totalBroken: 1,
        notificationResults: { US: 'skipped' },
      });
      expect(await counts(data.taskId)).toEqual({
        runs: 1,
        receipts: 1,
        history: 3,
        claims: 0,
      });
      expect(cards).toHaveLength(0);
    },
    35_000,
  );
});
