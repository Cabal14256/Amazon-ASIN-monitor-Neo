import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { getVariantGroup, getVariantGroups } from './asin';

const group = {
  id: 'group-1',
  name: 'Fixture group',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  isBroken: 1,
  statusSource: 'MANUAL',
  children: [{ id: 'child-1', asin: 'B00FIXTURE', country: 'US', isBroken: 0 }],
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

describe('ASIN catalog transport', () => {
  it.each(['/api', 'https://app.test/api/'])(
    'normalizes %s for both list and detail and passes server filters',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async (url) =>
        jsonResponse({
          success: true,
          errorCode: 0,
          data: String(url).includes('/group-1')
            ? group
            : {
                list: [group],
                total: 1,
                totalASINs: 1,
                current: 2,
                pageSize: 10,
              },
        }),
      );
      const http = client(baseURL, fetcher);
      await expect(
        getVariantGroups(http, {
          keyword: 'B00FIXTURE',
          country: 'US',
          variantStatus: 'BROKEN',
          current: 2,
          pageSize: 10,
        }),
      ).resolves.toMatchObject({ total: 1, list: [group] });
      await expect(getVariantGroup(http, 'group-1')).resolves.toMatchObject(
        group,
      );
      expect(fetcher.mock.calls[0][0]).toBe(
        'https://app.test/api/v1/variant-groups?keyword=B00FIXTURE&country=US&variantStatus=BROKEN&current=2&pageSize=10',
      );
      expect(fetcher.mock.calls[1][0]).toBe(
        'https://app.test/api/v1/variant-groups/group-1',
      );
    },
  );

  it('rejects incomplete success envelopes for both routes', async () => {
    const http = client('/api/', async () =>
      jsonResponse({ success: true, errorCode: 0, data: {} }),
    );
    await expect(
      getVariantGroups(http, { current: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    await expect(getVariantGroup(http, 'group-1')).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });

  it('bounds the large group response and forwards cancellation', async () => {
    const request = vi.fn().mockResolvedValue({ success: true, data: group });
    const signal = new AbortController().signal;
    await getVariantGroup(
      { request } as unknown as Pick<HttpClient, 'request'>,
      'group-1',
      signal,
    );
    expect(request).toHaveBeenCalledWith(
      '/api/v1/variant-groups/group-1',
      { signal, timeoutMs: 120_000, maxResponseBytes: 32 * 1024 * 1024 },
      expect.anything(),
    );
  });
});
