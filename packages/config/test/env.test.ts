import { describe, expect, it } from 'vitest';

import {
  EnvValidationError,
  getDefaultEnvironmentFiles,
  LEGACY_RECOMMENDED_ENV_VARS,
  LEGACY_REQUIRED_ENV_VARS,
  loadEnv,
  loadEnvironmentFiles,
  resolveRedisUrl,
} from '../src/index';

const validEnv = {
  DATABASE_URL: 'postgres://localhost/amazon_asin_monitor',
  COMPETITOR_DATABASE_URL: 'postgres://localhost/amazon_competitor_monitor',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-secret',
};

describe('loadEnv', () => {
  it('接受合法环境并应用默认值', () => {
    const env = loadEnv({ ...validEnv });
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('INFO');
    expect(env.PORT).toBe(3100);
    expect(env.PROCESS_ROLE).toBe('api');
    expect(env.SCHEDULER_ENABLED).toBe(false);
    expect(env.BULL_PREFIX).toBe('bull');
  });

  it('缺少必需变量时抛出 EnvValidationError 并列出全部缺失项', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
    try {
      loadEnv({});
    } catch (e) {
      const err = e as EnvValidationError;
      const paths = err.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('DATABASE_URL');
      expect(paths).toContain('COMPETITOR_DATABASE_URL');
      expect(paths).toContain('REDIS_URL');
      expect(paths).toContain('JWT_SECRET');
    }
  });

  it('SCHEDULER_ENABLED 字符串转布尔', () => {
    for (const value of ['true', '1', 'yes', 'on', ' YES ']) {
      expect(
        loadEnv({ ...validEnv, SCHEDULER_ENABLED: value }).SCHEDULER_ENABLED,
      ).toBe(true);
    }
    for (const value of ['false', '0', 'no', 'off', ' OFF ']) {
      expect(
        loadEnv({ ...validEnv, SCHEDULER_ENABLED: value }).SCHEDULER_ENABLED,
      ).toBe(false);
    }
  });

  it('PROCESS_ROLE 只接受 api | worker | all', () => {
    expect(loadEnv({ ...validEnv, PROCESS_ROLE: 'all' }).PROCESS_ROLE).toBe(
      'all',
    );
    expect(
      loadEnv({ ...validEnv, PROCESS_ROLE: ' WORKER ' }).PROCESS_ROLE,
    ).toBe('worker');
    expect(() => loadEnv({ ...validEnv, PROCESS_ROLE: 'bogus' })).toThrow(
      EnvValidationError,
    );
  });

  it('PORT 支持字符串数字', () => {
    expect(loadEnv({ ...validEnv, PORT: '3100' }).PORT).toBe(3100);
  });

  it('BULL_PREFIX 保留 legacy 命名空间并将空白回退 bull', () => {
    expect(loadEnv({ ...validEnv, BULL_PREFIX: ' staging ' }).BULL_PREFIX).toBe(
      'staging',
    );
    expect(loadEnv({ ...validEnv, BULL_PREFIX: '  ' }).BULL_PREFIX).toBe(
      'bull',
    );
  });

  it('REDIS_URI 与 legacy 分项配置归一为 REDIS_URL', () => {
    expect(
      loadEnv({
        ...validEnv,
        REDIS_URL: undefined,
        REDIS_URI: 'redis://legacy.example:6380/2',
      }).REDIS_URL,
    ).toBe('redis://legacy.example:6380/2');
    expect(
      resolveRedisUrl({
        REDIS_HOST: '::1',
        REDIS_PORT: '6380',
        REDIS_USERNAME: 'user@example',
        REDIS_PASSWORD: 'p@ss:word',
        REDIS_DB: '3',
      }),
    ).toBe('redis://user%40example:p%40ss%3Aword@[::1]:6380/3');
  });

  it('默认环境文件指向 workspace 的 .env.neo 与根 .env', () => {
    const paths = getDefaultEnvironmentFiles();
    expect(paths[0].replaceAll('\\', '/')).toMatch(/\/\.env\.neo$/);
    expect(paths[1].replaceAll('\\', '/')).toMatch(/\/\.env$/);
    expect(paths.every((path) => !path.includes('server'))).toBe(true);
  });

  it('Neo 环境模板包含双 PostgreSQL、Redis、JWT 与独立 3100 端口', () => {
    const [neoEnvPath] = getDefaultEnvironmentFiles();
    const target: Record<string, string> = {};
    loadEnvironmentFiles([`${neoEnvPath}.example`], target);

    const env = loadEnv(target);
    expect(env.PORT).toBe(3100);
    expect(env.DATABASE_URL).toContain('amazon_asin_monitor');
    expect(env.COMPETITOR_DATABASE_URL).toContain('amazon_competitor_monitor');
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:6379');
  });

  it.each([
    ['debug', 'DEBUG'],
    ['Info', 'INFO'],
    [' ERROR ', 'ERROR'],
  ] as const)('LOG_LEVEL 接受大小写不敏感的 %s', (input, expected) => {
    expect(loadEnv({ ...validEnv, LOG_LEVEL: input }).LOG_LEVEL).toBe(expected);
  });

  it('LOG_LEVEL 拒绝未知级别', () => {
    expect(() => loadEnv({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow(
      EnvValidationError,
    );
  });
});

describe('旧系统 envValidator 对照常量', () => {
  it('必需变量组与 server/src/config/envValidator.js 一致', () => {
    expect([...LEGACY_REQUIRED_ENV_VARS]).toEqual([
      'DB_HOST',
      'DB_USER',
      'DB_PASSWORD',
      'DB_NAME',
      'JWT_SECRET',
    ]);
  });

  it('推荐变量组与 server/src/config/envValidator.js 一致', () => {
    expect([...LEGACY_RECOMMENDED_ENV_VARS]).toEqual([
      'NODE_ENV',
      'LOG_LEVEL',
      'PORT',
      'PROCESS_ROLE',
      'SCHEDULER_ENABLED',
      'VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY',
      'WORKER_ENABLED_QUEUES',
    ]);
  });
});
