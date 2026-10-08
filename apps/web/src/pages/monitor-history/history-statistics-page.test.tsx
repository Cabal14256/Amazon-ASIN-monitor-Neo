// @vitest-environment jsdom
import type { CurrentUserData } from '@asin-monitor/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import type { RouteAuthState } from '../../auth/navigation';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { HistoryBrowser } from './history-browser';
import { HISTORY_SOURCES } from './history-sources';

const router = vi.hoisted(() => ({ search: '' }));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => router.search,
}));
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

const BASE = '/api/v1/monitor-history';
const STATS = `${BASE}/statistics`;
const PEAK = `${STATS}/peak-hours`;
const INTERVALS = `${BASE}/status-intervals`;
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
afterEach(() => {
  cleanup();
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  router.search = '';
  vi.restoreAllMocks();
});

const user = (changes: Partial<CurrentUserData> = {}): CurrentUserData => ({
  user: {
    id: 'reader-a',
    username: 'reader',
    status: 'ACTIVE',
    force_password_change: false,
  },
  sessionId: 'session-a',
  roles: [],
  permissions: ['monitor:read'],
  mustChangePassword: false,
  passwordExpired: false,
  ...changes,
});
const stats = (totalChecks = 1234) => ({
  totalChecks,
  brokenCount: '234',
  normalCount: '1000',
  groupCount: 3,
  asinCount: 7,
  totalDurationHours: 40,
  abnormalDurationHours: 8,
  normalDurationHours: 32,
  ratioAllAsin: 21.5,
  ratioAllTime: 20,
});
const peaks = () => ({
  peakBroken: 2,
  peakTotal: 8,
  peakRate: 25,
  offPeakBroken: 1,
  offPeakTotal: 8,
  offPeakRate: 12.5,
  peakDurationHours: 4,
  peakAbnormalDurationHours: 1,
  peakDurationRate: 25,
  offPeakDurationHours: 4,
  offPeakAbnormalDurationHours: 0.5,
  offPeakDurationRate: 12.5,
});
const record = (name = 'fixture history') => ({
  id: 107,
  asinName: name,
  asin: 'B012345678',
  asin_id: 'asin-fixture',
  variant_group_id: 'group-fixture',
  checkType: 'ASIN',
  country: 'US',
  isBroken: true,
  checkTime: '2026-09-01 12:00:00',
  checkResult: 'private detail result',
});
const ok = (data: unknown) => jsonResponse({ success: true, data });
const failure = (status: number) =>
  jsonResponse(
    {
      success: false,
      errorCode: status,
      errorMessage: status === 503 ? 'database unavailable' : 'read failed',
    },
    status,
  );

