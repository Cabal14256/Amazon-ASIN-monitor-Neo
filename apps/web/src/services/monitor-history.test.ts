import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import {
  getMonitorHistory,
  getMonitorHistoryDetail,
  historyId,
} from './monitor-history';

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
  check_type: 'ASIN',
  country: 'US',
  is_broken: 1,
  check_time: '2026-09-23T00:00:00Z',
  check_result: '{"state":"broken"}',
  notification_sent: 0,
  variant_group_name: 'Snapshot group',
  asin_name: 'Snapshot ASIN',
};

describe('monitor history API boundary', () => {
  it('reads filtered pages with a normalized URL and retains an unknown total', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { list: [row], total: null, current: 2, pageSize: 10 },
      }),
    );
    const data = await getMonitorHistory(f.http, {
      asin: 'B000000001, B000000002',
      isBroken: '1',
      startTime: '2026-09-23 09:30:00',
      current: 2,
      pageSize: 10,
    });
    expect(data.total).toBeNull();
    expect(data.list[0].variant_group_name).toBe('Snapshot group');
    const url = String(f.fetcher.mock.calls[0][0]);
    expect(url).toContain('/gateway/api/v1/monitor-history?');
    expect(url).not.toContain('/api/api/');
    expect(new URL(url).searchParams.get('asin')).toBe(
      'B000000001, B000000002',
    );
    expect(new URL(url).searchParams.get('startTime')).toBe(
      '2026-09-23 09:30:00',
    );
    expect(f.fetcher.mock.calls[0][1]?.credentials).toBe('include');
  });

  it('accepts an API-valid aliased history payload above the generic 32 MiB override', async () => {
    const f = setup();
    const result = 'x'.repeat(17 * 1024 * 1024);
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
    const data = await getMonitorHistory(f.http, { current: 1, pageSize: 10 });
    expect(data.list[0].check_result).toHaveLength(result.length);
  });

  it('checks detail identity and rejects invalid IDs before transport', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(jsonResponse({ success: true, data: row }));
    expect((await getMonitorHistoryDetail(f.http, 7)).id).toBe(7);
    expect(f.fetcher.mock.calls[0][0]).toBe(
      'https://api.test/gateway/api/v1/monitor-history/7',
    );
    f.fetcher.mockResolvedValueOnce(jsonResponse({ success: true, data: row }));
    await expect(getMonitorHistoryDetail(f.http, 8)).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    expect(() => historyId(0)).toThrow();
    expect(() => historyId(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    await expect(getMonitorHistoryDetail(f.http, 0)).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects pagination beyond the server contract and malformed envelopes', async () => {
    const f = setup();
    await expect(
      getMonitorHistory(f.http, { current: 1, pageSize: 101 }),
    ).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(jsonResponse({ success: true }));
    await expect(
      getMonitorHistory(f.http, { current: 1, pageSize: 10 }),
    ).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { list: [{ ...row, id: 0 }], total: 1, current: 1, pageSize: 10 },
      }),
    );
    await expect(
      getMonitorHistory(f.http, { current: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
});
