import 'reflect-metadata';

import { loadEnv, loadEnvironmentFiles } from '@asin-monitor/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

import { logger } from './logger';
import { attachQueueErrorLogger, attachRedisErrorLogger } from './queue-events';
import {
  getPhysicalQueueName,
  resolveQueueSelection,
  shouldInitializeQueueRuntime,
} from './queues';
import { getWatchdogRedisOptions, parseRedisUrl } from './redis-options';
import { runWorker } from './runner';
import { shutdownWorker } from './shutdown';
import { RedisWatchdog } from './watchdog';

/**
 * Worker 进程入口（PROCESS_ROLE=worker 角色）。
 * 脚手架阶段：建立 Redis 连接、按 WORKER_ENABLED_QUEUES 注册 BullMQ 队列、
 * 启动看门狗；具体 Processor 在 P2-T2 逐域平移。
 * BullMQ 自管连接（传 ConnectionOptions），看门狗使用独立 ioredis 实例。
 */
async function bootstrap(): Promise<void> {
  loadEnvironmentFiles();
  const env = loadEnv();
  const { enabledQueues: enabled, unknownQueues } = resolveQueueSelection(
    env.WORKER_ENABLED_QUEUES,
  );

  if (unknownQueues.length > 0) {
    logger.warn('WORKER_ENABLED_QUEUES 包含未知队列名，已忽略', {
      unknownQueues,
    });
  }

  if (!shouldInitializeQueueRuntime(enabled)) {
    logger.info('Worker 未启用任何队列，跳过 Redis 连接与看门狗');
    return;
  }

  const connection: ConnectionOptions = parseRedisUrl(env.REDIS_URL);

  const queues = enabled.map((name) => {
    const physicalName = getPhysicalQueueName(name);
    const queue = new Queue(physicalName, {
      connection,
      prefix: env.BULL_PREFIX,
    });
    attachQueueErrorLogger(queue, physicalName);
    return queue;
  });

  const watchdogRedis = new Redis(
    getWatchdogRedisOptions(connection as RedisOptions),
  );
  attachRedisErrorLogger(watchdogRedis, 'watchdog');
  const watchdog = new RedisWatchdog(watchdogRedis);
  watchdog.start(() => {
    logger.error('Redis 连续 60s 不健康，退出进程');
    process.exit(1);
  });

  logger.info('Worker 已启动', {
    enabledQueues: enabled,
    physicalQueues: enabled.map(getPhysicalQueueName),
    queueCount: queues.length,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= shutdownWorker({ watchdog, queues, watchdogRedis });
    return shutdownPromise;
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (require.main === module) {
  void runWorker(bootstrap);
}
