import 'reflect-metadata';

import { loadEnv } from '@asin-monitor/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

import { logger } from './logger';
import { getPhysicalQueueName, resolveEnabledQueues } from './queues';
import { RedisWatchdog } from './watchdog';

/** redis://[:password@]host[:port][/db] → RedisOptions */
export function parseRedisUrl(raw: string): RedisOptions {
  const url = new URL(raw);
  if (!['redis:', 'rediss:'].includes(url.protocol)) {
    throw new Error(`REDIS_URL 协议不受支持: ${url.protocol}`);
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname ? Number(url.pathname.slice(1)) || 0 : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null, // BullMQ 要求
  };
}

/** 看门狗命令必须可在 Redis 故障时失败，不能继承 BullMQ 的无限重试。 */
export function getWatchdogRedisOptions(
  connection: RedisOptions,
): RedisOptions {
  return {
    ...connection,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  };
}

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
