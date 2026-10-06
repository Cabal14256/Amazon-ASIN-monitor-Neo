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
import AnalyticsPage from './index';

const engine = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../components/charts/echarts-runtime', () => ({
  init: engine.init,
}));
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
const charts: Array<{
  host: HTMLElement;
  setOption: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}> = [];
const chartOption = (name: string) =>
  [...charts]
    .reverse()
    .find(
      (chart) =>
        chart.host.isConnected &&
        chart.host.closest('figure')?.getAttribute('aria-label') === name,
    )
    ?.setOption.mock.calls.at(-1)?.[0];
const chartValues = (name: string) =>
  chartOption(name)?.series[0].data.map((value: number | [number, number]) =>
    Array.isArray(value) ? value[1] : value,
  );

const metrics = {
  totalDurationHours: 8,
  abnormalDurationHours: 2,
  normalDurationHours: 6,
  peakDurationHours: 4,
  peakAbnormalDurationHours: 1,
  lowDurationHours: 4,
  lowAbnormalDurationHours: 1,
  totalChecks: 12,
  brokenCount: 2,
  totalAsinsDedup: 4,
  brokenAsinsDedup: 1,
  ratioAllAsin: 25,
  ratioAllTime: 25,
  globalPeakRate: 12.5,
  globalLowRate: 12.5,
  ratioHigh: 25,
  ratioLow: 25,
};
const currentUser = (
  overrides: Partial<CurrentUserData> = {},
): CurrentUserData => ({
  user: {
    id: 'reader-1',
    username: 'reader',
    status: 'ACTIVE',
    force_password_change: false,
  },
  sessionId: 'session-1',
  permissions: ['analytics:read'],
  roles: [],
  mustChangePassword: false,
  passwordExpired: false,
  ...overrides,
});
const responseData = (url: URL, marker = 2): unknown => {
  const key = url.pathname.split('/').at(-1);
  const row = { ...metrics, brokenCount: marker };
  switch (key) {
    case 'statistics':
      return { ...row, normalCount: 10, groupCount: 2, asinCount: 4 };
    case 'by-time':
      return Array.from({ length: 30 }, (_, index) => ({
        ...row,
        time_period: `2026-09-${String(index + 1).padStart(2, '0')} 00:00:00`,
        total_asins: 4,
        broken_asins: 1,
        asin_broken_rate: 25,
        normal_count: 10,
      }));
    case 'by-country':
      return [
        {
          country: 'US',
          total_checks: 12,
          broken_count: '2',
          normal_count: '10',
        },
      ];
    case 'all-countries-summary':
      return { ...row, timeRange: 'fixture' };
    case 'region-summary':
      return Array.from({ length: 7 }, (_, index) => ({
        ...row,
        region: `region-${index}`,
        regionCode: String(index),
        timeRange: 'fixture',
      }));
    case 'asin-by-country':
      return [
        {
          ...row,
          country: 'US',
          total_checks: 12,
          broken_count: 2,
          normal_count: 10,
        },
        {
          ...row,
          country: 'UK',
          abnormalDurationHours: 6,
          normalDurationHours: 6,
          totalDurationHours: 12,
          total_checks: 12,
          broken_count: 2,
          normal_count: 10,
        },
      ];
    case 'asin-by-variant-group':
      return Array.from({ length: 50 }, (_, index) => ({
        ...row,
        country: 'US',
        variant_group_id: `group ${index}`,
        variant_group_name: `Group ${index}`,
        total_checks: 12,
        broken_count: 2,
        normal_count: 10,
      }));
    case 'by-variant-group':
      return [
        {
          variant_group_id: 'group 0',
          variant_group_name: 'Group 0',
          total_checks: 12,
          broken_count: '2',
          normal_count: '10',
        },
      ];
    case 'period-summary':
      return { list: [], total: 0, current: 1, pageSize: 20 };
    case 'peak-hours':
      return {
        peakBroken: 1,
        peakTotal: 4,
        peakRate: 25,
        offPeakBroken: 1,
        offPeakTotal: 4,
        offPeakRate: 25,
        peakDurationHours: 4,
        peakAbnormalDurationHours: 1,
        peakDurationRate: 25,
        offPeakDurationHours: 4,
        offPeakAbnormalDurationHours: 1,
        offPeakDurationRate: 25,
      };
    case 'peak-mark-areas':
      return [
        {
          name: 'US',
          color: '#abc',
          areas: [
            [
              { name: 'US', xAxis: '2026-09-01 00:00' },
              { xAxis: '2026-09-02 00:00' },
            ],
          ],
        },
      ];
    case 'analytics-monthly-breakdown':
      return {
        month: url.searchParams.get('month'),
        rows: [],
        summary: {
          abnormalDurationTotal: 0,
          totalDurationTotal: 0,
          averageRatio: 0,
        },
      };
    case 'abnormal-duration-statistics':
      return { timeGranularity: 'day', data: [], summary: [] };
    default:
      throw new Error(`Unexpected Analytics fixture ${key}`);
  }
};
type Read = { url: URL; signal: AbortSignal; reader: CurrentUserData | null };
type Handler = (read: Read) => Response | Promise<Response> | undefined;
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
function fixture({
  state: initialState = { status: 'authenticated', identity: currentUser() },
  handler,
  baseURL = '/api/',
  strict = false,
}: {
  state?: RouteAuthState;
  handler?: Handler;
  baseURL?: string;
  strict?: boolean;
} = {}) {
  let state: RouteAuthState = initialState;
  const reads: Read[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const read = {
        url: new URL(String(input)),
        signal: init?.signal as AbortSignal,
        reader: state.status === 'authenticated' ? state.identity : null,
      };
      reads.push(read);
      return (
        handler?.(read) ??
        jsonResponse({ success: true, data: responseData(read.url) })
      );
    },
  );
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test/',
    baseURL,
    session: sessionFixture().store,
    fetch: fetcher,
  });
  runtime.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 60_000 },
  });
  runtimes.push(runtime);
  const listeners = new Set<() => void>();
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as IdentityStore;
  const element = (
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <AnalyticsPage />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  const view = render(strict ? <StrictMode>{element}</StrictMode> : element);
  return {
    reads,
    fetcher,
    runtime,
    view,
    setState: (next: RouteAuthState) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}
function setRange(start: string, end: string) {
  fireEvent.change(screen.getByLabelText('开始时间（上海）'), {
    target: { value: start },
  });
  fireEvent.change(screen.getByLabelText('结束时间（上海）'), {
    target: { value: end },
  });
  fireEvent.click(screen.getByRole('button', { name: '查询分析' }));
}
beforeEach(() => {
  charts.length = 0;
  engine.init.mockReset().mockImplementation((host: HTMLElement) => {
    const chart = {
      host,
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    };
    charts.push(chart);
    return chart;
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(360);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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

describe('mounted Analytics page with actual Query and REST contracts', () => {
  it.each(['/api/', 'https://app.test/gateway/api/'])(
    'renders full trend and country charts with independent duration switches through %s',
    async (baseURL) => {
      const f = fixture({ baseURL });
      await screen.findByRole('figure', { name: '监控异常趋势' });
      await waitFor(() =>
        expect(chartValues('监控异常趋势')).toEqual(Array(30).fill(25)),
      );
      expect(chartOption('监控异常趋势').xAxis.type).toBe('time');
      expect(chartOption('监控异常趋势').series[0].data[0][0]).toBe(
        Date.parse('2026-09-01T00:00+08:00'),
      );
      expect(chartOption('监控异常趋势').dataZoom).toMatchObject([
        { start: 0, end: 100 },
        { start: 0, end: 100 },
      ]);
      fireEvent.change(screen.getByLabelText('监控异常趋势单位'), {
        target: { value: 'hours' },
      });
      await waitFor(() =>
        expect(chartValues('监控异常趋势')).toEqual(Array(30).fill(2)),
      );
      await screen.findByRole('figure', { name: '各国家正常与异常时长' });
      fireEvent.change(screen.getByLabelText('国家柱状图单位'), {
        target: { value: 'percent' },
      });
      await waitFor(() =>
        expect(chartOption('各国家正常与异常时长')?.series).toMatchObject([
          { data: [25, 50] },
          { data: [75, 50] },
        ]),
      );
      expect(
        screen.getByLabelText<HTMLSelectElement>('国家饼图单位').value,
      ).toBe('hours');
      fireEvent.change(screen.getByLabelText('国家饼图单位'), {
        target: { value: 'percent' },
      });
      await waitFor(() =>
        expect(chartOption('各国家异常时长分布')?.series).toMatchObject([
          { data: [{ value: 25 }, { value: 75 }] },
        ]),
      );
      expect(
        f.reads.every((read) => !read.url.pathname.includes('/api/api/')),
      ).toBe(true);
      expect(
        f.reads.every((read) =>
          read.url.pathname.startsWith(
            baseURL.startsWith('https:') ? '/gateway/api/v1/' : '/api/v1/',
          ),
        ),
      ).toBe(true);
      expect(f.reads[0].url.searchParams.get('startTime')).toBe(
        '2026-08-31 20:00:00',
      );
    },
  );

  it('exposes all 50 ranked groups and permits monitor drilldowns only with verified monitor:read', async () => {
    const f = fixture();
    await screen.findByRole('figure', { name: '监控异常趋势' });
    fireEvent.click(screen.getByRole('tab', { name: /ASIN 与周期/ }));
    await screen.findByText('Group 49');
    await waitFor(() =>
      expect(chartOption('变体组异常时长排行')?.series[0].data).toHaveLength(
        50,
      ),
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    act(() =>
      f.setState({
        status: 'authenticated',
        identity: currentUser({
          permissions: ['analytics:read', 'monitor:read'],
        }),
      }),
    );
    await screen.findAllByRole('link', { name: 'Group 0' });
    expect(
      screen.getByRole('link', { name: 'Group 49' }).getAttribute('href'),
    ).toBe('/monitor-history?type=group&id=group%2049');
    fireEvent.change(screen.getByLabelText('变体组排行单位'), {
      target: { value: 'percent' },
    });
    await waitFor(() =>
      expect(chartOption('变体组异常时长排行')?.series).toMatchObject([
        { data: Array(50).fill(25) },
      ]),
    );
  });

  it.each<RouteAuthState>([
    { status: 'loading' },
    { status: 'anonymous' },
    {
      status: 'authenticated',
      identity: currentUser({ permissions: ['monitor:read'] }),
    },
    {
      status: 'authenticated',
      identity: currentUser({ mustChangePassword: true }),
    },
    {
      status: 'authenticated',
      identity: currentUser({
        user: { ...currentUser().user, status: 'INACTIVE' },
      }),
    },
  ])(
    'does not start or reveal reads before verified analytics permission: %o',
    async (state) => {
      const f = fixture({ state });
      expect(screen.getByText('分析数据暂不可读')).toBeTruthy();
      await act(async () => undefined);
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(screen.queryByRole('figure')).toBeNull();
    },
  );

  it('revokes page data and cancels queued/active reads when permission disappears', async () => {
    const pending = deferred<Response>();
    const f = fixture({ handler: () => pending.promise });
    await waitFor(() => expect(f.reads).toHaveLength(2));
    act(() =>
      f.setState({
        status: 'authenticated',
        identity: currentUser({ permissions: [] }),
      }),
    );
    expect(screen.getByText('分析数据暂不可读')).toBeTruthy();
    await waitFor(() =>
      expect(f.reads.every((read) => read.signal.aborted)).toBe(true),
    );
    await act(async () =>
      pending.resolve(jsonResponse({ success: true, data: [] })),
    );
    expect(f.reads).toHaveLength(2);
    expect(screen.queryByRole('figure')).toBeNull();
  });

  it.each([
    ['reader-2', 'session-2'],
    ['reader-1', 'session-2'],
  ])(
    'hides old cached results and cancels late reads across %s / %s',
    async (id, sessionId) => {
      const late = deferred<Response>();
      let blockOldTrend = false;
      const f = fixture({
        handler: (read) => {
          if (
            blockOldTrend &&
            read.reader?.sessionId === 'session-1' &&
            read.url.pathname.endsWith('/by-time')
          )
            return late.promise;
          return jsonResponse({
            success: true,
            data: responseData(
              read.url,
              read.reader?.sessionId === 'session-1' ? 111 : 222,
            ),
          });
        },
      });
      await screen.findByText('111');
      await screen.findByRole('figure', { name: '监控异常趋势' });
      await waitFor(() => expect(chartOption('监控异常趋势')).toBeTruthy());
      blockOldTrend = true;
      const trendPanel = screen.getByText('异常时长趋势').closest('section');
      if (!trendPanel) throw new Error('Missing trend panel');
      fireEvent.click(
        within(trendPanel as HTMLElement).getByRole('button', { name: '刷新' }),
      );
      await waitFor(() =>
        expect(
          f.reads.some(
            (read) =>
              read.url.pathname.endsWith('/by-time') &&
              !read.signal.aborted &&
              read.reader?.sessionId === 'session-1' &&
              f.reads.indexOf(read) > 1,
          ),
        ).toBe(true),
      );
      const oldCharts = charts.filter((chart) => chart.host.isConnected);
      act(() =>
        f.setState({
          status: 'authenticated',
          identity: currentUser({
            user: { ...currentUser().user, id },
            sessionId,
          }),
        }),
      );
      expect(screen.queryByText('111')).toBeNull();
      await screen.findByText('222');
      expect(
        oldCharts.every((chart) => chart.dispose.mock.calls.length > 0),
      ).toBe(true);
      const oldPending = f.reads
        .filter(
          (read) =>
            read.reader?.sessionId === 'session-1' &&
            read.url.pathname.endsWith('/by-time'),
        )
        .at(-1);
      expect(oldPending?.signal.aborted).toBe(true);
      await act(async () =>
        late.resolve(
          jsonResponse({
            success: true,
            data: (
              responseData(
                new URL(
                  'https://app.test/api/v1/monitor-history/statistics/by-time',
                ),
                999,
              ) as Record<string, unknown>[]
            ).map((row) => ({
              ...row,
              abnormalDurationHours: 7,
              normalDurationHours: 1,
              ratioAllTime: 87.5,
            })),
          }),
        ),
      );
      expect(screen.queryByText('111')).toBeNull();
      expect(chartValues('监控异常趋势')).toEqual(Array(30).fill(25));
      const analyticsKeys = f.runtime.queryClient
        .getQueryCache()
        .findAll({ queryKey: ['analytics'] })
        .map((query) => query.queryKey);
      expect(
        analyticsKeys.some(
          (key) => JSON.stringify(key[1]) === JSON.stringify([id, sessionId]),
        ),
      ).toBe(true);
    },
  );

  it('keeps a server 403 local to its panel and recovers only after an explicit retry', async () => {
    let denied = true;
    fixture({
      handler: (read) =>
        read.url.pathname.endsWith('/by-time') && denied
          ? jsonResponse({ errorMessage: 'Denied' }, 403)
          : undefined,
    });
    const error = await screen.findByText(
      '当前账号没有数据分析读取权限，请联系管理员。',
    );
    expect(screen.queryByRole('figure', { name: '监控异常趋势' })).toBeNull();
    await screen.findByRole('figure', { name: '各国家正常与异常时长' });
    denied = false;
    const alert = error.closest('[role="alert"]');
    if (!alert) throw new Error('Missing error panel');
    fireEvent.click(
      within(alert as HTMLElement).getByRole('button', { name: '重试' }),
    );
    await screen.findByRole('figure', { name: '监控异常趋势' });
  });

  it('cancels sibling and queued months on a mounted range failure and retries complete intersections', async () => {
    const july = deferred<Response>();
    const august = deferred<Response>();
    let failMonths = true;
    const f = fixture({
      handler: (read) => {
        if (
          failMonths &&
          read.url.pathname.endsWith('/analytics-monthly-breakdown')
        ) {
          if (read.url.searchParams.get('month') === '2026-07')
            return july.promise;
          if (read.url.searchParams.get('month') === '2026-08')
            return august.promise;
        }
        return undefined;
      },
    });
    await screen.findByRole('figure', { name: '监控异常趋势' });
    setRange('2026-07-15T09:30', '2026-09-20T17:15');
    await screen.findByRole('figure', { name: '监控异常趋势' });
    fireEvent.click(screen.getByRole('tab', { name: /高峰与时长/ }));
    await waitFor(() =>
      expect(
        f.reads.filter((read) =>
          read.url.pathname.endsWith('/analytics-monthly-breakdown'),
        ),
      ).toHaveLength(2),
    );
    await act(async () =>
      july.resolve(jsonResponse({ errorMessage: 'Month failed' }, 400)),
    );
    const failure = await screen.findByText('Month failed');
    await waitFor(() =>
      expect(
        f.reads.find((read) => read.url.searchParams.get('month') === '2026-08')
          ?.signal.aborted,
      ).toBe(true),
    );
    expect(
      f.reads.some((read) => read.url.searchParams.get('month') === '2026-09'),
    ).toBe(false);
    failMonths = false;
    await act(async () =>
      august.resolve(
        jsonResponse({
          success: true,
          data: responseData(
            new URL(
              'https://app.test/api/v1/monitor-history/statistics/analytics-monthly-breakdown?month=2026-08',
            ),
          ),
        }),
      ),
    );
    const alert = failure.closest('[role="alert"]');
    if (!alert) throw new Error('Missing monthly error');
    fireEvent.click(
      within(alert as HTMLElement).getByRole('button', { name: '重试' }),
    );
    await screen.findByRole('figure', { name: '月度异常拆分' });
    const julyRead = f.reads
      .filter((read) => read.url.searchParams.get('month') === '2026-07')
      .at(-1);
    const septemberRead = [...f.reads]
      .reverse()
      .find((read) => read.url.searchParams.get('month') === '2026-09');
    expect(julyRead?.url.searchParams.get('startTime')).toBe(
      '2026-07-15 09:30:00',
    );
    expect(julyRead?.url.searchParams.get('endTime')).toBe(
      '2026-07-31 23:59:59',
    );
    expect(septemberRead?.url.searchParams.get('startTime')).toBe(
      '2026-09-01 00:00:00',
    );
    expect(septemberRead?.url.searchParams.get('endTime')).toBe(
      '2026-09-20 17:15:00',
    );
  });

  it('can toggle hour peaks without discarding any timeline slots', async () => {
    fixture({ strict: true });
    await screen.findByRole('figure', { name: '监控异常趋势' });
    fireEvent.change(screen.getByLabelText('趋势粒度'), {
      target: { value: 'hour' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查询分析' }));
    const peak = await screen.findByRole('checkbox', { name: '美国高峰' });
    await waitFor(() =>
      expect(chartOption('监控异常趋势')?.series[0].markArea.data).toHaveLength(
        1,
      ),
    );
    fireEvent.click(peak);
    await waitFor(() =>
      expect(chartOption('监控异常趋势')?.series[0].markArea).toBeUndefined(),
    );
    expect(chartOption('监控异常趋势').series[0].data).toHaveLength(30);
  });

  it('keeps invalid month durations local to the chart instead of drawing fabricated zero values', async () => {
    fixture({
      handler: (read) =>
        read.url.pathname.endsWith('/analytics-monthly-breakdown')
          ? jsonResponse({
              success: true,
              data: {
                month: read.url.searchParams.get('month'),
                rows: [
                  {
                    date: `${read.url.searchParams.get('month')}-01`,
                    day: 1,
                    abnormalDurationHours: -1,
                    totalDurationHours: 2,
                    abnormalDurationRate: -50,
                  },
                ],
                summary: {
                  abnormalDurationTotal: -1,
                  totalDurationTotal: 2,
                  averageRatio: -50,
                },
              },
            })
          : undefined,
    });
    await screen.findByRole('figure', { name: '监控异常趋势' });
    fireEvent.click(screen.getByRole('tab', { name: /高峰与时长/ }));
    await screen.findByText('时长统计缺少有效数据，请刷新该统计面板。');
    expect(chartOption('月度异常拆分')).toBeUndefined();
    expect(screen.getByText('US 高峰与低峰')).toBeTruthy();
  });

  it('makes peak intervals beyond the old eight-row limit reachable with readable pagination', async () => {
    const time = (hour: number) =>
      new Date(Date.UTC(2026, 8, 1, hour))
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ');
    fixture({
      handler: (read) =>
        read.url.pathname.endsWith('/peak-mark-areas')
          ? jsonResponse({
              success: true,
              data: [
                {
                  name: 'US',
                  color: '#abc',
                  areas: Array.from({ length: 55 }, (_, hour) => [
                    { name: 'US', xAxis: time(hour) },
                    { xAxis: time(hour + 1) },
                  ]),
                },
              ],
            })
          : undefined,
    });
    await screen.findByRole('figure', { name: '监控异常趋势' });
    fireEvent.change(screen.getByLabelText('趋势粒度'), {
      target: { value: 'hour' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查询分析' }));
    fireEvent.click(screen.getByRole('tab', { name: /高峰与时长/ }));
    const intervals = await screen.findByRole('list', { name: '美国高峰时段' });
    expect(within(intervals).getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText('第 1 / 2 页 · 共 55 个高峰时段')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一页高峰' }));
    expect(within(intervals).getAllByRole('listitem')).toHaveLength(5);
    expect(
      within(intervals).getByText(`${time(54)} 至 ${time(55)}`),
    ).toBeTruthy();
  });
});
