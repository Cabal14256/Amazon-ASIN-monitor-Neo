import { vi } from 'vitest';
import { SpApiClient } from '../src/client';
import type {
  AttemptContext,
  HttpInput,
  HttpResponse,
  QuotaExecutor,
  SpApiConfig,
} from '../src/types';

export const path = '/catalog/2022-04-01/items/B000000001';
export const response = (
  body: unknown = { asin: 'B000000001' },
  statusCode = 200,
  headers: HttpResponse['headers'] = {},
): HttpResponse => ({
  body: JSON.stringify(body),
  statusCode,
  headers,
});
export const tokenResponse = () =>
  response({
    access_token: 'fixture-access-token',
    expires_in: 3600,
    token_type: 'bearer',
  });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function fixture() {
  const credentials = {
    lwaClientId: 'fixture-client',
    lwaClientSecret: 'fixture-secret',
    refreshToken: 'fixture-refresh',
  };
  const config: SpApiConfig = {
    useAwsSignature: false,
    regions: { US: { ...credentials }, EU: { ...credentials } },
  };
  const source = {
    get: vi.fn(async () => config),
    reload: vi.fn(async () => config),
  };
  const transport = {
    request: vi.fn(
      async (input: HttpInput): Promise<HttpResponse> =>
        input.url.hostname === 'api.amazon.com' ? tokenResponse() : response(),
    ),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const execute = vi.fn(
    async (_context: AttemptContext, task: () => Promise<unknown>) => task(),
  );
  const observe = vi.fn<QuotaExecutor['observe']>();
  const quota: QuotaExecutor = {
    execute: <T>(context: AttemptContext, task: () => Promise<T>) =>
      execute(context, task) as Promise<T>,
    observe,
  };
  const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  const now = vi.fn(() => Date.UTC(2026, 8, 5));
  const client = new SpApiClient({
    config: source,
    transport,
    quota,
    logger,
    sleep,
    now,
  });
  return {
    client,
    config,
    source,
    transport,
    logger,
    quota,
    execute,
    observe,
    sleep,
    now,
  };
}
