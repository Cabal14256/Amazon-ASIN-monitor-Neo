import { Injectable } from '@nestjs/common';

/** 与旧系统 logger.js 相同的敏感字段清单（子串匹配、大小写不敏感） */
const SENSITIVE_FIELDS = [
  'password',
  'pwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'apikey',
  'authorization',
  'auth',
];

type AppLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<AppLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function sanitize(data: unknown): unknown {
  if (data instanceof Error) {
    const errorWithCode = data as Error & { code?: unknown };
    return {
      name: data.name,
      message: data.message,
      ...(errorWithCode.code === undefined ? {} : { code: errorWithCode.code }),
    };
  }
  if (!data || typeof data !== 'object') {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map(sanitize);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_FIELDS.some((f) => lower.includes(f))) {
      out[key] = '***REDACTED***';
    } else if (value && typeof value === 'object') {
      out[key] = sanitize(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** UTC+8 时间戳（对齐旧系统 getUTC8ISOString 语义） */
export function utc8Iso(): string {
  const utc8 = new Date(Date.now() + 8 * 60 * 60_000);
  return utc8.toISOString().replace('Z', '+08:00');
}

@Injectable()
export class AppLogger {
  private readonly threshold: number;

  constructor() {
    const level = (process.env.LOG_LEVEL || 'INFO').toLowerCase();
    this.threshold = LEVEL_WEIGHT[level as AppLogLevel] ?? LEVEL_WEIGHT.info;
  }

  private shouldLog(level: AppLogLevel): boolean {
    return (LEVEL_WEIGHT[level] ?? 99) >= this.threshold;
  }

  private write(
    level: AppLogLevel,
    message: unknown,
    context?: string,
    ...args: unknown[]
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }
    const prefix = `[${utc8Iso()}] [${level.toUpperCase()}]${
      context ? ` [${context}]` : ''
    }`;
    const sanitizedMessage = sanitize(message);
    const sanitized = args.map((a) => sanitize(a));
    const method: AppLogLevel = level;
    // eslint-disable-next-line no-console -- 日志模块是唯一允许的 console 出口
    console[method](prefix, sanitizedMessage, ...sanitized);
  }

  debug(message: unknown, context?: string, ...args: unknown[]): void {
    this.write('debug', message, context, ...args);
  }

  info(message: unknown, context?: string, ...args: unknown[]): void {
    this.write('info', message, context, ...args);
  }

  warn(message: unknown, context?: string, ...args: unknown[]): void {
    this.write('warn', message, context, ...args);
  }

  error(message: unknown, context?: string, ...args: unknown[]): void {
    this.write('error', message, context, ...args);
  }
}

export { sanitize };
