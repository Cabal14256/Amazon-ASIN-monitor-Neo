import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import {
  createCompetitorAsin,
  createCompetitorGroup,
  deleteCompetitorAsin,
  deleteCompetitorGroup,
  getCompetitorGroup,
  getCompetitorGroups,
  moveCompetitorAsin,
  updateCompetitorAsin,
  updateCompetitorGroup,
} from './competitor-asin';

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

  it.each(['/api', 'https://app.test/api/'])(
    'uses %s for all seven writes with competitor-only request fields',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async (url, options) =>
        jsonResponse({
          success: true,
          errorCode: 0,
          data:
            options?.method === 'DELETE'
              ? '删除成功'
              : new URL(String(url)).pathname.includes('/asins')
              ? {
                  id: 'competitor-child-1',
                  asin: 'B00RIVAL00',
                  country: 'DE',
                  brand: 'Rival',
                  variantGroupId: 'competitor-group-1',
                }
              : group,
        }),
      );
      const http = client(baseURL, fetcher);
      const groupInput = {
        name: 'Fixture competitor',
        country: 'DE',
        brand: 'Rival',
      };
      const childInput = {
        asin: 'B00RIVAL00',
        name: 'Rival child',
        country: 'DE',
        brand: 'Rival',
        asinType: '2' as const,
      };
      await createCompetitorGroup(http, groupInput);
      await updateCompetitorGroup(http, group.id, groupInput);
      await deleteCompetitorGroup(http, group.id, ['competitor-child-1']);
      await createCompetitorAsin(http, { ...childInput, parentId: group.id });
      await updateCompetitorAsin(http, 'competitor-child-1', childInput);
      await moveCompetitorAsin(http, 'competitor-child-1', {
        targetGroupId: 'competitor-group-2',
      });
      await deleteCompetitorAsin(http, 'competitor-child-1');
      expect(
        fetcher.mock.calls.map(([url, options]) => [
          options?.method,
          new URL(String(url)).pathname,
        ]),
      ).toEqual([
        ['POST', '/api/v1/competitor/variant-groups'],
        ['PUT', '/api/v1/competitor/variant-groups/competitor-group-1'],
        ['DELETE', '/api/v1/competitor/variant-groups/competitor-group-1'],
        ['POST', '/api/v1/competitor/asins'],
        ['PUT', '/api/v1/competitor/asins/competitor-child-1'],
        ['POST', '/api/v1/competitor/asins/competitor-child-1/move'],
        ['DELETE', '/api/v1/competitor/asins/competitor-child-1'],
      ]);
      expect(
        fetcher.mock.calls.every(([url]) => !String(url).includes('/api/api/')),
      ).toBe(true);
      expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
        expectedChildIds: ['competitor-child-1'],
      });
      for (const [, options] of fetcher.mock.calls) {
        if (!options?.body) continue;
        expect(JSON.parse(String(options.body))).not.toHaveProperty('site');
      }
      expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toMatchObject({
        parentId: group.id,
        country: group.country,
        asinType: '2',
      });
    },
  );

  it('rejects malformed identifiers and request fields before sending a write', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = client('/api/', fetcher);
    await expect(
      deleteCompetitorAsin(http, '../outside'),
    ).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(getCompetitorGroup(http, ' group ')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(
      createCompetitorGroup(http, { name: '', country: 'DE', brand: 'Rival' }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a success envelope without write data and budgets full group responses', async () => {
    const request = vi.fn().mockResolvedValue({ success: true });
    const http = { request } as unknown as Pick<HttpClient, 'request'>;
    await expect(
      deleteCompetitorGroup(http, group.id, []),
    ).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    request.mockResolvedValue({ success: true, data: group });
    await createCompetitorGroup(http, {
      name: group.name,
      country: group.country,
      brand: group.brand,
    });
    expect(request.mock.calls[1][1]).toMatchObject({
      timeoutMs: 120_000,
      maxResponseBytes: 32 * 1024 * 1024,
    });
  });
});
