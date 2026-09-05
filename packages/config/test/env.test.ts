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
  AUTH_DATA_AUTHORITY: 'postgresql',
};

describe('loadEnv', () => {
  it('队列并发兼容 Legacy 取整与默认回退，监控限速拒绝非法负数', () => {
    for (const [raw, expected] of [
      ['3.9', 3],
      ['0.5', 1],
      ['0', 1],
      ['-1', 1],
      ['invalid', 1],
      ['', 1],
    ] as const) {
      const env = loadEnv({
        ...validEnv,
        MONITOR_QUEUE_WORKER_CONCURRENCY: raw,
        VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY: raw,
      });
      expect(env.MONITOR_QUEUE_WORKER_CONCURRENCY).toBe(expected);
      expect(env.VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY).toBe(expected);
    }
    expect(
      loadEnv({
        ...validEnv,
        MONITOR_QUEUE_LIMITER_MAX: '0',
        COMPETITOR_QUEUE_LIMITER_DURATION_MS: 'invalid',
      }),
    ).toMatchObject({
      MONITOR_QUEUE_LIMITER_MAX: 1,
      COMPETITOR_QUEUE_LIMITER_DURATION_MS: 200,
    });
    expect(() =>
      loadEnv({ ...validEnv, MONITOR_QUEUE_LIMITER_MAX: '-1' }),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv({ ...validEnv, COMPETITOR_QUEUE_LIMITER_DURATION_MS: '1.2' }),
    ).toThrow(EnvValidationError);
  });

  it('接受合法环境并应用默认值', () => {
    const env = loadEnv({ ...validEnv });
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('INFO');
    expect(env.PORT).toBe(3100);
    expect(env.CORS_ORIGIN).toBe('http://localhost:8000');
    expect(env.PROCESS_ROLE).toBe('api');
    expect(env.SCHEDULER_ENABLED).toBe(false);
    expect(env.BULL_PREFIX).toBe('bull');
    expect(env.JWT_EXPIRES_IN).toBe('7d');
    expect(env.JWT_REMEMBER_EXPIRES_IN).toBe('30d');
    expect(env.AUTH_COOKIE_NAME).toBe('amazon_asin_monitor_auth');
    expect(env.AUTH_HINT_COOKIE_NAME).toBe('amazon_asin_monitor_session');
    expect(env.AUTH_PERMISSION_CACHE_TTL_SECONDS).toBe(900);
    expect(env.HEALTH_PROBE_TIMEOUT_MS).toBe(2_000);
    expect(env.DATABASE_POOL_CONNECTION_TIMEOUT_MS).toBe(2_000);
    expect(env.HEALTH_DB_POOL_DEGRADED_THRESHOLD).toBe(0.9);
    expect(env.HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD).toBe(0.9);
    expect(env.HEALTH_MEMORY_RSS_DEGRADED_MB).toBe(0);
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
      expect(paths).toContain('AUTH_DATA_AUTHORITY');
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

  it('鉴权配置拒绝非法 Cookie 名称、JWT 有效期与生产弱密钥', () => {
    expect(() =>
      loadEnv({ ...validEnv, AUTH_COOKIE_NAME: 'bad cookie' }),
    ).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...validEnv, JWT_EXPIRES_IN: 'next-week' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...validEnv, NODE_ENV: 'production' })).toThrow(
      '生产环境 JWT_SECRET 至少需要 32 个字符',
    );
    expect(
      loadEnv({
        ...validEnv,
        NODE_ENV: 'production',
        JWT_SECRET: 'a-secure-production-secret-with-32-chars',
      }).NODE_ENV,
    ).toBe('production');
    expect(() =>
      loadEnv({
        ...validEnv,
        NODE_ENV: 'production',
        JWT_SECRET: 'replace_with_a_long_random_secret',
      }),
    ).toThrow('生产环境 JWT_SECRET 不得使用公开模板值');
  });

  it('JWT_SECRET 校验不改变与 legacy 共享的密钥字节', () => {
    const secret = '  legacy-shared-secret\n';
    expect(loadEnv({ ...validEnv, JWT_SECRET: secret }).JWT_SECRET).toBe(
      secret,
    );
    expect(() => loadEnv({ ...validEnv, JWT_SECRET: ' \t\n ' })).toThrow(
      '缺少 JWT_SECRET',
    );
  });

  it('无单位 legacy JWT 有效期按秒规范化', () => {
    const normalized = loadEnv({
      ...validEnv,
      JWT_EXPIRES_IN: '3600',
      JWT_REMEMBER_EXPIRES_IN: '2592000',
    });
    expect(normalized.JWT_EXPIRES_IN).toBe('3600s');
    expect(normalized.JWT_REMEMBER_EXPIRES_IN).toBe('2592000s');
  });

  it('双跑期 Session 权威源要求完整 Legacy MySQL 连接配置', () => {
    expect(() =>
      loadEnv({ ...validEnv, AUTH_DATA_AUTHORITY: 'legacy-mysql' }),
    ).toThrow('AUTH_DATA_AUTHORITY=legacy-mysql 时缺少 DB_HOST');

    const legacy = loadEnv({
      ...validEnv,
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: '127.0.0.1',
      DB_PORT: '3306',
      DB_USER: 'root',
      DB_PASSWORD: '',
      DB_NAME: 'amazon_asin_monitor',
    });
    expect(legacy.AUTH_DATA_AUTHORITY).toBe('legacy-mysql');
    expect(legacy.DB_PASSWORD).toBe('');
    expect(() =>
      loadEnv({
        ...validEnv,
        NODE_ENV: 'production',
        JWT_SECRET: 'a-secure-production-secret-with-32-chars',
        AUTH_DATA_AUTHORITY: 'legacy-mysql',
        DB_HOST: '127.0.0.1',
        DB_USER: 'root',
        DB_PASSWORD: '',
        DB_NAME: 'amazon_asin_monitor',
      }),
    ).toThrow('AUTH_DATA_AUTHORITY=legacy-mysql 时缺少 DB_PASSWORD');
  });

  it('健康阈值兼容比例和百分数写法，并约束探针超时', () => {
    const env = loadEnv({
      ...validEnv,
      HEALTH_PROBE_TIMEOUT_MS: '750',
      DATABASE_POOL_CONNECTION_TIMEOUT_MS: '750',
      HEALTH_DB_POOL_DEGRADED_THRESHOLD: '85',
      HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD: '0.8',
      HEALTH_MEMORY_RSS_DEGRADED_MB: '1024',
    });
    expect(env.HEALTH_PROBE_TIMEOUT_MS).toBe(750);
    expect(env.DATABASE_POOL_CONNECTION_TIMEOUT_MS).toBe(750);
    expect(env.HEALTH_DB_POOL_DEGRADED_THRESHOLD).toBe(0.85);
    expect(env.HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD).toBe(0.8);
    expect(env.HEALTH_MEMORY_RSS_DEGRADED_MB).toBe(1024);
    expect(() =>
      loadEnv({ ...validEnv, HEALTH_PROBE_TIMEOUT_MS: '0' }),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv({
        ...validEnv,
        HEALTH_PROBE_TIMEOUT_MS: '750',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: '751',
      }),
    ).toThrow('共享数据库池连接超时不得大于健康探针总超时');
  });

  it('空白健康阈值沿用默认值以兼容 legacy 可选环境变量', () => {
    const env = loadEnv({
      ...validEnv,
      HEALTH_DB_POOL_DEGRADED_THRESHOLD: '',
      HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD: '   ',
    });

    expect(env.HEALTH_DB_POOL_DEGRADED_THRESHOLD).toBe(0.9);
    expect(env.HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD).toBe(0.9);
  });

  it('拒绝凭据、协议别名和默认端口不同但目标相同的双 PostgreSQL URL', () => {
    expect(() =>
      loadEnv({
        ...validEnv,
        DATABASE_URL:
          'postgres://primary:one@localhost/amazon_asin_monitor?sslmode=verify-full',
        COMPETITOR_DATABASE_URL:
          'postgresql://competitor:two@LOCALHOST:5432/amazon_asin_monitor',
      }),
    ).toThrow('主库与竞品库必须指向不同的 PostgreSQL database');
  });

  it('按 node-postgres 优先级比较 query-string 覆盖的 host 与 port', () => {
    expect(() =>
      loadEnv({
        ...validEnv,
        DATABASE_URL:
          'postgres://primary-alias:6543/amazon_asin_monitor?host=db.internal&port=5433',
        COMPETITOR_DATABASE_URL:
          'postgres://db.internal:5433/amazon_asin_monitor',
      }),
    ).toThrow('主库与竞品库必须指向不同的 PostgreSQL database');
  });

  it('按 node-postgres 实际解析结果使用 pathname database', () => {
    const env = loadEnv({
      ...validEnv,
      DATABASE_URL:
        'postgres://db.internal/amazon_asin_monitor?database=shared',
      COMPETITOR_DATABASE_URL:
        'postgres://db.internal/amazon_competitor_monitor?database=shared',
    });

    expect(env.DATABASE_URL).toContain('/amazon_asin_monitor');
    expect(env.COMPETITOR_DATABASE_URL).toContain('/amazon_competitor_monitor');
  });

  it('BULL_PREFIX 保留 legacy 命名空间并将空白回退 bull', () => {
    expect(loadEnv({ ...validEnv, BULL_PREFIX: ' staging ' }).BULL_PREFIX).toBe(
      'staging',
    );
    expect(loadEnv({ ...validEnv, BULL_PREFIX: '  ' }).BULL_PREFIX).toBe(
      'bull',
    );
  });

  it('按 node-postgres 默认链归一省略的 host、port 与 database', () => {
    expect(() =>
      loadEnv({
        ...validEnv,
        DATABASE_URL: 'postgres:///shared',
        COMPETITOR_DATABASE_URL: 'postgres://localhost:5432/shared',
      }),
    ).toThrow('主库与竞品库必须指向不同的 PostgreSQL database');

    expect(() =>
      loadEnv({
        ...validEnv,
        PGHOST: 'db.internal',
        PGPORT: '6543',
        PGDATABASE: 'shared',
        DATABASE_URL: 'postgres:///',
        COMPETITOR_DATABASE_URL: 'postgres://db.internal:6543/shared',
      }),
    ).toThrow('主库与竞品库必须指向不同的 PostgreSQL database');

    expect(() =>
      loadEnv({
        ...validEnv,
        DATABASE_URL: 'postgres://app_user@db.internal',
        COMPETITOR_DATABASE_URL: 'postgres://db.internal/app_user',
      }),
    ).toThrow('主库与竞品库必须指向不同的 PostgreSQL database');
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
    expect(env.CORS_ORIGIN).toBe('http://localhost:8000');
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
