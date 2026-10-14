// @vitest-environment jsdom
import type { CurrentUserData } from '@asin-monitor/contracts';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
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
import { IdentityStore } from '../../auth/identity';
import {
  deferred,
  FakeSocket,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { createAppRouter } from '../../router';
import { createTransportRuntime } from '../../services/runtime';

// Only the visual shell is replaced. The application router, RouteGate,
// IdentityStore, HistoryBrowser, QueryClient and typed HTTP remain real.
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));

const BASE = '/api/v1/monitor-history';
const ABNORMAL = `${BASE}/abnormal-duration-statistics`;
const STATS = `${BASE}/statistics`;
const PEAK = `${STATS}/peak-hours`;
const INTERVALS = `${BASE}/status-intervals`;
const CURRENT_USER = '/api/v1/auth/current-user';
const START = '2026-09-01 00:00:00';
const END = '2026-09-02 00:00:00';
const HEADERS = [
  'ASIN',
  '国家',
  '查询时间段',
  '异常次数',
  '平均异常时长',
  '最短异常时长',
  '最长异常时长',
  '最长异常时间',
];
const disposals: (() => void)[] = [];
const originalCreateURL = Object.getOwnPropertyDescriptor(
  URL,
  'createObjectURL',
);
const originalRevokeURL = Object.getOwnPropertyDescriptor(
  URL,
  'revokeObjectURL',
);
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  for (const [key, descriptor] of [
    ['createObjectURL', originalCreateURL],
    ['revokeObjectURL', originalRevokeURL],
  ] as const) {
    if (descriptor) Object.defineProperty(URL, key, descriptor);
    else Reflect.deleteProperty(URL, key);
  }
});

const user = (changes: Partial<CurrentUserData> = {}): CurrentUserData => ({
  user: {
    id: 'reader-a',
    username: 'fixture',
    status: 'ACTIVE',
    force_password_change: false,
  },
  sessionId: 'session-a',
  permissions: ['monitor:read'],
  roles: [],
  mustChangePassword: false,
  passwordExpired: false,
  ...changes,
});
const summaryRow = (index = 0) => ({
  key: `summary-${index}`,
  asin: `SUMMARY-${String(index).padStart(5, '0')}`,
  country: 'US',
  queryTimeRange: `${START} 至 ${END}`,
  abnormalCount: 7,
  averageAbnormalDuration: 1.234,
  minAbnormalDuration: 0.004,
  maxAbnormalDuration: 4.567,
  maxAbnormalTime: '2026-09-01 12:34:56',
});
type SummaryRow = ReturnType<typeof summaryRow>;
const result = (summary: SummaryRow[] = [summaryRow()]) => ({
  timeGranularity: 'hour',
  // Summary is authoritative: the series is deliberately empty.
  data: [],
  summary,
});
const ok = (data: unknown) => jsonResponse({ success: true, data });
const failure = (status: number) =>
  jsonResponse(
    { success: false, errorCode: status, errorMessage: 'fixture refusal' },
    status,
  );
