import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import {
  checkCompetitorAsin,
  checkCompetitorGroup,
  checkSelectedGroups,
} from './catalog-check';

const clients: HttpClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.close()));
function fixture(
  data: unknown,
  status = 200,
  baseURL = 'https://api.test/api/',
) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(jsonResponse({ success: status === 200, data }, status));
  const http = new HttpClient({
    baseURL,
    pageOrigin: 'https://app.test',
    fetch: fetcher,
    session: sessionFixture().store,
  });
  clients.push(http);
  return { http, fetcher };
}
describe('catalog asynchronous checks', () => {
  it.each(['https://api.test/api/', 'https://api.test/'])(
    'dedupes /api and preserves selected raw JSON IDs for %s',
    async (baseURL) => {
      const f = fixture(
        {
          taskId: 'batch-1',
          status: 'pending',
          taskType: 'variant-group',
          total: 3,
        },
        200,
        baseURL,
      );
      const groupIds = [' Mixed-É ', 'mixed-é', 'a/b'];
      expect(
        await checkSelectedGroups(f.http, groupIds, { forceRefresh: false }),
      ).toEqual({ kind: 'task', taskId: 'batch-1', status: 'pending' });
      const [url, request] = f.fetcher.mock.calls[0];
      expect(String(url)).toBe(
        'https://api.test/api/v1/variant-groups/batch-check',
      );
      expect(JSON.parse(String(request?.body))).toEqual({
        groupIds,
        forceRefresh: false,
        useAsync: true,
      });
    },
  );
  it.each([
    [
      'group',
      checkCompetitorGroup,
      'competitor-variant-group-check',
      'variant-groups',
    ],
    ['asin', checkCompetitorAsin, 'competitor-asin-check', 'asins'],
  ] as const)(
    'dispatches %s checks explicitly async with encoded original record IDs',
    async (_kind, check, taskType, collection) => {
      const f = fixture({
        taskId: 'competitor-1',
        status: 'pending',
        taskType,
      });
      await check(f.http, ' MiXeD-É😀 ', { forceRefresh: true });
      expect(String(f.fetcher.mock.calls[0][0])).toBe(
        `https://api.test/api/v1/competitor/${collection}/${encodeURIComponent(
          ' MiXeD-É😀 ',
        )}/check`,
      );
      expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual({
        useAsync: true,
        forceRefresh: true,
      });
    },
  );
  it.each([
    [
      'batch',
      (http: HttpClient) =>
        checkSelectedGroups(http, ['g1'], { forceRefresh: true }),
      'variant-group',
    ],
    [
      'competitor',
      (http: HttpClient) =>
        checkCompetitorGroup(http, 'g1', { forceRefresh: true }),
      'competitor-variant-group-check',
    ],
  ] as const)(
    'preserves a server 500 unknown %s receipt',
    async (_label, check, taskType) => {
      const f = fixture(
        { taskId: 'unknown-1', status: 'unknown', taskType },
        500,
      );
      expect(await check(f.http)).toEqual({
        kind: 'task',
        taskId: 'unknown-1',
        status: 'unknown',
      });
    },
  );
  it.each([
    { taskId: '../task', status: 'pending' },
    { taskId: 'task-1', status: 'completed' },
    { taskId: 'task-1', status: 'pending', taskType: 'asin-check' },
    {
      taskId: 'task-1',
      status: 'pending',
      taskType: 'variant-group',
      total: 2,
    },
    { total: 1, results: [] },
  ])(
    'rejects an invalid or synchronous batch ACK without retry: %j',
    async (data) => {
      const f = fixture(data);
      await expect(
        checkSelectedGroups(f.http, ['g1'], { forceRefresh: true }),
      ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects unsafe single paths and invalid batch input before HTTP while preserving fifty codepoints', async () => {
    const f = fixture({
      taskId: 'batch-1',
      status: 'pending',
      taskType: 'variant-group',
    });
    for (const ids of [
      [],
      ['g', 'g'],
      ['\t'],
      ['😀'.repeat(51)],
      Array.from({ length: 1001 }, (_, i) => String(i)),
    ])
      await expect(
        checkSelectedGroups(f.http, ids, { forceRefresh: true }),
      ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
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
    ])
      await expect(
        checkCompetitorAsin(f.http, id, { forceRefresh: true }),
      ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
    await checkSelectedGroups(f.http, [` ${'😀'.repeat(48)} `], {
      forceRefresh: true,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not reinterpret a mismatched unknown competitor receipt as accepted', async () => {
    const f = fixture(
      {
        taskId: 'wrong-1',
        status: 'unknown',
        taskType: 'competitor-asin-check',
      },
      500,
    );
    await expect(
      checkCompetitorGroup(f.http, 'g1', { forceRefresh: true }),
    ).rejects.toMatchObject({ status: 500 });
  });
});
