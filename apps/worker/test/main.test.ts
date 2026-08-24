import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger, sanitizeWorkerLog } from '../src/logger';
import { getWatchdogRedisOptions, parseRedisUrl } from '../src/redis-options';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

  it('无效 URL 异常不携带原始凭据', () => {
    const password = 'super-secret-password';
    let error: unknown;
    try {
      parseRedisUrl(`redis://user:${password}@`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain(password);
    expect((error as Error).message).toBe('REDIS_URL 格式无效');
  });

  it.each(['redis://', 'redis:///0'])('拒绝无主机名 Redis URL %s', (url) => {
    expect(() => parseRedisUrl(url)).toThrow('REDIS_URL 缺少主机名');
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

  it('LOG_LEVEL 带空白时仍应用正确阈值', () => {
    vi.stubEnv('LOG_LEVEL', ' ERROR ');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    logger.info('below threshold');
    logger.error('at threshold');

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });
});
