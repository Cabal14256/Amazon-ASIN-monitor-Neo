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
  it.each(['/api/', 'https://app.test/api/'])(
    'preserves the confirmed target snapshot at the actual %s boundary and reports lock-time conflicts',
    async (baseURL) => {
      const expectedTargetSnapshot = {
        id: ' Gróup cible ',
        name: ' Target group \n ',
        country: 'DE',
        brand: ' Rival \n ',
        updateTime: '2020-02-02T00:00:00.000Z',
      };
      const input = {
        targetGroupId: expectedTargetSnapshot.id,
        expectedSourceGroup: ' Source Şöurce ',
        expectedTargetSnapshot,
      };
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse({
          success: true,
          data: {
            id: ' Child α ',
            asin: 'B00RIVAL00',
            country: 'DE',
            variantGroupId: expectedTargetSnapshot.id,
          },
        }),
      );
      const http = client(baseURL, fetcher);
      await moveCompetitorAsin(http, ' Child α ', input);
      expect(fetcher.mock.calls[0][0]).toBe(
        `https://app.test/api/v1/competitor/asins/${encodeURIComponent(
          ' Child α ',
        )}/move`,
      );
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input);
      fetcher.mockResolvedValueOnce(
        jsonResponse({ success: false, errorMessage: '竞品目标组已变化' }, 409),
      );
      await expect(
        moveCompetitorAsin(http, ' Child α ', input),
      ).rejects.toMatchObject({ kind: 'HTTP', status: 409 });
      expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(input);
    },
  );
  it.each(['/api', 'https://app.test/api/'])(
    'preserves the full parent snapshot on the actual %s create request',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse({
          success: true,
          data: {
            id: 'a1',
            asin: 'B00RIVAL00',
            country: 'DE',
            brand: 'Own brand',
            variantGroupId: group.id,
          },
        }),
      );
      const expectedParent = {
        name: '\n ',
        country: 'DE',
        brand: '',
        updateTime: '2020-01-01T00:00:00.000Z',
      };
      const input = {
        asin: 'B00RIVAL00',
        country: 'DE',
        brand: 'Own brand',
        parentId: group.id,
        expectedParent,
      };
      await createCompetitorAsin(client(baseURL, fetcher), input);
      expect(fetcher.mock.calls[0][0]).toBe(
        'https://app.test/api/v1/competitor/asins',
      );
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input);
    },
  );
  it.each(['/api', 'https://app.test/api/'])(
    'normalizes %s for list/detail while preserving response display status',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async (url) =>
        jsonResponse({
          success: true,
          errorCode: 0,
          data: new URL(String(url)).pathname.endsWith('/detail')
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
        'https://app.test/api/v1/competitor/catalog/variant-groups/detail?groupId=competitor-group-1',
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
      '/api/v1/competitor/catalog/variant-groups/detail',
      {
        query: { groupId: group.id },
        signal,
        timeoutMs: 30_000,
        maxResponseBytes: 32 * 1024 * 1024,
      },
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
      await deleteCompetitorGroup(
        http,
        group.id,
        ['competitor-child-1'],
        groupInput,
      );
      await createCompetitorAsin(http, { ...childInput, parentId: group.id });
      await updateCompetitorAsin(http, 'competitor-child-1', childInput);
      await moveCompetitorAsin(http, 'competitor-child-1', {
        targetGroupId: 'competitor-group-2',
        expectedSourceGroup: group.id,
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
        expectedSource: groupInput,
      });
      expect(JSON.parse(String(fetcher.mock.calls[5][1]?.body))).toEqual({
        targetGroupId: 'competitor-group-2',
        expectedSourceGroup: group.id,
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
    for (const id of [
      '',
      ' ',
      '.',
      '..',
      'a/b',
      'a\\b',
      'a?b',
      'a#b',
      'a\tb',
      'a\nb',
      'a\u0000b',
      'a\u007fb',
      '🔎'.repeat(51),
    ]) {
      await expect(deleteCompetitorAsin(http, id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
    }
    for (const id of [
      '',
      'a\tb',
      'a\nb',
      'a\u0000b',
      'a\u007fb',
      'a\u0085b',
      '\ud800',
      '🔎'.repeat(51),
    ]) {
      await expect(getCompetitorGroup(http, id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
    }
    await expect(
      createCompetitorGroup(http, { name: '', country: 'DE', brand: 'Rival' }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['/api', 'https://app.test/api/'])(
    'preserves migrated PADSPACE group and child IDs through reads and writes with %s',
    async (baseURL) => {
      const groupId = 'Gróup ';
      const childId = 'Ásin ';
      const targetId = ' Gróup cible ';
      const child = {
        ...group.children[0],
        id: childId,
        variantGroupId: groupId,
      };
      const migrated = { ...group, id: groupId, children: [child] };
      const fetcher = vi.fn<typeof fetch>(async (url, options) =>
        jsonResponse({
          success: true,
          errorCode: 0,
          data:
            options?.method === 'DELETE'
              ? '删除成功'
              : new URL(String(url)).pathname.includes('/asins')
              ? child
              : new URL(String(url)).pathname.endsWith('/variant-groups')
              ? {
                  list: [migrated],
                  total: 1,
                  totalASINs: 1,
                  current: 1,
                  pageSize: 20,
                }
              : migrated,
        }),
      );
      const http = client(baseURL, fetcher);
      const list = await getCompetitorGroups(http, {});
      const detail = await getCompetitorGroup(http, list.list[0].id);
      expect(detail.id).toBe(groupId);
      expect(detail.children?.[0].id).toBe(childId);
      const groupInput = {
        name: group.name,
        country: group.country,
        brand: group.brand,
      };
      const childInput = {
        asin: child.asin,
        country: child.country,
        brand: group.brand,
      };
      const expectedSource = {
        ...childInput,
        variantGroupId: groupId,
        name: null,
        asinType: null,
      };
      await updateCompetitorGroup(http, detail.id, groupInput);
      await deleteCompetitorGroup(http, detail.id, [childId], groupInput);
      await createCompetitorAsin(http, { ...childInput, parentId: detail.id });
      await updateCompetitorAsin(http, childId, {
        ...childInput,
        expectedSource,
      });
      await moveCompetitorAsin(http, childId, {
        targetGroupId: targetId,
        expectedSourceGroup: detail.id,
      });
      await deleteCompetitorAsin(http, childId, expectedSource);
      const groupPath = '/api/v1/competitor/variant-groups/Gr%C3%B3up%20';
      const childPath = '/api/v1/competitor/asins/%C3%81sin%20';
      expect(
        fetcher.mock.calls.map(([url, options]) => [
          options?.method,
          new URL(String(url)).pathname,
        ]),
      ).toEqual([
        ['GET', '/api/v1/competitor/variant-groups'],
        ['GET', '/api/v1/competitor/catalog/variant-groups/detail'],
        ['PUT', groupPath],
        ['DELETE', groupPath],
        ['POST', '/api/v1/competitor/asins'],
        ['PUT', childPath],
        ['POST', `${childPath}/move`],
        ['DELETE', childPath],
      ]);
      expect(
        new URL(String(fetcher.mock.calls[1][0])).searchParams.get('groupId'),
      ).toBe(groupId);
      expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toEqual({
        expectedChildIds: [childId],
        expectedSource: groupInput,
      });
      expect(JSON.parse(String(fetcher.mock.calls[4][1]?.body))).toMatchObject({
        parentId: groupId,
      });
      expect(JSON.parse(String(fetcher.mock.calls[5][1]?.body))).toMatchObject({
        expectedSource,
      });
      expect(JSON.parse(String(fetcher.mock.calls[6][1]?.body))).toEqual({
        targetGroupId: targetId,
        expectedSourceGroup: groupId,
      });
      expect(JSON.parse(String(fetcher.mock.calls[7][1]?.body))).toEqual({
        expectedSource,
      });
      expect(
        fetcher.mock.calls.every(([url]) => !String(url).includes('/api/api/')),
      ).toBe(true);
    },
  );

  it('counts Unicode code points without shortening a valid 50-character ID', async () => {
    const id = '🔎'.repeat(49) + ' ';
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ success: true, errorCode: 0, data: { ...group, id } }),
    );
    const http = client('/api', fetcher);
    await expect(getCompetitorGroup(http, id)).resolves.toMatchObject({ id });
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(
      '/api/v1/competitor/catalog/variant-groups/detail',
    );
    expect(
      new URL(String(fetcher.mock.calls[0][0])).searchParams.get('groupId'),
    ).toBe(id);
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