interface RequestRead {
  url: URL;
  signal?: AbortSignal | null;
}
type Handler = (request: RequestRead) => Response | Promise<Response>;
function fixture(
  options: {
    initial?: RouteAuthState;
    search?: string;
  } = {},
) {
  router.search = options.search ?? '';
  const requests: RequestRead[] = [];
  const handlers = new Map<string, Handler>();
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { url: new URL(String(input)), signal: init?.signal };
      requests.push(request);
      const handler = handlers.get(request.url.pathname);
      if (handler) return handler(request);
      switch (request.url.pathname) {
        case BASE:
          return ok({
            list: [record()],
            total: 1,
            current: Number(request.url.searchParams.get('current') ?? 1),
            pageSize: Number(request.url.searchParams.get('pageSize') ?? 10),
          });
        case STATS:
          return ok(stats());
        case PEAK:
          return ok(peaks());
        case INTERVALS:
          return ok({
            coverage: 'complete',
            current: 1,
            pageSize: 50,
            total: 1,
            list: [
              {
                asinKey: 'fixture-key',
                asinName: 'fixture interval',
                country: 'US',
                asinId: 'asin-fixture',
                asinCode: 'B012345678',
                variantGroupId: 'group-fixture',
                variantGroupName: null,
                intervalStart: '2026-09-01 00:00:00',
                intervalEnd: null,
                isBroken: true,
              },
            ],
          });
        case `${BASE}/107`:
          return ok(record());
        default:
          throw new Error(`Unexpected request ${request.url.pathname}`);
      }
    },
  );
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test/',
    baseURL: '/api/',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  runtime.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  runtimes.push(runtime);
  let state: RouteAuthState = options.initial ?? {
    status: 'authenticated',
    identity: user(),
  };
  const listeners = new Set<() => void>();
  const setIdentity = (next: RouteAuthState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as IdentityStore;
  // Match IdentityStore's reset response while keeping auth reads out of the
  // fixture: every business read still goes through the real HTTP runtime.
  runtime.subscribeSession((event) => {
    if (event === 'reset') setIdentity({ status: 'anonymous' });
  });
  render(
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <HistoryBrowser source={HISTORY_SOURCES.primary} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return {
    requests,
    handlers,
    runtime,
    setIdentity,
    reads: (path: string) =>
      requests.filter((request) => request.url.pathname === path),
  };
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
function applyCountry(country = 'US') {
  change('国家代码', country);
  fireEvent.click(screen.getByRole('button', { name: '查询' }));
}
const card = () => screen.getByRole('region', { name: '监控检查统计' });
async function ready() {
  await screen.findByText('1,234');
  await waitFor(() =>
    expect(screen.getAllByText('fixture history')).toHaveLength(2),
  );
}

describe('mounted primary history statistics with real HTTP and schemas', () => {
  it('sends only applied statistics scopes, normalizes /api once, refreshes both reads and hides an unset country', async () => {
    const f = fixture();
    await ready();
    expect(f.reads(PEAK)).toHaveLength(0);
    expect(screen.getByText('应用国家筛选后显示高低峰统计。')).toBeTruthy();
    change('国家代码', 'us');
    change('变体组 ID', 'group-fixture');
    change('ASIN ID', 'asin-fixture');
    change('检查类型', 'ASIN');
    change('ASIN（支持多值）', 'B012345678,B087654321');
    change('变体组名称', 'ignored group name');
    change('ASIN 名称', 'ignored asin name');
    change('ASIN 类型', 'child');
    change('异常状态', '1');
    change('开始时间（上海）', '2026-09-01T00:00');
    change('结束时间（上海）', '2026-09-02T00:00');
    expect(f.reads(STATS)).toHaveLength(1);
    expect(f.reads(PEAK)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText('25.00%');
    expect(Object.fromEntries(f.reads(STATS).at(-1)!.url.searchParams)).toEqual(
      {
        country: 'US',
        variantGroupId: 'group-fixture',
        asinId: 'asin-fixture',
        checkType: 'ASIN',
        startTime: '2026-09-01 00:00:00',
        endTime: '2026-09-02 00:00:00',
      },
    );
    expect(Object.fromEntries(f.reads(PEAK).at(-1)!.url.searchParams)).toEqual({
      country: 'US',
      checkType: 'ASIN',
      startTime: '2026-09-01 00:00:00',
      endTime: '2026-09-02 00:00:00',
    });
    expect(
      f.requests.every((request) => !request.url.pathname.includes('/api/api')),
    ).toBe(true);
    expect(within(card()).getByText('1,000')).toBeTruthy();
    expect(within(card()).getByText('234')).toBeTruthy();
    expect(screen.getByText('12.50%')).toBeTruthy();
    expect(screen.queryByText('2500.00%')).toBeNull();
    const priorStats = f.reads(STATS).length,
      priorPeak = f.reads(PEAK).length;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(f.reads(STATS)).toHaveLength(priorStats + 1);
      expect(f.reads(PEAK)).toHaveLength(priorPeak + 1);
    });
    change('国家代码', '');
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText('应用国家筛选后显示高低峰统计。');
    expect(screen.queryByText('25.00%')).toBeNull();
    expect(f.reads(PEAK)).toHaveLength(priorPeak + 1);
  });

  it('keeps a group deep link in totals while explaining the broader peak scope', async () => {
    const f = fixture({ search: '?type=group&id=group-fixture' });
    await ready();
    expect(f.reads(STATS)[0].url.searchParams.get('variantGroupId')).toBe(
      'group-fixture',
    );
    applyCountry();
    await screen.findByText('25.00%');
    expect(f.reads(STATS).at(-1)!.url.searchParams.get('variantGroupId')).toBe(
      'group-fixture',
    );
    expect(f.reads(PEAK)[0].url.searchParams.has('variantGroupId')).toBe(false);
    expect(screen.getByText(/覆盖该范围内全部监控对象/)).toBeTruthy();
  });

  it('rejects malformed statistics independently without inventing zero counts', async () => {
    const f = fixture();
    await ready();
    f.handlers.set(STATS, () => ok({ totalChecks: 0 }));
    applyCountry();
    await screen.findByText('服务器响应契约不匹配');
    await screen.findByText('25.00%');
    expect(within(card()).queryByText('1,234')).toBeNull();
    expect(within(card()).queryByText('总检查次数')).toBeNull();
    expect(screen.getAllByText('fixture history')).toHaveLength(2);
    f.handlers.set(STATS, () => ok(stats(4321)));
    fireEvent.click(screen.getByRole('button', { name: '重试统计' }));
    await screen.findByText('4,321');
  });

  it.each([503, 504])(
    'keeps a peak failure (%i) visible while totals and history remain usable',
    async (status) => {
      const f = fixture();
      await ready();
      f.handlers.set(PEAK, () => failure(status));
      applyCountry();
      await screen.findByRole('button', { name: '重试统计' });
      expect(within(card()).getByText('1,234')).toBeTruthy();
      expect(within(card()).queryByText('0.00%')).toBeNull();
      expect(screen.getAllByText('fixture history')).toHaveLength(2);
      f.handlers.set(PEAK, () => ok(peaks()));
      fireEvent.click(screen.getByRole('button', { name: '重试统计' }));
      await screen.findByText('25.00%');
    },
  );

  it.each([STATS, PEAK])(
    'a 403 from %s conceals every shared read; incomplete recovery keeps them hidden',
    async (path) => {
      const f = fixture();
      await ready();
      change('开始时间（上海）', '2026-09-01T00:00');
      change('结束时间（上海）', '2026-09-02T00:00');
      applyCountry();
      await screen.findByText('25.00%');
      await screen.findByText('fixture interval');
      fireEvent.click(screen.getByRole('button', { name: '详情' }));
      await screen.findByText('private detail result');
      f.handlers.set(path, () => failure(403));
      fireEvent.click(screen.getByRole('button', { name: '刷新' }));
      await screen.findByRole('heading', { name: '读取权限需要重新确认' });
      for (const value of [
        'fixture history',
        'fixture interval',
        'private detail result',
        '1,234',
        '25.00%',
      ])
        expect(screen.queryByText(value)).toBeNull();
      f.handlers.delete(path);
      const other = path === STATS ? PEAK : STATS;
      f.handlers.set(other, () => failure(503));
      fireEvent.click(screen.getByRole('button', { name: '重新验证并读取' }));
      await screen.findByText(
        '重新验证或读取未完成，旧数据继续隐藏，请稍后重试。',
      );
      expect(screen.queryByText('1,234')).toBeNull();
      expect(screen.queryByText('fixture history')).toBeNull();
      f.handlers.delete(other);
      fireEvent.click(screen.getByRole('button', { name: '重新验证并读取' }));
      await ready();
      await screen.findByText('25.00%');
      expect(screen.queryByText('private detail result')).toBeNull();
    },
  );

  it.each([STATS, PEAK])(
    'a real 401 from %s resets identity and removes all history/statistics',
    async (path) => {
      const f = fixture();
      await ready();
      applyCountry();
      await screen.findByText('25.00%');
      f.handlers.set(path, () => failure(401));
      fireEvent.click(screen.getByRole('button', { name: '刷新' }));
      await waitFor(() => expect(screen.queryByText('检查统计')).toBeNull());
      expect(screen.queryByText('fixture history')).toBeNull();
      expect(screen.queryByText('25.00%')).toBeNull();
      expect(f.runtime.session.hasSession()).toBe(false);
    },
  );

  it.each(['owner', 'session'])(
    'aborts old requests on %s change and ignores delayed results',
    async (kind) => {
      const f = fixture();
      await ready();
      const oldStats = deferred<Response>(),
        oldPeak = deferred<Response>();
      f.handlers.set(STATS, () => oldStats.promise);
      f.handlers.set(PEAK, () => oldPeak.promise);
      applyCountry();
      await waitFor(() => expect(f.reads(PEAK)).toHaveLength(1));
      const oldReads = [f.reads(STATS).at(-1)!, f.reads(PEAK).at(-1)!];
      f.handlers.set(STATS, () => ok(stats(9876)));
      f.handlers.delete(PEAK);
      act(() =>
        f.setIdentity({
          status: 'authenticated',
          identity: user({
            ...(kind === 'owner'
              ? { user: { ...user().user, id: 'reader-b' } }
              : {}),
            sessionId: 'session-b',
          }),
        }),
      );
      await screen.findByText('9,876');
      expect(oldReads.every((request) => request.signal?.aborted)).toBe(true);
      await act(async () => {
        oldStats.resolve(ok(stats(5555)));
        oldPeak.resolve(ok({ ...peaks(), peakRate: 99 }));
        await Promise.all([oldStats.promise, oldPeak.promise]);
      });
      expect(screen.queryByText('5,555')).toBeNull();
      expect(screen.queryByText('99.00%')).toBeNull();
      expect(screen.getByText('9,876')).toBeTruthy();
      expect(screen.getByText('应用国家筛选后显示高低峰统计。')).toBeTruthy();
    },
  );

  it.each([
    { status: 'anonymous' } as RouteAuthState,
    {
      status: 'authenticated',
      identity: user({ permissions: ['analytics:read'] }),
    } as RouteAuthState,
  ])(
    'does not read history or statistics for an inaccessible initial identity: $status',
    async (initial) => {
      const f = fixture({ initial });
      await act(async () => undefined);
      expect(f.requests).toHaveLength(0);
      expect(screen.queryByText('检查统计')).toBeNull();
    },
  );

  it('removes current data and aborts in-flight statistics immediately after monitor permission is revoked', async () => {
    const f = fixture();
    await ready();
    const late = deferred<Response>();
    f.handlers.set(STATS, () => late.promise);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(f.reads(STATS)).toHaveLength(2));
    const request = f.reads(STATS).at(-1)!;
    act(() =>
      f.setIdentity({
        status: 'authenticated',
        identity: user({ permissions: [] }),
      }),
    );
    expect(request.signal?.aborted).toBe(true);
    expect(screen.queryByText('fixture history')).toBeNull();
    expect(screen.queryByText('1,234')).toBeNull();
    await act(async () => {
      late.resolve(ok(stats(5555)));
      await late.promise;
    });
    expect(screen.queryByText('5,555')).toBeNull();
    expect(f.reads(STATS)).toHaveLength(2);
  });
});
