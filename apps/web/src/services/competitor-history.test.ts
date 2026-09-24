import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import {
  getCompetitorHistory,
  getCompetitorHistoryDetail,
} from './competitor-history';

const clients: HttpClient[] = [];
function setup() {
  const session = sessionFixture();
  const fetcher = vi.fn<typeof fetch>();
  const http = new HttpClient({
    baseURL: 'https://api.test/gateway/api/',
    pageOrigin: 'https://app.test',
    session: session.store,
    fetch: fetcher,
  });
  clients.push(http);
  return { http, fetcher };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

const row = {
  id: 7,
  variant_group_id: 'group-1',
  asin_id: 'asin-1',
  asin: 'B000000001',
  parentAsin: 'B000000000',
  check_type: 'ASIN',
  country: 'US',
  is_broken: 1,
  check_time: '2026-09-23T00:00:00Z',
  check_result: '{"state":"broken"}',
};

describe('competitor history API boundary', () => {
  it('reads filtered pages with normalized URL, single LIKE pattern and unknown total', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { list: [row], total: null, current: 2, pageSize: 10 },
      }),
    );
    const data = await getCompetitorHistory(f.http, {
      asin: 'B000%',
      isBroken: '1',
      startTime: '2026-09-23 09:30:00',
      current: 2,
      pageSize: 10,
    });
    expect(data.total).toBeNull();
    expect(data.list[0].parentAsin).toBe('B000000000');
    const url = String(f.fetcher.mock.calls[0][0]);
    expect(url).toContain('/gateway/api/v1/competitor/monitor-history?');
    expect(url).not.toContain('/api/api/');
    expect(new URL(url).searchParams.get('asin')).toBe('B000%');
    expect(new URL(url).searchParams.get('startTime')).toBe(
      '2026-09-23 09:30:00',
    );
    expect(f.fetcher.mock.calls[0][1]?.credentials).toBe('include');
  });

  it('accepts an API-valid aliased competitor history response above the generic task limit', async () => {
    const f = setup();
    const result = 'x'.repeat(21 * 1024 * 1024);
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          list: [{ ...row, check_result: result, checkResult: result }],
          total: 1,
          current: 1,
          pageSize: 10,
        },
      }),
    );
    const data = await getCompetitorHistory(f.http, {
      current: 1,
      pageSize: 10,
    });
    expect(data.list[0].check_result).toHaveLength(result.length);
  });

  it('checks detail identity and requires the competitor parent ASIN field', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(jsonResponse({ success: true, data: row }));
    expect((await getCompetitorHistoryDetail(f.http, 7)).parentAsin).toBe(
      'B000000000',
    );
    expect(f.fetcher.mock.calls[0][0]).toBe(
      'https://api.test/gateway/api/v1/competitor/monitor-history/7',
    );
    f.fetcher.mockResolvedValueOnce(jsonResponse({ success: true, data: row }));
    await expect(getCompetitorHistoryDetail(f.http, 8)).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { ...row, parentAsin: undefined } }),
    );
    await expect(getCompetitorHistoryDetail(f.http, 7)).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    await expect(getCompetitorHistoryDetail(f.http, 0)).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid pagination and mismatched list envelopes', async () => {
    const f = setup();
    await expect(
      getCompetitorHistory(f.http, { current: 1, pageSize: 101 }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { list: [row], total: 1, current: 2, pageSize: 10 },
      }),
    );
    await expect(
      getCompetitorHistory(f.http, { current: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
});
