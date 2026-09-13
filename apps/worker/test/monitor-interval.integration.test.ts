import { loadEnv } from '@asin-monitor/config';
import { createPgPool } from '@asin-monitor/db';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMonitorIntervalRuntime } from '../src/monitor-interval-runtime';
import {
  MONITOR_INTERVAL_JOB,
  MONITOR_INTERVAL_JOB_OPTIONS,
  MONITOR_INTERVAL_QUEUE,
  MONITOR_INTERVAL_SCHEDULER,
} from '../src/monitor-interval-schedules';
import { getNeoQueuePrefix } from '../src/queue-policy';
import { getWatchdogRedisOptions, parseRedisUrl } from '../src/redis-options';

async function eventually(action: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await action()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('Interval worker fixture condition timed out');
}
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'status interval runtime on PostgreSQL and Redis',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    let env: ReturnType<typeof loadEnv>, pool: ReturnType<typeof createPgPool>;
    let unrelated: {
      query: ReturnType<typeof createPgPool>['query'];
      release(): void;
    };
    let queue: Queue, events: QueueEvents, redis: Redis;
    let verified = false;
    const runtimes: Awaited<ReturnType<typeof startMonitorIntervalRuntime>>[] =
      [];
    const failures: string[] = [];
    const country = 'ZW109';
    async function start(scheduler = false) {
      const runtime = await startMonitorIntervalRuntime(
        { ...env, SCHEDULER_ENABLED: scheduler },
        () => failures.push('fatal'),
      );
      runtimes.push(runtime);
      return runtime;
    }
    async function seed() {
      await pool.query(
        `INSERT INTO public.monitor_history(asin_id,asin_code,country,check_type,is_broken,check_time)
      VALUES ('interval-worker-109','I109-WORKER',$1,'ASIN',false,'1999-01-01 00:00:00'),
        ('interval-worker-109','I109-WORKER',$1,'ASIN',true,'1999-01-01 02:00:00'),
        ('interval-worker-109','I109-WORKER',$1,'ASIN',false,'1999-01-01 04:00:00')`,
        [country],
      );
    }
    async function clean() {
      await pool.query(
        'DELETE FROM public.monitor_history WHERE country = $1',
        [country],
      );
      await pool.query(
        'DELETE FROM public.monitor_history_status_interval WHERE country = $1',
        [country],
      );
      await pool.query(
        'DELETE FROM public.monitor_interval_dirty WHERE country = $1',
        [country],
      );
    }
    beforeAll(async () => {
      if (
        process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
        'amazon_asin_monitor_ci'
      )
        throw new Error(
          'Interval workers require the explicitly disposable CI database',
        );
      pool = createPgPool(process.env.DATABASE_URL!, {
        max: 5,
        connectionTimeoutMillis: 2000,
      });
      expect(
        (await pool.query('SELECT current_database() AS name')).rows[0].name,
      ).toBe('amazon_asin_monitor_ci');
      verified = true;
      env = loadEnv({
        ...process.env,
        AUTH_DATA_AUTHORITY: 'postgresql',
        ANALYTICS_STATUS_INTERVAL_ENABLED: '1',
        WORKER_ENABLED_QUEUES: 'interval-maintenance',
        BULL_PREFIX: `interval-worker-109-${suffix}`,
        SCHEDULER_ENABLED: 'false',
      });
      const connection = parseRedisUrl(env.REDIS_URL),
        prefix = getNeoQueuePrefix(env);
      queue = new Queue(MONITOR_INTERVAL_QUEUE, {
        connection: getWatchdogRedisOptions(connection),
        prefix,
        defaultJobOptions: MONITOR_INTERVAL_JOB_OPTIONS,
      });
      events = new QueueEvents(MONITOR_INTERVAL_QUEUE, { connection, prefix });
      redis = new Redis(getWatchdogRedisOptions(connection));
      const connectionError = () => {
        failures.push('fixture connection error');
      };
      queue.on('error', connectionError);
      events.on('error', connectionError);
      redis.on('error', connectionError);
      await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
      await redis.set(
        `${env.BULL_PREFIX}:${MONITOR_INTERVAL_QUEUE}:legacy-sentinel`,
        'untouched',
      );
      unrelated = await pool.connect();
      await unrelated.query('BEGIN');
      await unrelated.query(
        'SELECT 1 FROM public.monitor_interval_dirty WHERE country <> $1 FOR UPDATE',
        [country],
      );
    });
    beforeEach(async () => {
      for (const runtime of runtimes.splice(0)) await runtime.close();
      await queue.removeJobScheduler(MONITOR_INTERVAL_SCHEDULER);
      await queue.drain(true);
      await queue.resume();
      await clean();
    });
    afterAll(async () => {
      try {
        for (const runtime of runtimes.splice(0)) await runtime.close();
        await events?.close();
        if (queue) {
          if (queue.opts.prefix !== `interval-worker-109-${suffix}:neo`)
            throw new Error('Unexpected interval fixture namespace');
          await queue.obliterate({ force: true });
        }
        if (redis)
          await redis.del(
            `${env.BULL_PREFIX}:${MONITOR_INTERVAL_QUEUE}:legacy-sentinel`,
            `${getNeoQueuePrefix(env)}:scheduler:monitor-intervals`,
          );
      } finally {
        if (unrelated) {
          await unrelated.query('ROLLBACK');
          unrelated.release();
        }
        if (verified) await clean();
        await Promise.allSettled([queue?.close(), redis?.quit(), pool?.end()]);
      }
    });

    it('reconciles late corrections with one shared schedule and leaves Legacy queue state untouched', async () => {
      await queue.pause();
      await start(true);
      await start(true);
      expect((await queue.getJobSchedulers()).map((item) => item.key)).toEqual([
        MONITOR_INTERVAL_SCHEDULER,
      ]);
      expect(await queue.getGlobalConcurrency()).toBe(2);
      await queue.removeJobScheduler(MONITOR_INTERVAL_SCHEDULER);
      await queue.drain(true);
      await seed();
      const job = await queue.add(MONITOR_INTERVAL_JOB, { schemaVersion: 1 });
      await queue.resume();
      expect(await job.waitUntilFinished(events, 8000)).toMatchObject({
        processed: 1,
        deferred: 0,
      });
      expect(
        (
          await pool.query(
            'SELECT is_broken FROM public.monitor_history_status_interval WHERE country = $1 ORDER BY interval_start',
            [country],
          )
        ).rows,
      ).toEqual([
        { is_broken: false },
        { is_broken: true },
        { is_broken: false },
      ]);
      await pool.query(
        'UPDATE public.monitor_history SET is_broken = false WHERE country = $1',
        [country],
      );
      const correction = await queue.add(MONITOR_INTERVAL_JOB, {
        schemaVersion: 1,
      });
      await correction.waitUntilFinished(events, 8000);
      expect(
        (
          await pool.query(
            'SELECT is_broken FROM public.monitor_history_status_interval WHERE country = $1',
            [country],
          )
        ).rows,
      ).toEqual([{ is_broken: false }]);
      expect(
        await redis.get(
          `${env.BULL_PREFIX}:${MONITOR_INTERVAL_QUEUE}:legacy-sentinel`,
        ),
      ).toBe('untouched');
      expect(failures).toEqual([]);
    }, 20_000);

    it('rejects malformed persisted jobs once and resumes pending database work after shutdown', async () => {
      const first = await start();
      const invalid = await queue.add(MONITOR_INTERVAL_JOB, {
        schemaVersion: 1,
        sql: 'fixture-secret',
      });
      await expect(invalid.waitUntilFinished(events, 8000)).rejects.toThrow(
        'Invalid monitor interval maintenance job',
      );
      expect((await queue.getJob(invalid.id!))?.attemptsMade).toBe(1);
      await seed();
      const initial = await queue.add(MONITOR_INTERVAL_JOB, {
        schemaVersion: 1,
      });
      await initial.waitUntilFinished(events, 8000);
      await pool.query(
        'UPDATE public.monitor_history SET is_broken = true WHERE country = $1',
        [country],
      );
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT 1 FROM public.monitor_history_status_interval WHERE country = $1 FOR UPDATE',
          [country],
        );
        const pending = await queue.add(MONITOR_INTERVAL_JOB, {
          schemaVersion: 1,
        });
        await eventually(async () => (await pending.getState()) === 'active');
        await first.close();
        expect(
          (
            await pool.query(
              'SELECT completed_revision <> revision AS pending FROM public.monitor_interval_dirty WHERE country = $1',
              [country],
            )
          ).rows[0]?.pending,
        ).toBe(true);
        await blocker.query('ROLLBACK');
        await start();
        await pending.waitUntilFinished(events, 12000);
        expect(
          (
            await pool.query(
              'SELECT is_broken FROM public.monitor_history_status_interval WHERE country = $1',
              [country],
            )
          ).rows,
        ).toEqual([{ is_broken: true }]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(failures).toEqual([]);
    }, 25_000);

    it.skipIf(process.platform === 'win32')(
      'the compiled Worker entry starts the selected consumer and shuts down cleanly',
      async () => {
        await seed();
        const child = spawn(
          process.execPath,
          [resolve(__dirname, '../dist/main.js')],
          {
            cwd: resolve(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              AUTH_DATA_AUTHORITY: 'postgresql',
              DATABASE_URL: env.DATABASE_URL,
              REDIS_URL: env.REDIS_URL,
              BULL_PREFIX: env.BULL_PREFIX,
              WORKER_ENABLED_QUEUES: 'interval-maintenance',
              ANALYTICS_STATUS_INTERVAL_ENABLED: '1',
              SCHEDULER_ENABLED: 'false',
              LOG_LEVEL: 'INFO',
            },
          },
        );
        let output = '',
          exited = false,
          code: number | null = null;
        const collect = (data: Buffer) => {
          output = (output + data.toString('utf8')).slice(-64000);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', () => {
          output += '\nfixture child failed';
        });
        child.on('exit', (value) => {
          exited = true;
          code = value;
        });
        try {
          await eventually(async () => {
            if (exited)
              throw new Error(
                `Interval entry exited before readiness: ${output}`,
              );
            return /mode: 'monitor-interval-maintenance'/.test(output);
          }, 10000);
          const task = await queue.add(MONITOR_INTERVAL_JOB, {
            schemaVersion: 1,
          });
          expect(await task.waitUntilFinished(events, 8000)).toMatchObject({
            processed: 1,
          });
          child.kill('SIGTERM');
          await eventually(async () => exited, 12000);
          expect(code).toBe(0);
          expect(output).not.toContain('fixture-secret');
        } finally {
          if (!exited) {
            child.kill('SIGKILL');
            await eventually(async () => exited, 2000);
          }
        }
      },
      25_000,
    );
  },
);
