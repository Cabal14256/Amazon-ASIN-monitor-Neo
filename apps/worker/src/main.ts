import 'reflect-metadata';

import { loadEnv } from '@asin-monitor/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

import { resolveEnabledQueues } from './queues';
import { RedisWatchdog } from './watchdog';

/** redis://[:password@]host[:port][/db] → RedisOptions */
export function parseRedisUrl(raw: string): RedisOptions {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname ? Number(url.pathname.slice(1)) || 0 : 0,
    maxRetriesPerRequest: null, // BullMQ 要求
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

  const queues = enabled.map((name) => new Queue(name, { connection }));

  const watchdogRedis = new Redis(connection as RedisOptions);
  const watchdog = new RedisWatchdog(watchdogRedis);
  watchdog.start(() => {
    // eslint-disable-next-line no-console -- 进程退出前的最后通道
    console.error('[worker] Redis 连续 60s 不健康，退出进程');
    process.exit(1);
  });

  // eslint-disable-next-line no-console -- 脚手架阶段启动横幅
  console.info(
    `[worker] 已启动，启用队列: ${enabled.join(', ')}（共 ${
      queues.length
    } 个）`,
  );

  const shutdown = async (): Promise<void> => {
    watchdog.stop();
    await Promise.all(queues.map((q) => q.close()));
    await watchdogRedis.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void bootstrap();
