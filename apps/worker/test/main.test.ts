import { describe, expect, it } from 'vitest';

import { sanitizeWorkerLog } from '../src/logger';
import { getWatchdogRedisOptions, parseRedisUrl } from '../src/redis-options';

describe('Redis 连接选项', () => {
  it('保留 rediss TLS 与 URL 编码凭据', () => {
    const options = parseRedisUrl(
      'rediss://user%40example:p%40ss%3Aword@redis.example:6380/2',
    );
    expect(options).toMatchObject({
      host: 'redis.example',
      port: 6380,
      username: 'user@example',
      password: 'p@ss:word',
      db: 2,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('看门狗使用有限命令重试，队列连接仍保持无限重试', () => {
    const queueOptions = parseRedisUrl('redis://localhost:6379');
    const watchdogOptions = getWatchdogRedisOptions(queueOptions);
    expect(queueOptions.maxRetriesPerRequest).toBeNull();
    expect(watchdogOptions.maxRetriesPerRequest).toBe(1);
    expect(watchdogOptions.commandTimeout).toBe(5_000);
    expect(watchdogOptions.enableOfflineQueue).toBe(false);
  });

  it('移除 IPv6 字面量主机的 URL 方括号', () => {
    expect(parseRedisUrl('redis://[::1]:6379/0').host).toBe('::1');
  });

  it.each(['redis://host/jobs', 'redis://host/1/extra', 'redis://host/-1'])(
    '拒绝无效 Redis 数据库路径 %s',
    (url) => {
      expect(() => parseRedisUrl(url)).toThrow(/数据库路径无效/);
    },
  );
});

describe('Worker 日志脱敏', () => {
  it('覆盖 API logger 的全部凭据别名', () => {
    expect(
      sanitizeWorkerLog({
        apiKey: 'key',
        pwd: 'password',
        auth: 'basic',
        cookie: 'session=secret',
        nested: { accessToken: 'token', refreshToken: 'refresh' },
      }),
    ).toEqual({
      apiKey: '***REDACTED***',
      pwd: '***REDACTED***',
      auth: '***REDACTED***',
      cookie: '***REDACTED***',
      nested: {
        accessToken: '***REDACTED***',
        refreshToken: '***REDACTED***',
      },
    });
  });
});
