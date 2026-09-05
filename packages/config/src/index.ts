import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { parse as parsePostgresConnectionString } from 'pg-connection-string';
import { z } from 'zod';

/**
 * 共享环境变量校验。
 * 必需/推荐变量对齐旧系统 server/src/config/envValidator.js；
 * 新增 PG / Redis / 调度相关变量按目标架构（总体计划 §2）定义。
 */

const healthRatioSchema = z
  .preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.coerce.number().positive().max(100).default(0.9),
  )
  .transform((value) => (value >= 1 ? value / 100 : value));

const optionalNonEmptyStringSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);

// Legacy getWorkerConcurrency: invalid/nonpositive values fall back to one,
// positive fractions are floored (with a minimum of one).
const queueConcurrencySchema = z.preprocess((value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.floor(number))
    : 1;
}, z.number().int().positive());

const queueLimiterSchema = (fallback: number) =>
  z.preprocess(
    (value) => Number(value) || fallback,
    z.number().int().positive(),
  );

const cookieNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'Cookie 名称包含非法字符');

const jwtDurationSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:ms|s|m|h|d|w|y)?$/i, 'JWT 有效期格式无效')
  .transform((value) =>
    /^\d+$/.test(value) ? `${value}s` : value.toLowerCase(),
  );

const templateJwtSecret = 'replace_with_a_long_random_secret';

interface PostgresTargetDefaults {
  database?: string;
  host?: string;
  port?: number;
  user?: string;
}

function postgresTargetIdentity(
  value: string,
  defaults: PostgresTargetDefaults,
): string | undefined {
  try {
    const connectionString = value.trim();
    const parsedUrl = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
      return undefined;
    }
    const parsed = parsePostgresConnectionString(connectionString);
    const databaseName =
      parsed.database || defaults.database || parsed.user || defaults.user;
    if (!databaseName) return undefined;
    const effectiveHost = parsed.host || defaults.host || 'localhost';
    const host = effectiveHost
      ? effectiveHost.startsWith('/')
        ? `socket:${effectiveHost}`
        : effectiveHost.toLowerCase()
      : '<default>';
    const port = parsed.port || String(defaults.port ?? 5432);
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      return undefined;
    }
    return `${host}\u0000${port}\u0000${databaseName}`;
  } catch {
    return undefined;
  }
}

const envObjectSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  LOG_LEVEL: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']))
    .default('INFO'),
  PORT: z.coerce.number().int().positive().default(3100),
  CORS_ORIGIN: z
    .string()
    .trim()
    .min(1, 'CORS_ORIGIN 不能为空')
    .default('http://localhost:8000'),

  // PostgreSQL（主库，平移旧 MySQL amazon_asin_monitor）
  DATABASE_URL: z.string().min(1, '缺少 DATABASE_URL'),
  // PostgreSQL（竞品库，平移旧 MySQL amazon_competitor_monitor，决策 D6 独立 database）
  COMPETITOR_DATABASE_URL: z.string().min(1, '缺少 COMPETITOR_DATABASE_URL'),
  // node-postgres 在 URL 省略连接参数时读取的标准 libpq 环境变量。
  PGHOST: optionalNonEmptyStringSchema,
  PGPORT: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.coerce.number().int().min(1).max(65_535).optional(),
  ),
  PGDATABASE: optionalNonEmptyStringSchema,
  PGUSER: optionalNonEmptyStringSchema,

  // Redis（队列 / 限流 / 缓存 / PubSub 四角色不变）
  REDIS_URL: z.string().min(1, '缺少 REDIS_URL'),
  BULL_PREFIX: z
    .string()
    .trim()
    .transform((value) => value || 'bull')
    .default('bull'),

  JWT_SECRET: z
    .string()
    .refine((value) => value.trim().length > 0, '缺少 JWT_SECRET'),
  JWT_EXPIRES_IN: jwtDurationSchema.default('7d'),
  JWT_REMEMBER_EXPIRES_IN: jwtDurationSchema.default('30d'),
  AUTH_COOKIE_NAME: cookieNameSchema.default('amazon_asin_monitor_auth'),
  AUTH_HINT_COOKIE_NAME: cookieNameSchema.default(
    'amazon_asin_monitor_session',
  ),
  AUTH_PERMISSION_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400)
    .default(900),
  AUTH_DATA_AUTHORITY: z.enum(['legacy-mysql', 'postgresql']),

  // 双跑期鉴权数据实时权威源使用 Legacy MySQL；最终同步/写冻结后才切 PostgreSQL。
  DB_HOST: optionalNonEmptyStringSchema,
  DB_PORT: z.coerce.number().int().min(1).max(65_535).default(3306),
  DB_USER: optionalNonEmptyStringSchema,
  DB_PASSWORD: z.string().optional(),
  DB_NAME: optionalNonEmptyStringSchema,
  DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(200).default(50),
  DB_CONNECT_TIMEOUT: z.coerce
    .number()
    .int()
    .min(50)
    .max(120_000)
    .default(10_000),
  DB_QUERY_TIMEOUT: z.coerce
    .number()
    .int()
    .min(50)
    .max(3_600_000)
    .default(600_000),

  // Neo 健康探针：比例同时接受 0.9 或 90 两种 Legacy 配置写法。
  HEALTH_PROBE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(30_000)
    .default(2_000),
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(30_000)
    .default(2_000),
  HEALTH_DB_POOL_DEGRADED_THRESHOLD: healthRatioSchema,
  HEALTH_MEMORY_HEAP_LIMIT_DEGRADED_THRESHOLD: healthRatioSchema,
  HEALTH_MEMORY_RSS_DEGRADED_MB: z.coerce.number().nonnegative().default(0),

  // 进程拓扑：api | worker | all；单调度器语义
  PROCESS_ROLE: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(['api', 'worker', 'all']))
    .default('api'),
  SCHEDULER_ENABLED: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(['true', '1', 'yes', 'on', 'false', '0', 'no', 'off']))
    .default('false')
    .transform((value) => !['false', '0', 'no', 'off'].includes(value)),

  // Worker 队列选择语义（对齐旧 WORKER_ENABLED_QUEUES）
  WORKER_ENABLED_QUEUES: z.string().optional(),
  MONITOR_QUEUE_WORKER_CONCURRENCY: queueConcurrencySchema,
  COMPETITOR_QUEUE_WORKER_CONCURRENCY: queueConcurrencySchema,
  EXPORT_QUEUE_WORKER_CONCURRENCY: queueConcurrencySchema,
  BATCH_CHECK_QUEUE_WORKER_CONCURRENCY: queueConcurrencySchema,
  BATCH_DELETE_QUEUE_WORKER_CONCURRENCY: queueConcurrencySchema,
  BACKUP_QUEUE_WORKER_CONCURRENCY: queueConcurrencySchema,
  VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY: queueConcurrencySchema,
  MONITOR_QUEUE_LIMITER_MAX: queueLimiterSchema(1),
  MONITOR_QUEUE_LIMITER_DURATION_MS: queueLimiterSchema(200),
  COMPETITOR_QUEUE_LIMITER_MAX: queueLimiterSchema(1),
  COMPETITOR_QUEUE_LIMITER_DURATION_MS: queueLimiterSchema(200),
});

