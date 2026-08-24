type WorkerLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<WorkerLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function sanitize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      /(password|token|secret|authorization|cookie)/i.test(key)
        ? '***REDACTED***'
        : sanitize(child),
    ]),
  );
}

function shouldLog(level: WorkerLogLevel): boolean {
  const configured = String(process.env.LOG_LEVEL || 'INFO').toLowerCase();
  const threshold =
    LEVEL_WEIGHT[configured as WorkerLogLevel] ?? LEVEL_WEIGHT.info;
  return LEVEL_WEIGHT[level] >= threshold;
}

function write(
  level: WorkerLogLevel,
  message: unknown,
  context?: unknown,
): void {
  if (!shouldLog(level)) return;
  const method = level === 'debug' ? 'debug' : level;
  // eslint-disable-next-line no-console -- logger 是 worker 唯一的 console 出口
  console[method](
    `[${level.toUpperCase()}] [worker]`,
    sanitize(message),
    sanitize(context),
  );
}

export const logger = {
  debug: (message: unknown, context?: unknown) =>
    write('debug', message, context),
  info: (message: unknown, context?: unknown) =>
    write('info', message, context),
  warn: (message: unknown, context?: unknown) =>
    write('warn', message, context),
  error: (message: unknown, context?: unknown) =>
    write('error', message, context),
};

export { sanitize as sanitizeWorkerLog };
