import type { DashboardData } from '@asin-monitor/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { getDashboard } from './dashboard';

const counters = {
  totalGroups: 0,
  totalASINs: 0,
  brokenGroups: 0,
  brokenASINs: 0,
  todayChecks: 0,
  todayBroken: 0,
  normalGroups: 0,
  normalASINs: 0,
};
const data: DashboardData = {
  overview: { ...counters, overviewByCountry: {} },
  realtimeAlerts: { brokenGroups: [], brokenASINs: [] },
  distribution: { byCountry: [] },
  recentActivities: [],
};
const clients: HttpClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe('dashboard transport', () => {
  it.each(['/api', 'https://app.test/api/'])(
    'uses the shared /api normalization for %s and validates dashboard data',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        jsonResponse({ success: true, errorCode: 0, data }),
      );
      const client = new HttpClient({
        pageOrigin: 'https://app.test',
        baseURL,
        session: sessionFixture().store,
        fetch: fetcher,
      });
      clients.push(client);
      await expect(getDashboard(client)).resolves.toEqual(data);
      expect(fetcher.mock.calls[0][0]).toBe(
        'https://app.test/api/v1/dashboard',
      );
    },
  );
  it('rejects a successful envelope without usable counters', async () => {
    const client = new HttpClient({
      pageOrigin: 'https://app.test',
      baseURL: '/api/',
      session: sessionFixture().store,
      fetch: async () =>
        jsonResponse({ success: true, errorCode: 0, data: { overview: {} } }),
    });
    clients.push(client);
    await expect(getDashboard(client)).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });
  it('uses the dashboard-specific 120-second and 32 MiB transport bounds', async () => {
    const request = vi.fn().mockResolvedValue({ success: true, data });
    await expect(
      getDashboard({ request } as unknown as Pick<HttpClient, 'request'>),
    ).resolves.toEqual(data);
    expect(request).toHaveBeenCalledWith(
      '/api/v1/dashboard',
      {
        signal: undefined,
        timeoutMs: 120_000,
        maxResponseBytes: 32 * 1024 * 1024,
      },
      expect.anything(),
    );
  });
});
