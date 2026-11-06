import http, {
  createServer,
  type RequestListener,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeHttpTransport } from '../src/transport';
import { createWorkSettlement } from '../src/work-settlement';
import { deferred } from './fixtures';

let server: Server;
let origin: string;
let handler: RequestListener;
const transports: NodeHttpTransport[] = [];
beforeEach(async () => {
  handler = (_req, res) => res.end('{"ok":true}');
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const transport of transports.splice(0)) transport.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
const setup = (
  options: ConstructorParameters<typeof NodeHttpTransport>[0] = {},
) => {
  const transport = new NodeHttpTransport({ allowLocalHttp: true, ...options });
  transports.push(transport);
  return transport;
};
const input = (signal = new AbortController().signal) => ({
  url: new URL('/fixture', origin),
  method: 'GET',
  headers: {},
  signal,
});

describe('real bounded Node HTTP I/O (loopback fixtures only)', () => {
  it('does not retain physical ownership when native request creation throws synchronously', async () => {
    const transport = setup();
    const stop = new AbortController();
    const settlement = createWorkSettlement(stop.signal);
    vi.spyOn(http, 'request').mockImplementationOnce(() => {
      throw new Error('fixture creation failure');
    });
    await expect(transport.request(input(stop.signal))).rejects.toMatchObject({
      code: 'HTTP_ERROR',
    });
    await settlement.drain();
    await expect(transport.request(input())).resolves.toHaveProperty(
      'body',
      '{"ok":true}',
    );
  });
  it('retains tracked physical ownership until the real ClientRequest close event is delivered', async () => {
    const transport = setup({ maxInFlight: 1 });
    const began = deferred<void>();
    const closed = deferred<void>();
    let deliverClose!: () => void;
    const nativeRequest = http.request.bind(http);
    vi.spyOn(http, 'request').mockImplementationOnce(
      (...args: Parameters<typeof http.request>) => {
        const request = nativeRequest(...args);
        const nativeEmit = request.emit.bind(request);
        vi.spyOn(request, 'emit').mockImplementation(
          (event: string | symbol, ...values: unknown[]) => {
            if (event !== 'close') return nativeEmit(event, ...values);
            deliverClose = () => {
              nativeEmit(event, ...values);
            };
            closed.resolve();
            return true;
          },
        );
        return request;
      },
    );
    handler = (_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      began.resolve();
    };
    const stop = new AbortController();
    const settlement = createWorkSettlement(stop.signal);
    const outcome = transport
      .request(input(stop.signal))
      .catch((error: unknown) => error);
    await began.promise;
    stop.abort();
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    await closed.promise;
    let drained = false;
    const actualDone = settlement.drain().then(() => {
      drained = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(drained).toBe(false);
      await expect(transport.request(input())).rejects.toMatchObject({
        code: 'CAPACITY',
      });
    } finally {
      deliverClose();
      await actualDone;
    }
    expect(drained).toBe(true);
    handler = (_req, res) => res.end('{}');
    await expect(transport.request(input())).resolves.toHaveProperty(
      'body',
      '{}',
    );
  });
  it('returns JSON and safe raw headers and supports pooled requests', async () => {
    const transport = setup();
    handler = (req, res) => {
      res.setHeader('x-fixture-method', req.method!);
      res.end('{"ok":true}');
    };
    for (let i = 0; i < 3; i++) {
      const result = await transport.request(input());
      expect(result.body).toBe('{"ok":true}');
      expect(result.headers['x-fixture-method']).toBe('GET');
    }
  });
  it('does not follow redirects or forward credentials to the Location target', async () => {
    const transport = setup();
    const visits: string[] = [];
    handler = (req, res) => {
      visits.push(req.url!);
      res.writeHead(302, { location: `${origin}/redirect-target` });
      res.end();
    };
    expect((await transport.request(input())).statusCode).toBe(302);
    expect(visits).toEqual(['/fixture']);
  });
  it('rejects non-HTTPS destinations except explicitly opted-in IP loopback fixtures', async () => {
    const transport = setup({ allowLocalHttp: false });
    await expect(transport.request(input())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const local = setup();
    for (const url of [
      'http://example.invalid/',
      'http://localhost/',
      'ftp://127.0.0.1/',
      'https://user:password@example.invalid/',
    ]) {
      await expect(
        local.request({ ...input(), url: new URL(url) }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
  it('preserves BODY_TOO_LARGE even after headers arrive and destroys that request', async () => {
    const transport = setup({ maxResponseBytes: 8 });
    const gone = deferred<void>();
    handler = (_req, res) => {
      res.on('close', () => gone.resolve());
      res.writeHead(200);
      res.flushHeaders();
      res.write('too-many-bytes');
    };
    await expect(transport.request(input())).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    });
    await gone.promise;
    handler = (_req, res) => res.end('{}');
    await expect(transport.request(input())).resolves.toHaveProperty(
      'body',
      '{}',
    );
  });
  it('enforces a hard deadline for a stalled response and actually closes the socket', async () => {
    const transport = setup({ timeoutMs: 200 });
    const gone = deferred<void>();
    handler = (_req, res) => {
      res.on('close', () => gone.resolve());
      res.writeHead(200);
      res.flushHeaders();
      res.write('{');
    };
    await expect(transport.request(input())).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await gone.promise;
  });
  it('cancels an in-progress response with the safe cause, then frees actual capacity', async () => {
    const transport = setup({ maxInFlight: 1 });
    const began = deferred<void>();
    const gone = deferred<void>();
    handler = (_req, res) => {
      res.on('close', () => gone.resolve());
      res.writeHead(200);
      res.flushHeaders();
      began.resolve();
    };
    const controller = new AbortController();
    const outcome = transport
      .request(input(controller.signal))
      .catch((error: unknown) => error);
    await began.promise;
    await expect(transport.request(input())).rejects.toMatchObject({
      code: 'CAPACITY',
    });
    controller.abort(new Error('private cancellation payload'));
    expect(await outcome).toMatchObject({
      code: 'CANCELLED',
      message: 'SP-API CANCELLED',
    });
    await gone.promise;
    handler = (_req, res) => res.end('{}');
    await vi.waitFor(async () =>
      expect((await transport.request(input())).statusCode).toBe(200),
    );
  });
  it('rejects a truncated response without leaking request headers', async () => {
    const transport = setup();
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': '500', connection: 'close' });
      res.end('{}');
    };
    await expect(
      transport.request({
        ...input(),
        headers: { 'x-amz-access-token': 'fixture-private' },
      }),
    ).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      message: 'SP-API HTTP_ERROR',
    });
  });
  it('close aborts current requests and prevents new ones', async () => {
    const transport = setup();
    const began = deferred<void>();
    handler = (_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      began.resolve();
    };
    const outcome = transport.request(input()).catch((error: unknown) => error);
    await began.promise;
    transport.close();
    expect(await outcome).toMatchObject({ code: 'CLOSED' });
    await expect(transport.request(input())).rejects.toMatchObject({
      code: 'CLOSED',
    });
  });
  it('rejects oversized outgoing bodies and invalid constructor limits', async () => {
    const transport = setup();
    await expect(
      transport.request({
        ...input(),
        method: 'POST',
        body: 'x'.repeat(1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    for (const options of [
      { maxInFlight: 0 },
      { timeoutMs: 60001 },
      { maxResponseBytes: Infinity },
    ]) {
      expect(() => new NodeHttpTransport(options)).toThrow('INVALID_CONFIG');
    }
  });
});
