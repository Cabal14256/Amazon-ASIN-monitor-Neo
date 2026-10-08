import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import {
  getMonitorStatistics,
  getPeakHoursStatistics,
} from './monitor-statistics';

const statistics = {
  totalChecks: 12,
  brokenCount: '3',
  normalCount: '9',
  groupCount: 2,
  asinCount: 4,
  totalDurationHours: 24,
  abnormalDurationHours: 6,
  normalDurationHours: 18,
  ratioAllAsin: 25,
  ratioAllTime: 25,
};
const peakHours = {
  peakBroken: 2,
  peakTotal: 8,
  peakRate: 25,
  offPeakBroken: 1,
  offPeakTotal: 4,
  offPeakRate: 25,
  peakDurationHours: 16,
  peakAbnormalDurationHours: 4,
  peakDurationRate: 25,
  offPeakDurationHours: 8,
  offPeakAbnormalDurationHours: 2,
  offPeakDurationRate: 25,
};

const clients: HttpClient[] = [];
function setup(baseURL = 'https://api.test/gateway/api/') {
  const fetcher = vi.fn<typeof fetch>();
  const http = new HttpClient({
    baseURL,
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  clients.push(http);
  return { http, fetcher };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
});

describe('monitor statistics transport', () => {
  it.each(['/api/', 'https://api.test/gateway/api/'])(
    'reads both strict Neo results and deduplicates the API prefix for %s',
    async (baseURL) => {
      const f = setup(baseURL);
      f.fetcher.mockResolvedValueOnce(
        jsonResponse({ success: true, errorCode: 0, data: statistics }),
      );
      f.fetcher.mockResolvedValueOnce(
        jsonResponse({ success: true, errorCode: 0, data: peakHours }),
      );
      const query = {
        variantGroupId: ' group ',
        asinId: 'asin-1',
        country: 'US',
        checkType: 'GROUP',
        startTime: '2026-10-08 00:00:00',
        endTime: '2026-10-09 00:00:00',
        asin: 'B000000001',
        asinName: 'Unsupported record filter',
        isBroken: '1',
        current: 2,
        pageSize: 50,
      };
      await expect(getMonitorStatistics(f.http, query)).resolves.toEqual(
        statistics,
      );
      await expect(getPeakHoursStatistics(f.http, query)).resolves.toEqual(
        peakHours,
      );
      const statisticsUrl = new URL(String(f.fetcher.mock.calls[0][0]));
      const peakUrl = new URL(String(f.fetcher.mock.calls[1][0]));
      expect(statisticsUrl.pathname).toBe(
        baseURL.startsWith('https:')
          ? '/gateway/api/v1/monitor-history/statistics'
          : '/api/v1/monitor-history/statistics',
      );
      expect(peakUrl.pathname).toBe(`${statisticsUrl.pathname}/peak-hours`);
      expect(Object.fromEntries(statisticsUrl.searchParams)).toEqual({
        variantGroupId: ' group ',
        asinId: 'asin-1',
        country: 'US',
        checkType: 'GROUP',
        startTime: '2026-10-08 00:00:00',
        endTime: '2026-10-09 00:00:00',
      });
      expect(Object.fromEntries(peakUrl.searchParams)).toEqual({
        country: 'US',
        checkType: 'GROUP',
        startTime: '2026-10-08 00:00:00',
        endTime: '2026-10-09 00:00:00',
      });
      for (const [url, options] of f.fetcher.mock.calls) {
        expect(String(url)).not.toContain('/api/api/');
        expect(options?.credentials).toBe('include');
        expect(options?.method).toBe('GET');
      }
    },
  );

  it('rejects contract-invalid queries before any transport work', async () => {
    const f = setup();
    await expect(
      getMonitorStatistics(f.http, { checkType: 1 as never }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    await expect(
      getPeakHoursStatistics(f.http, { country: '' }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    await expect(
      getPeakHoursStatistics(f.http, { country: 'US', startTime: [] as never }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { success: true },
    { data: statistics },
    { success: true, data: { ...statistics, ratioAllTime: undefined } },
    { success: true, data: { ...statistics, totalChecks: '12' } },
    { success: true, data: { ...statistics, abnormalDurationHours: -1 } },
    { success: true, data: { ...statistics, totalChecks: -1 } },
    { success: true, data: { ...statistics, brokenCount: -1 } },
    { success: true, data: { ...statistics, normalCount: '9.5' } },
    { success: true, data: { ...statistics, groupCount: 1.5 } },
    { success: true, data: { ...statistics, asinCount: -1 } },
    {
      success: true,
      data: { ...statistics, brokenCount: '9007199254740990.5' },
    },
    { success: true, data: { ...statistics, normalCount: '9007199254740993' } },
    {
      success: true,
      data: {
        ...statistics,
        groupCount: Number.MAX_SAFE_INTEGER,
        asinCount: 1,
      },
    },
    { success: true, data: { ...statistics, ratioAllAsin: 100.01 } },
    { success: true, data: { ...statistics, ratioAllTime: -1 } },
  ])('rejects a missing or malformed statistics result %#', async (payload) => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(jsonResponse(payload));
    await expect(getMonitorStatistics(f.http, {})).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });

  it.each([
    { success: true },
    { data: peakHours },
    { success: true, data: { ...peakHours, peakDurationHours: undefined } },
    { success: true, data: { ...peakHours, peakRate: '25' } },
    { success: true, data: { ...peakHours, peakBroken: -1 } },
    {
      success: true,
      data: { ...peakHours, peakTotal: Number.MAX_SAFE_INTEGER + 1 },
    },
    { success: true, data: { ...peakHours, offPeakBroken: 0.5 } },
    { success: true, data: { ...peakHours, offPeakTotal: -1 } },
    { success: true, data: { ...peakHours, peakRate: 100.01 } },
    { success: true, data: { ...peakHours, offPeakRate: -1 } },
    { success: true, data: { ...peakHours, peakDurationRate: 101 } },
    { success: true, data: { ...peakHours, offPeakDurationRate: -1 } },
    { success: true, data: { ...peakHours, peakDurationHours: -1 } },
    { success: true, data: { ...peakHours, peakAbnormalDurationHours: -1 } },
    { success: true, data: { ...peakHours, offPeakDurationHours: -1 } },
    { success: true, data: { ...peakHours, offPeakAbnormalDurationHours: -1 } },
  ])('rejects a missing or malformed peak-hours result %#', async (payload) => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(jsonResponse(payload));
    await expect(
      getPeakHoursStatistics(f.http, { country: 'US' }),
    ).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });

  it('retains zero and exact SQL count strings without rounding nonzero decimal tails', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          ...statistics,
          brokenCount: '0.000',
          normalCount: '9007199254740991.000',
        },
      }),
    );
    const data = await getMonitorStatistics(f.http, {});
    expect(data.brokenCount).toBe('0.000');
    expect(data.normalCount).toBe('9007199254740991.000');
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { ...peakHours, peakRate: 0, offPeakRate: 100 },
      }),
    );
    expect(
      (await getPeakHoursStatistics(f.http, { country: 'US' })).offPeakRate,
    ).toBe(100);
  });

  it('rejects JSON numeric overflow instead of accepting infinite peak metrics', async () => {
    const f = setup();
    const overflow = JSON.stringify({ success: true, data: peakHours }).replace(
      '"peakDurationHours":16',
      '"peakDurationHours":1e400',
    );
    f.fetcher.mockResolvedValueOnce(new Response(overflow));
    await expect(
      getPeakHoursStatistics(f.http, { country: 'US' }),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });

  it.each([403, 413, 429, 503, 504])(
    'preserves HTTP %s for permission and retry handling',
    async (status) => {
      const f = setup();
      f.fetcher.mockResolvedValueOnce(
        jsonResponse(
          { success: false, errorCode: status, errorMessage: '查询暂不可用' },
          status,
        ),
      );
      await expect(getMonitorStatistics(f.http, {})).rejects.toMatchObject({
        kind: 'HTTP',
        status,
        errorCode: status,
        message: '查询暂不可用',
      });
    },
  );

  it('preserves business-error envelopes instead of presenting their data as a success', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        errorCode: 403,
        errorMessage: '读取权限已撤销',
        data: peakHours,
      }),
    );
    await expect(
      getPeakHoursStatistics(f.http, { country: 'US' }),
    ).rejects.toMatchObject({
      kind: 'BUSINESS',
      errorCode: 403,
      message: '读取权限已撤销',
    });
  });

  it('uses the same bounded read and supplied cancellation signal on both APIs', async () => {
    const controller = new AbortController();
    const request = vi
      .fn()
      .mockResolvedValue({ success: true, data: statistics });
    await getMonitorStatistics({ request }, {}, controller.signal);
    request.mockResolvedValueOnce({ success: true, data: peakHours });
    await getPeakHoursStatistics(
      { request },
      { country: 'US' },
      controller.signal,
    );
    for (const call of request.mock.calls) {
      expect(call[1]).toMatchObject({
        timeoutMs: 120_000,
        maxResponseBytes: 32 * 1024 * 1024,
        signal: controller.signal,
      });
    }
  });

  it('accepts a complete valid statistics response above the default HTTP 8 MiB budget', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { ...statistics, extra: 'x'.repeat(9 * 1024 * 1024) },
      }),
    );
    expect((await getMonitorStatistics(f.http, {})).totalChecks).toBe(12);
  });

  it('cancels reading a response exceeding the complete 32 MiB budget', async () => {
    const f = setup();
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    f.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel,
        }),
      ),
    );
    await expect(
      getPeakHoursStatistics(f.http, { country: 'US' }),
    ).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
      message: '服务器响应过大',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels active transport and ignores its late result', async () => {
    const f = setup();
    const response = deferred<Response>();
    f.fetcher.mockReturnValueOnce(response.promise);
    const controller = new AbortController();
    const pending = getMonitorStatistics(f.http, {}, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      kind: 'CANCELLED',
    });
    controller.abort();
    await rejected;
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    response.resolve(jsonResponse({ success: true, data: statistics }));
    await Promise.resolve();
  });

  it('does not start fetch for a pre-cancelled read', async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      getPeakHoursStatistics(f.http, { country: 'US' }, controller.signal),
    ).rejects.toMatchObject({
      kind: 'CANCELLED',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('ends an unresponsive read at the 120-second client deadline', async () => {
    vi.useFakeTimers();
    const f = setup();
    const response = deferred<Response>();
    f.fetcher.mockReturnValueOnce(response.promise);
    const pending = getMonitorStatistics(f.http, {});
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    response.resolve(jsonResponse({ success: true, data: statistics }));
    await Promise.resolve();
  });
});
