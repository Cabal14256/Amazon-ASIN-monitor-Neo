type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const sensitiveKeyPattern =
  /password|token|secret|authorization|cookie|connection|string|url/i;

function sanitizeMessage(value: string): string {
  return value
    .replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(
      /\b(password|token|secret|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    );
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return { message: sanitizeMessage(value.message) };
  }
  if (typeof value === 'string') return sanitizeMessage(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      sensitiveKeyPattern.test(key) ? '[REDACTED]' : sanitize(entry, seen),
    ]),
  );
}

export interface MigrationLogger {
  debug(event: string, context?: LogContext): void;
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
}

export function createMigrationLogger(
  configuredLevel = process.env.LOG_LEVEL ?? 'INFO',
): MigrationLogger {
  const normalized = configuredLevel.toLowerCase() as LogLevel;
  const threshold = levelOrder[normalized] ?? levelOrder.info;

  const write = (level: LogLevel, event: string, context: LogContext = {}) => {
    if (levelOrder[level] < threshold) return;
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      context: sanitize(context),
    })}\n`;
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(line);
  };

  return {
    debug: (event, context) => write('debug', event, context),
    info: (event, context) => write('info', event, context),
    warn: (event, context) => write('warn', event, context),
    error: (event, context) => write('error', event, context),
  };
}

export { sanitizeMessage as sanitizeMigrationErrorMessage };
