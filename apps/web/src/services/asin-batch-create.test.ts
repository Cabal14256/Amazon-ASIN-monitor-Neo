import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { batchCreateAsins } from './asin-batch-create';

const items = ['B000000001', 'B000000002'].map((asin) => ({
  asin,
  country: 'US',
  site: 'amazon.com',
  brand: 'Example',
  parentId: 'Imported Group 中文 ID',
  name: null,
  asinType: '1' as const,
}));
function result(success: boolean[]) {
  const results = success.map((ok, index) => ({
    index,
    asin: items[index].asin,
    country: items[index].country,
    success: ok,
    ...(ok ? { id: `created-${index}` } : { message: '该国家的 ASIN 已存在' }),
  }));
  return {
    total: results.length,
    successCount: success.filter(Boolean).length,
    failedCount: success.filter((ok) => !ok).length,
    results,
    errors: results.filter((row) => !row.success),
  };
}
const clients: HttpClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((http) => http.close());
  vi.useRealTimers();
});
function client(fetcher: typeof fetch, baseURL = '/api/') {
  const http = new HttpClient({
    baseURL,
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  clients.push(http);
  return http;
}

describe('primary batch-create transport with the real HttpClient', () => {
  it.each(['/api/', 'https://app.test/api/', 'https://app.test/gateway/api/'])(
    'normalizes request/export URLs and preserves original group ID at %s',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse({
          success: true,
          errorCode: 0,
          data: result([true, false]),
        }),
      );
      const http = client(fetcher, baseURL);
      expect(await batchCreateAsins(http, { items })).toEqual(
        result([true, false]),
      );
      const [url, options] = fetcher.mock.calls[0];
      expect(new URL(String(url)).pathname).toBe(
        `${
          baseURL.includes('/gateway/') ? '/gateway' : ''
        }/api/v1/asins/batch-create`,
      );
      expect(String(url)).not.toContain('/api/api/');
      expect(http.url('/api/v1/export/asin')).not.toContain('/api/api/');
      expect(options?.method).toBe('POST');
      expect(JSON.parse(String(options?.body))).toEqual({ items });
    },
  );

  it.each([
    { outcomes: [true, true] },
    { outcomes: [false, false] },
    { outcomes: [true, false] },
  ])(
    'returns authoritative row outcomes %j without turning partial success into failure',
    async ({ outcomes }) => {
      const data = result(outcomes);
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse({
          success: true,
          data: { ...data, results: [...data.results].reverse() },
        }),
      );
      expect(await batchCreateAsins(client(fetcher), { items })).toEqual(data);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { items: [] },
    { items: [{ ...items[0], asin: 'bad' }] },
    { items: [{ ...items[0], country: 'us' }] },
    { items: [{ ...items[0], site: '' }] },
    { items: [{ ...items[0], brand: '' }] },
    { items: [{ ...items[0], parentId: '' }] },
    { items: [{ ...items[0], name: '\0invalid' }] },
    { items: Array.from({ length: 1001 }, () => items[0]) },
  ])('rejects invalid form data before sending', async (input) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      batchCreateAsins(client(fetcher), input),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { ...result([true, false]), total: 3 },
    { ...result([true, false]), successCount: 2, failedCount: 0, errors: [] },
    { ...result([true, false]), errors: [] },
    {
      ...result([true, false]),
      errors: [{ index: 0, message: '该国家的 ASIN 已存在' }],
    },
    { ...result([true, false]), errors: [{ message: '该国家的 ASIN 已存在' }] },
    {
      ...result([false, false]),
      errors: [
        result([false, false]).errors[0],
        result([false, false]).errors[0],
      ],
    },
    { ...result([true, false]), results: [result([true, false]).results[0]] },
    {
      ...result([true, false]),
      results: [
        result([true, false]).results[0],
        result([true, false]).results[0],
      ],
    },
    {
      ...result([true, false]),
      results: [
        { ...result([true, false]).results[0], asin: 'B000000099' },
        result([true, false]).results[1],
      ],
    },
    {
      ...result([true, false]),
      results: [
        result([true, false]).results[0],
        { ...result([true, false]).results[1], message: '' },
      ],
    },
  ])(
    'treats unaccounted/mismatched responses as unknown, sending only once',
    async (data) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse({ success: true, data }),
      );
      await expect(
        batchCreateAsins(client(fetcher), { items }),
      ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 503])(
    'preserves authoritative HTTP %i without retry',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { success: false, errorCode: status, errorMessage: '请求未获受理' },
          status,
        ),
      );
      await expect(
        batchCreateAsins(client(fetcher), { items }),
      ).rejects.toMatchObject({ status });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves network uncertainty without automatically resubmitting', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Connection lost');
    });
    await expect(
      batchCreateAsins(client(fetcher), { items }),
    ).rejects.toMatchObject({ kind: 'NETWORK' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the bounded mutation timeout and never retries the timed-out POST', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const submission = batchCreateAsins(client(fetcher), { items });
    const rejected = expect(submission).rejects.toMatchObject({
      kind: 'TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
