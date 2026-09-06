import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, HttpClient, shouldRetryQuery, transportURL } from './http';
import { deferred, jsonResponse, sessionFixture } from './transport-fixtures';

const clients: HttpClient[] = [];
function setup(baseURL = '/api') {
  const session = sessionFixture();
  const fetcher = vi.fn<typeof fetch>(async () =>
    jsonResponse({ success: true, data: { ok: true }, errorCode: 0 }),
  );
  const unauthorized = vi.fn();
  const client = new HttpClient({
    pageOrigin: 'https://app.test',
    baseURL,
    session: session.store,
    fetch: fetcher,
    onUnauthorized: unauthorized,
  });
  clients.push(client);
  return { ...session, client, fetcher, unauthorized };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
});
describe('fetch and download transport boundary', () => {
  it('shares request/download normalization and merges existing query before fragments', async () => {
    const f = setup('https://api.test/gateway/api/v1/');
    const expected =
      'https://api.test/gateway/api/v1/tasks/one/download?old=1&new=2#file';
    const path = '/api/api/v1/tasks/one/download?old=1#file';
    expect(f.client.url(path, { new: 2, ignored: null })).toBe(expected);
    await f.client.request(path, { query: { new: 2 } });
    expect(f.fetcher.mock.calls[0][0]).toBe(expected);
    expect(expected).not.toContain('/api/api');
  });
  it.each([
    '/../outside',
    '/%2e%2e/outside',
    '/%252e%252e/outside',
    '/x%2fy',
    '/x%5cy',
    '/x\\y',
    '//foreign.test/api',
    'https://foreign.test/api',
    '/bad/%ZZ',
  ])(
    'rejects escaping or malformed endpoint %s before sending credentials',
    async (path) => {
      const f = setup();
      f.local.set('token', 'fixture-private');
      await expect(f.client.request(path)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    'javascript:alert(1)',
    'https://user:password@api.test/api',
    '/api?destination=wrong',
    '/api#x',
    'http://api.test/api',
  ])('rejects unsafe/mixed-content config %s', (base) => {
    expect(() =>
      transportURL(base, '/v1/health', 'https://app.test'),
    ).toThrow();
  });
  it('uses include credentials and error redirects, with legacy Bearer only when present', async () => {
    const f = setup();
    f.local.set('token', 'fixture-legacy');
    await f.client.request('/v1/health');
    const options = f.fetcher.mock.calls[0][1]!;
    expect(options.credentials).toBe('include');
    expect(options.redirect).toBe('error');
    expect(new Headers(options.headers).get('authorization')).toBe(
      'Bearer fixture-legacy',
    );
    f.store.markAuthenticated(false);
    await f.client.request('/v1/health');
    expect(
      new Headers(f.fetcher.mock.calls[1][1]?.headers).has('authorization'),
    ).toBe(false);
  });
  it('sends JSON and FormData without inventing a multipart boundary', async () => {
    const f = setup();
    await f.client.request('/v1/example', { method: 'POST', json: { one: 1 } });
    expect(f.fetcher.mock.calls[0][1]?.body).toBe('{"one":1}');
    expect(
      new Headers(f.fetcher.mock.calls[0][1]?.headers).get('content-type'),
    ).toBe('application/json');
    const form = new FormData();
    form.set('file', 'fixture');
    await f.client.request('/v1/import', { method: 'POST', body: form });
    expect(f.fetcher.mock.calls[1][1]?.body).toBe(form);
    expect(
      new Headers(f.fetcher.mock.calls[1][1]?.headers).has('content-type'),
    ).toBe(false);
  });
  it('preserves the response envelope and rejects business failures without payload dumps', async () => {
    const f = setup();
    await expect(f.client.request('/v1/example')).resolves.toEqual({
      success: true,
      data: { ok: true },
      errorCode: 0,
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        errorMessage: '名称已存在',
        errorCode: 409,
        data: { private: 'fixture-secret' },
      }),
    );
    const error = await f.client
      .request('/v1/example')
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      kind: 'BUSINESS',
      message: '名称已存在',
      errorCode: 409,
    });
    expect(JSON.stringify(error)).not.toContain('fixture-secret');
  });
  it.each([401, 200])(
    'notifies expiry for HTTP/envelope 401 (HTTP %s)',
    async (status) => {
      const f = setup();
      f.fetcher.mockResolvedValueOnce(
        jsonResponse({ success: false, errorCode: 401 }, status),
      );
      await expect(
        f.client.request('/v1/auth/current-user'),
      ).rejects.toMatchObject({ kind: 'AUTH', errorCode: 401 });
      expect(f.unauthorized).toHaveBeenCalledTimes(1);
    },
  );
  it('does not treat a normal permission 403 or a failed login as global expiry', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: false, errorCode: 403 }, 403),
    );
    await expect(f.client.request('/v1/roles')).rejects.toMatchObject({
      kind: 'HTTP',
      status: 403,
    });
    f.fetcher.mockResolvedValueOnce(jsonResponse({ errorCode: 401 }, 401));
    await expect(
      f.client.request('/v1/auth/login', { authFailure: 'ignore' }),
    ).rejects.toMatchObject({ kind: 'AUTH' });
    expect(f.unauthorized).not.toHaveBeenCalled();
  });
  it('ignores expiry from an old session after a new login changes the revision', async () => {
    const f = setup();
    const gate = deferred<Response>();
    f.fetcher.mockReturnValueOnce(gate.promise);
    const outcome = f.client
      .request('/v1/example')
      .catch((value: unknown) => value);
    f.store.markAuthenticated();
    gate.resolve(jsonResponse({ errorCode: 401 }, 401));
    expect(await outcome).toMatchObject({ kind: 'AUTH' });
    expect(f.unauthorized).not.toHaveBeenCalled();
  });
  it('rejects invalid JSON, null payloads and contract mismatch', async () => {
    const f = setup();
    for (const response of [
      new Response('<html>invalid</html>'),
      jsonResponse(null),
      jsonResponse([]),
    ]) {
      f.fetcher.mockResolvedValueOnce(response);
      await expect(f.client.request('/v1/example')).rejects.toMatchObject({
        kind: 'INVALID_RESPONSE',
      });
    }
    await expect(
      f.client.request(
        '/v1/example',
        {},
        {
          parse: () => {
            throw new Error('bad shape');
          },
        },
      ),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('bounds JSON response memory and cancels oversized body readers', async () => {
    const f = setup();
    const cancel = vi.fn();
    f.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          },
          cancel,
        }),
      ),
    );
    await expect(f.client.request('/v1/example')).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('aborts native/injected I/O and retains capacity if a dependency ignores the signal', async () => {
    vi.useFakeTimers();
    const f = setup();
    const gate = deferred<void>();
    f.fetcher.mockImplementation(async () => {
      await gate.promise;
      return jsonResponse({ success: true });
    });
    const outcomes = Array.from({ length: 64 }, () =>
      f.client
        .request('/v1/example', { timeoutMs: 10 })
        .catch((value: unknown) => value),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(
      (await Promise.all(outcomes)).every(
        (value) => value instanceof ApiError && value.kind === 'TIMEOUT',
      ),
    ).toBe(true);
    expect(
      f.fetcher.mock.calls.every(([, options]) => options?.signal?.aborted),
    ).toBe(true);
    await expect(f.client.request('/v1/example')).rejects.toMatchObject({
      kind: 'CAPACITY',
    });
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.client.request('/v1/example')).resolves.toMatchObject({
      success: true,
    });
  });
  it('does not make a request for an already aborted signal and never retries on its own', async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.client.request('/v1/example', { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'CANCELLED' });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockRejectedValueOnce(new Error('private URL or header'));
    await expect(f.client.request('/v1/example')).rejects.toMatchObject({
      kind: 'NETWORK',
      message: '网络请求失败',
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.client.close();
    await expect(f.client.request('/v1/example')).rejects.toMatchObject({
      kind: 'CLOSED',
    });
  });
  it('only retries a Query once for network/deadline/5xx and never business/auth errors', () => {
    for (const kind of ['NETWORK', 'TIMEOUT'] as const)
      expect(shouldRetryQuery(0, new ApiError(kind, 'fixture'))).toBe(true);
    expect(shouldRetryQuery(0, new ApiError('HTTP', 'fixture', 503))).toBe(
      true,
    );
    for (const error of [
      new ApiError('AUTH', 'fixture', 401),
      new ApiError('BUSINESS', 'fixture'),
      new ApiError('HTTP', 'fixture', 403),
      new Error(),
    ])
      expect(shouldRetryQuery(0, error)).toBe(false);
    expect(shouldRetryQuery(1, new ApiError('NETWORK', 'fixture'))).toBe(false);
  });
});
