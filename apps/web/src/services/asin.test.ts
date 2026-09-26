import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import {
  createAsin,
  createVariantGroup,
  deleteAsin,
  deleteVariantGroup,
  getVariantGroup,
  getVariantGroups,
  moveAsin,
  updateAsin,
  updateAsinManual,
  updateAsinNotify,
  updateVariantGroup,
  updateVariantGroupManual,
  updateVariantGroupNotify,
} from './asin';

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
    'normalizes %s for all single-item writes and validates their envelopes',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async (url, options) => {
        const path = new URL(String(url)).pathname;
        return jsonResponse({
          success: true,
          errorCode: 0,
          data:
            options?.method === 'DELETE'
              ? '删除成功'
              : path.includes('/asins')
              ? {
                  id: 'child-1',
                  asin: 'B00FIXTURE',
                  country: 'US',
                  site: 'amazon.com',
                  brand: 'Fixture',
                }
              : group,
        });
      });
      const http = client(baseURL, fetcher);
      const groupInput = {
        name: 'Fixture group',
        country: 'US',
        site: 'amazon.com',
        brand: 'Fixture',
      };
      const asinInput = {
        asin: 'B00FIXTURE',
        name: 'Fixture child',
        country: 'US',
        site: 'amazon.com',
        brand: 'Fixture',
        asinType: '1' as const,
      };
      await createVariantGroup(http, groupInput);
      await updateVariantGroup(http, 'group-1', groupInput);
      await deleteVariantGroup(http, 'group-1');
      await createAsin(http, { ...asinInput, parentId: 'group-1' });
      await updateAsin(http, 'child-1', asinInput);
      await moveAsin(http, 'child-1', { targetGroupId: 'group-2' });
      await deleteAsin(http, 'child-1');
      expect(
        fetcher.mock.calls.map(([url, options]) => [
          options?.method,
          new URL(String(url)).pathname,
        ]),
      ).toEqual([
        ['POST', '/api/v1/variant-groups'],
        ['PUT', '/api/v1/variant-groups/group-1'],
        ['DELETE', '/api/v1/variant-groups/group-1'],
        ['POST', '/api/v1/asins'],
        ['PUT', '/api/v1/asins/child-1'],
        ['POST', '/api/v1/asins/child-1/move'],
        ['DELETE', '/api/v1/asins/child-1'],
      ]);
      expect(
        fetcher.mock.calls.every(([url]) => !String(url).includes('/api/api/')),
      ).toBe(true);
      expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toMatchObject({
        parentId: 'group-1',
        asinType: '1',
      });
    },
  );

  it('rejects invalid write inputs before transport and incomplete success responses', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ success: true, errorCode: 0 }),
    );
    const http = client('/api/', fetcher);
    await expect(deleteAsin(http, '../outside')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(getVariantGroup(http, '..')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(deleteVariantGroup(http, ' group-1 ')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(
      createVariantGroup(http, {
        name: '',
        country: 'US',
        site: 'amazon.com',
        brand: 'Fixture',
      }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(deleteVariantGroup(http, 'group-1')).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });

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

  it('uses the detail response budget for full-group mutation responses', async () => {
    const request = vi.fn().mockResolvedValue({ success: true, data: group });
    const http = { request } as unknown as Pick<HttpClient, 'request'>;
    const input = {
      name: 'Fixture group',
      country: 'US',
      site: 'amazon.com',
      brand: 'Fixture',
    };
    await createVariantGroup(http, input);
    await updateVariantGroup(http, 'group-1', input);
    for (const call of request.mock.calls) {
      expect(call[1]).toMatchObject({
        timeoutMs: 120_000,
        maxResponseBytes: 32 * 1024 * 1024,
      });
    }
  });

  it('covers notification and manual status routes without duplicating /api', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      return jsonResponse({
        success: true,
        errorCode: 0,
        data: path.includes('/variant-groups/') ? group : group.children[0],
      });
    });
    const http = client('https://app.test/api/', fetcher);
    await updateVariantGroupNotify(http, 'group-1', true);
    await updateVariantGroupManual(http, 'group-1', {
      markedBroken: true,
      reason: 'fixture reason',
    });
    await updateAsinNotify(http, 'child-1', false);
    await updateAsinManual(http, 'child-1', {
      action: 'EXCLUDE_GROUP_MANUAL',
      reason: 'fixture exclusion',
    });
    expect(
      fetcher.mock.calls.map(([url, options]) => [
        options?.method,
        new URL(String(url)).pathname,
        JSON.parse(String(options?.body)),
      ]),
    ).toEqual([
      [
        'PUT',
        '/api/v1/variant-groups/group-1/feishu-notify',
        { enabled: true },
      ],
      [
        'PUT',
        '/api/v1/variant-groups/group-1/manual-broken',
        {
          markedBroken: true,
          reason: 'fixture reason',
        },
      ],
      ['PUT', '/api/v1/asins/child-1/feishu-notify', { enabled: false }],
      [
        'PUT',
        '/api/v1/asins/child-1/manual-broken',
        {
          action: 'EXCLUDE_GROUP_MANUAL',
          reason: 'fixture exclusion',
        },
      ],
    ]);
    const budgetedRequest = vi.fn().mockResolvedValue({
      success: true,
      errorCode: 0,
      data: group,
    });
    const budgetedHttp = {
      request: budgetedRequest,
    } as unknown as Pick<HttpClient, 'request'>;
    await updateVariantGroupNotify(budgetedHttp, 'group-1', true);
    await updateVariantGroupManual(budgetedHttp, 'group-1', {
      markedBroken: true,
      reason: 'fixture reason',
    });
    expect(budgetedRequest.mock.calls[0][1]).toMatchObject({
      timeoutMs: 120_000,
      maxResponseBytes: 32 * 1024 * 1024,
    });
    expect(budgetedRequest.mock.calls[1][1]).toMatchObject({
      timeoutMs: 120_000,
      maxResponseBytes: 32 * 1024 * 1024,
    });
  });
});
