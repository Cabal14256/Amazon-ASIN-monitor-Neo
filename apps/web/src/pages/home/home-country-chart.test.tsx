// @vitest-environment jsdom
import type { DashboardData, WsMessage } from '@asin-monitor/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import type { RouteAuthState } from '../../auth/navigation';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { DASHBOARD_SERVER_TTL_MS } from './dashboard-data';
import HomePage from './index';

const engine = vi.hoisted(() => ({ init: vi.fn(), imported: vi.fn() }));
vi.mock('../../components/charts/echarts-runtime', () => {
  engine.imported();
  return { init: engine.init };
});
const charts: Array<{
  setOption: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}> = [];
const latestOption = () => charts.at(-1)?.setOption.mock.calls.at(-1)?.[0];

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const counters = {
  totalGroups: 4,
  totalASINs: 6,
  brokenGroups: 1,
  brokenASINs: 1,
  todayChecks: 2,
  todayBroken: 1,
  normalGroups: 3,
  normalASINs: 5,
};
const zeroCounters = Object.fromEntries(
  Object.keys(counters).map((key) => [key, 0]),
) as typeof counters;
function dashboard(
  rows: DashboardData['distribution']['byCountry'] = [
    { country: 'US', normal: 3, broken: '1', total: 4 },
    { country: 'UK', normal: 0, broken: '0', total: 0 },
  ],
): DashboardData {
  return {
    overview: {
      ...counters,
      overviewByCountry: {
        US: counters,
        UK: zeroCounters,
        DE: zeroCounters,
        FR: zeroCounters,
        IT: zeroCounters,
        ES: zeroCounters,
      },
    },
    distribution: { byCountry: rows },
    realtimeAlerts: { brokenGroups: [], brokenASINs: [] },
    recentActivities: [],
  };
}
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
function fixture(
  responses: (Response | Promise<Response>)[],
  baseURL = '/api/',
  strict = false,
) {
  const requests: { url: string; signal?: AbortSignal | null }[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), signal: init?.signal });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected dashboard read');
      return response;
    },
  );
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test/',
    baseURL,
    session: sessionFixture().store,
    fetch: fetcher,
  });
  runtime.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  runtimes.push(runtime);
  let state: RouteAuthState = {
    status: 'authenticated',
    identity: {
      user: {
        id: 'reader-1',
        username: 'reader',
        status: 'ACTIVE',
        force_password_change: false,
      },
      sessionId: 'session-1',
      permissions: ['dashboard:read'],
      roles: [],
      mustChangePassword: false,
      passwordExpired: false,
    },
  };
  const listeners = new Set<() => void>();
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as IdentityStore;
  let emit: (message: WsMessage) => void = () => undefined;
  vi.spyOn(runtime.ws, 'onMessage').mockImplementation((handler) => {
    emit = handler;
    return () => {
      emit = () => undefined;
    };
  });
  const element = (
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <HomePage />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  const view = render(strict ? <StrictMode>{element}</StrictMode> : element);
  return {
    requests,
    fetcher,
    runtime,
    view,
    emit: (message: WsMessage) => emit(message),
    setOwner: (id: string, sessionId = id + '-session') => {
      if (state.status !== 'authenticated')
        throw new Error('Fixture not authenticated');
      state = {
        ...state,
        identity: {
          ...state.identity,
          user: { ...state.identity.user, id },
          sessionId,
        },
      };
      for (const listener of listeners) listener();
    },
  };
}
beforeEach(() => {
  charts.length = 0;
  engine.imported.mockClear();
  engine.init.mockReset().mockImplementation(() => {
    const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    charts.push(chart);
    return chart;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('mounted Home country chart using the real dashboard transport and Query', () => {
  it.each([
    ['/api/', 'https://app.test/api/v1/dashboard'],
    [
      'https://app.test/gateway/api/',
      'https://app.test/gateway/api/v1/dashboard',
    ],
  ])(
    'renders the actual country chart and readable counts through %s without duplicate API prefixes',
    async (base, url) => {
      const f = fixture(
        [jsonResponse({ success: true, data: dashboard() })],
        base,
      );
      await screen.findByText('正常 3 · 异常 1');
      expect(f.requests.map((request) => request.url)).toEqual([url]);
      expect(
        screen.getByRole('figure', { name: '站点正常与异常变体组' }),
      ).toBeTruthy();
      expect(screen.getByText('正常 0 · 异常 0')).toBeTruthy();
      await waitFor(() =>
        expect(
          latestOption()?.series.map(
            (series: { data: number[] }) => series.data,
          ),
        ).toEqual([
          [3, 0],
          [1, 0],
        ]),
      );
      expect(latestOption()?.aria.label.description).toContain(
        '美国：正常 3，异常 1，共 4 组',
      );
      expect(latestOption()?.tooltip.renderMode).toBe('richText');
      fireEvent.click(screen.getByRole('button', { name: '英国 0' }));
      expect(screen.queryByText('正常 3 · 异常 1')).toBeNull();
      await waitFor(() =>
        expect(
          latestOption()?.series.map(
            (series: { data: number[] }) => series.data,
          ),
        ).toEqual([[0], [0]]),
      );
      expect(
        screen.getByRole('figure', { name: '站点正常与异常变体组' }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '法国 0' }));
      expect(screen.getByText('暂无站点数据')).toBeTruthy();
      expect(
        screen.queryByRole('figure', { name: '站点正常与异常变体组' }),
      ).toBeNull();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('shows the initial loading and request failure before rendering a chart on an explicit retry', async () => {
    const pending = deferred<Response>();
    fixture([
      pending.promise,
      jsonResponse({ success: true, data: dashboard() }),
    ]);
    expect(screen.getByLabelText('正在加载仪表盘')).toBeTruthy();
    expect(screen.queryByRole('figure')).toBeNull();
    await act(async () =>
      pending.resolve(
        jsonResponse({ message: 'Unable to read dashboard' }, 400),
      ),
    );
    expect(await screen.findByText('仪表盘暂不可用')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    expect(
      await screen.findByRole('figure', { name: '站点正常与异常变体组' }),
    ).toBeTruthy();
  });
  it('does not import or initialize the engine for an initially empty snapshot', async () => {
    fixture([jsonResponse({ success: true, data: dashboard([]) })]);
    expect(await screen.findByText('暂无站点数据')).toBeTruthy();
    await vi.dynamicImportSettled();
    expect(engine.imported).not.toHaveBeenCalled();
    expect(engine.init).not.toHaveBeenCalled();
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.getByRole('region', { name: '站点筛选' })).toBeTruthy();
  });
  it.each([
    { total: 6 },
    { broken: '0.5' },
    { normal: -1 },
    { total: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    'reports local invalid count feedback without drawing or hiding the rest of Home: %j',
    async (change) => {
      fixture([
        jsonResponse({
          success: true,
          data: dashboard([
            { country: 'US', total: 4, normal: 3, broken: '1', ...change },
          ]),
        }),
      ]);
      expect(await screen.findByText('站点状态暂不可用')).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toContain(
        '站点计数不完整或不一致',
      );
      expect(engine.init).not.toHaveBeenCalled();
      expect(screen.queryByRole('figure')).toBeNull();
      expect(screen.getByRole('region', { name: '关键指标' })).toBeTruthy();
      expect(screen.getByRole('region', { name: '站点筛选' })).toBeTruthy();
    },
  );
  it('retains the prior successful chart and the existing stale snapshot notice when a refresh fails', async () => {
    fixture([
      jsonResponse({ success: true, data: dashboard() }),
      jsonResponse({ message: 'Refresh failed' }, 400),
    ]);
    await screen.findByText('正常 3 · 异常 1');
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(
      await screen.findByText('最新刷新失败，当前显示上一次成功读取的数据。'),
    ).toBeTruthy();
    expect(screen.getByText('正常 3 · 异常 1')).toBeTruthy();
    expect(
      screen.getByRole('figure', { name: '站点正常与异常变体组' }),
    ).toBeTruthy();
  });
  it('updates the actual selected chart on a primary WS invalidation without fetching on country clicks', async () => {
    const f = fixture([
      jsonResponse({ success: true, data: dashboard() }),
      jsonResponse({
        success: true,
        data: dashboard([{ country: 'US', total: 5, normal: 3, broken: '2' }]),
      }),
    ]);
    await screen.findByText('正常 3 · 异常 1');
    fireEvent.click(screen.getByRole('button', { name: '美国 4' }));
    await act(async () => f.emit({ type: 'stats_update' }));
    await screen.findByText('正常 3 · 异常 2');
    await waitFor(() =>
      expect(
        latestOption()?.series.map((series: { data: number[] }) => series.data),
      ).toEqual([[3], [2]]),
    );
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole('button', { name: '美国 4' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });
  it('re-reads after the server cache window and drops the old snapshot only when a new valid snapshot arrives', async () => {
    const f = fixture([
      jsonResponse({ success: true, data: dashboard() }),
      jsonResponse({ success: true, data: dashboard() }),
      jsonResponse({ success: true, data: dashboard() }),
      jsonResponse({
        success: true,
        data: dashboard([{ country: 'US', total: 5, normal: 3, broken: '2' }]),
      }),
    ]);
    await screen.findByText('正常 3 · 异常 1');
    vi.useFakeTimers();
    await act(async () => {
      f.emit({ type: 'stats_update' });
      await vi.advanceTimersByTimeAsync(0);
    });
    // Preserve the existing 30-second poll. It can still read the cached
    // snapshot; the separate 31-second completion read obtains fresh data.
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText('正常 3 · 异常 1')).toBeTruthy();
    await act(async () =>
      vi.advanceTimersByTimeAsync(DASHBOARD_SERVER_TTL_MS + 999),
    );
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(screen.getByText('正常 3 · 异常 1')).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTimeAsync(5));
    expect(screen.getByText('正常 3 · 异常 2')).toBeTruthy();
    expect(
      latestOption()?.series.map((series: { data: number[] }) => series.data),
    ).toEqual([[3], [2]]);
  });
  it('uses the actual status CSS tokens and the foundation reduced-motion policy for the business series', async () => {
    const originalStyle = getComputedStyle;
    vi.stubGlobal('getComputedStyle', (element: Element) => {
      const style = originalStyle(element);
      const originalProperty = style.getPropertyValue.bind(style);
      style.getPropertyValue = (name: string) =>
        name === '--color-status-success'
          ? '#145a32'
          : name === '--color-status-danger'
          ? '#a01726'
          : originalProperty(name);
      return style;
    });
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    fixture([jsonResponse({ success: true, data: dashboard() })]);
    await screen.findByText('正常 3 · 异常 1');
    await waitFor(() =>
      expect(
        latestOption()?.series.map(
          (series: { itemStyle: { color: string } }) => series.itemStyle.color,
        ),
      ).toEqual(['#145a32', '#a01726']),
    );
    expect(latestOption()?.animation).toBe(false);
    expect(latestOption()?.animationDurationUpdate).toBe(0);
    expect(
      latestOption()?.series.every(
        (series: { animation: boolean; animationDurationUpdate: number }) =>
          series.animation === false && series.animationDurationUpdate === 0,
      ),
    ).toBe(true);
  });
  it.each([
    ['reader-2', 'new-user-session'],
    ['reader-1', 'new-same-user-session'],
  ])(
    'hides the prior %s snapshot immediately and ignores its late refresh after a session switch',
    async (id, sessionId) => {
      const oldRead = deferred<Response>();
      const newRead = deferred<Response>();
      const f = fixture([
        jsonResponse({ success: true, data: dashboard() }),
        oldRead.promise,
        newRead.promise,
      ]);
      await screen.findByText('正常 3 · 异常 1');
      fireEvent.click(screen.getByRole('button', { name: '刷新' }));
      await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
      act(() => f.setOwner(id, sessionId));
      expect(screen.queryByText('正常 3 · 异常 1')).toBeNull();
      expect(screen.queryByRole('figure')).toBeNull();
      await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
      expect(f.requests[1].signal?.aborted).toBe(true);
      await act(async () =>
        oldRead.resolve(
          jsonResponse({
            success: true,
            data: dashboard([
              { country: 'US', total: 99, normal: 99, broken: '0' },
            ]),
          }),
        ),
      );
      expect(screen.queryByText('正常 99 · 异常 0')).toBeNull();
      expect(screen.queryByRole('figure')).toBeNull();
      await act(async () =>
        newRead.resolve(
          jsonResponse({
            success: true,
            data: dashboard([
              { country: 'US', total: 2, normal: 1, broken: '1' },
            ]),
          }),
        ),
      );
      await screen.findByText('正常 1 · 异常 1');
      await waitFor(() =>
        expect(
          latestOption()?.series.map(
            (series: { data: number[] }) => series.data,
          ),
        ).toEqual([[1], [1]]),
      );
      expect(screen.queryByText('正常 99 · 异常 0')).toBeNull();
    },
  );
  it('allows StrictMode to restart the consumed canceled read without a global cancellation of the fresh query', async () => {
    const discarded = deferred<Response>();
    const f = fixture(
      [discarded.promise, jsonResponse({ success: true, data: dashboard() })],
      '/api/',
      true,
    );
    await screen.findByText('正常 3 · 异常 1');
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0].signal?.aborted).toBe(true);
    expect(f.requests[1].signal?.aborted).toBe(false);
    await act(async () =>
      discarded.resolve(jsonResponse({ success: true, data: dashboard([]) })),
    );
    expect(screen.queryByText('暂无站点数据')).toBeNull();
    expect(
      screen.getByRole('figure', { name: '站点正常与异常变体组' }),
    ).toBeTruthy();
  });
});