const statisticsResponse = () =>
  ok({
    totalChecks: 1234,
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
const peakResponse = () =>
  ok({
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
interface RequestRead {
  url: URL;
  signal?: AbortSignal | null;
  method?: string;
}
type Handler = (request: RequestRead) => Response | Promise<Response>;

async function fixture(
  options: { path?: string; identity?: CurrentUserData } = {},
) {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const requests: RequestRead[] = [];
  const handlers = new Map<string, Handler>();
  let currentIdentity = options.identity ?? user();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = {
      url: new URL(String(input)),
      signal: init?.signal,
      method: init?.method,
    };
    requests.push(request);
    const handler = handlers.get(request.url.pathname);
    if (handler) return handler(request);
    switch (request.url.pathname) {
      case CURRENT_USER:
        return ok(currentIdentity);
      case BASE:
      case '/api/v1/competitor/monitor-history':
        return ok({
          list: [
            {
              id: 107,
              asin: 'RECORD-ONLY',
              asinName: 'healthy existing history',
              country: 'US',
              isBroken: true,
              checkTime: START,
              parentAsin: null,
            },
          ],
          total: 1,
          current: Number(request.url.searchParams.get('current') ?? 1),
          pageSize: Number(request.url.searchParams.get('pageSize') ?? 10),
        });
      case STATS:
        return statisticsResponse();
      case PEAK:
        return peakResponse();
      case INTERVALS:
        return ok({
          coverage: 'complete',
          current: 1,
          pageSize: 50,
          total: 0,
          list: [],
        });
      case ABNORMAL:
        return ok(result());
      default:
        throw new Error(`Unexpected fixture request ${request.url.pathname}`);
    }
  });
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test/',
    baseURL: '/api/',
    session: sessionFixture().store,
    fetch: fetcher,
    socket: () => new FakeSocket(),
  });
  runtime.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  const identity = new IdentityStore(runtime);
  const history = createMemoryHistory({
    initialEntries: [options.path ?? '/monitor-history'],
  });
  const router = createAppRouter(identity, history);
  router.update({
    isServer: false,
    origin: 'https://app.test',
    context: { identity },
  });
  disposals.push(() => {
    identity.stop();
    runtime.dispose();
    history.destroy();
  });
  await act(async () => {
    await router.load();
  });
  render(
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return {
    requests,
    handlers,
    identity,
    runtime,
    history,
    router,
    setUser: (next: CurrentUserData) => {
      currentIdentity = next;
    },
    reads: (path: string) =>
      requests.filter((request) => request.url.pathname === path),
  };
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
function applyScope(changes: Record<string, string> = {}) {
  change('ASIN ID', 'asin-fixture');
  change('开始时间（上海）', '2026-09-01T00:00');
  change('结束时间（上海）', '2026-09-02T00:00');
  for (const [label, value] of Object.entries(changes)) change(label, value);
  fireEvent.click(screen.getByRole('button', { name: '查询' }));
}
async function historyReady() {
  await waitFor(
    () =>
      expect(screen.getAllByText('healthy existing history')).toHaveLength(2),
    { timeout: 10_000 },
  );
}
async function summaryReady(asin = 'SUMMARY-00000') {
  // On unchanged main this assertion is the intended mounted missing-feature
  // RED, after real identity and existing history have already succeeded.
  await screen.findByText(asin);
  return screen.getByRole('region', { name: '异常时长统计' });
}
function csvCapture() {
  const blobs: Blob[] = [];
  const links: { filename: string; href: string }[] = [];
  const createURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return `blob:summary-${blobs.length}`;
  });
  const revokeURL = vi.fn<(url: string) => void>();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeURL,
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      links.push({ filename: this.download, href: this.href });
    });
  return { blobs, links, createURL, revokeURL, click };
}

function holdAnalytics(f: Awaited<ReturnType<typeof fixture>>) {
  let active = 0;
  let maximum = 0;
  let refusals = 0;
  const pending: {
    request: RequestRead;
    release: (value?: Response) => void;
  }[] = [];
  for (const path of [STATS, PEAK, ABNORMAL])
    f.handlers.set(path, (request) => {
      if (active >= 2) {
        refusals++;
        return failure(429);
      }
      active++;
      maximum = Math.max(maximum, active);
      const response = deferred<Response>();
      pending.push({
        request,
        release: (value) =>
          response.resolve(
            value ??
              (path === STATS
                ? statisticsResponse()
                : path === PEAK
                ? peakResponse()
                : ok(result())),
          ),
      });
      // Deliberately ignore abort: admission remains held until actual work
      // completes, matching HttpClient's existing non-cooperating fetch guard.
      return response.promise.finally(() => active--);
    });
  return { pending, maximum: () => maximum, refusals: () => refusals };
}
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}
async function csvText(blob: Blob) {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    await blobBytes(blob),
  );
}
const exportCsv = () =>
  fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));

