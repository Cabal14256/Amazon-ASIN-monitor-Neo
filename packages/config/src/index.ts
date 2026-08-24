import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * 共享环境变量校验。
 * 必需/推荐变量对齐旧系统 server/src/config/envValidator.js；
 * 新增 PG / Redis / 调度相关变量按目标架构（总体计划 §2）定义。
 */

export const envSchema = z.object({
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

  // PostgreSQL（主库，平移旧 MySQL amazon_asin_monitor）
  DATABASE_URL: z.string().min(1, '缺少 DATABASE_URL'),
  // PostgreSQL（竞品库，平移旧 MySQL amazon_competitor_monitor，决策 D6 独立 database）
  COMPETITOR_DATABASE_URL: z.string().min(1, '缺少 COMPETITOR_DATABASE_URL'),

  // Redis（队列 / 限流 / 缓存 / PubSub 四角色不变）
  REDIS_URL: z.string().min(1, '缺少 REDIS_URL'),
  BULL_PREFIX: z
    .string()
    .trim()
    .transform((value) => value || 'bull')
    .default('bull'),

  JWT_SECRET: z.string().min(1, '缺少 JWT_SECRET'),

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
  VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
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
    return [join(workspaceRoot, 'server', '.env'), join(workspaceRoot, '.env')];
  }
  return [join(cwd, 'server', '.env'), join(cwd, '.env')];
}

/** server/.env 优先，根 .env 作为补充；已有进程环境变量始终优先。 */
export function loadEnvironmentFiles(
  paths: string[] = getDefaultEnvironmentFiles(),
): void {
  for (const path of [...new Set(paths)]) {
    loadDotenv({ path, override: false, quiet: true });
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
