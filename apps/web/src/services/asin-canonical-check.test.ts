import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { checkAsin, checkVariantGroup } from './asin';

const groupId = ' Gróup 主 营 ';
const childId = ' Chíld α 子 ';
const clients: HttpClient[] = [];
let server: Server | undefined;
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
});

function receipt(url: string) {
  return {
    success: true,
    errorCode: 0,
    data: {
      taskId: 'canonical-check-1',
      status: 'pending',
      taskType: url.includes('/variant-groups/')
        ? 'variant-group-check'
        : 'asin-check',
    },
  };
}
function client(baseURL: string, pageOrigin: string, fetcher?: typeof fetch) {
  const http = new HttpClient({
    baseURL,
    pageOrigin,
    session: sessionFixture().store,
    ...(fetcher ? { fetch: fetcher } : {}),
  });
  clients.push(http);
  return http;
}

const outcome = {
  kind: 'task',
  taskId: 'canonical-check-1',
  status: 'pending',
};
const requestBody = { forceRefresh: true, useAsync: true };

describe('primary canonical IDs for immediate check transport', () => {
  it.each(['/api/', 'https://app.test/gateway/api/'])(
    'preserves raw IDs through actual HttpClient with %s',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async (url) =>
        jsonResponse(receipt(String(url))),
      );
      const http = client(baseURL, 'https://app.test', fetcher);
      await expect(checkAsin(http, childId)).resolves.toEqual(outcome);
      await expect(checkVariantGroup(http, groupId)).resolves.toEqual(outcome);
      const prefix = baseURL.includes('/gateway/')
        ? '/gateway/api/v1'
        : '/api/v1';
      expect(
        fetcher.mock.calls.map(([url, options]) => [
          options?.method,
          new URL(String(url)).pathname,
          JSON.parse(String(options?.body)),
        ]),
      ).toEqual([
        [
          'POST',
          `${prefix}/asins/${encodeURIComponent(childId)}/check`,
          requestBody,
        ],
        [
          'POST',
          `${prefix}/variant-groups/${encodeURIComponent(groupId)}/check`,
          requestBody,
        ],
      ]);
      expect(
        fetcher.mock.calls.every(([url]) => !String(url).includes('/api/api/')),
      ).toBe(true);
    },
  );

  it('rejects route escapes and oversized IDs before either check is sent', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = client('/api/', 'https://app.test', fetcher);
    for (const id of [
      '',
      ' ',
      '.',
      '..',
      'a/b',
      'a\\b',
      'a?b',
      'a#b',
      'a\u0000b',
      'a\u007fb',
      '😀'.repeat(51),
    ]) {
      await expect(checkAsin(http, id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
      await expect(checkVariantGroup(http, id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['same-origin', 'gateway'] as const)(
    'preserves encoded check IDs on the native %s HTTP wire',
    async (deployment) => {
      const received: Array<{ url: string; method: string; body: unknown }> =
        [];
      server = createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        received.push({
          url: req.url!,
          method: req.method!,
          body: JSON.parse(Buffer.concat(parts).toString('utf8')),
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(receipt(req.url!)));
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, '127.0.0.1', resolve),
      );
      const origin = `http://127.0.0.1:${
        (server.address() as AddressInfo).port
      }`;
      const http = client(
        deployment === 'gateway' ? `${origin}/gateway/api/` : '/api/',
        origin,
      );
      await expect(checkAsin(http, childId)).resolves.toEqual(outcome);
      await expect(checkVariantGroup(http, groupId)).resolves.toEqual(outcome);
      const prefix = deployment === 'gateway' ? '/gateway/api/v1' : '/api/v1';
      expect(received).toEqual([
        {
          method: 'POST',
          url: `${prefix}/asins/${encodeURIComponent(childId)}/check`,
          body: requestBody,
        },
        {
          method: 'POST',
          url: `${prefix}/variant-groups/${encodeURIComponent(groupId)}/check`,
          body: requestBody,
        },
      ]);
      expect(received.every(({ url }) => !url.includes('/api/api/'))).toBe(
        true,
      );
    },
  );
});
