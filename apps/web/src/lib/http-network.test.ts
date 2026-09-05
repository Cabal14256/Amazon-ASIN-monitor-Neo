import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient } from './http';
import { deferred, sessionFixture } from './transport-fixtures';

let server: Server;
let handler: RequestListener;
let origin: string;
let client: HttpClient;
beforeEach(async () => {
  handler = (_req, res) => res.end('{"success":true}');
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fixture = sessionFixture();
  fixture.local.set('token', 'fixture-loopback-only');
  client = new HttpClient({ pageOrigin: origin, session: fixture.store });
});
afterEach(async () => {
  client.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
describe('actual fetch against disposable loopback HTTP', () => {
  it('sends the normalized request and explicit compatibility header', async () => {
    let received: unknown;
    handler = (req, res) => {
      received = { url: req.url, authorization: req.headers.authorization };
      res.setHeader('content-type', 'application/json');
      res.end('{"success":true,"data":{"one":1}}');
    };
    await expect(client.request('/api/api/v1/example')).resolves.toMatchObject({
      data: { one: 1 },
    });
    expect(received).toEqual({
      url: '/api/v1/example',
      authorization: 'Bearer fixture-loopback-only',
    });
  });
  it('does not follow an actual redirect to a different origin or replay a POST', async () => {
    const visits: string[] = [];
    handler = (req, res) => {
      visits.push(req.url!);
      res.writeHead(302, {
        location: origin.replace('127.0.0.1', 'localhost') + '/foreign-target',
      });
      res.end();
    };
    await expect(
      client.request('/v1/example', { method: 'POST', json: { one: 1 } }),
    ).rejects.toMatchObject({ kind: 'NETWORK' });
    expect(visits).toEqual(['/api/v1/example']);
  });
  it('aborts a stalled response body and confirms the actual socket closes', async () => {
    const closed = deferred<void>();
    handler = (_req, res) => {
      res.on('close', () => closed.resolve());
      res.writeHead(200);
      res.flushHeaders();
      res.write('{');
    };
    await expect(
      client.request('/v1/example', { timeoutMs: 300 }),
    ).rejects.toMatchObject({ kind: 'TIMEOUT' });
    await closed.promise;
  });
});
