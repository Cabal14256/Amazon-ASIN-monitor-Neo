// @vitest-environment jsdom
import {
  homeWorkbenchDataSchema,
  type CurrentUserData,
} from '@asin-monitor/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeWorkbenchFixture } from '../../../../../packages/contracts/test/helpers/home-workbench';
import { AuthContext } from '../../auth/context';
import { IdentityStore } from '../../auth/identity';
import { RouteGate } from '../../auth/route-gate';
import {
  deferred,
  FakeSocket,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { HOME_WORKBENCH_QUERY_KEY } from '../../services/home-workbench';
import { createTransportRuntime } from '../../services/runtime';
import { HomeWorkbench } from './home-workbench';

const ENDPOINT = '/api/v1/dashboard/workbench';
const BLANK_BRAND = '';
const RAW_BRAND = ' Raw Brand ';
const SITE = ' amazon.com ';
type Runtime = ReturnType<typeof createTransportRuntime>;
const resources: Array<{ runtime: Runtime; identity: IdentityStore }> = [];

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  for (const { runtime, identity } of resources.splice(0)) {
    identity.stop();
    runtime.dispose();
  }
  vi.restoreAllMocks();
});

interface Read {
  url: URL;
  method: string;
  signal?: AbortSignal | null;
}

/** Only the HTTP transport is synthetic. Identity, route access, Query and
 * production service/schema parsing all execute without module mocks. */
function fixture({ total = 2 } = {}) {
  const requests: Read[] = [];
  let deny = false;
  let trendsAuthorized = true;
  let authResponse: ReturnType<typeof deferred<Response>> | undefined;
  let nextWorkbenchResponse: ReturnType<typeof deferred<Response>> | undefined;
  const identityData: CurrentUserData = {
    user: {
      id: 'workbench-reader',
      username: 'Fixture reader',
      status: 'ACTIVE',
      force_password_change: false,
    },
    sessionId: 'workbench-session',
    permissions: ['dashboard:read', 'asin:read', 'monitor:read'],
    roles: [],
    mustChangePassword: false,
    passwordExpired: false,
  };
  const dataFor = (url: URL) => {
    const value = homeWorkbenchFixture();
    const current = Number(url.searchParams.get('current') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 10);
    const brand = url.searchParams.get('brand');
    const country = url.searchParams.get('country');
    const label =
      brand === BLANK_BRAND
        ? 'Blank brand group'
        : brand === RAW_BRAND
        ? 'Raw brand group'
        : country === 'US'
        ? 'US group'
        : 'ALL group';
    value.current = current;
    value.pageSize = pageSize;
    value.facetCurrent = Number(url.searchParams.get('facetCurrent') ?? 1);
    const filteredTotal =
      brand === BLANK_BRAND
        ? Math.floor(total / 2)
        : brand === RAW_BRAND
        ? Math.ceil(total / 2)
        : total;
    value.total = filteredTotal;
    const offset = (current - 1) * pageSize;
    const template = value.list[0];
    value.list = Array.from(
      { length: Math.min(pageSize, Math.max(0, filteredTotal - offset)) },
      (_, index) => ({
        ...template,
        id: ` Raw group ${offset + index + 1} `,
        name: `${label} page ${current}${
          index === 0 ? '' : ` row ${index + 1}`
        }`,
        brand: brand ?? (index % 2 ? BLANK_BRAND : RAW_BRAND),
      }),
    );
    value.facets = [BLANK_BRAND, RAW_BRAND].map((item) => ({
      country: 'US',
      site: SITE,
      brand: item,
      totalGroups:
        item === BLANK_BRAND ? Math.floor(total / 2) : Math.ceil(total / 2),
    }));
    if (!trendsAuthorized) {
      value.trendsAuthorized = false;
      value.list = value.list.map((group) => ({ ...group, trend: null }));
    }
    // A malformed test response must fail here, before reaching the product.
    return homeWorkbenchDataSchema.parse(value);
  };
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const read = {
      url: new URL(String(input)),
      method: options?.method ?? 'GET',
      signal: options?.signal,
    };
    requests.push(read);
    if (read.url.pathname === '/api/v1/auth/current-user')
      return (
        authResponse?.promise ??
        jsonResponse({ success: true, data: identityData })
      );
    if (read.url.pathname !== ENDPOINT || read.method !== 'GET')
      return jsonResponse(
        {
          success: false,
          errorCode: 404,
          errorMessage: 'Unexpected fixture route',
        },
        404,
      );
    const held = nextWorkbenchResponse;
    nextWorkbenchResponse = undefined;
    if (held) return held.promise;
    if (deny)
      return jsonResponse(
        {
          success: false,
          errorCode: 403,
          errorMessage: 'Workbench read revoked',
        },
        403,
      );
    return jsonResponse({ success: true, data: dataFor(read.url) });
  });
  const runtime = createTransportRuntime({
    baseURL: '/api/',
    pageOrigin: 'https://app.test',
    fetch: fetcher,
    session: sessionFixture().store,
    socket: () => new FakeSocket(),
  });
  runtime.queryClient.setDefaultOptions({ queries: { retry: false } });
  const identity = new IdentityStore(runtime);
  resources.push({ runtime, identity });
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/home'] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/home',
        component: () => (
          <RouteGate>
            <HomeWorkbench
              country="ALL"
              countryControls={<p>Fixture dashboard country controls</p>}
              statusPanel={<p>Fixture independent dashboard status panel</p>}
              alertsPanel={<p>Fixture independent dashboard alerts panel</p>}
            />
          </RouteGate>
        ),
      }),
      createRoute({
        getParentRoute: () => root,
        path: '/login',
        component: () => <p>Fixture login page</p>,
      }),
      createRoute({
        getParentRoute: () => root,
        path: '/asin',
        component: () => <p>Fixture catalog destination</p>,
      }),
    ]),
  });
  identity.start();
  render(
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return {
    runtime,
    identity,
    identityData,
    router,
    requests,
    reads: () => requests.filter((read) => read.url.pathname === ENDPOINT),
    deny: (value: boolean) => {
      deny = value;
    },
    trends: (value: boolean) => {
      trendsAuthorized = value;
    },
    holdIdentity: () => {
      authResponse = deferred<Response>();
      return authResponse;
    },
    holdWorkbench: () => {
      nextWorkbenchResponse = deferred<Response>();
      return nextWorkbenchResponse;
    },
    responseFor: (url: URL) =>
      jsonResponse({ success: true, data: dataFor(url) }),
  };
}

