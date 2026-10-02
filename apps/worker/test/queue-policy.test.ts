import { loadEnv } from '@asin-monitor/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkerPlans } from '../src/processor-registry';
import {
  getNeoQueuePrefix,
  getQueueOptions,
  getQueuePolicy,
  getWorkerOptions,
} from '../src/queue-policy';
import {
  QUEUE_NAMES,
  resolveEnabledQueues,
  type QueueName,
} from '../src/queues';

const source = {
  DATABASE_URL: 'postgresql://localhost/primary',
  COMPETITOR_DATABASE_URL: 'postgresql://localhost/competitor',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'fixture',
  AUTH_DATA_AUTHORITY: 'postgresql',
};
const files: Record<QueueName, string> = {
  monitor: 'monitorTaskQueue',
  'competitor-monitor': 'competitorMonitorTaskQueue',
  export: 'exportTaskQueue',
  import: 'importTaskQueue',
  'batch-check': 'batchCheckTaskQueue',
  'batch-delete': 'batchDeleteTaskQueue',
  backup: 'backupTaskQueue',
  'variant-check': 'variantCheckTaskQueue',
};
const keys = [
  'MONITOR_QUEUE_WORKER_CONCURRENCY',
  'COMPETITOR_QUEUE_WORKER_CONCURRENCY',
  'EXPORT_QUEUE_WORKER_CONCURRENCY',
  'BATCH_CHECK_QUEUE_WORKER_CONCURRENCY',
  'BATCH_DELETE_QUEUE_WORKER_CONCURRENCY',
  'BACKUP_QUEUE_WORKER_CONCURRENCY',
  'VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY',
];

/** Load only queue registration with stubbed I/O; never import live producers. */
function legacy(name: QueueName, env: Record<string, string>) {
  let captured!: {
    physicalName: string;
    options: { defaultJobOptions: unknown; limiter: unknown };
    concurrency: number;
  };
  class Queue {
    constructor(
      physicalName: string,
      _url: string,
      options: { defaultJobOptions: unknown; limiter: unknown },
    ) {
      captured = { physicalName, options, concurrency: 0 };
    }
    on() {
      return this;
    }
    process(concurrency: number) {
      captured.concurrency = concurrency;
    }
  }
  const module = { exports: {} as { registerProcessor(): void } };
  runInNewContext(
    readFileSync(
      resolve(__dirname, `../../../server/src/services/${files[name]}.js`),
      'utf8',
    ),
    {
      module,
      process: { env },
      require: (id: string) =>
        id === 'bull' ? Queue : { info() {}, warn() {}, error() {} },
    },
  );
  module.exports.registerProcessor();
  return captured;
}

