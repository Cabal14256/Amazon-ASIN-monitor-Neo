import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCatalogItemNotFoundError, SpApiError } from '../src/errors';
import {
  HtmlVariantClient,
  type HtmlVariantClientOptions,
} from '../src/html-client';
import type { HttpInput, HttpResponse } from '../src/types';
import { deferred } from './fixtures';
import { asin, htmlResponse, parent, productPage } from './html-fixtures';

const clients: HtmlVariantClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
  vi.useRealTimers();
});
function setup(options: Partial<HtmlVariantClientOptions> = {}) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const transport = {
    request: vi.fn(async (_input: HttpInput) => htmlResponse()),
    close: vi.fn(),
  };
  const isEnabled = vi.fn(() => true);
  const client = new HtmlVariantClient({
    logger,
    transport,
    isEnabled,
    ...options,
  });
  clients.push(client);
  return { client, logger, transport, isEnabled };
}
describe('explicit, bounded HTML fallback lifecycle', () => {
  it('does no construction I/O and defaults to disabled', async () => {
    const { client, transport } = setup({ isEnabled: undefined });
    expect(transport.request).not.toHaveBeenCalled();
    await expect(client.checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    expect(transport.request).not.toHaveBeenCalled();
  });
  it('returns the Legacy result shape and sends only fixed anonymous HTML headers', async () => {
    const { client, transport, logger } = setup();
    transport.request.mockResolvedValue(
      htmlResponse(
        productPage(
          `"parentAsin":"${parent}",variationDisplayData:{"variationASINs":["${asin}","${parent}"]}`,
        ),
      ),
    );
    const result = await client.checkVariants(
      ` ${asin.toLowerCase()} `,
      ' us ',
    );
    expect(result).toEqual({
      hasVariants: true,
      variantCount: 2,
      details: {
        asin,
        parentAsin: parent,
        variantAsins: [asin, parent],
        source: 'html_scraper',
        duration: expect.any(Number),
      },
    });
    expect(result.details.duration).toBeGreaterThanOrEqual(0);
    const request = transport.request.mock.calls[0][0] as unknown as {
      url: URL;
      method: string;
      headers: object;
    };
    expect(request.url.toString()).toBe(`https://www.amazon.com/dp/${asin}`);
    expect(request.method).toBe('GET');
    expect(request.headers).toEqual({
      'User-Agent': 'Amazon-ASIN-monitor-Neo/1.0 (HTML fallback)',
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(asin);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('http');
  });
  it.each([
    ['UK', 'amazon.co.uk', 'en-GB'],
    ['DE', 'amazon.de', 'de-DE'],
    ['FR', 'amazon.fr', 'fr-FR'],
    ['IT', 'amazon.it', 'it-IT'],
    ['ES', 'amazon.es', 'es-ES'],
  ])(
    'uses a fixed country host and language for %s',
    async (country, domain, language) => {
      const { client, transport } = setup();
      transport.request.mockResolvedValue(
        htmlResponse(productPage().replace('amazon.com', domain)),
      );
      await client.checkVariants(asin, country);
      const request = transport.request.mock.calls[0][0] as unknown as {
        url: URL;
        headers: Record<string, string>;
      };
      expect(request.url.hostname).toBe(`www.${domain}`);
      expect(request.headers['Accept-Language']).toContain(language);
    },
  );
  it('rereads the enable flag every time and fails closed on non-boolean or failed reads', async () => {
    const flag = vi
      .fn<NonNullable<HtmlVariantClientOptions['isEnabled']>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce('true' as never)
      .mockRejectedValueOnce(new Error('fixture-private'));
    const { client, transport, logger } = setup({ isEnabled: flag });
    await client.checkVariants(asin, 'US');
    for (const code of ['INVALID_CONFIG', 'INVALID_CONFIG', 'DEPENDENCY_ERROR'])
      await expect(client.checkVariants(asin, 'US')).rejects.toMatchObject({
        code,
      });
    expect(flag).toHaveBeenCalledTimes(4);
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'fixture-private',
    );
  });
  it.each([301, 302, 403, 404, 429, 500])(
    'does not retry or follow HTTP %i, and never classifies HTML as terminal Catalog NOT_FOUND',
    async (status) => {
      const { client, transport } = setup();
      transport.request.mockResolvedValue({
        ...htmlResponse('fixture-private', status),
        headers: { location: 'https://example.invalid/private' },
      });
      const error = await client
        .checkVariants(asin, 'US')
        .catch((error) => error);
      expect(error).toMatchObject({
        code: 'HTTP_ERROR',
        statusCode: status,
        amazonCodes: [],
      });
      expect(isCatalogItemNotFoundError(error)).toBe(false);
      expect(transport.request).toHaveBeenCalledTimes(1);
    },
  );
  it('validates content type, encoding, body and HTTP status even with a supplied transport', async () => {
    const { client, transport } = setup();
    for (const response of [
      { ...htmlResponse(), headers: {} },
      { ...htmlResponse(), headers: { 'content-type': 'application/json' } },
      { ...htmlResponse(), headers: { 'content-type': ['text/html'] } },
      {
        ...htmlResponse(),
        headers: { 'content-type': 'text/html', 'Content-Type': 'text/html' },
      },
      {
        ...htmlResponse(),
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      },
      htmlResponse(''),
      htmlResponse(productPage('Robot Check')),
      htmlResponse(productPage().replaceAll(asin, parent)),
      htmlResponse(productPage(), 0),
    ]) {
      transport.request.mockResolvedValueOnce(response);
      await expect(client.checkVariants(asin, 'US')).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    }
    transport.request.mockResolvedValueOnce(
      htmlResponse('x'.repeat(2 * 1024 * 1024 + 1)),
    );
    await expect(client.checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    });
  });
  it('sanitizes dependency messages, API codes and caller cancellation reasons', async () => {
    const { client, transport, logger } = setup();
    transport.request.mockRejectedValueOnce(
      new Error('private-token-url-html'),
    );
    await expect(client.checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'DEPENDENCY_ERROR',
      message: 'SP-API DEPENDENCY_ERROR',
    });
    const error = new SpApiError('HTTP_ERROR', 404, [
      'NOT_FOUND',
      'private-token',
    ]);
    error.message = 'private-token';
    transport.request.mockRejectedValueOnce(error);
    const result = await client
      .checkVariants(asin, 'US')
      .catch((error) => error);
    expect(result).toMatchObject({
      message: 'SP-API HTTP_ERROR (404)',
      amazonCodes: [],
    });
    expect(isCatalogItemNotFoundError(result)).toBe(false);
    const controller = new AbortController();
    controller.abort(error);
    await expect(
      client.checkVariants(asin, 'US', controller.signal),
    ).rejects.toMatchObject({ message: 'SP-API CANCELLED' });
    expect(JSON.stringify(logger)).not.toContain('private-token');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'private-token',
    );
  });
  it('rejects invalid inputs before reading the flag or starting I/O', async () => {
    const { client, isEnabled, transport } = setup();
    for (const [product, country] of [
      ['../private', 'US'],
      [asin, 'CA'],
    ])
      await expect(
        client.checkVariants(product, country),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      client.checkVariants(asin, 'US', null as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(isEnabled).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  });
  it('retains admission after cancellation until an ignoring transport settles; rejects late results', async () => {
    const began = deferred<void>(),
      pending = deferred<HttpResponse>();
    const request = vi.fn(async () => {
      began.resolve();
      return pending.promise;
    });
    const { client, logger } = setup({ maxActive: 1, transport: { request } });
    const controller = new AbortController();
    const outcome = client
      .checkVariants(asin, 'US', controller.signal)
      .catch((error) => error);
    await began.promise;
    controller.abort(new Error('private-reason'));
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    await expect(client.checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'CAPACITY',
    });
    pending.resolve(htmlResponse());
    await vi.waitFor(async () =>
      expect(await client.checkVariants(asin, 'US')).toHaveProperty(
        'hasVariants',
        false,
      ),
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
  it('includes flag reads in the total deadline and retains their admission until settlement', async () => {
    vi.useFakeTimers();
    const began = deferred<void>(),
      flag = deferred<boolean>();
    const isEnabled = vi.fn(async () => {
      began.resolve();
      return flag.promise;
    });
    const { client, transport } = setup({
      maxActive: 1,
      timeoutMs: 100,
      isEnabled,
    });
    const outcome = client.checkVariants(asin, 'US').catch((error) => error);
    await began.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ code: 'TIMEOUT' });
    await expect(client.checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'CAPACITY',
    });
    flag.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.request).not.toHaveBeenCalled();
    await expect(client.checkVariants(asin, 'US')).resolves.toHaveProperty(
      'hasVariants',
      false,
    );
  });
  it('aborts ongoing work on close and leaves a supplied transport under caller ownership', async () => {
    const began = deferred<void>(),
      pending = deferred<HttpResponse>();
    const close = vi.fn();
    let aborted = false;
    const { client, logger } = setup({
      transport: {
        request: async (input: HttpInput) => {
          input.signal.addEventListener('abort', () => {
            aborted = true;
          });
          began.resolve();
          return pending.promise;
        },
        close,
      } as never,
    });
    const outcome = client.checkVariants(asin, 'US').catch((error) => error);
    await began.promise;
    client.close();
    client.close();
    expect(await outcome).toMatchObject({ code: 'CLOSED' });
    expect(aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    await expect(client.checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'CLOSED',
    });
    pending.reject(new Error('private-late-rejection'));
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.info).not.toHaveBeenCalled();
  });
  it.each([
    { maxActive: 0 },
    { maxActive: 9 },
    { maxActive: 1.5 },
    { timeoutMs: 0 },
    { timeoutMs: 15001 },
    { timeoutMs: NaN },
    { logger: null },
    { isEnabled: true },
    { transport: {} },
  ])('rejects invalid options %j', (options) => {
    expect(() => setup(options as never)).toThrow('INVALID_CONFIG');
  });
});