async function applyUS() {
  fireEvent.change(screen.getByRole('textbox', { name: '工作台国家' }), {
    target: { value: 'US' },
  });
  fireEvent.submit(
    screen.getByRole('button', { name: '应用工作台筛选' }).closest('form')!,
  );
  await screen.findByRole('link', { name: 'US group page 1' });
}

function clearFilters() {
  fireEvent.click(screen.getByRole('button', { name: '清除工作台筛选' }));
}

describe('Home workbench actual identity, route and typed query boundaries', () => {
  it('applies the exact nonempty facet through the real GET service', async () => {
    const f = fixture();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    fireEvent.click(screen.getByRole('button', { name: /Raw Brand/ }));
    await screen.findByRole('link', { name: 'Raw brand group page 1' });
    const last = f.reads().at(-1)!;
    expect(last.url.pathname).toBe(ENDPOINT);
    expect(last.url.searchParams.get('country')).toBe('US');
    expect(last.url.searchParams.get('site')).toBe(SITE);
    expect(last.url.searchParams.get('brand')).toBe(RAW_BRAND);
    expect(f.requests.every((read) => read.method === 'GET')).toBe(true);
    expect(f.identity.getSnapshot().status).toBe('authenticated');
  });

  it('selects the real empty-brand facet without losing the literal filter or rejecting it before HTTP', async () => {
    const f = fixture();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    fireEvent.click(screen.getByRole('button', { name: /空品牌/ }));
    await waitFor(() =>
      expect(
        f
          .reads()
          .some(
            (read) =>
              read.url.searchParams.has('brand') &&
              read.url.searchParams.get('brand') === BLANK_BRAND,
          ),
      ).toBe(true),
    );
    await screen.findByRole('link', { name: 'Blank brand group page 1' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(f.reads().at(-1)!.url.searchParams.get('site')).toBe(SITE);
    expect(f.requests.every((read) => read.method === 'GET')).toBe(true);
  });

  it('keeps ordinary pagination at its real final page', async () => {
    const f = fixture({ total: 11 });
    await screen.findByRole('link', { name: 'ALL group page 1' });
    fireEvent.click(screen.getByRole('button', { name: '下一页变体组' }));
    await screen.findByRole('link', { name: 'ALL group page 2' });
    expect(
      (
        screen.getByRole('button', {
          name: '下一页变体组',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      f.reads().map((read) => read.url.searchParams.get('current')),
    ).toEqual(['1', '2']);
  });

  it('stops at current 1000 before offering a schema-invalid next page when total exceeds 10000', async () => {
    const f = fixture({ total: 10_001 });
    await screen.findByRole('link', { name: 'ALL group page 1' });
    // The production page has no jump-to-page control. Traverse the real user
    // actions and real typed requests rather than injecting hook state or
    // returning a mismatched page number that the service would reject.
    for (let page = 2; page <= 1000; page++) {
      await act(async () => {
        const next = document.querySelector<HTMLButtonElement>(
          'button[aria-label="下一页变体组"]',
        );
        expect(next).not.toBeNull();
        expect(next!.disabled).toBe(false);
        fireEvent.click(next!);
      });
      await waitFor(
        () => {
          const link = document.querySelector<HTMLAnchorElement>(
            'section[aria-label="首页变体组工作台"] tbody tr:first-child a',
          );
          expect(link?.textContent).toBe(`ALL group page ${page}`);
          expect(link?.getAttribute('href')).toContain('/asin?groupId=');
        },
        { interval: 1 },
      );
    }
    expect(
      screen.getByRole('link', { name: 'ALL group page 1000' }),
    ).toBeTruthy();
    expect(
      f.reads().map((read) => read.url.searchParams.get('current')),
    ).toEqual(Array.from({ length: 1000 }, (_, index) => String(index + 1)));
    expect(f.reads().at(-1)!.url.searchParams.get('current')).toBe('1000');
    expect(f.reads().at(-1)!.url.searchParams.get('pageSize')).toBe('10');
    const next = screen.getByRole('button', {
      name: '下一页变体组',
    }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    const before = f.reads().length;
    fireEvent.click(next);
    expect(f.reads()).toHaveLength(before);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/已达到分页浏览上限/)).toBeTruthy();
  }, 60_000);

  it('keeps unapplied drafts out of GETs and reuses an authorized same-scope ALL cache', async () => {
    const f = fixture();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    const before = f.reads().length;
    fireEvent.change(screen.getByRole('textbox', { name: '工作台国家' }), {
      target: { value: 'US' },
    });
    expect(f.reads()).toHaveLength(before);
    expect(screen.getByRole('link', { name: 'ALL group page 1' })).toBeTruthy();
    await applyUS();
    const afterUS = f.reads().length;
    clearFilters();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    expect(f.reads()).toHaveLength(afterUS);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps every cached row and trend hidden after a real US 403 even when filters return to a fresh ALL key', async () => {
    const f = fixture();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    await applyUS();
    // Both keys hold successful snapshots. Revoke the actual HTTP read, while
    // the real IdentityStore still has the last verified same-session grants.
    const cached = f.runtime.queryClient.getQueryCache().findAll({
      queryKey: HOME_WORKBENCH_QUERY_KEY,
    });
    expect(cached.filter((query) => query.state.data)).toHaveLength(2);
    f.deny(true);
    fireEvent.click(screen.getByRole('button', { name: '刷新工作台' }));
    await screen.findByText('Workbench read revoked');
    expect(screen.queryByRole('link', { name: 'US group page 1' })).toBeNull();
    const before = f.reads().length;
    clearFilters();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('link', { name: 'ALL group page 1' })).toBeNull();
    expect(
      screen.queryByRole('img', { name: /近七日组检查异常率/ }),
    ).toBeNull();
    expect(f.reads()).toHaveLength(before);
    expect(f.requests.every((read) => read.method === 'GET')).toBe(true);
  });

  it('retires all same-identity historical caches after a 200 response withdraws trend authority', async () => {
    const f = fixture();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    await applyUS();
    expect(
      screen.getAllByRole('img', { name: /近七日组检查异常率/ }),
    ).toHaveLength(2);
    f.trends(false);
    fireEvent.click(screen.getByRole('button', { name: '刷新工作台' }));
    await screen.findByText(/没有历史读取权限/);
    expect(screen.getByRole('link', { name: 'US group page 1' })).toBeTruthy();
    clearFilters();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    expect(
      screen.queryAllByRole('img', { name: /近七日组检查异常率/ }),
    ).toHaveLength(0);
    const cached = f.runtime.queryClient.getQueriesData({
      queryKey: HOME_WORKBENCH_QUERY_KEY,
    });
    for (const [, data] of cached) {
      if (!data) continue;
      expect(homeWorkbenchDataSchema.parse(data).trendsAuthorized).toBe(false);
      expect(
        homeWorkbenchDataSchema
          .parse(data)
          .list.every((group) => group.trend === null),
      ).toBe(true);
    }
    // A later authorized response under the same verified identity cannot
    // restore history after the server withdrew its current grant.
    f.trends(true);
    await act(async () => {
      await f.runtime.queryClient.invalidateQueries({
        queryKey: HOME_WORKBENCH_QUERY_KEY,
      });
    });
    expect(
      screen.queryAllByRole('img', { name: /近七日组检查异常率/ }),
    ).toHaveLength(0);
    await act(async () => {
      await f.router.navigate({ to: '/asin' });
    });
    await screen.findByText('Fixture catalog destination');
    await act(async () => {
      await f.router.navigate({ to: '/home' });
    });
    await screen.findByRole('link', { name: 'ALL group page 1' });
    expect(
      screen.queryAllByRole('img', { name: /近七日组检查异常率/ }),
    ).toHaveLength(0);
    await act(async () => {
      await f.identity.refresh();
    });
    await screen.findByRole('img', { name: /^ALL group page 1近七日/ });
  });

  it('recovers only after actual identity verification and a successful fresh workbench GET', async () => {
    const f = fixture();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    f.deny(true);
    fireEvent.click(screen.getByRole('button', { name: '刷新工作台' }));
    await screen.findByText('Workbench read revoked');
    expect(screen.queryByRole('link', { name: 'ALL group page 1' })).toBeNull();
    const verification = f.holdIdentity();
    const read = f.holdWorkbench();
    const before = f.reads().length;
    fireEvent.click(screen.getByRole('button', { name: '重试工作台读取' }));
    await screen.findByText('正在验证登录状态…');
    expect(screen.queryByRole('link', { name: 'ALL group page 1' })).toBeNull();
    f.deny(false);
    await act(async () => {
      verification.resolve(
        jsonResponse({ success: true, data: f.identityData }),
      );
      await verification.promise;
    });
    await waitFor(() => expect(f.reads().length).toBeGreaterThan(before));
    expect(f.identity.getSnapshot().status).toBe('authenticated');
    expect(screen.queryByRole('link', { name: 'ALL group page 1' })).toBeNull();
    await act(async () => {
      read.resolve(f.responseFor(f.reads().at(-1)!.url));
      await read.promise;
    });
    await screen.findByRole('link', { name: 'ALL group page 1' });
    expect(screen.queryByText('Workbench read revoked')).toBeNull();
    expect(
      f.requests.filter((item) => item.url.pathname.endsWith('/current-user')),
    ).toHaveLength(2);
    expect(f.requests.every((item) => item.method === 'GET')).toBe(true);
  });

  it('keeps the real same verified identity denied across cache invalidation and route remounts', async () => {
    const f = fixture();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    const verified = f.identity.getSnapshot();
    f.deny(true);
    fireEvent.click(screen.getByRole('button', { name: '刷新工作台' }));
    await screen.findByText('Workbench read revoked');
    f.deny(false);
    const before = f.reads().length;
    await act(async () => {
      await f.runtime.queryClient.invalidateQueries({
        queryKey: HOME_WORKBENCH_QUERY_KEY,
      });
      await f.router.navigate({ to: '/asin' });
    });
    await screen.findByText('Fixture catalog destination');
    await act(async () => {
      await f.router.navigate({ to: '/home' });
    });
    await screen.findByText('Workbench read revoked');
    expect(f.identity.getSnapshot()).toBe(verified);
    expect(screen.queryByRole('link', { name: 'ALL group page 1' })).toBeNull();
    expect(f.reads()).toHaveLength(before);
    fireEvent.click(screen.getByRole('button', { name: '重试工作台读取' }));
    await screen.findByRole('link', { name: 'ALL group page 1' });
    expect(f.identity.getSnapshot()).not.toBe(verified);
    expect(f.reads()).toHaveLength(before + 1);
  });

  it('does not use a failed identity refresh to clear a read denial or start a workbench GET', async () => {
    const f = fixture();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    f.deny(true);
    fireEvent.click(screen.getByRole('button', { name: '刷新工作台' }));
    await screen.findByText('Workbench read revoked');
    const verification = f.holdIdentity();
    const before = f.reads().length;
    fireEvent.click(screen.getByRole('button', { name: '重试工作台读取' }));
    await screen.findByText('正在验证登录状态…');
    await act(async () => {
      verification.resolve(jsonResponse({ success: false }, 503));
      await verification.promise;
    });
    await screen.findByText('暂时无法验证登录状态');
    expect(f.identity.getSnapshot().status).toBe('error');
    expect(f.reads()).toHaveLength(before);
    expect(screen.queryByRole('link', { name: 'ALL group page 1' })).toBeNull();
  });

  it('keeps a recoverable 500 separate from a sticky authorization denial', async () => {
    const f = fixture();
    await screen.findByRole('link', { name: 'ALL group page 1' });
    const response = f.holdWorkbench();
    fireEvent.click(screen.getByRole('button', { name: '刷新工作台' }));
    await act(async () => {
      response.resolve(
        jsonResponse(
          {
            success: false,
            errorCode: 500,
            errorMessage: 'Temporary read failure',
          },
          500,
        ),
      );
      await response.promise;
    });
    await screen.findByText('Temporary read failure');
    expect(screen.getByRole('link', { name: 'ALL group page 1' })).toBeTruthy();
    expect(
      screen.getByText('当前保留上一次成功读取的同范围数据。'),
    ).toBeTruthy();
    await applyUS();
    expect(screen.queryByText('Temporary read failure')).toBeNull();
    expect(f.identity.getSnapshot().status).toBe('authenticated');
  });
});
