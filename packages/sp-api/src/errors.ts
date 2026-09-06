export type FailureCode =
  | 'INVALID_INPUT'
  | 'INVALID_CONFIG'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'BODY_TOO_LARGE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CAPACITY'
  | 'CLOSED'
  | 'DEPENDENCY_ERROR';
export class SpApiError extends Error {
  constructor(
    readonly code: FailureCode,
    readonly statusCode?: number,
    readonly amazonCodes: readonly string[] = [],
    readonly retryAfter?: string,
  ) {
    super(
      `SP-API ${code}${statusCode === undefined ? '' : ` (${statusCode})`}`,
    );
    this.name = 'SpApiError';
  }
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
export function parseJson(value: unknown): unknown {
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
export function amazonCodes(value: unknown): string[] {
  const body = record(parseJson(value));
  const allowed = new Set([
    'NOT_FOUND',
    'QuotaExceeded',
    'TooManyRequests',
    'invalid_client',
    'invalid_grant',
  ]);
  const codes = [
    body?.code,
    body?.error,
    ...(Array.isArray(body?.errors)
      ? body.errors.map((error) => record(error)?.code)
      : []),
  ];
  return codes.filter(
    (code): code is string => typeof code === 'string' && allowed.has(code),
  );
}
export function isCatalogItemNotFoundError(value: unknown): boolean {
  const error = record(value);
  const response = record(error?.response);
  if (
    Number(error?.statusCode ?? response?.statusCode ?? response?.status) !==
    404
  )
    return false;
  if (
    String(error?.code ?? '')
      .trim()
      .toUpperCase() === 'NOT_FOUND'
  )
    return true;
  if (value instanceof SpApiError && value.amazonCodes.includes('NOT_FOUND'))
    return true;
  return [error?.responseData, error?.errorDetails, response?.data].some(
    (payload) => {
      const body = record(parseJson(payload));
      const codes = [
        body?.code,
        ...(Array.isArray(body?.errors)
          ? body.errors.map((item) => record(item)?.code)
          : []),
      ];
      return codes.some(
        (code) =>
          String(code ?? '')
            .trim()
            .toUpperCase() === 'NOT_FOUND',
      );
    },
  );
}
export function retryDelayMs(
  value: string | undefined,
  attempt: number,
  initialDelay: number,
  now: number,
): number {
  let delay =
    value && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value) * 1000
      : value
      ? Date.parse(value) - now
      : NaN;
  if (!Number.isFinite(delay) || delay <= 0)
    delay = Math.min(initialDelay * 2 ** attempt, 30000);
  return Math.min(delay, 120000);
}
export function abortError(signal: AbortSignal): SpApiError {
  return signal.reason instanceof SpApiError
    ? signal.reason
    : new SpApiError('CANCELLED');
}
export function waitFor<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const done = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
