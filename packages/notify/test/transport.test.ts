import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFeishuCard } from '../src/cards';
import { FeishuNotifications } from '../src/service';
import { NodeFeishuTransport } from '../src/transport';

describe('Feishu HTTP transport / real isolated loopback', () => {
  let server: http.Server, transport: NodeFeishuTransport, url: string;
  let handler: (request: IncomingMessage, response: ServerResponse) => void;
  const sockets = new Set<Socket>();
  const card = buildFeishuCard({ country: 'US', checkTime: 'fixture-time' });
  beforeEach(async () => {
    handler = (_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"code":0}');
    };
    server = http.createServer((request, response) =>
      handler(request, response),
    );
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `http://127.0.0.1:${
      (server.address() as AddressInfo).port
    }/synthetic-webhook`;
    transport = new NodeFeishuTransport({
      allowLocalHttp: true,
      timeoutMs: 150,
      maxResponseBytes: 2048,
    });
  });
  afterEach(async () => {
    transport.close();
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    for (const socket of sockets) socket.destroy();
    await closed;
    sockets.clear();
  });
  const send = (signal = new AbortController().signal) =>
    transport.send(url, card, signal);
  it('sends exactly one interactive card POST with complete UTF-8 JSON', async () => {
    let received:
      | { method?: string; contentType?: string; body: string }
      | undefined;
    handler = (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received = {
          method: request.method,
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        response.end('{"code":0}');
      });
    };
    expect(await send()).toEqual({ statusCode: 200, code: 0 });
    expect(received).toMatchObject({
      method: 'POST',
      contentType: 'application/json',
    });
    expect(JSON.parse(received!.body)).toEqual({
      msg_type: 'interactive',
      card,
    });
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });
  it.each([
    { status: 200, body: 'plain text', code: undefined },
    { status: 429, body: '{"code":"11232"}', code: '11232' },
    { status: 500, body: '[]', code: undefined },
  ])(
    'does not hide retries or change upstream status/code (%j)',
    async ({ status, body, code }) => {
      const served = vi.fn(
        (_request: IncomingMessage, response: ServerResponse) => {
          response.statusCode = status;
          response.end(body);
        },
      );
      handler = served;
      expect(await send()).toEqual({ statusCode: status, code });
      expect(served).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses redirects instead of posting a credential-bearing URL to another destination', async () => {
    const requests: string[] = [];
    handler = (request, response) => {
      requests.push(request.url!);
      response.writeHead(302, { Location: `${url}/other` });
      response.end();
    };
    expect(await send()).toEqual({ statusCode: 302, code: undefined });
    expect(requests).toEqual(['/synthetic-webhook']);
  });
  it.each(['headers', 'body'])(
    'bounds a silent %s peer and releases the socket',
    async (phase) => {
      handler = (_request, response) => {
        if (phase === 'body') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.write('{');
        }
      };
      const started = Date.now();
      await expect(send()).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(1500);
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    },
  );
  it('rejects oversized and truncated response bodies without exposing their content', async () => {
    handler = (_request, response) =>
      response.end('private-response-117'.repeat(300));
    const error = await send().catch((error) => error as Error);
    expect(error).toMatchObject({ code: 'BODY_TOO_LARGE' });
    expect(String(error)).not.toContain('private-response');
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Length': 100 });
      response.end('{"code":0}');
    };
    await expect(send()).rejects.toBeInstanceOf(Error);
  });
  it('aborts an in-flight request on caller cancellation and closes all pending I/O', async () => {
    handler = () => {};
    const abort = new AbortController(),
      task = send(abort.signal),
      rejected = expect(task).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(sockets.size).toBe(1));
    abort.abort('private-cancel');
    await rejected;
    await vi.waitFor(() => expect(sockets.size).toBe(0));
    const next = send(),
      closed = expect(next).rejects.toMatchObject({ code: 'CLOSED' });
    await vi.waitFor(() => expect(sockets.size).toBe(1));
    transport.close();
    await closed;
    await vi.waitFor(() => expect(sockets.size).toBe(0));
    await expect(send()).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it('rejects ordinary HTTP and credential URL user-info without making requests', async () => {
    const ordinary = new NodeFeishuTransport();
    try {
      await expect(
        ordinary.send(url, card, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(send(new AbortController().signal)).resolves.toMatchObject({
        statusCode: 200,
      });
      await expect(
        transport.send(
          url.replace('http://', 'http://user:private-pass@'),
          card,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      ordinary.close();
    }
  });
  it('applies service retries over real HTTP and reads a rotated endpoint before the next attempt', async () => {
    const paths: string[] = [];
    handler = (request, response) => {
      paths.push(request.url!);
      response.end(paths.length === 1 ? '{"code":11232}' : '{"code":0}');
    };
    let reads = 0;
    const service = new FeishuNotifications({
      source: {
        read: async () => ({
          webhookUrl: reads++ === 0 ? url : `${url}/rotated`,
        }),
      },
      transport,
      logger: { info() {}, warn() {}, error() {} },
      delay: async () => {},
    });
    try {
      expect(
        await service.sendCountry('primary', 'UK', {
          checkTime: 'fixture-time',
        }),
      ).toEqual({ success: true, skipped: false });
      expect(paths).toEqual([
        '/synthetic-webhook',
        '/synthetic-webhook/rotated',
      ]);
      expect(reads).toBe(2);
    } finally {
      service.close();
    }
  });
});
