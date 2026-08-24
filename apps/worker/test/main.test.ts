import { describe, expect, it } from 'vitest';

import { getWatchdogRedisOptions, parseRedisUrl } from '../src/main';

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
    expect(watchdogOptions.enableOfflineQueue).toBe(false);
  });
});
