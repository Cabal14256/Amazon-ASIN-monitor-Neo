import { afterEach, describe, expect, it, vi } from 'vitest';
import { homeWorkbenchFixture } from '../../../../packages/contracts/test/helpers/home-workbench';
import { HttpClient } from '../lib/http';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import { getHomeWorkbench } from './home-workbench';

const clients: HttpClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
});
function fixture(response: Response | Promise<Response>, baseURL = '/api/') {
  const fetcher = vi.fn<typeof fetch>(async () => response),
    session = sessionFixture();
  const http = new HttpClient({
    baseURL,
    pageOrigin: 'https://app.test',
    session: session.store,
    fetch: fetcher,
  });
  clients.push(http);
  return { http, fetcher };
}
const query = { current: 1, pageSize: 10, facetCurrent: 1 };
describe('Home workbench bounded real transport', () => {
  it.each(['/api/', 'https://app.test/gateway/api/'])(
    'normalizes %s and preserves literal filters in actual GET',
    async (base) => {
      const f = fixture(
        jsonResponse({ success: true, data: homeWorkbenchFixture() }),
        base,
      );
      expect(
        await getHomeWorkbench(f.http, {
          ...query,
          country: 'us',
          site: ' Raw Site ',
          brand: ' Raw Brand ',
          keyword: '20%_',
          facetKeyword: '尾',
        }),
      ).toEqual(homeWorkbenchFixture());
      const url = new URL(String(f.fetcher.mock.calls[0][0]));
      expect(url.pathname).toBe(
        base === '/api/'
          ? '/api/v1/dashboard/workbench'
          : '/gateway/api/v1/dashboard/workbench',
      );
      expect(url.searchParams.get('brand')).toBe(' Raw Brand ');
      expect(url.searchParams.get('keyword')).toBe('20%_');
      expect(f.fetcher.mock.calls[0][1]?.method).toBe('GET');
    },
  );
  it('does not send an unbounded page or invalid filter', async () => {
    const f = fixture(jsonResponse({}));
    await expect(
      getHomeWorkbench(f.http, { ...query, pageSize: 21 }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['/api/', 'https://app.test/gateway/api/'])(
    'preserves an explicit empty brand at the normalized %s endpoint',
    async (base) => {
      const f = fixture(
        jsonResponse({ success: true, data: homeWorkbenchFixture() }),
        base,
      );
      await getHomeWorkbench(f.http, { ...query, brand: '' });
      const url = new URL(String(f.fetcher.mock.calls[0][0]));
      expect(url.pathname).toBe(
        base === '/api/'
          ? '/api/v1/dashboard/workbench'
          : '/gateway/api/v1/dashboard/workbench',
      );
      expect(url.searchParams.has('brand')).toBe(true);
      expect(url.searchParams.get('brand')).toBe('');
      expect(url.pathname).not.toContain('/api/api/');
    },
  );
  it.each(['page', 'day', 'unknown', 'auth'] as const)(
    'rejects inconsistent %s data',
    async (kind) => {
      const data = homeWorkbenchFixture();
      if (kind === 'page') data.current = 2;
      if (kind === 'day') data.days.reverse();
      if (kind === 'unknown') data.list[0].trend![0].unknownChecks = 3;
      if (kind === 'auth') data.trendsAuthorized = false;
      const f = fixture(jsonResponse({ success: true, data }));
      await expect(getHomeWorkbench(f.http, query)).rejects.toMatchObject({
        kind: 'INVALID_RESPONSE',
      });
    },
  );
  it('keeps 512KiB actual bytes bounded before parsing an oversized body', async () => {
    const f = fixture(
      new Response('x'.repeat(512 * 1024 + 1), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getHomeWorkbench(f.http, query)).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
      message: '服务器响应过大',
      status: 200,
    });
  });
  it('aborts an old owner read and ignores a physically late successful response', async () => {
    const pending = deferred<Response>(),
      f = fixture(pending.promise),
      abort = new AbortController();
    const reading = getHomeWorkbench(f.http, query, abort.signal);
    abort.abort();
    await expect(reading).rejects.toMatchObject({ kind: 'CANCELLED' });
    pending.resolve(
      jsonResponse({ success: true, data: homeWorkbenchFixture() }),
    );
  });
});
