import 'reflect-metadata';

import { loadEnv } from '@asin-monitor/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

import { logger } from './logger';
import { getPhysicalQueueName, resolveEnabledQueues } from './queues';
import { getWatchdogRedisOptions, parseRedisUrl } from './redis-options';
import { RedisWatchdog } from './watchdog';

/**
 * Worker 进程入口（PROCESS_ROLE=worker 角色）。
 * 脚手架阶段：建立 Redis 连接、按 WORKER_ENABLED_QUEUES 注册 BullMQ 队列、
 * 启动看门狗；具体 Processor 在 P2-T2 逐域平移。
 * BullMQ 自管连接（传 ConnectionOptions），看门狗使用独立 ioredis 实例。
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const enabled = resolveEnabledQueues(env.WORKER_ENABLED_QUEUES);
  const connection: ConnectionOptions = parseRedisUrl(env.REDIS_URL);

  const queues = enabled.map(
    (name) => new Queue(getPhysicalQueueName(name), { connection }),
  );

  const watchdogRedis = new Redis(
    getWatchdogRedisOptions(connection as RedisOptions),
  );
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

  const shutdown = async (): Promise<void> => {
    watchdog.stop();
    await Promise.all(queues.map((q) => q.close()));
    await watchdogRedis.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (require.main === module) {
  void bootstrap();
}
