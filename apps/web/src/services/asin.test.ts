import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import {
  checkAsin,
  checkVariantGroup,
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
const variantView = {
  asin: 'B00FIXTURE',
  title: 'Fixture child',
  hasVariation: true,
  isBroken: false,
  parentAsin: 'B00PARENT1',
  brotherAsins: ['B00SIBLING'],
  brand: 'Fixture',
  raw: null,
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
  it('preserves a fifty-codepoint Unicode ID without depending on the shared HTTP layer', async () => {
    const id = ` ${'😀'.repeat(48)} `;
    expect([...id]).toHaveLength(50);
    const request = vi
      .fn()
      .mockResolvedValue({ success: true, data: { ...group, id } });
    await getVariantGroup(
      { request } as unknown as Pick<HttpClient, 'request'>,
      id,
    );
    expect(request.mock.calls[0][0]).toBe(
      '/api/v1/catalog/variant-groups/detail',
    );
    expect(request.mock.calls[0][1].query).toEqual({ groupId: id });
  });

  it('retains mutation route boundaries and rejects malformed literal detail IDs before transport', async () => {
    const request = vi.fn();
    const http = { request } as unknown as Pick<HttpClient, 'request'>;
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
      '😀'.repeat(51),
    ]) {
      await expect(deleteVariantGroup(http, id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
      await expect(deleteAsin(http, id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
      await expect(
        moveAsin(http, id, { targetGroupId: 'valid-target' }),
      ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    }
    for (const id of [
      '',
      'a\tb',
      'a\nb',
      'a\u0000b',
      'a\u007fb',
      'a\u0085b',
      '\ud800',
      '😀'.repeat(51),
    ]) {
      await expect(getVariantGroup(http, id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['/api/', 'https://app.test/gateway/api/'])(
    'preserves canonical group/ASIN paths and parent/target payloads with actual %s HttpClient',
    async (baseURL) => {
      const groupId = ' Gróup 主营 ';
      const childId = ' Child α ';
      const targetId = ' Cible 目标 ';
      const fetcher = vi.fn<typeof fetch>(async (url, options) =>
        jsonResponse({
          success: true,
          data:
            options?.method === 'DELETE'
              ? '删除成功'
              : String(url).includes('/asins')
              ? { ...group.children[0], id: childId }
              : { ...group, id: groupId },
        }),
      );
      const http = client(baseURL, fetcher);
      const groupInput = {
        name: group.name,
        country: group.country,
        site: group.site,
        brand: group.brand,
      };
      const asinInput = {
        asin: 'B000000001',
        country: 'US',
        site: 'amazon.com',
        brand: 'Fixture',
      };
      await getVariantGroup(http, groupId);
      await updateVariantGroup(http, groupId, groupInput);
      await deleteVariantGroup(http, groupId);
      await createAsin(http, { ...asinInput, parentId: groupId });
      await updateAsin(http, childId, asinInput);
      await moveAsin(http, childId, { targetGroupId: targetId });
      await deleteAsin(http, childId);
      await updateVariantGroupNotify(http, groupId, true);
      await updateVariantGroupManual(http, groupId, { markedBroken: false });
      await updateAsinNotify(http, childId, false);
      await updateAsinManual(http, childId, { action: 'CLEAR_SELF_MANUAL' });
      const prefix = baseURL.includes('/gateway/')
        ? '/gateway/api/v1'
        : '/api/v1';
      const groupPath = `${prefix}/variant-groups/${encodeURIComponent(
        groupId,
      )}`;
      const childPath = `${prefix}/asins/${encodeURIComponent(childId)}`;
      expect(
        fetcher.mock.calls.map(([url, options]) => [
          options?.method ?? 'GET',
          new URL(String(url)).pathname,
        ]),
      ).toEqual([
        ['GET', `${prefix}/catalog/variant-groups/detail`],
        ['PUT', groupPath],
        ['DELETE', groupPath],
        ['POST', `${prefix}/asins`],
        ['PUT', childPath],
        ['POST', `${childPath}/move`],
        ['DELETE', childPath],
        ['PUT', `${groupPath}/feishu-notify`],
        ['PUT', `${groupPath}/manual-broken`],
        ['PUT', `${childPath}/feishu-notify`],
        ['PUT', `${childPath}/manual-broken`],
      ]);
      expect(
        new URL(String(fetcher.mock.calls[0][0])).searchParams.get('groupId'),
      ).toBe(groupId);
      expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body)).parentId).toBe(
        groupId,
      );
      expect(
        JSON.parse(String(fetcher.mock.calls[5][1]?.body)).targetGroupId,
      ).toBe(targetId);
      expect(
        fetcher.mock.calls.every(([url]) => !String(url).includes('/api/api/')),
      ).toBe(true);
    },
  );

  it.each(['/api', 'https://app.test/api/', 'https://app.test/api/v1/'])(
    'submits both checks with normalized %s URLs and async defaults',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async (url) =>
        jsonResponse({
          success: true,
          errorCode: 0,
          data: {
            taskId: 'check-1',
            status: 'pending',
            taskType: String(url).includes('/variant-groups/')
              ? 'variant-group-check'
              : 'asin-check',
          },
        }),
      );
      const http = client(baseURL, fetcher);
      await expect(checkAsin(http, 'child-1')).resolves.toEqual({
        kind: 'task',
        taskId: 'check-1',
        status: 'pending',
      });
      await expect(checkVariantGroup(http, 'group-1')).resolves.toEqual({
        kind: 'task',
        taskId: 'check-1',
        status: 'pending',
      });
      expect(
        fetcher.mock.calls.map(([url, options]) => [
          options?.method,
          new URL(String(url)).pathname,
          JSON.parse(String(options?.body)),
        ]),
      ).toEqual([
        [
          'POST',
          '/api/v1/asins/child-1/check',
          { forceRefresh: true, useAsync: true },
        ],
        [
          'POST',
          '/api/v1/variant-groups/group-1/check',
          { forceRefresh: true, useAsync: true },
        ],
      ]);
      expect(http.url('/api/v1/tasks/check-1/download')).toBe(
        'https://app.test/api/v1/tasks/check-1/download',
      );
      expect(
        fetcher.mock.calls.every(([url]) => !String(url).includes('/api/api/')),
      ).toBe(true);
    },
  );

  it('returns typed synchronous results for both routes and forwards explicit flags', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      jsonResponse({
        success: true,
        errorCode: 0,
        data: String(url).includes('/variant-groups/')
          ? { isBroken: false, details: { results: [] } }
          : variantView,
      }),
    );
    const http = client('/api', fetcher);
    const signal = new AbortController().signal;
    await expect(
      checkAsin(
        http,
        'child-1',
        { forceRefresh: false, useAsync: false },
        signal,
      ),
    ).resolves.toEqual({ kind: 'result', result: variantView });
    await expect(
      checkVariantGroup(http, 'group-1', { useAsync: false }),
    ).resolves.toEqual({
      kind: 'result',
      result: { isBroken: false, details: { results: [] } },
    });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      forceRefresh: false,
      useAsync: false,
    });
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      forceRefresh: true,
      useAsync: false,
    });
  });

  it.each([
    ['asin', checkAsin, 'asin-check'],
    ['group', checkVariantGroup, 'variant-group-check'],
  ] as const)(
    'retains a task lookup ID after uncertain %s submission',
    async (_label, check, taskType) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            success: false,
            errorCode: 500,
            errorMessage: '任务提交结果未确认',
            data: { taskId: 'check-uncertain', status: 'unknown' },
          },
          500,
        ),
      );
      const http = client('/api', fetcher);
      await expect(
        check(http, taskType === 'asin-check' ? 'child-1' : 'group-1'),
      ).resolves.toEqual({
        kind: 'task',
        taskId: 'check-uncertain',
        status: 'unknown',
      });
    },
  );

  it('rejects invalid check inputs and unexpected receipts without submitting twice', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        success: true,
        errorCode: 0,
        data: {
          taskId: 'check-1',
          status: 'completed',
          taskType: 'asin-check',
        },
      }),
    );
    const http = client('/api/', fetcher);
    await expect(checkAsin(http, '../outside')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(
      checkVariantGroup(http, 'group-1', { useAsync: 'invalid' as never }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(checkAsin(http, 'child-1')).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed task IDs before the page starts polling', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        success: true,
        errorCode: 0,
        data: {
          taskId: 'task/with-slash',
          status: 'pending',
          taskType: 'asin-check',
        },
      }),
    );
    await expect(
      checkAsin(client('/api', fetcher), 'child-1'),
    ).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });

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
    await expect(getVariantGroup(http, '\u0085')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    await expect(deleteVariantGroup(http, 'group\n-1')).rejects.toMatchObject({
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
          data: new URL(String(url)).pathname.endsWith('/detail')
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
        'https://app.test/api/v1/catalog/variant-groups/detail?groupId=group-1',
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
      '/api/v1/catalog/variant-groups/detail',
      {
        query: { groupId: 'group-1' },
        signal,
        timeoutMs: 120_000,
        maxResponseBytes: 32 * 1024 * 1024,
      },
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
