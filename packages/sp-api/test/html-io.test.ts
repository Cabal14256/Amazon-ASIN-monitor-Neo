import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HtmlVariantClient } from '../src/html-client';
import { NodeHttpTransport } from '../src/transport';
import { deferred } from './fixtures';
import { asin, productPage } from './html-fixtures';

let server: Server, origin: string, handler: RequestListener;
const clients: HtmlVariantClient[] = [],
  transports: NodeHttpTransport[] = [];
beforeEach(async () => {
  handler = (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(productPage());
  };
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  transports.splice(0).forEach((transport) => transport.close());
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
function setup(timeoutMs = 15000) {
  const native = new NodeHttpTransport({
    allowLocalHttp: true,
    maxResponseBytes: 2 * 1024 * 1024,
    maxInFlight: 1,
    timeoutMs,
  });
  transports.push(native);
  const client = new HtmlVariantClient({
    timeoutMs,
    maxActive: 1,
    isEnabled: () => true,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    transport: {
      request: (input) => {
        // Fixture-only adapter: no configurable product origin in production client.
        expect(input.url.toString()).toBe(`https://www.amazon.com/dp/${asin}`);
        return native.request({
          ...input,
          url: new URL(input.url.pathname, origin),
        });
      },
    },
  });
  clients.push(client);
  return client;
}
describe('HTML fallback with real bounded Node HTTP over loopback', () => {
  it('parses real HTML responses over a reusable connection', async () => {
    const client = setup();
    for (let index = 0; index < 3; index++)
      await expect(client.checkVariants(asin, 'US')).resolves.toMatchObject({
        hasVariants: false,
        variantCount: 0,
        details: { asin, source: 'html_scraper' },
      });
  });
  it('does not follow redirects on the actual transport', async () => {
    const visits: string[] = [];
    handler = (req, res) => {
      visits.push(req.url!);
      res.writeHead(302, { location: `${origin}/private-target` });
      res.end();
    };
    await expect(setup().checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      statusCode: 302,
    });
    expect(visits).toEqual([`/dp/${asin}`]);
  });
  it('destroys a response when the actual streamed body exceeds the cap', async () => {
    const gone = deferred<void>();
    handler = (_req, res) => {
      res.on('close', () => gone.resolve());
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('x'.repeat(2 * 1024 * 1024 + 1));
    };
    await expect(setup().checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    });
    await gone.promise;
  });
  it('enforces the total deadline and closes a stalled socket', async () => {
    const gone = deferred<void>();
    handler = (_req, res) => {
      res.on('close', () => gone.resolve());
      res.writeHead(200, { 'content-type': 'text/html' });
      res.flushHeaders();
    };
    await expect(setup(200).checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await gone.promise;
  });
  it('cancels actual I/O and recovers capacity only after the request closes', async () => {
    const began = deferred<void>(),
      gone = deferred<void>();
    handler = (_req, res) => {
      res.on('close', () => gone.resolve());
      res.writeHead(200, { 'content-type': 'text/html' });
      res.flushHeaders();
      began.resolve();
    };
    const client = setup(),
      controller = new AbortController();
    const outcome = client
      .checkVariants(asin, 'US', controller.signal)
      .catch((error) => error);
    await began.promise;
    await expect(client.checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'CAPACITY',
    });
    controller.abort(new Error('fixture-private'));
    expect(await outcome).toMatchObject({
      code: 'CANCELLED',
      message: 'SP-API CANCELLED',
    });
    await gone.promise;
    handler = (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(productPage());
    };
    await vi.waitFor(async () =>
      expect(await client.checkVariants(asin, 'US')).toHaveProperty(
        'hasVariants',
        false,
      ),
    );
  });
  it('rejects incomplete HTML bytes and never returns a partial no-variants result', async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-length': '10000',
        connection: 'close',
      });
      res.end(productPage());
    };
    await expect(setup().checkVariants(asin, 'US')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
    });
  });
});
