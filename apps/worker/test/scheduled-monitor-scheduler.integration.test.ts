import { loadEnv, type Env } from '@asin-monitor/config';
import { createPgPool, PgSpApiConfigurationRepository } from '@asin-monitor/db';
import { Queue, QueueEvents } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getNeoQueuePrefix } from '../src/queue-policy';
import { getWatchdogRedisOptions, parseRedisUrl } from '../src/redis-options';
import { startScheduledMonitorScheduler } from '../src/scheduled-monitor-scheduler-runtime';
import {
  buildScheduledMonitorDispatches,
  SCHEDULED_MONITOR_JOB_OPTIONS,
  SCHEDULED_MONITOR_SCHEDULER_ID,
  SCHEDULED_MONITOR_TICK_EVERY_MS,
  SCHEDULED_MONITOR_TICK_JOB,
  SCHEDULED_MONITOR_TICK_QUEUE,
  type ScheduledMonitorConfig,
} from '../src/scheduled-monitor-schedules';

const enabled =
  process.env.RUN_NEO_SCHEDULED_MONITOR_SCHEDULER_INTEGRATION === '1';
const scheduledConfig: ScheduledMonitorConfig = {
  enabled: true,
  competitorEnabled: true,
  usIntervalMinutes: 15,
  euIntervalMinutes: 30,
  totalBatches: 2,
};

async function eventually(action: () => Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Scheduled monitor scheduler integration timed out');
}

async function waitForRedisReady(client: Redis) {
  if (client.status === 'wait') await client.connect();
  if (client.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      client.removeListener('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      client.removeListener('ready', onReady);
      reject(error);
    };
    client.once('ready', onReady);
    client.once('error', onError);
  });
}

