import { loadEnv } from '@asin-monitor/config';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildWorkerPlans } from '../src/processor-registry';
import { getQueueOptions, getQueuePolicy } from '../src/queue-policy';
import { parseRedisUrl } from '../src/redis-options';

it.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'real BullMQ shares limiter across workers, retries, retains results and isolates legacy keys',
  async () => {
    const env = loadEnv({
      ...process.env,
      BULL_PREFIX: `fixture-${randomUUID()}`,
    });
    const connection = parseRedisUrl(env.REDIS_URL);
    const times: number[] = [];
    const [plan] = buildWorkerPlans(
      ['export'],
      {
        export: async (job) => {
          if (job.name === 'retry' && job.attemptsMade === 0)
            throw new Error('fixture retry');
          if (job.name === 'limiter') times.push(Date.now());
          return { complete: true };
        },
      },
      env,
      connection,
    );
    const queue = new Queue(
      plan!.physicalName,
      getQueueOptions('export', env, connection),
    );
    const events = new QueueEvents(plan!.physicalName, {
      connection,
      prefix: plan!.options.prefix,
    });
    const workers = [
      new Worker(plan!.physicalName, plan!.processor, plan!.options),
      new Worker(plan!.physicalName, plan!.processor, plan!.options),
    ];
    const redis = new Redis(connection);
    const errors: string[] = [];
    const onError = () => {
      errors.push('fixture connection error');
    };
    queue.on('error', onError);
    events.on('error', onError);
    for (const worker of workers) worker.on('error', onError);
    redis.on('error', onError);
    const legacyKey = `${env.BULL_PREFIX}:${plan!.physicalName}:wait`;
    try {
      await events.waitUntilReady();
      await queue.waitUntilReady();
      expect(await redis.exists(legacyKey)).toBe(0);
      await redis.rpush(legacyKey, 'legacy-fixture');
      const jobs = await queue.addBulk([
        { name: 'limiter', data: {} },
        { name: 'limiter', data: {} },
      ]);
      await Promise.all(
        jobs.map((job) => job.waitUntilFinished(events, 10_000)),
      );
      expect(times).toHaveLength(2);
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(400);
      const retry = await queue.add('retry', {}, { jobId: 'retry-fixture' });
      await expect(retry.waitUntilFinished(events, 12_000)).resolves.toEqual({
        complete: true,
      });
      const saved = await queue.getJob(retry.id!);
      expect(saved?.attemptsMade).toBe(2);
      expect(saved?.opts).toMatchObject({
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      });
      expect(await redis.lrange(legacyKey, 0, -1)).toEqual(['legacy-fixture']);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(workers.map((worker) => worker.close(true)));
      await events.close();
      // Only remove the random, explicitly created fixture namespace.
      expect(queue.opts.prefix).toBe(`${env.BULL_PREFIX}:neo`);
      await queue.obliterate({ force: true });
      await queue.close();
      await redis.del(legacyKey);
      await redis.quit();
    }
  },
  20_000,
);

it
  .skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')
  .each(['604800', '1209600'])(
  'real monitor cleanup preserves the completion receipt through metadata TTL %s and then expires it',
  async (ttl) => {
    const env = loadEnv({
      ...process.env,
      BULL_PREFIX: `fixture-${randomUUID()}`,
      TASK_META_TTL_SECONDS: ttl,
    });
    const connection = parseRedisUrl(env.REDIS_URL);
    const [plan] = buildWorkerPlans(
      ['monitor'],
      { monitor: async () => ({ totalChecked: 1, success: true }) },
      env,
      connection,
    );
    const queue = new Queue(
      plan!.physicalName,
      getQueueOptions('monitor', env, connection),
    );
    const events = new QueueEvents(queue.name, {
      connection,
      prefix: plan!.options.prefix,
    });
    const worker = new Worker(queue.name, plan!.processor, plan!.options);
    const redis = new Redis(connection);
    const errors: string[] = [];
    for (const resource of [queue, events, worker, redis])
      resource.on('error', () => errors.push('fixture connection error'));
    try {
      await events.waitUntilReady();
      const receipt = await queue.add('primary-monitor', {});
      await receipt.waitUntilFinished(events, 5000);
      const age = getQueuePolicy('monitor', env).defaultJobOptions
        .removeOnComplete.age;
      // Age only this isolated fixture's completed index; no wall-clock wait.
      await redis.zadd(
        queue.toKey('completed'),
        Date.now() - (age - 60) * 1000,
        receipt.id!,
      );
      const cleanup = await queue.add('primary-monitor', {});
      await cleanup.waitUntilFinished(events, 5000);
      expect((await queue.getJob(receipt.id!))?.returnvalue).toEqual({
        totalChecked: 1,
        success: true,
      });
      await redis.zadd(
        queue.toKey('completed'),
        Date.now() - (age + 60) * 1000,
        receipt.id!,
      );
      const expiredCleanup = await queue.add('primary-monitor', {});
      await expiredCleanup.waitUntilFinished(events, 5000);
      expect(await queue.getJob(receipt.id!)).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      await worker.close(true);
      await events.close();
      expect(queue.opts.prefix).toBe(`${env.BULL_PREFIX}:neo`);
      await queue.obliterate({ force: true });
      await queue.close();
      await redis.quit();
    }
  },
  15_000,
);
