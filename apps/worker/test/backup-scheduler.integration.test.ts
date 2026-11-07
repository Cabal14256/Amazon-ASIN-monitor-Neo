import {
  getNeoQueuePrefix,
  getPhysicalQueueName,
  loadEnv,
} from '@asin-monitor/config';
import { createPgPool } from '@asin-monitor/db';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startBackupRuntime } from '../src/backup-runtime';
import { parseRedisUrl } from '../src/redis-options';

async function eventually(check: () => Promise<boolean>, timeout = 35_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Backup scheduler fixture condition timed out');
}

describe.skipIf(
  process.env.RUN_INTEGRATION_TESTS !== 'true' || process.platform === 'win32',
)('backup scheduler on disposable PostgreSQL and Redis', () => {
  it('drains a real blocked config transaction on shutdown without admitting late scheduled jobs', async () => {
    if (process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true')
      throw new Error('Explicit disposable integration opt-in required');
    for (const [key, protocol, pathname, port] of [
      ['DATABASE_URL', 'postgresql:', '/amazon_asin_monitor_ci', '5432'],
      [
        'COMPETITOR_DATABASE_URL',
        'postgresql:',
        '/amazon_competitor_monitor_ci',
        '5432',
      ],
      ['REDIS_URL', 'redis:', '/15', '6379'],
    ]) {
      const value = new URL(process.env[key] ?? '');
      if (
        value.hostname !== '127.0.0.1' ||
        value.protocol !== protocol ||
        value.pathname !== pathname ||
        value.port !== port ||
        value.password ||
        value.search ||
        value.hash
      )
        throw new Error(
          'Backup scheduler requires exact disposable loopback CI targets',
        );
    }
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `backup_scheduler_161_${suffix}`;
    const prefix = `backup-scheduler-161-${suffix}`;
    const application = `backup-scheduler-${suffix}`;
    const source = new URL(process.env.DATABASE_URL!);
    source.searchParams.set('options', `-c search_path=${schema}`);
    source.searchParams.set('application_name', application);
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: source.toString(),
      AUTH_DATA_AUTHORITY: 'postgresql',
      TASK_META_TTL_SECONDS: '604800',
      BULL_PREFIX: prefix,
      SCHEDULER_ENABLED: 'true',
    });
    const bootstrap = createPgPool(process.env.DATABASE_URL!, {
      max: 2,
      connectionTimeoutMillis: 2000,
      statement_timeout: 2000,
    });
    let installed = false;
    let runtime: Awaited<ReturnType<typeof startBackupRuntime>> | undefined;
    let observer: Queue | undefined;
    let lock:
      | { query(sql: string): Promise<unknown>; release(): void }
      | undefined;
    try {
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      installed = true;
      await bootstrap.query(
        `CREATE TABLE ${schema}.backup_config (LIKE public.backup_config INCLUDING ALL)`,
      );
      const backupTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date());
      await bootstrap.query(
        `INSERT INTO ${schema}.backup_config(id,enabled,backup_time,schedule_type,schedule_value) OVERRIDING SYSTEM VALUE VALUES(1,false,$1,'daily',NULL)`,
        [backupTime],
      );
      const fatal: string[] = [];
      runtime = await startBackupRuntime(env, () => {
        fatal.push('worker stopped');
      });
      observer = new Queue(getPhysicalQueueName('backup'), {
        connection: parseRedisUrl(env.REDIS_URL),
        prefix: getNeoQueuePrefix(env),
      });
      observer.on('error', () => undefined);
      await observer.waitUntilReady();
      await bootstrap.query(`UPDATE ${schema}.backup_config SET enabled=true`);
      lock = await bootstrap.connect();
      await lock.query('BEGIN');
      await lock.query(
        `LOCK TABLE ${schema}.backup_config IN ACCESS EXCLUSIVE MODE`,
      );
      await eventually(
        async () =>
          Number(
            (
              await bootstrap.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%backup_config%'",
                [application],
              )
            ).rows[0].n,
          ) > 0,
      );
      let closed = false;
      const completion = runtime.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      await lock.query('ROLLBACK');
      lock.release();
      lock = undefined;
      await completion;
      expect(
        await observer.getJobCounts(
          'wait',
          'active',
          'completed',
          'failed',
          'delayed',
        ),
      ).toMatchObject({
        wait: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      });
      expect(fatal).toEqual([]);
    } finally {
      if (lock) {
        await lock.query('ROLLBACK').catch(() => undefined);
        lock.release();
      }
      await runtime?.close();
      if (observer) {
        if (observer.opts.prefix !== `${prefix}:neo`)
          throw new Error('Fixture namespace changed');
        await observer.obliterate({ force: true });
        await observer.close();
      }
      try {
        if (installed) await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await bootstrap.end();
      }
    }
  }, 50_000);
});
