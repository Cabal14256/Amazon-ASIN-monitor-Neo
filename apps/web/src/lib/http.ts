import { buildApiURL } from './api-url';
import type { SessionStore } from './session';

export type ApiFailure =
  | 'AUTH'
  | 'HTTP'
  | 'BUSINESS'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_RESPONSE'
  | 'INVALID_INPUT'
  | 'CLOSED'
  | 'CAPACITY';
export class ApiError extends Error {
  constructor(
    readonly kind: ApiFailure,
    message: string,
    readonly status?: number,
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export type QueryParams = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: QueryParams;
  json?: unknown;
  body?: FormData;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Login failures are not expired sessions; callers can suppress global logout. */
  authFailure?: 'notify' | 'ignore';
}
export interface ResponseSchema<T> {
  parse(value: unknown): T;
}

/** Same URL builder for ordinary requests and export/task download links. */
export function transportURL(
  base: string | undefined,
  path: string,
  pageOrigin: string,
  params: QueryParams = {},
): URL {
  try {
    const route = path.trim().split(/[?#]/)[0];
    if (
      route.includes('\\') ||
      base?.includes('\\') ||
      [...route].some((char) => char.charCodeAt(0) <= 32)
    )
      throw new Error();
    const page = new URL(pageOrigin);
    const configuredBase = new URL(base || '/api', page);
    if (configuredBase.search || configuredBase.hash) throw new Error();
    const url = new URL(buildApiURL(base, path), page);
    const root = new URL(buildApiURL(base, ''), page);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (page.protocol === 'https:' && url.protocol !== 'https:') ||
      url.origin !== root.origin ||
      !(
        url.pathname === root.pathname ||
        url.pathname.startsWith(`${root.pathname}/`)
      )
    )
      throw new Error();
    // Encoded separators/dot segments must not escape a gateway or download root.
    let decoded = url.pathname;
    for (let i = 0; i < 4; i++) {
      const next = decodeURIComponent(decoded);
      if (
        next.includes('\\') ||
        [...next].some((char) => char.charCodeAt(0) <= 32) ||
        next.split('/').some((part) => part === '.' || part === '..')
      )
        throw new Error();
      if (next === decoded) break;
      if (
        (next.match(/\//g)?.length ?? 0) !== (decoded.match(/\//g)?.length ?? 0)
      )
        throw new Error();
      decoded = next;
    }
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '')
        url.searchParams.set(key, String(value));
    }
    if (url.href.length > 16384) throw new Error();
    return url;
  } catch {
    throw new ApiError('INVALID_INPUT', 'API 请求地址无效');
  }
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let bytes = 0;
  let chunks = 0;
  let text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8 * 1024 * 1024 || ++chunks > 10000)
        throw new ApiError(
          'INVALID_RESPONSE',
          '服务器响应过大',
          response.status,
        );
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      /* The native fetch signal also owns cancellation. */
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class HttpClient {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly options: {
      baseURL?: string;
      pageOrigin: string;
      session: SessionStore;
      fetch?: typeof fetch;
      onUnauthorized?: () => void;
    },
  ) {}
  url(path: string, query?: QueryParams): string {
    return transportURL(
      this.options.baseURL,
      path,
      this.options.pageOrigin,
      query,
    ).href;
  }
  async request<T = unknown>(
    path: string,
    options: RequestOptions = {},
    schema?: ResponseSchema<T>,
  ): Promise<T> {
    if (this.closed) throw new ApiError('CLOSED', '请求客户端已关闭');
    if (this.active.size >= 64)
      throw new ApiError('CAPACITY', '请求过多，请稍后重试');
    const url = this.url(path, options.query);
    const timeout = options.timeoutMs ?? 30000;
    if (
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 300000 ||
      (options.json !== undefined && options.body !== undefined)
    )
      throw new ApiError('INVALID_INPUT', '请求参数无效');
    const method = options.method ?? 'GET';
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      throw new ApiError('INVALID_INPUT', '请求方法无效');
    let body: BodyInit | undefined = options.body;
    if (options.json !== undefined) {
      try {
        body = JSON.stringify(options.json);
      } catch {
        throw new ApiError('INVALID_INPUT', '请求参数无效');
      }
      if (typeof body !== 'string')
        throw new ApiError('INVALID_INPUT', '请求参数无效');
    }
    if (method === 'GET' && body !== undefined)
      throw new ApiError('INVALID_INPUT', 'GET 请求不能包含请求体');
    const headers = new Headers({ accept: 'application/json' });
    if (options.json !== undefined)
      headers.set('content-type', 'application/json');
    const token = this.options.session.getLegacyToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const controller = new AbortController();
    const abort = () =>
      controller.abort(new ApiError('CANCELLED', '请求已取消'));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new ApiError('TIMEOUT', '请求超时')),
      timeout,
    );
    const revision = this.options.session.revision;
    this.active.add(controller);
    const signal = controller.signal;
    const work = (async () => {
      if (signal.aborted) throw signal.reason;
      const response = await (this.options.fetch ?? fetch)(url, {
        method,
        headers,
        body,
        signal,
        credentials: 'include',
        redirect: 'error',
      });
      if (signal.aborted) throw signal.reason;
      let parsed: unknown;
      try {
        parsed = await readJson(response);
      } catch {
        if (response.status !== 401 && response.status !== 403 && response.ok)
          throw new ApiError(
            'INVALID_RESPONSE',
            '服务器响应格式无效',
            response.status,
          );
      }
      if (signal.aborted) throw signal.reason;
      const envelope =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : undefined;
      const errorCode =
        typeof envelope?.errorCode === 'number'
          ? envelope.errorCode
          : undefined;
      if (response.status === 401 || errorCode === 401) {
        if (
          options.authFailure !== 'ignore' &&
          revision === this.options.session.revision
        ) {
          // This response has finished reading. Global logout can cancel other
          // requests without replacing this AUTH error with its own cancellation.
          this.active.delete(controller);
          try {
            this.options.onUnauthorized?.();
          } catch {
            /* Keep the authentication failure authoritative. */
          }
        }
        throw new ApiError('AUTH', '未认证或认证已过期', response.status, 401);
      }
      const message =
        typeof envelope?.errorMessage === 'string' &&
        envelope.errorMessage.length <= 500
          ? envelope.errorMessage
          : '请求失败';
      if (!response.ok)
        throw new ApiError('HTTP', message, response.status, errorCode);
      if (envelope?.success === false)
        throw new ApiError('BUSINESS', message, response.status, errorCode);
      if (!envelope || Array.isArray(parsed))
        throw new ApiError(
          'INVALID_RESPONSE',
          '服务器响应格式无效',
          response.status,
        );
      try {
        return schema ? schema.parse(parsed) : (parsed as T);
      } catch {
        throw new ApiError(
          'INVALID_RESPONSE',
          '服务器响应契约不匹配',
          response.status,
        );
      }
    })()
      .catch((error: unknown) => {
        if (signal.aborted) throw signal.reason;
        if (error instanceof ApiError) throw error;
        throw new ApiError('NETWORK', '网络请求失败');
      })
      .finally(() => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        this.active.delete(controller);
      });
    // A non-cooperating injected fetch retains its actual-work admission slot.
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(signal.reason);
      if (signal.aborted) cancelled();
      else signal.addEventListener('abort', cancelled, { once: true });
      work
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', cancelled));
    });
  }
  cancelAll(): void {
    for (const controller of this.active)
      controller.abort(new ApiError('CANCELLED', '请求已取消'));
  }
  close(): void {
    this.closed = true;
    this.cancelAll();
  }
}

export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  return (
    failureCount < 1 &&
    error instanceof ApiError &&
    (['NETWORK', 'TIMEOUT'].includes(error.kind) ||
      (error.kind === 'HTTP' && (error.status ?? 0) >= 500))
  );
}