export const envSchema = envObjectSchema.superRefine((env, context) => {
  if (env.NODE_ENV === 'production' && env.JWT_SECRET.trim().length < 32) {
    context.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: '生产环境 JWT_SECRET 至少需要 32 个字符',
    });
  }
  if (
    env.NODE_ENV === 'production' &&
    env.JWT_SECRET.trim() === templateJwtSecret
  ) {
    context.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: '生产环境 JWT_SECRET 不得使用公开模板值',
    });
  }
  if (env.AUTH_DATA_AUTHORITY === 'legacy-mysql') {
    const requiredLegacyDatabaseFields = [
      ['DB_HOST', env.DB_HOST],
      ['DB_USER', env.DB_USER],
      ['DB_PASSWORD', env.DB_PASSWORD],
      ['DB_NAME', env.DB_NAME],
    ] as const;
    for (const [path, value] of requiredLegacyDatabaseFields) {
      const missing =
        value === undefined ||
        (path === 'DB_PASSWORD' &&
          env.NODE_ENV === 'production' &&
          value.length === 0);
      if (missing) {
        context.addIssue({
          code: 'custom',
          path: [path],
          message: `AUTH_DATA_AUTHORITY=legacy-mysql 时缺少 ${path}`,
        });
      }
    }
  }
  const postgresDefaults = {
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user:
      env.PGUSER ??
      (process.platform === 'win32' ? process.env.USERNAME : process.env.USER),
  };
  const primary = postgresTargetIdentity(env.DATABASE_URL, postgresDefaults);
  const competitor = postgresTargetIdentity(
    env.COMPETITOR_DATABASE_URL,
    postgresDefaults,
  );
  if (primary && competitor && primary === competitor) {
    context.addIssue({
      code: 'custom',
      path: ['COMPETITOR_DATABASE_URL'],
      message: '主库与竞品库必须指向不同的 PostgreSQL database',
    });
  }
  if (env.DATABASE_POOL_CONNECTION_TIMEOUT_MS > env.HEALTH_PROBE_TIMEOUT_MS) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_POOL_CONNECTION_TIMEOUT_MS'],
      message: '共享数据库池连接超时不得大于健康探针总超时',
    });
  }
});

export type Env = z.infer<typeof envSchema>;
export type EnvInput = z.input<typeof envSchema>;

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/** 对齐旧队列 buildRedisUrl：优先 URL/URI，否则由分项变量组装。 */
export function resolveRedisUrl(
  source: Record<string, string | undefined>,
): string | undefined {
  const explicit = nonEmpty(source.REDIS_URL) ?? nonEmpty(source.REDIS_URI);
  if (explicit) return explicit;

  const hostValue = nonEmpty(source.REDIS_HOST);
  if (!hostValue) return undefined;
  const host =
    hostValue.includes(':') && !hostValue.startsWith('[')
      ? `[${hostValue}]`
      : hostValue;
  const port = nonEmpty(source.REDIS_PORT) ?? '6379';
  const username = nonEmpty(source.REDIS_USERNAME);
  const password = nonEmpty(source.REDIS_PASSWORD);
  const database = nonEmpty(source.REDIS_DB) ?? '0';

  let authority = '';
  if (username && password) {
    authority = `${encodeURIComponent(username)}:${encodeURIComponent(
      password,
    )}@`;
  } else if (password) {
    authority = `:${encodeURIComponent(password)}@`;
  }

  return `redis://${authority}${host}:${port}${
    database === '0' ? '' : `/${database}`
  }`;
}

function findWorkspaceRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function getDefaultEnvironmentFiles(cwd = process.cwd()): string[] {
  const workspaceRoot = findWorkspaceRoot(cwd);
  if (workspaceRoot) {
    return [join(workspaceRoot, '.env.neo'), join(workspaceRoot, '.env')];
  }
  return [join(cwd, '.env.neo'), join(cwd, '.env')];
}

/** Neo 专用配置优先，根前端配置作为补充；已有进程环境变量始终优先。 */
export function loadEnvironmentFiles(
  paths: string[] = getDefaultEnvironmentFiles(),
  target: Record<string, string> = process.env as Record<string, string>,
): void {
  for (const path of [...new Set(paths)]) {
    loadDotenv({ path, override: false, quiet: true, processEnv: target });
  }
}

/** 旧系统 envValidator 的必需变量组，供迁移期对照 */
export const LEGACY_REQUIRED_ENV_VARS = [
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_SECRET',
] as const;

/** 旧系统 envValidator 的推荐变量组，供迁移期对照 */
export const LEGACY_RECOMMENDED_ENV_VARS = [
  'NODE_ENV',
  'LOG_LEVEL',
  'PORT',
  'PROCESS_ROLE',
  'SCHEDULER_ENABLED',
  'VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY',
  'WORKER_ENABLED_QUEUES',
] as const;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(
      `环境变量校验失败: ${issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * 校验并返回类型安全的环境对象。
 * @param source 默认取 process.env，测试可注入
 * @throws {EnvValidationError}
 */
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const result = envSchema.safeParse({
    ...source,
    REDIS_URL: resolveRedisUrl(source),
  });
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }
  return result.data;
}