describe.skipIf(!enabled)(
  'scheduled monitor scheduler on BullMQ and Redis',
  () => {
    let suffix: string;
    let env: Env;
    let connection: RedisOptions;
    let queuePrefix: string;
    let leaseKey: string;
    const businessQueueName = 'scheduled-monitor-task-queue';
    const activeRuntimes: Array<
      Awaited<ReturnType<typeof startScheduledMonitorScheduler>>
    > = [];
    const controlClients: Redis[] = [];
    let tickQueue: Queue | undefined;
    let tickEvents: QueueEvents | undefined;
    let businessQueue: Queue | undefined;
    let bootstrapPool: ReturnType<typeof createPgPool> | undefined;
    let configPool: ReturnType<typeof createPgPool> | undefined;
    let configRepository: PgSpApiConfigurationRepository | undefined;
    let configSchema: string | undefined;
    let resourcesStarted = false;

    async function writeBatchConfig(totalBatches: number) {
      if (!bootstrapPool || !configSchema)
        throw new Error('Scheduler config fixture is not initialized');
      await bootstrapPool.query(
        `INSERT INTO ${configSchema}.sp_api_config(config_key, config_value)
         VALUES
           ('MONITOR_BATCH_COUNT', $1),
           ('MONITOR_US_SCHEDULE_MINUTES', '15'),
           ('MONITOR_EU_SCHEDULE_MINUTES', '30'),
           ('COMPETITOR_MONITOR_ENABLED', 'true')
         ON CONFLICT (config_key) DO UPDATE
         SET config_value = EXCLUDED.config_value`,
        [String(totalBatches)],
      );
    }

    async function startRuntime(
      control: Redis,
      configRepository: Pick<
        PgSpApiConfigurationRepository,
        'readConfiguration'
      >,
      scheduledQueue: Pick<Queue, 'add'>,
    ) {
      const runtime = await startScheduledMonitorScheduler({
        env,
        connection,
        control,
        scheduledQueue,
        configRepository,
        competitorEnabled: { value: true },
        onFatal: () => undefined,
      });
      activeRuntimes.push(runtime);
      return runtime;
    }

    async function initQueues() {
      suffix = randomUUID().replaceAll('-', '');
      env = loadEnv({
        ...process.env,
        AUTH_DATA_AUTHORITY: 'postgresql',
        BULL_PREFIX: `scheduler-integration-${suffix}`,
        SCHEDULER_ENABLED: 'true',
        MONITOR_US_SCHEDULE_MINUTES: '15',
        MONITOR_EU_SCHEDULE_MINUTES: '30',
        MONITOR_BATCH_COUNT: '2',
        COMPETITOR_MONITOR_ENABLED: 'true',
      });
      connection = parseRedisUrl(env.REDIS_URL);
      if (
        !['127.0.0.1', '::1', 'localhost'].includes(String(connection.host)) ||
        connection.port !== 6379 ||
        connection.db !== 15
      )
        throw new Error(
          'Scheduler integration requires loopback Redis database 15',
        );
      queuePrefix = getNeoQueuePrefix(env);
      leaseKey = `${queuePrefix}:scheduler:scheduled-monitor`;
      if (
        process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
        'amazon_asin_monitor_ci'
      )
        throw new Error(
          'Scheduler integration requires the explicitly disposable CI PostgreSQL database',
        );
      const databaseUrlValue = process.env.DATABASE_URL;
      if (!databaseUrlValue)
        throw new Error('Scheduler integration requires DATABASE_URL');
      const databaseUrl = new URL(databaseUrlValue);
      if (
        !['127.0.0.1', '::1', 'localhost'].includes(databaseUrl.hostname) ||
        databaseUrl.port !== '5432' ||
        databaseUrl.pathname !== '/amazon_asin_monitor_ci'
      )
        throw new Error(
          'Scheduler integration requires loopback disposable PostgreSQL',
        );
      bootstrapPool = createPgPool(databaseUrlValue, {
        max: 1,
        connectionTimeoutMillis: 2000,
      });
      resourcesStarted = true;
      const database = (
        await bootstrapPool.query('SELECT current_database() AS name')
      ).rows[0]?.name;
      if (database !== 'amazon_asin_monitor_ci')
        throw new Error('Unexpected scheduler integration database');
      configSchema = `neo_scheduler_${suffix}`;
      if (!/^neo_scheduler_[a-f0-9]{32}$/.test(configSchema))
        throw new Error('Invalid scheduler configuration schema');
      await bootstrapPool.query(`CREATE SCHEMA ${configSchema}`);
      await bootstrapPool.query(`
        CREATE TABLE ${configSchema}.sp_api_config (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          config_key varchar(50) NOT NULL UNIQUE,
          config_value text,
          description varchar(255),
          create_time timestamp,
          update_time timestamp
        )
      `);
      const scopedUrl = new URL(databaseUrlValue);
      scopedUrl.searchParams.set(
        'options',
        `-c search_path=${configSchema} -c timezone=UTC`,
      );
      configPool = createPgPool(scopedUrl.toString(), {
        max: 4,
        connectionTimeoutMillis: 2000,
      });
      configRepository = new PgSpApiConfigurationRepository(configPool);
      await writeBatchConfig(2);
      const server = new Redis(getWatchdogRedisOptions(connection));
      controlClients.push(server);
      await waitForRedisReady(server);
      const info = await server.info('server');
      const version = /^redis_version:(\d+)\./m.exec(info)?.[1];
      if (!version || Number(version) < 7)
        throw new Error('Scheduler integration requires Redis 7 or later');
      await server.quit();
      controlClients.splice(controlClients.indexOf(server), 1);
      tickQueue = new Queue(SCHEDULED_MONITOR_TICK_QUEUE, {
        connection,
        prefix: queuePrefix,
        defaultJobOptions: SCHEDULED_MONITOR_JOB_OPTIONS,
      });
      tickEvents = new QueueEvents(SCHEDULED_MONITOR_TICK_QUEUE, {
        connection,
        prefix: queuePrefix,
      });
      businessQueue = new Queue(businessQueueName, {
        connection,
        prefix: queuePrefix,
      });
      await Promise.all([
        tickQueue.waitUntilReady(),
        tickEvents.waitUntilReady(),
        businessQueue.waitUntilReady(),
      ]);
    }

    afterEach(async () => {
      if (!resourcesStarted) return;
      await Promise.allSettled(
        activeRuntimes.splice(0).map((runtime) => runtime.close()),
      );
      await Promise.allSettled(
        controlClients.splice(0).map(async (client) => {
          if (client.status === 'end') return;
          if (client.status === 'wait') await client.connect();
          await client.quit();
        }),
      );
      if (tickEvents) await tickEvents.close().catch(() => undefined);
      // Random BullMQ prefix confines obliterate to this test's queues.
      await Promise.allSettled([
        tickQueue?.obliterate({ force: true }),
        businessQueue?.obliterate({ force: true }),
      ]);
      await Promise.allSettled([tickQueue?.close(), businessQueue?.close()]);
      await configPool?.end();
      configPool = undefined;
      configRepository = undefined;
      if (configSchema && bootstrapPool) {
        if (!/^neo_scheduler_[a-f0-9]{32}$/.test(configSchema))
          throw new Error(
            'Refusing to drop an unexpected scheduler fixture schema',
          );
        await bootstrapPool
          .query(`DROP SCHEMA IF EXISTS ${configSchema} CASCADE`)
          .catch(() => undefined);
      }
      await bootstrapPool?.end();
      bootstrapPool = undefined;
      const cleanup = new Redis(getWatchdogRedisOptions(connection));
      await cleanup.del(leaseKey).catch(() => undefined);
      await cleanup.quit().catch(() => undefined);
      resourcesStarted = false;
    });

    it('recovers an ACK-lost tick from its saved config after the owner disconnects', async () => {
      await initQueues();
      const activeTickQueue = tickQueue!;
      const activeTickEvents = tickEvents!;
      const activeBusinessQueue = businessQueue!;
      const controlA = new Redis(getWatchdogRedisOptions(connection));
      const controlB = new Redis(getWatchdogRedisOptions(connection));
      controlClients.push(controlA, controlB);
      let loseCompetitorAck = false;
      let failCompetitorDelivery = false;
      let signalAckLoss!: () => void;
      const ackLost = new Promise<void>((resolve) => {
        signalAckLoss = resolve;
      });
      const attempts: Array<{ id: string; delay: number | undefined }> = [];
      const scheduledQueue = {
        add: async (
          name: string,
          data: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => {
          attempts.push({
            id: String(data.jobId),
            delay: options?.delay as number | undefined,
          });
          if (data.domain === 'competitor' && loseCompetitorAck) {
            loseCompetitorAck = false;
            await writeBatchConfig(3);
            await activeBusinessQueue.add(name, data, options);
            signalAckLoss();
            throw new Error('fixture competitor enqueue acknowledgement lost');
          }
          if (data.domain === 'competitor' && failCompetitorDelivery) {
            failCompetitorDelivery = false;
            throw new Error('fixture competitor enqueue failed');
          }
          return activeBusinessQueue.add(name, data, options);
        },
      };
      const runtimeA = await startRuntime(
        controlA,
        configRepository!,
        scheduledQueue as Pick<Queue, 'add'>,
      );
      const runtimeB = await startRuntime(
        controlB,
        configRepository!,
        activeBusinessQueue,
      );
      await eventually(async () =>
        Boolean(
          await activeTickQueue.getJobScheduler(SCHEDULED_MONITOR_SCHEDULER_ID),
        ),
      );
      const firstOwner = await controlA.get(leaseKey);
      expect(firstOwner).toBeTruthy();
      expect(await controlB.get(leaseKey)).toBe(firstOwner);

      // Stop future generated ticks and drain any tick created during startup so
      // the assertions below cover only the explicit retry fixtures.
      await activeTickQueue.removeJobScheduler(SCHEDULED_MONITOR_SCHEDULER_ID);
      await eventually(
        async () => (await activeTickQueue.getJobCounts('active')).active === 0,
      );
      const startupTicks = await activeTickQueue.getJobs(['wait', 'delayed']);
      await Promise.all(startupTicks.map((job) => job.remove()));
      await activeBusinessQueue.drain(true);
      attempts.length = 0;
      loseCompetitorAck = true;
      failCompetitorDelivery = true;

      // The tick needs a persisted planned time, and an exact slot boundary makes
      // the expected US/EU dispatch independent of local wall-clock drift.
      const plannedAt = Math.ceil(Date.now() / (30 * 60_000)) * (30 * 60_000);
      const tick = await activeTickQueue.add(
        SCHEDULED_MONITOR_TICK_JOB,
        { schemaVersion: 1 },
        { jobId: `fixture-${suffix}`, prevMillis: plannedAt } as never,
      );
      await ackLost;
      await eventually(async () => {
        const current = await activeTickQueue.getJob(tick.id!);
        return (current?.attemptsMade ?? 0) > 0;
      });
      controlA.disconnect();
      await runtimeA.worker.close(true);
      await eventually(
        async () => (await controlB.get(leaseKey)) !== firstOwner,
        25_000,
      );
      await tick.waitUntilFinished(activeTickEvents, 50_000);
      const completedTick = await activeTickQueue.getJob(tick.id!);
      expect(loseCompetitorAck).toBe(false);
      expect(failCompetitorDelivery).toBe(false);
      expect(completedTick?.data).toMatchObject({
        dispatchSnapshot: { config: { totalBatches: 2 } },
      });

      const expected = buildScheduledMonitorDispatches(
        plannedAt,
        scheduledConfig,
      );
      expect(attempts).toHaveLength(28);
      expect(attempts.slice(6, 17).map(({ delay }) => delay)).toEqual(
        expected.map(({ delayMs }) => delayMs),
      );
      const nextPlannedAt = plannedAt + 30 * 60_000;
      await writeBatchConfig(4);
      const nextTick = await activeTickQueue.add(
        SCHEDULED_MONITOR_TICK_JOB,
        { schemaVersion: 1 },
        { jobId: `fixture-next-${suffix}`, prevMillis: nextPlannedAt } as never,
      );
      await nextTick.waitUntilFinished(activeTickEvents, 10_000);
      const completedNextTick = await activeTickQueue.getJob(nextTick.id!);
      expect(completedNextTick?.data).toMatchObject({
        dispatchSnapshot: { config: { totalBatches: 4 } },
      });
      const nextExpected = buildScheduledMonitorDispatches(nextPlannedAt, {
        ...scheduledConfig,
        totalBatches: 4,
      });
      expect(attempts.slice(17).map(({ delay }) => delay)).toEqual(
        nextExpected.map(({ delayMs }) => delayMs),
      );
      const jobs = await activeBusinessQueue.getJobs([
        'wait',
        'delayed',
        'active',
      ]);
      const scheduled = jobs.filter(
        (job) => job.data?.taskType === 'scheduled-monitor',
      );
      expect(new Set(scheduled.map((job) => job.data.jobId))).toEqual(
        new Set([...expected, ...nextExpected].map(({ job }) => job.jobId)),
      );
      expect(scheduled).toHaveLength(22);

      await activeTickQueue.upsertJobScheduler(
        SCHEDULED_MONITOR_SCHEDULER_ID,
        { every: SCHEDULED_MONITOR_TICK_EVERY_MS },
        {
          name: SCHEDULED_MONITOR_TICK_JOB,
          data: { schemaVersion: 1 },
          opts: SCHEDULED_MONITOR_JOB_OPTIONS,
        },
      );

      await controlA.connect();
      await runtimeA.close();
      activeRuntimes.splice(activeRuntimes.indexOf(runtimeA), 1);
      expect(
        await activeTickQueue.getJobScheduler(SCHEDULED_MONITOR_SCHEDULER_ID),
      ).toBeDefined();
      await runtimeB.close();
      activeRuntimes.splice(activeRuntimes.indexOf(runtimeB), 1);
      expect(
        await activeTickQueue.getJobScheduler(SCHEDULED_MONITOR_SCHEDULER_ID),
      ).toBeUndefined();
    }, 120_000);

    it('acknowledges a persisted enabled snapshot without dispatch when scheduling is disabled', async () => {
      await initQueues();
      const activeTickQueue = tickQueue!;
      const activeTickEvents = tickEvents!;
      const activeBusinessQueue = businessQueue!;
      const disabledEnv = { ...env, SCHEDULER_ENABLED: false } as Env;
      const control = new Redis(getWatchdogRedisOptions(connection));
      controlClients.push(control);
      const runtime = await startScheduledMonitorScheduler({
        env: disabledEnv,
        connection,
        control,
        scheduledQueue: activeBusinessQueue,
        configRepository: { readConfiguration: async () => [] },
        competitorEnabled: { value: true },
        onFatal: () => undefined,
      });
      activeRuntimes.push(runtime);
      const plannedAt = Math.floor(Date.now() / (30 * 60_000)) * (30 * 60_000);
      const staleTick = await activeTickQueue.add(
        SCHEDULED_MONITOR_TICK_JOB,
        {
          schemaVersion: 1,
          dispatchSnapshot: {
            version: 1,
            tickJobId: `stale-${suffix}`,
            plannedAt: new Date(plannedAt).toISOString(),
            config: scheduledConfig,
          },
        },
        { jobId: `stale-${suffix}`, prevMillis: plannedAt } as never,
      );
      await staleTick.waitUntilFinished(activeTickEvents, 5000);
      expect(
        await activeBusinessQueue.getJobCounts('wait', 'delayed', 'active'),
      ).toMatchObject({ wait: 0, delayed: 0, active: 0 });
    }, 20_000);
  },
);
