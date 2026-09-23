import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { getCompetitorGroup, getCompetitorGroups } from './competitor-asin';

const group = {
  id: 'competitor-group-1',
  name: 'Fixture competitor',
  country: 'DE',
  brand: 'Rival',
  is_broken: 1,
  isBroken: 0,
  children: [
    {
      id: 'competitor-child-1',
      asin: 'B00RIVAL00',
      country: 'DE',
      isBroken: 0,
    },
  ],
};
const clients: HttpClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function client(baseURL: string, fetcher: typeof fetch) {
  const result = new HttpClient({
    baseURL,
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  clients.push(result);
  return result;
}

describe('competitor catalog transport', () => {
  it.each(['/api', 'https://app.test/api/'])(
    'normalizes %s for list/detail while preserving response display status',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async (url) =>
        jsonResponse({
          success: true,
          errorCode: 0,
          data: String(url).includes('/competitor-group-1')
            ? group
            : {
                list: [group],
                total: 1,
                totalASINs: 1,
                current: 1,
                pageSize: 20,
              },
        }),
      );
      const http = client(baseURL, fetcher);
      const list = await getCompetitorGroups(http, {
        keyword: 'B00RIVAL00',
        country: 'DE',
        variantStatus: 'BROKEN',
        current: 1,
        pageSize: 20,
      });
      expect(list.list[0].isBroken).toBe(0);
      await expect(getCompetitorGroup(http, group.id)).resolves.toMatchObject(
        group,
      );
      expect(fetcher.mock.calls[0][0]).toBe(
        'https://app.test/api/v1/competitor/variant-groups?keyword=B00RIVAL00&country=DE&variantStatus=BROKEN&current=1&pageSize=20',
      );
      expect(fetcher.mock.calls[1][0]).toBe(
        'https://app.test/api/v1/competitor/variant-groups/competitor-group-1',
      );
    },
  );

  it('rejects an incomplete success response', async () => {
    const http = client('/api/', async () =>
      jsonResponse({ success: true, errorCode: 0, data: {} }),
    );
    await expect(getCompetitorGroups(http, {})).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    await expect(getCompetitorGroup(http, group.id)).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });

  it('uses the API response cap and forwards cancellation', async () => {
    const request = vi.fn().mockResolvedValue({ success: true, data: group });
    const signal = new AbortController().signal;
    await getCompetitorGroup(
      { request } as unknown as Pick<HttpClient, 'request'>,
      group.id,
      signal,
    );
    expect(request).toHaveBeenCalledWith(
      '/api/v1/competitor/variant-groups/competitor-group-1',
      { signal, timeoutMs: 30_000, maxResponseBytes: 32 * 1024 * 1024 },
      expect.anything(),
    );
  });
});
