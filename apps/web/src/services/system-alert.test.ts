import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { getSystemAlert } from './system-alert';

const clients: HttpClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.close()));

function client(fetcher: typeof fetch, baseURL = '/api/') {
  const http = new HttpClient({
    pageOrigin: 'https://app.test',
    baseURL,
    session: sessionFixture().store,
    fetch: fetcher,
  });
  clients.push(http);
  return http;
}

describe('public system alert transport', () => {
  it.each([
    ['/api', 'https://app.test/api/v1/system/alert'],
    ['/api/', 'https://app.test/api/v1/system/alert'],
    ['https://app.test/api/', 'https://app.test/api/v1/system/alert'],
    ['/gateway/api/v1/', 'https://app.test/gateway/api/v1/system/alert'],
  ])(
    'normalizes request and shared URL assembly for %s',
    async (baseURL, expected) => {
      const data = { message: '部署维护通知', type: 'warning' };
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse({ success: true, errorCode: 0, data }),
      );
      const http = client(fetcher, baseURL);
      await expect(getSystemAlert(http)).resolves.toEqual(data);
      expect(fetcher.mock.calls[0][0]).toBe(expected);
      expect(http.url('/api/v1/system/alert')).toBe(expected);
      expect(fetcher.mock.calls[0][1]?.credentials).toBe('include');
    },
  );

  it.each([
    { message: '', type: 'info' },
    { message: '完整公告', type: 'new-deployment-type' },
  ])('preserves the shared string contract: $type', async (data) => {
    await expect(
      getSystemAlert(
        client(async () => jsonResponse({ success: true, errorCode: 0, data })),
      ),
    ).resolves.toEqual(data);
  });

  it.each([
    undefined,
    { message: 'incomplete' },
    { message: 12, type: 'info' },
    { message: 'notice', type: 12 },
  ])('rejects malformed responses before rendering %j', async (data) => {
    await expect(
      getSystemAlert(
        client(async () => jsonResponse({ success: true, errorCode: 0, data })),
      ),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });

  it('does not expire a verified session when the public endpoint returns 401', async () => {
    const onUnauthorized = vi.fn();
    const http = new HttpClient({
      pageOrigin: 'https://app.test',
      baseURL: '/api',
      session: sessionFixture().store,
      onUnauthorized,
      fetch: async () => jsonResponse({ errorMessage: 'Unavailable' }, 401),
    });
    clients.push(http);
    await expect(getSystemAlert(http)).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
