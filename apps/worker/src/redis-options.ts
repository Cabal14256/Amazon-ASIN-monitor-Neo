import type { RedisOptions } from 'ioredis';

function normalizeRedisHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function parseRedisDatabase(pathname: string): number {
  if (pathname === '' || pathname === '/') return 0;
  const match = /^\/(\d+)$/.exec(pathname);
  if (!match) {
    throw new Error(`REDIS_URL 数据库路径无效: ${pathname}`);
  }
  const database = Number(match[1]);
  if (!Number.isSafeInteger(database)) {
    throw new Error(`REDIS_URL 数据库编号超出安全整数范围: ${pathname}`);
  }
  return database;
}

/** redis://[:password@]host[:port][/db] → RedisOptions */
export function parseRedisUrl(raw: string): RedisOptions {
  const url = new URL(raw);
  if (!['redis:', 'rediss:'].includes(url.protocol)) {
    throw new Error(`REDIS_URL 协议不受支持: ${url.protocol}`);
  }
  return {
    host: normalizeRedisHostname(url.hostname),
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: parseRedisDatabase(url.pathname),
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
    commandTimeout: 5_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  };
}
