import { loadEnv } from '@asin-monitor/config';
import { createPgPool } from '@asin-monitor/db';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startAuthMaintenanceRuntime } from '../../src/auth-maintenance-runtime';
import {
  AUTH_MAINTENANCE_JOB_OPTIONS,
  AUTH_MAINTENANCE_QUEUE,
} from '../../src/auth-maintenance-schedules';
import { getNeoQueuePrefix } from '../../src/queue-policy';
import {
  getWatchdogRedisOptions,
  parseRedisUrl,
} from '../../src/redis-options';

interface MaintenanceFixture {
  env: ReturnType<typeof loadEnv>;
  pool: ReturnType<typeof createPgPool>;
  queue: Queue;
  events: QueueEvents;
  redis: Redis;
  legacyKey: string;
  leaseKey: string;
  connectionErrors: string[];
  fatal: string[];
  close(): Promise<void>;
  start(
    schedulerEnabled?: boolean,
  ): Promise<Awaited<ReturnType<typeof startAuthMaintenanceRuntime>>>;
  session(id: string, expired?: boolean): Promise<void>;
  audit(id: number): Promise<void>;
}

export async function maintenanceFixture(): Promise<MaintenanceFixture> {
  const suffix = randomUUID().replace(/-/g, '');
  const schema = `auth_worker_67_${suffix}`;
  if (!/^auth_worker_67_[a-f0-9]{32}$/.test(schema))
    throw new Error('Invalid fixture schema');
  const bootstrap = createPgPool(process.env.DATABASE_URL!, {
    max: 1,
    connectionTimeoutMillis: 2000,
  });
  const url = new URL(process.env.DATABASE_URL!);
  // Deliberately exclude public so missing fixture relations cannot fall through
  // to shared integration data. Every runtime connection gets the same schema.
  url.searchParams.set('options', `-c search_path=${schema} -c timezone=UTC`);
  const pool = createPgPool(url.toString(), {
    max: 4,
    connectionTimeoutMillis: 2000,
  });
  const env = loadEnv({
    ...process.env,
    AUTH_DATA_AUTHORITY: 'postgresql',
    DATABASE_URL: url.toString(),
    BULL_PREFIX: `auth-worker-67-${suffix}`,
    WORKER_ENABLED_QUEUES: 'maintenance',
    SCHEDULER_ENABLED: 'true',
  });
  const connection = parseRedisUrl(env.REDIS_URL);
  const queue = new Queue(AUTH_MAINTENANCE_QUEUE, {
    connection: getWatchdogRedisOptions(connection),
    prefix: getNeoQueuePrefix(env),
    defaultJobOptions: AUTH_MAINTENANCE_JOB_OPTIONS,
  });
  const events = new QueueEvents(AUTH_MAINTENANCE_QUEUE, {
    connection,
    prefix: getNeoQueuePrefix(env),
  });
  const redis = new Redis(getWatchdogRedisOptions(connection));
  const connectionErrors: string[] = [];
  const onError = () => {
    connectionErrors.push('fixture connection error');
  };
  queue.on('error', onError);
  events.on('error', onError);
  redis.on('error', onError);
  const runtimes: Awaited<ReturnType<typeof startAuthMaintenanceRuntime>>[] =
    [];
  const fatal: string[] = [];
  const legacyKey = `${env.BULL_PREFIX}:${AUTH_MAINTENANCE_QUEUE}:wait`;
  const leaseKey = `${getNeoQueuePrefix(env)}:scheduler:leader`;
  let installed = false;
  async function close() {
    try {
      await Promise.all(runtimes.map((runtime) => runtime.close()));
      await events.close();
      // Only the random fixture namespace and explicitly created schema are owned.
      if (queue.opts.prefix !== `auth-worker-67-${suffix}:neo`)
        throw new Error('Unexpected fixture queue prefix');
      await queue.obliterate({ force: true });
      await redis.del(legacyKey, leaseKey);
    } finally {
      await Promise.allSettled([queue.close(), redis.quit(), pool.end()]);
      try {
        if (installed) await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await bootstrap.end();
      }
    }
  }
  try {
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    installed = true;
    for (const table of ['users', 'sessions', 'audit_logs'])
      await bootstrap.query(
        `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    await bootstrap.query(
      `ALTER TABLE ${schema}.sessions ADD FOREIGN KEY (user_id) REFERENCES ${schema}.users(id)`,
    );
    // A dedicated bootstrap connection prevents SET search_path from changing the
    // transaction pool used by tests or consumers.
    await bootstrap.query(
      readFileSync(
        resolve(
          __dirname,
          '../../../../packages/db/migrations/0003_auth_maintenance.sql',
        ),
        'utf8',
      ).replaceAll('public', schema),
    );
    await pool.query(
      "INSERT INTO users(id,username,password) VALUES('fixture-owner','fixture-owner','unused-fixture-hash')",
    );
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
    await redis.rpush(legacyKey, 'legacy-fixture');
    return {
      env,
      pool,
      queue,
      events,
      redis,
      legacyKey,
      leaseKey,
      connectionErrors,
      fatal,
      close,
      async start(schedulerEnabled = true) {
        const runtime = await startAuthMaintenanceRuntime(
          { ...env, SCHEDULER_ENABLED: schedulerEnabled },
          () => {
            fatal.push('fatal');
          },
        );
        runtimes.push(runtime);
        return runtime;
      },
      async session(id: string, expired = true) {
        await pool.query(
          'INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,$3)',
          [
            id,
            'fixture-owner',
            expired ? '2000-01-01 00:00:00' : '2999-01-01 00:00:00',
          ],
        );
      },
      async audit(id: number) {
        await pool.query(
          "INSERT INTO audit_logs(id,user_id,username,action,resource,request_data,create_time) OVERRIDING SYSTEM VALUE VALUES($1,'fixture-owner','fixture-owner','UPDATE','user','{\"fixture\":true}','2000-01-01 00:00:00.123456')",
          [id],
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 8000,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Fixture condition did not become true');
}
