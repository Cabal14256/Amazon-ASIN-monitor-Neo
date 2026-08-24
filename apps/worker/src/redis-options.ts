import type { RedisOptions } from 'ioredis';

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