describe('Legacy to BullMQ queue policy parity', () => {
  it.each(QUEUE_NAMES)(
    '%s preserves defaults and positive fractional concurrency normalization',
    (name) => {
      for (const concurrency of ['1', '3.9', '0', 'invalid']) {
        const raw = {
          ...source,
          ...Object.fromEntries(keys.map((key) => [key, concurrency])),
        };
        const baseline = legacy(name, raw);
        const policy = getQueuePolicy(name, loadEnv(raw));
        expect(policy.physicalName).toBe(baseline.physicalName);
        expect(policy.defaultJobOptions).toEqual(
          name === 'monitor' ||
            name === 'variant-check' ||
            name === 'batch-check' ||
            name === 'export'
            ? {
                ...(baseline.options.defaultJobOptions as object),
                removeOnComplete: { age: 604800 },
                removeOnFail: { age: 604800 },
              }
            : baseline.options.defaultJobOptions,
        );
        expect(policy.limiter).toEqual(baseline.options.limiter);
        expect(policy.concurrency).toBe(baseline.concurrency);
      }
    },
  );

  it.each(['variant-check', 'batch-check'] as const)(
    '%s retains terminal evidence for at least the configured metadata lifetime',
    (name) => {
      for (const ttl of [60, 604800, 1209600]) {
        const env = loadEnv({ ...source, TASK_META_TTL_SECONDS: String(ttl) });
        expect(getQueuePolicy(name, env).defaultJobOptions).toMatchObject({
          removeOnComplete: { age: Math.max(3600, ttl) },
          removeOnFail: { age: Math.max(86400, ttl) },
        });
        expect(
          getQueueOptions(name, env, { host: 'localhost' }).defaultJobOptions,
        ).toEqual(getQueuePolicy(name, env).defaultJobOptions);
      }
    },
  );
  it.each(
    ['518400', '604800', '1209600', '31536000'].flatMap((ttl) => [
      [ttl, 'removeOnComplete'] as const,
      [ttl, 'removeOnFail'] as const,
    ]),
  )('retains export evidence for metadata TTL %s / %s', (ttl, field) => {
    const env = loadEnv({ ...source, TASK_META_TTL_SECONDS: ttl });
    const options = getQueuePolicy('export', env).defaultJobOptions;
    expect(options[field]).toEqual({
      age: Math.max(field === 'removeOnComplete' ? 86400 : 604800, Number(ttl)),
    });
    expect(
      getQueueOptions('export', env, { host: 'localhost' }).defaultJobOptions,
    ).toEqual(options);
  });

  it.each([
    ['3600', 604_800],
    ['604800', 604_800],
    ['1209600', 1_209_600],
    ['31536000', 31_536_000],
  ])(
    'retains monitor success and failure for the bounded metadata lifetime %s',
    (ttl, expectedAge) => {
      const env = loadEnv({ ...source, TASK_META_TTL_SECONDS: ttl });
      const policy = getQueuePolicy('monitor', env);
      expect(policy.defaultJobOptions.removeOnComplete).toEqual({
        age: expectedAge,
      });
      expect(policy.defaultJobOptions.removeOnFail).toEqual({
        age: expectedAge,
      });
      expect(
        getQueueOptions('monitor', env, { host: 'localhost' }).defaultJobOptions
          ?.removeOnComplete,
      ).toEqual({ age: expectedAge });
      expect(
        getQueueOptions('monitor', env, { host: 'localhost' }).defaultJobOptions
          ?.removeOnFail,
      ).toEqual({ age: expectedAge });
      expect(
        getQueuePolicy('competitor-monitor', env).defaultJobOptions,
      ).toMatchObject({ removeOnComplete: { age: 3600 } });
    },
  );

  it.each(['monitor', 'competitor-monitor'] as const)(
    '%s preserves configured limiter values',
    (name) => {
      const raw = {
        ...source,
        MONITOR_QUEUE_LIMITER_MAX: '4',
        MONITOR_QUEUE_LIMITER_DURATION_MS: '725',
        COMPETITOR_QUEUE_LIMITER_MAX: '3',
        COMPETITOR_QUEUE_LIMITER_DURATION_MS: '400',
      };
      expect(getQueuePolicy(name, loadEnv(raw)).limiter).toEqual(
        legacy(name, raw).options.limiter,
      );
    },
  );

  it('places limiter/concurrency on workers, retries/retention on queues, and isolates legacy keys', () => {
    const env = loadEnv({ ...source, BULL_PREFIX: 'stage' });
    const connection = { host: 'localhost' };
    expect(getNeoQueuePrefix(env)).toBe('stage:neo');
    const queue = getQueueOptions('export', env, connection);
    const worker = getWorkerOptions('export', env, connection);
    expect(queue).not.toHaveProperty('limiter');
    expect(queue.defaultJobOptions).toMatchObject({
      attempts: 2,
      removeOnComplete: { age: Math.max(86400, env.TASK_META_TTL_SECONDS) },
      removeOnFail: { age: 604800 },
    });
    expect(worker).toMatchObject({
      prefix: queue.prefix,
      limiter: { max: 1, duration: 500 },
      concurrency: 1,
    });
  });

  it('preflights missing processors without executing registered handlers', () => {
    const processor = vi.fn();
    const env = loadEnv(source);
    expect(() =>
      buildWorkerPlans(['export', 'backup'], { export: processor }, env, {
        host: 'localhost',
      }),
    ).toThrow('backup');
    expect(processor).not.toHaveBeenCalled();
    expect(buildWorkerPlans([], {}, env, { host: 'localhost' })).toEqual([]);
    const plans = buildWorkerPlans(
      ['export', 'export'],
      { export: processor },
      env,
      { host: 'localhost' },
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.processor).toBe(processor);
    expect(resolveEnabledQueues(' , , ')).toEqual(QUEUE_NAMES);
  });
});