describe('Issue 241 mounted history abnormal summary and local CSV', () => {
  it('review: retains summary and CSV for an accepted equal timestamp range', async () => {
    const f = await fixture();
    await historyReady();
    applyScope({ '结束时间（上海）': '2026-09-01T00:00' });
    await summaryReady();
    expect(f.reads(BASE).at(-1)!.url.searchParams.get('endTime')).toBe(START);
    expect(f.reads(ABNORMAL).at(-1)!.url.searchParams.get('endTime')).toBe(
      START,
    );
    const csv = csvCapture();
    exportCsv();
    expect(csv.blobs).toHaveLength(1);
  });

  it.each([700, 1000])(
    'review: applies %i supported list ASINs independently of the summary URL budget',
    async (count) => {
      const f = await fixture();
      await historyReady();
      applyScope();
      await summaryReady();
      const codes = Array.from(
        { length: count },
        (_, index) => `B${String(index).padStart(9, '0')}`,
      ).join(',');
      applyScope({ 'ASIN（支持多值）': codes });
      await waitFor(() =>
        expect(f.reads(BASE).at(-1)!.url.searchParams.get('asin')).toBe(codes),
      );
      const region = screen.getByRole('region', { name: '异常时长统计' });
      expect(within(region).getByRole('alert').textContent).toMatch(
        /请求地址|减少/,
      );
      expect(f.reads(ABNORMAL)).toHaveLength(1);
      expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
      expect(screen.queryByText('SUMMARY-00000')).toBeNull();
      const csv = csvCapture();
      expect(csv.createURL).not.toHaveBeenCalled();
      applyScope({ 'ASIN（支持多值）': 'B000000001' });
      await summaryReady();
      expect(f.reads(ABNORMAL)).toHaveLength(2);
    },
  );

  it('review: stays within two actual analytics reads on apply and refresh', async () => {
    const f = await fixture();
    await historyReady();
    const admission = holdAnalytics(f);
    applyScope({ 国家代码: 'US' });
    await waitFor(() => expect(admission.pending).toHaveLength(2));
    expect(f.reads(ABNORMAL)).toHaveLength(0);
    await act(async () => admission.pending[0].release());
    await waitFor(() => expect(admission.pending).toHaveLength(3));
    await act(async () => {
      admission.pending[1].release();
      admission.pending[2].release();
    });
    await summaryReady();
    const first = f.requests.length;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(admission.pending).toHaveLength(5));
    expect(
      f.requests.slice(first).filter((r) => r.url.pathname === ABNORMAL),
    ).toHaveLength(0);
    await act(async () => admission.pending[3].release());
    await waitFor(() => expect(admission.pending).toHaveLength(6));
    await act(async () => {
      admission.pending[4].release();
      admission.pending[5].release();
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '刷新' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    expect(admission.maximum()).toBe(2);
    expect(admission.refusals()).toBe(0);
  });

  it('review: cancels queued scope work and retains occupied slots until delayed aborted fetches settle', async () => {
    const f = await fixture();
    await historyReady();
    const admission = holdAnalytics(f);
    applyScope({ 国家代码: 'US' });
    await waitFor(() => expect(admission.pending).toHaveLength(2));
    const old = admission.pending.map(({ request }) => request);
    applyScope({ 国家代码: 'DE' });
    await act(async () => undefined);
    expect(old.every((request) => request.signal?.aborted)).toBe(true);
    expect(admission.pending).toHaveLength(2);
    expect(f.reads(ABNORMAL)).toHaveLength(0);
    await act(async () => admission.pending[0].release());
    await waitFor(() => expect(admission.pending).toHaveLength(3));
    expect(admission.pending[2].request.url.searchParams.get('country')).toBe(
      'DE',
    );
    await act(async () => admission.pending[1].release());
    await waitFor(() => expect(admission.pending).toHaveLength(4));
    await act(async () => admission.pending[2].release());
    await waitFor(() => expect(admission.pending).toHaveLength(5));
    await act(async () => {
      admission.pending[3].release();
      admission.pending[4].release();
    });
    await summaryReady();
    expect(f.reads(ABNORMAL)).toHaveLength(1);
    expect(f.reads(ABNORMAL)[0].url.searchParams.get('country')).toBe('DE');
    expect(admission.refusals()).toBe(0);
  });

  it('review: cancels queued abnormal reads after a 403 and limits concurrent recovery reads', async () => {
    const f = await fixture();
    await historyReady();
    const admission = holdAnalytics(f);
    applyScope({ 国家代码: 'US' });
    await waitFor(() => expect(admission.pending).toHaveLength(2));
    await act(async () => admission.pending[0].release(failure(403)));
    await screen.findByRole('heading', { name: '读取权限需要重新确认' });
    expect(f.reads(ABNORMAL)).toHaveLength(0);
    expect(admission.pending[1].request.signal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重新验证并读取' }));
    await waitFor(() => expect(admission.pending).toHaveLength(3));
    expect(f.reads(ABNORMAL)).toHaveLength(0);
    await act(async () => admission.pending[1].release());
    await waitFor(() => expect(admission.pending).toHaveLength(4));
    await act(async () => admission.pending[2].release());
    await waitFor(() => expect(admission.pending).toHaveLength(5));
    await act(async () => {
      admission.pending[3].release();
      admission.pending[4].release();
    });
    await summaryReady();
    await historyReady();
    expect(admission.refusals()).toBe(0);
    expect(admission.maximum()).toBe(2);
  });

  it('review: limits focus refetches through the same analytics queue', async () => {
    const f = await fixture();
    await historyReady();
    applyScope({ 国家代码: 'US' });
    await summaryReady();
    const prior = f.reads(ABNORMAL).length;
    const admission = holdAnalytics(f);
    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitFor(() => expect(admission.pending).toHaveLength(2));
      expect(f.reads(ABNORMAL)).toHaveLength(prior);
      await act(async () => admission.pending[0].release());
      await waitFor(() => expect(admission.pending).toHaveLength(3));
      await act(async () => {
        admission.pending[1].release();
        admission.pending[2].release();
      });
      await waitFor(() => expect(f.reads(ABNORMAL)).toHaveLength(prior + 1));
      expect(admission.maximum()).toBe(2);
      expect(admission.refusals()).toBe(0);
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  it.each(['owner', 'session'] as const)(
    'review: shares occupied admission across a %s remount without starting stale queued work',
    async (kind) => {
      const f = await fixture();
      await historyReady();
      const admission = holdAnalytics(f);
      applyScope({ 国家代码: 'US' });
      await waitFor(() => expect(admission.pending).toHaveLength(2));
      const next = user(
        kind === 'session'
          ? { sessionId: 'session-b' }
          : { user: { ...user().user, id: 'reader-b' } },
      );
      f.setUser(next);
      await act(async () => {
        await f.identity.refresh();
      });
      expect(
        admission.pending.every(({ request }) => request.signal?.aborted),
      ).toBe(true);
      expect(admission.pending).toHaveLength(2);
      expect(f.reads(ABNORMAL)).toHaveLength(0);
      expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
      await act(async () => admission.pending[0].release());
      await waitFor(() => expect(admission.pending).toHaveLength(3));
      expect(admission.pending[2].request.url.pathname).toBe(STATS);
      expect(admission.pending[2].request.url.searchParams.has('country')).toBe(
        false,
      );
      await act(async () => {
        admission.pending[1].release();
        admission.pending[2].release();
      });
      await historyReady();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: '刷新' }).hasAttribute('disabled'),
        ).toBe(false),
      );
      expect(admission.refusals()).toBe(0);
      expect(f.reads(ABNORMAL)).toHaveLength(0);
    },
  );
  it('CONTROL: reads actual current-user and existing history/statistics without a scoped duration request', async () => {
    const f = await fixture();
    await historyReady();
    expect(f.identity.getSnapshot().status).toBe('authenticated');
    expect(f.reads(CURRENT_USER)).toHaveLength(1);
    expect(f.reads(STATS)).toHaveLength(1);
    expect(f.reads(ABNORMAL)).toHaveLength(0);
    expect(screen.getByText('1,234')).toBeTruthy();
  });

  it('CONTROL: competitor history never calls the primary duration endpoint', async () => {
    const f = await fixture({ path: '/competitor-monitor-history' });
    await historyReady();
    applyScope();
    await historyReady();
    expect(f.reads(ABNORMAL)).toHaveLength(0);
    expect(screen.queryByRole('region', { name: '异常时长统计' })).toBeNull();
  }, 15_000);

  it('CONTROL: actual RouteGate denies an initial identity without monitor:read', async () => {
    const f = await fixture({
      identity: user({ permissions: ['analytics:read'] }),
    });
    await screen.findByRole('heading', { name: '你暂无访问权限' });
    expect(f.reads(BASE)).toHaveLength(0);
    expect(f.reads(ABNORMAL)).toHaveLength(0);
    expect(screen.queryByText('healthy existing history')).toBeNull();
  });

  it('RED: applies only supported duration scopes through typed HTTP with includeSeries=0 and displays all eight columns', async () => {
    const f = await fixture();
    await historyReady();
    applyScope({
      '变体组 ID': 'group-fixture',
      变体组名称: 'group %_',
      'ASIN（支持多值）': 'B000000001,B000000002',
      'ASIN 名称': 'name %_',
      'ASIN 类型': 'child',
      国家代码: 'us',
      检查类型: 'ASIN',
      异常状态: '1',
    });
    const region = await summaryReady();
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(HEADERS);
    const request = f.reads(ABNORMAL).at(-1)!;
    expect(request.method).toBe('GET');
    expect(
      Object.fromEntries(
        [...request.url.searchParams].filter(([key]) => !key.endsWith('[]')),
      ),
    ).toEqual({
      includeSeries: '0',
      startTime: START,
      endTime: END,
      variantGroupId: 'group-fixture',
      variantGroupName: 'group %_',
      asinName: 'name %_',
      asinType: 'child',
      country: 'US',
    });
    expect(request.url.searchParams.getAll('asinIds[]')).toEqual([
      'asin-fixture',
    ]);
    expect(request.url.searchParams.getAll('asinCodes[]')).toEqual([
      'B000000001',
      'B000000002',
    ]);
    expect(request.url.searchParams.has('asinIds')).toBe(false);
    expect(request.url.searchParams.has('asinCodes')).toBe(false);
    expect(
      f.requests.every((read) => !read.url.pathname.includes('/api/api')),
    ).toBe(true);
    expect(within(region).getByText('美国')).toBeTruthy();
    expect(within(region).getByText('1.23 小时')).toBeTruthy();
    expect(within(region).getByText('0.00 小时')).toBeTruthy();
    expect(within(region).getByText('4.57 小时')).toBeTruthy();
    expect(within(region).getByText('7')).toBeTruthy();
    expect(within(region).queryByText('RECORD-ONLY')).toBeNull();
    expect(region.textContent).toMatch(
      /检查类型.*异常状态.*分页.*不参与|异常状态.*检查类型.*分页.*不参与/,
    );
  });

  it('RED: preserves a raw group deep-link ID when the time range is applied', async () => {
    const rawId = ' 00042,MiXeD ';
    const f = await fixture({
      path: `/monitor-history?type=group&id=${encodeURIComponent(rawId)}`,
    });
    await historyReady();
    change('开始时间（上海）', '2026-09-01T00:00');
    change('结束时间（上海）', '2026-09-02T00:00');
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await summaryReady();
    expect(
      f.reads(ABNORMAL).at(-1)!.url.searchParams.get('variantGroupId'),
    ).toBe(rawId);
    expect(f.reads(BASE).at(-1)!.url.searchParams.get('variantGroupId')).toBe(
      rawId.trim(),
    );
    expect(
      screen.getByRole('region', { name: '异常时长统计' }).textContent,
    ).toContain(rawId);
  });

  it('RED: preserves one padded comma-containing ASIN ID and literal name patterns with the scoped bracket wire', async () => {
    const rawId = ' 00042,MiXeD ';
    const f = await fixture({
      path: `/monitor-history?type=asin&id=${encodeURIComponent(rawId)}`,
    });
    await historyReady();
    change('变体组名称', '  group %_  ');
    change('ASIN 名称', '  name %_  ');
    change('开始时间（上海）', '2026-09-01T00:00');
    change('结束时间（上海）', '2026-09-02T00:00');
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await summaryReady();
    const params = f.reads(ABNORMAL).at(-1)!.url.searchParams;
    expect(params.getAll('asinIds[]')).toEqual([rawId]);
    expect(params.get('variantGroupName')).toBe('  group %_  ');
    expect(params.get('asinName')).toBe('  name %_  ');
    expect(params.has('asinIds')).toBe(false);
    expect(params.has('asinId')).toBe(false);
    expect(f.reads(BASE).at(-1)!.url.searchParams.get('asinId')).toBe(
      rawId.trim(),
    );
    const scopeText = screen.getByRole('region', {
      name: '异常时长统计',
    }).textContent;
    expect(scopeText).toContain(rawId);
    expect(scopeText).toContain('  group %_  ');
    expect(scopeText).toContain('  name %_  ');
  });

  it('RED: draft edits do not change the applied summary and record pagination never narrows it', async () => {
    const f = await fixture();
    await historyReady();
    applyScope();
    await summaryReady();
    const priorReads = f.reads(ABNORMAL).length;
    change('国家代码', 'DE');
    expect(f.reads(ABNORMAL)).toHaveLength(priorReads);
    change('每页数量', '50');
    await waitFor(() =>
      expect(f.reads(BASE).at(-1)!.url.searchParams.get('pageSize')).toBe('50'),
    );
    expect(f.reads(ABNORMAL)).toHaveLength(priorReads);
    expect(screen.getByText('SUMMARY-00000')).toBeTruthy();
  });

  it('RED: pages the complete summary locally and exports every row rather than the visible page', async () => {
    const f = await fixture();
    await historyReady();
    f.handlers.set(ABNORMAL, () =>
      ok(result(Array.from({ length: 21 }, (_, index) => summaryRow(index)))),
    );
    applyScope();
    const region = await summaryReady();
    const reads = f.reads(ABNORMAL).length;
    fireEvent.click(within(region).getByRole('button', { name: '下一页统计' }));
    await screen.findByText('SUMMARY-00020');
    expect(f.reads(ABNORMAL)).toHaveLength(reads);
    const csv = csvCapture();
    exportCsv();
    expect(csv.blobs).toHaveLength(1);
    const text = await csvText(csv.blobs[0]);
    expect(text).toContain('SUMMARY-00000');
    expect(text).toContain('SUMMARY-00020');
    expect(text.split('\r\n')).toHaveLength(22);
    expect(csv.revokeURL).toHaveBeenCalledWith('blob:summary-1');
  });

  it('RED: accepts all 50,000 contract rows without truncating the local CSV', async () => {
    const f = await fixture();
    await historyReady();
    f.handlers.set(ABNORMAL, () =>
      ok(
        result(Array.from({ length: 50_000 }, (_, index) => summaryRow(index))),
      ),
    );
    applyScope();
    await summaryReady();
    const csv = csvCapture();
    exportCsv();
    const text = await csvText(csv.blobs[0]);
    expect(text.split('\r\n')).toHaveLength(50_001);
    expect(text).toContain('SUMMARY-49999');
    expect(csv.revokeURL).toHaveBeenCalledTimes(1);
  });

  it('RED: emits the Legacy eight-column duration semantics, UTF-8 BOM/CRLF/MIME, exact quotes and safe formula text', async () => {
    const f = await fixture();
    await historyReady();
    const rows = [
      {
        ...summaryRow(),
        asin: '=1+1',
        queryTimeRange: 'quoted,"range"\nnext',
        maxAbnormalTime: '\t@SUM(1,1)',
      },
      ...['UK', 'DE', 'FR', 'IT', 'ES', 'UNKNOWN'].map((country, index) => ({
        ...summaryRow(index + 1),
        country,
      })),
    ];
    f.handlers.set(ABNORMAL, () => ok(result(rows)));
    applyScope();
    await summaryReady('=1+1');
    const csv = csvCapture();
    exportCsv();
    const bytes = await blobBytes(csv.blobs[0]);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([239, 187, 191]);
    expect(csv.blobs[0].type).toBe('text/csv;charset=utf-8;');
    const text = await csvText(csv.blobs[0]);
    expect(
      text.startsWith(
        '\uFEFF"ASIN","国家","查询时间段","异常次数","平均异常时长","最短异常时长","最长异常时长","最长异常时间"\r\n',
      ),
    ).toBe(true);
    expect(text).toContain(
      '"\'=1+1","美国","quoted,""range""\nnext","7","1.23 小时","0.00 小时","4.57 小时","\'\t@SUM(1,1)"\r\n',
    );
    for (const country of [
      '英国',
      '德国',
      '法国',
      '意大利',
      '西班牙',
      'UNKNOWN',
    ])
      expect(text).toContain(`"${country}"`);
    expect(csv.links[0].filename).toBe(
      '异常时长统计_2026-09-01-00-00-00_2026-09-02-00-00-00.csv',
    );
    expect(csv.links[0].href).toBe('blob:summary-1');
    expect(csv.revokeURL).toHaveBeenCalledWith('blob:summary-1');
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('RED: always releases an object URL and removes the anchor when clicking the CSV download fails', async () => {
    await fixture();
    await historyReady();
    applyScope();
    await summaryReady();
    const csv = csvCapture();
    csv.click.mockImplementation(() => {
      throw new Error('fixture click failure');
    });
    exportCsv();
    expect(csv.revokeURL).toHaveBeenCalledWith('blob:summary-1');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('导出');
  });

  it.each([
    ['missing summary', { timeGranularity: 'hour', data: [] }],
    [
      'invalid duration',
      result([{ ...summaryRow(), maxAbnormalDuration: -1 }]),
    ],
    [
      'invalid count',
      result([{ ...summaryRow(), abnormalCount: Number.MAX_SAFE_INTEGER + 1 }]),
    ],
    ['unknown granularity', { ...result(), timeGranularity: 'month' }],
    ['failed envelope', { success: false, data: result() }],
  ])(
    'RED: rejects %s without a zero fallback or an export of stale data',
    async (_case, data) => {
      const f = await fixture();
      await historyReady();
      applyScope();
      await summaryReady();
      f.handlers.set(ABNORMAL, () =>
        _case === 'failed envelope' ? jsonResponse(data) : ok(data),
      );
      applyScope({ 国家代码: 'DE' });
      await screen.findByText(/服务器响应契约不匹配|服务器响应不完整|请求失败/);
      expect(screen.queryByText('SUMMARY-00000')).toBeNull();
      const csv = csvCapture();
      const button = screen.queryByRole('button', { name: '导出 CSV' });
      if (button) fireEvent.click(button);
      expect(csv.createURL).not.toHaveBeenCalled();
      expect(screen.getAllByText('healthy existing history')).toHaveLength(2);
    },
  );

  it('RED: rejects 50,001 rows rather than silently slicing the payload', async () => {
    const f = await fixture();
    await historyReady();
    f.handlers.set(ABNORMAL, () =>
      ok(
        result(Array.from({ length: 50_001 }, (_, index) => summaryRow(index))),
      ),
    );
    applyScope();
    await screen.findByText('服务器响应契约不匹配');
    expect(screen.queryByText('SUMMARY-00000')).toBeNull();
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
  });

  it('RED: enforces the real 32 MiB streamed response cap and cancels an oversized reader', async () => {
    const f = await fixture();
    await historyReady();
    const cancel = vi.fn();
    let sent = 0;
    f.handlers.set(
      ABNORMAL,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent++ < 33)
                controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
              // Keep the source open so cancellation, rather than prior close,
              // owns disposal after the byte boundary rejects the 33rd chunk.
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    applyScope();
    await screen.findByText('页面读取上限已达到，请缩小范围或减少每页数量。');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('SUMMARY-00000')).toBeNull();
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
  });

  it('RED: a real 401 resets IdentityStore and unmounts every history read through RouteGate', async () => {
    const f = await fixture();
    await historyReady();
    applyScope();
    await summaryReady();
    f.handlers.set(ABNORMAL, () => failure(401));
    applyScope({ 国家代码: 'DE' });
    await waitFor(() =>
      expect(f.identity.getSnapshot().status).toBe('anonymous'),
    );
    expect(f.runtime.session.hasSession()).toBe(false);
    expect(screen.queryByText('SUMMARY-00000')).toBeNull();
    expect(screen.queryByText('healthy existing history')).toBeNull();
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
  });

  it('RED: a real 403 hides shared reads; failed summary recovery never revives earlier cached data', async () => {
    const f = await fixture();
    await historyReady();
    applyScope();
    await summaryReady();
    f.handlers.set(ABNORMAL, () => failure(403));
    applyScope({ 国家代码: 'DE' });
    await screen.findByRole('heading', { name: '读取权限需要重新确认' });
    expect(screen.queryByText('SUMMARY-00000')).toBeNull();
    expect(screen.queryByText('healthy existing history')).toBeNull();
    f.handlers.set(ABNORMAL, () => failure(503));
    fireEvent.click(screen.getByRole('button', { name: '重新验证并读取' }));
    await screen.findByText(
      '重新验证或读取未完成，旧数据继续隐藏，请稍后重试。',
    );
    expect(screen.queryByText('SUMMARY-00000')).toBeNull();
    f.handlers.set(ABNORMAL, () =>
      ok(result([{ ...summaryRow(), asin: 'FRESH-RECOVERY' }])),
    );
    fireEvent.click(screen.getByRole('button', { name: '重新验证并读取' }));
    await summaryReady('FRESH-RECOVERY');
    expect(screen.queryByText('SUMMARY-00000')).toBeNull();
    await historyReady();
  });

  it.each(['owner', 'session', 'permission'] as const)(
    'RED: the actual identity refresh removes the summary and cancels late data across a %s change',
    async (kind) => {
      const f = await fixture();
      await historyReady();
      applyScope();
      await summaryReady();
      const late = deferred<Response>();
      f.handlers.set(ABNORMAL, () => late.promise);
      applyScope({ 国家代码: 'DE' });
      await waitFor(() => expect(f.reads(ABNORMAL)).toHaveLength(2));
      const request = f.reads(ABNORMAL).at(-1)!;
      const pendingIdentity = deferred<Response>();
      f.handlers.set(CURRENT_USER, () => pendingIdentity.promise);
      let refresh!: ReturnType<IdentityStore['refresh']>;
      act(() => {
        refresh = f.identity.refresh();
      });
      await screen.findByText('正在验证登录状态…');
      expect(screen.queryByText('SUMMARY-00000')).toBeNull();
      expect(request.signal?.aborted).toBe(true);
      f.handlers.delete(ABNORMAL);
      const next = user(
        kind === 'permission'
          ? { permissions: [] }
          : kind === 'session'
          ? { sessionId: 'session-b' }
          : { user: { ...user().user, id: 'reader-b' } },
      );
      f.setUser(next);
      f.handlers.delete(CURRENT_USER);
      await act(async () => {
        pendingIdentity.resolve(ok(next));
        await refresh;
      });
      if (kind === 'permission')
        await screen.findByRole('heading', { name: '你暂无访问权限' });
      else await historyReady();
      await act(async () => {
        late.resolve(ok(result([{ ...summaryRow(), asin: 'LATE-PRIVATE' }])));
        await late.promise;
      });
      expect(screen.queryByText('LATE-PRIVATE')).toBeNull();
      expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
    },
  );

  it('RED: runtime session refresh clears scoped work and prevents a delayed old-session CSV', async () => {
    const f = await fixture();
    await historyReady();
    applyScope();
    await summaryReady();
    const late = deferred<Response>();
    f.handlers.set(ABNORMAL, () => late.promise);
    applyScope({ 国家代码: 'DE' });
    await waitFor(() => expect(f.reads(ABNORMAL)).toHaveLength(2));
    const request = f.reads(ABNORMAL).at(-1)!;
    f.handlers.delete(ABNORMAL);
    await act(async () => {
      f.runtime.refreshSession();
      await f.identity.ensure();
    });
    await historyReady();
    expect(request.signal?.aborted).toBe(true);
    await act(async () => {
      late.resolve(ok(result([{ ...summaryRow(), asin: 'OLD-SESSION' }])));
      await late.promise;
    });
    expect(screen.queryByText('OLD-SESSION')).toBeNull();
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
  });

  it('RED: a new applied filter wins over late results and clearing the scope removes export authority', async () => {
    const f = await fixture();
    await historyReady();
    const late = deferred<Response>();
    f.handlers.set(ABNORMAL, () => late.promise);
    applyScope({ 国家代码: 'US' });
    await waitFor(() => expect(f.reads(ABNORMAL)).toHaveLength(1));
    const request = f.reads(ABNORMAL)[0];
    f.handlers.set(ABNORMAL, () =>
      ok(result([{ ...summaryRow(), asin: 'NEW-FILTER', country: 'DE' }])),
    );
    applyScope({ 国家代码: 'DE' });
    await summaryReady('NEW-FILTER');
    expect(request.signal?.aborted).toBe(true);
    await act(async () => {
      late.resolve(ok(result([{ ...summaryRow(), asin: 'OLD-FILTER' }])));
      await late.promise;
    });
    expect(screen.queryByText('OLD-FILTER')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }));
    await waitFor(() => expect(screen.queryByText('NEW-FILTER')).toBeNull());
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
  });

  it('RED: route search changes and leaving the actual route cancel old scoped requests', async () => {
    const f = await fixture();
    await historyReady();
    applyScope();
    await summaryReady();
    const late = deferred<Response>();
    f.handlers.set(ABNORMAL, () => late.promise);
    applyScope({ 国家代码: 'DE' });
    await waitFor(() => expect(f.reads(ABNORMAL)).toHaveLength(2));
    const request = f.reads(ABNORMAL).at(-1)!;
    await act(async () => {
      f.history.push('/monitor-history?type=group&id=another-group');
      await f.router.load();
    });
    expect(screen.queryByText('SUMMARY-00000')).toBeNull();
    expect(request.signal?.aborted).toBe(true);
    await act(async () => {
      f.history.push('/403');
      await f.router.load();
    });
    await screen.findByRole('heading', { name: '你暂无访问权限' });
    await act(async () => {
      late.resolve(ok(result([{ ...summaryRow(), asin: 'LEFT-ROUTE' }])));
      await late.promise;
    });
    expect(screen.queryByText('LEFT-ROUTE')).toBeNull();
    expect(screen.queryByRole('button', { name: '导出 CSV' })).toBeNull();
  });

  it('RED: an empty validated summary shows a specific empty state and cannot create a CSV', async () => {
    const f = await fixture();
    await historyReady();
    f.handlers.set(ABNORMAL, () => ok(result([])));
    applyScope();
    await screen.findByText('暂无异常时长统计');
    const csv = csvCapture();
    const button = screen.queryByRole('button', { name: '导出 CSV' });
    if (button) fireEvent.click(button);
    expect(csv.createURL).not.toHaveBeenCalled();
    expect(screen.getAllByText('healthy existing history')).toHaveLength(2);
  });
});
