import type { LoggerService } from '@nestjs/common';

import { AppLogger } from './app-logger.service';

type AppLoggerMethod = 'debug' | 'info' | 'warn' | 'error';

function looksLikeStack(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith('Error:') || /\n\s*at\s/.test(value))
  );
}

function forward(
  logger: AppLogger,
  method: AppLoggerMethod,
  message: unknown,
  optionalParams: unknown[],
  errorLevel = false,
): void {
  const args = [...optionalParams];
  const last = args.at(-1);
  const hasContext =
    typeof last === 'string' &&
    (!errorLevel || args.length > 1 || !looksLikeStack(last));
  const context = hasContext ? (args.pop() as string) : undefined;
  logger[method](message, context, ...args);
}

/** 将 Nest 的 (...optionalParams, context) 约定完整转交给脱敏 AppLogger。 */
export function createNestLoggerAdapter(logger: AppLogger): LoggerService {
  return {
    log: (message, ...params) => forward(logger, 'info', message, params),
    error: (message, ...params) =>
      forward(logger, 'error', message, params, true),
    warn: (message, ...params) => forward(logger, 'warn', message, params),
    debug: (message, ...params) => forward(logger, 'debug', message, params),
    verbose: (message, ...params) => forward(logger, 'debug', message, params),
    fatal: (message, ...params) =>
      forward(logger, 'error', message, params, true),
  };
}
