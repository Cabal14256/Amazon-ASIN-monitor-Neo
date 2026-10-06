// @vitest-environment jsdom
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { ASIN_CATALOG } from '../asin/config';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { catalogSafetyKey } from './catalog-safety-gate';
import { CatalogPage } from './index';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
beforeEach(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, work: () => unknown) => work() },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(
  baseURL = '/api/',
  permissions = ['asin:read', 'asin:write'],
  competitor = false,
  groupId = 'group-1',
) {
  const group = {
    id: groupId,
    name: 'Primary fixture',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    children: [] as Array<{ id: string; asin: string; country: string }>,
  };
  let state = {
    status: 'authenticated' as const,
    identity: {
      user: {
        id: 'operator',
        username: 'Fixture',
        status: 'ACTIVE' as const,
        force_password_change: false,
      },
      sessionId: 'session-1',
      roles: [],
      permissions,
      mustChangePassword: false,
      passwordExpired: false,
    },
  };
  const listeners = new Set<() => void>();
  const refresh = vi.fn(async () => state);
  const identity = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
  } as unknown as IdentityStore;
  let outcomes = [true, false];
  let responseMode: 'ready' | 'invalid' | '403' | '500' | 'network' = 'ready';
  let failReads = false;
  let readFailureStatus = 400;
  let postGate: ReturnType<typeof deferred<void>> | undefined;
  let readGate: ReturnType<typeof deferred<void>> | undefined;
  let receiptSerial = 0;
  let posted = false;
  const prefix = baseURL.includes('/gateway/') ? '/gateway/api/v1' : '/api/v1';
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const path = new URL(String(input)).pathname;
    const readOwner = state.identity.user.id;
    const snapshot = {
      ...group,
      name: readOwner === 'operator' ? group.name : 'Other fixture',
      children: [...group.children],
    };
    if (options?.method === 'POST' && path.endsWith('/asins/batch-create')) {
      posted = true;
      const receipt = ++receiptSerial;
      const items = (
        JSON.parse(String(options.body)) as {
          items: Array<{ asin: string; country: string }>;
        }
      ).items;
      await postGate?.promise;
      if (responseMode === '403')
        return jsonResponse(
          { success: false, errorMessage: 'Fixture permission withdrawn' },
          403,
        );
      if (responseMode === 'network')
        throw new TypeError('Fixture network disconnected');
      if (responseMode === '500')
        return jsonResponse(
          { success: false, message: 'Fixture unconfirmed result' },
          500,
        );
      const results = items.map((item, index) => ({
        index,
        asin: item.asin,
        country: item.country,
        success: outcomes[index] ?? true,
        id: outcomes[index] ?? true ? `created-${receipt}-${index}` : undefined,
        message: outcomes[index] ?? true ? undefined : 'Fixture duplicate',
      }));
      for (const row of results)
        if (row.success)
          group.children.push({
            id: row.id!,
            asin: row.asin,
            country: row.country,
          });
      const result = {
        total: results.length,
        successCount: results.filter((row) => row.success).length,
        failedCount: results.filter((row) => !row.success).length,
        results,
        errors: results
          .filter((row) => !row.success)
          .map((row) => ({
            index: row.index,
            asin: row.asin,
            message: row.message!,
          })),
      };
      return jsonResponse({
        success: true,
        data: responseMode === 'invalid' ? { ...result, errors: [] } : result,
      });
    }
    if (posted) {
      if (readOwner === 'operator') await readGate?.promise;
      if (failReads && readOwner === 'operator')
        return jsonResponse(
          { success: false, message: 'Fixture read unavailable' },
          readFailureStatus,
        );
    }
    return jsonResponse({
      success: true,
      data:
        path.endsWith('/variant-groups') ||
        path.endsWith('/competitor-variant-groups')
          ? {
              list: [snapshot],
              total: 1,
              totalASINs: group.children.length,
              current: 1,
              pageSize: 10,
            }
          : snapshot,
    });
  });
  const runtime = createTransportRuntime({
    baseURL,
    pageOrigin: 'https://app.test',
    fetch: fetcher,
    session: sessionFixture().store,
  });
  runtime.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  runtimes.push(runtime);
  const config = competitor ? COMPETITOR_CATALOG : ASIN_CATALOG;
  const page = () => (
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <CatalogPage config={config} />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  let view = render(page());
  return {
    fetcher,
    runtime,
    refresh,
    group,
    prefix,
    outcomes: (values: boolean[]) => {
      outcomes = values;
    },
    mode: (value: typeof responseMode) => {
      responseMode = value;
    },
    refreshReadOnly: () => {
      refresh.mockImplementation(async () => {
        state = {
          ...state,
          identity: { ...state.identity, permissions: ['asin:read'] },
        };
        for (const listener of listeners) listener();
        return state;
      });
      return refresh;
    },
    failReads: (value: boolean, status = 400) => {
      failReads = value;
      readFailureStatus = status;
    },
    holdPost: () => {
      postGate = deferred<void>();
      return postGate;
    },
    holdRead: () => {
      readGate = deferred<void>();
      return readGate;
    },
    identity: async (
      id: string,
      nextPermissions = permissions,
      session = 'session-1',
    ) => {
      await act(async () => {
        state = {
          ...state,
          identity: {
            ...state.identity,
            user: { ...state.identity.user, id },
            permissions: nextPermissions,
            sessionId: session,
          },
        };
        for (const listener of listeners) listener();
      });
    },
    unmount: () => view.unmount(),
    remount: () => {
      view = render(page());
    },
    posts: () =>
      fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'),
  };
}

async function openBatch() {
  if (!screen.queryAllByRole('button', { name: '批量添加 ASIN' }).length) {
    const buttons = await screen.findAllByRole('button', { name: '查看 ASIN' });
    fireEvent.click(buttons[0]);
  }
  fireEvent.click(
    (await screen.findAllByRole('button', { name: '批量添加 ASIN' }))[0],
  );
  await screen.findByRole('region', { name: '批量添加组内 ASIN' });
}
function fillBatch(codes = 'b000000001，B000000002\nb000000001') {
  fireEvent.change(screen.getByRole('textbox', { name: 'ASIN 编码列表' }), {
    target: { value: codes },
  });
  return screen
    .getByRole('button', { name: '确认添加 2 个 ASIN' })
    .closest('form')!;
}
const guardKey = catalogSafetyKey('operator', 'asin');
const fiftyPointGroupId = ` ${'😀'.repeat(48)} `;

describe('actual primary batch-create catalog integration', () => {
  it.each([
    { base: '/api/', outcomes: [true, true], success: 2, failed: 0 },
    {
      base: 'https://app.test/gateway/api/',
      outcomes: [false, false],
      success: 0,
      failed: 2,
    },
    { base: '/api/', outcomes: [true, false], success: 1, failed: 1 },
  ])(
    'renders authoritative $success/$failed results after fresh directory and detail at $base',
    async ({ base, outcomes, success, failed }) => {
      const f = fixture(base);
      f.outcomes(outcomes);
      await openBatch();
      fireEvent.submit(fillBatch());
      const result = within(
        await screen.findByRole('region', { name: '批量添加结果' }),
      );
      expect(
        result.getByText(
          `变体组「Primary fixture」 · 共 2 个，成功 ${success} 个，失败 ${failed} 个。`,
        ),
      ).toBeTruthy();
      expect(result.getByText('B000000001')).toBeTruthy();
      expect(result.getByText('B000000002')).toBeTruthy();
      expect(f.posts()).toHaveLength(1);
      const [url, options] = f.posts()[0];
      expect(new URL(String(url)).pathname).toBe(
        `${f.prefix}/asins/batch-create`,
      );
      expect(
        JSON.parse(String(options?.body)).items.map(
          (item: { asin: string; parentId: string }) => [
            item.asin,
            item.parentId,
          ],
        ),
      ).toEqual([
        ['B000000001', f.group.id],
        ['B000000002', f.group.id],
      ]);
      const postIndex = f.fetcher.mock.calls.findIndex(
        ([, init]) => init?.method === 'POST',
      );
      const reads = f.fetcher.mock.calls
        .slice(postIndex + 1)
        .map(([input]) => new URL(String(input)).pathname);
      expect(reads).toContain(`${f.prefix}/variant-groups`);
      expect(reads).toContain(`${f.prefix}/variant-groups/group-1`);
      expect(window.localStorage.getItem(guardKey)).toBeNull();
      expect(
        f.fetcher.mock.calls.every(
          ([input]) => !String(input).includes('/api/api/'),
        ),
      ).toBe(true);
    },
  );

  it('starts a fresh result identity after failure-only selection in the previous batch', async () => {
    const f = fixture();
    await openBatch();
    fireEvent.submit(fillBatch());
    fireEvent.click(
      await screen.findByRole('button', { name: '仅查看失败项' }),
    );
    expect(
      within(screen.getByRole('region', { name: '批量添加结果' })).queryByText(
        'B000000001',
      ),
    ).toBeNull();
    f.outcomes([true, true]);
    await openBatch();
    expect(screen.queryByRole('region', { name: '批量添加结果' })).toBeNull();
    fireEvent.submit(fillBatch('B000000003 B000000004'));
    const result = within(
      await screen.findByRole('region', { name: '批量添加结果' }),
    );
    expect(result.getByText('B000000003')).toBeTruthy();
    expect(result.getByText('B000000004')).toBeTruthy();
    expect(result.queryByRole('button', { name: '查看全部结果' })).toBeNull();
    expect(f.posts()).toHaveLength(2);
  });

  it.each(['/api/', 'https://app.test/gateway/api/'])(
    'preserves raw default brand and entered site/name including astral capacity boundaries through the real form and HTTP at %s',
    async (base) => {
      const f = fixture(base);
      f.group.brand = ` ${'😀'.repeat(98)} `;
      const site = ` ${'😀'.repeat(98)} `;
      const name = ` ${'😀'.repeat(498)} `;
      await openBatch();
      expect(screen.getByLabelText(/^品牌/)).toHaveProperty(
        'value',
        f.group.brand,
      );
      fireEvent.change(screen.getByLabelText(/^站点/), {
        target: { value: site },
      });
      fireEvent.change(screen.getByLabelText(/^统一名称/), {
        target: { value: name },
      });
      fireEvent.submit(fillBatch());
      await screen.findByRole('region', { name: '批量添加结果' });
      expect(f.posts()).toHaveLength(1);
      const [url, options] = f.posts()[0];
      expect(new URL(String(url)).pathname).toBe(
        `${f.prefix}/asins/batch-create`,
      );
      expect(JSON.parse(String(options?.body))).toEqual({
        items: ['B000000001', 'B000000002'].map((asin) => ({
          asin,
          country: 'US',
          parentId: f.group.id,
          brand: f.group.brand,
          site,
          name,
          asinType: null,
        })),
      });
    },
  );

  it.each(
    ['/api/', 'https://app.test/gateway/api/'].flatMap((base) =>
      [' Gróup 主营 ', fiftyPointGroupId].map((groupId, index) => ({
        base,
        groupId,
        length: index === 0 ? 'raw-space' : '50-codepoint',
      })),
    ),
  )(
    'uses the authoritative $length ID for detail preflight, batch parent payload and refreshed detail at $base',
    async ({ base, groupId }) => {
      const f = fixture(base, ['asin:read', 'asin:write'], false, groupId);
      await openBatch();
      fireEvent.submit(fillBatch());
      await screen.findByRole('region', { name: '批量添加结果' });
      expect(f.posts()).toHaveLength(1);
      expect(
        JSON.parse(String(f.posts()[0][1]?.body)).items.every(
          (item: { parentId: string }) => item.parentId === groupId,
        ),
      ).toBe(true);
      const postIndex = f.fetcher.mock.calls.findIndex(
        ([, init]) => init?.method === 'POST',
      );
      const rawDetailPath = `${f.prefix}/variant-groups/${encodeURIComponent(
        groupId,
      )}`;
      const before = f.fetcher.mock.calls
        .slice(0, postIndex)
        .map(([url]) => new URL(String(url)).pathname);
      const after = f.fetcher.mock.calls
        .slice(postIndex + 1)
        .map(([url]) => new URL(String(url)).pathname);
      expect(
        before.filter((path) => path === rawDetailPath).length,
      ).toBeGreaterThanOrEqual(2);
      expect(after).toContain(rawDetailPath);
      expect(
        f.fetcher.mock.calls.every(
          ([url]) => !String(url).includes('/api/api/'),
        ),
      ).toBe(true);
      expect(window.localStorage.getItem(guardKey)).toBeNull();
    },
  );

  it('keeps the claim and hides results until a failed post-write refresh is retried with GET only', async () => {
    const f = fixture();
    f.failReads(true);
    await openBatch();
    fireEvent.submit(fillBatch());
    await screen.findByRole('button', { name: '重新读取目录' });
    expect(screen.queryByRole('region', { name: '批量添加结果' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(guardKey)!)).toMatchObject({
      createUncertain: false,
      detailId: f.group.id,
    });
    f.failReads(false);
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await screen.findByRole('region', { name: '批量添加结果' });
    expect(f.posts()).toHaveLength(1);
    expect(window.localStorage.getItem(guardKey)).toBeNull();
  });

  it.each(['invalid', '500', 'network'] as const)(
    'persists %s uncertainty across remount and requires explicit read/inspection without resending',
    async (mode) => {
      const f = fixture();
      f.mode(mode);
      await openBatch();
      fireEvent.submit(fillBatch());
      await screen.findByRole('button', { name: '重新读取目录' });
      expect(JSON.parse(window.localStorage.getItem(guardKey)!)).toMatchObject({
        phase: 'refresh',
        detailId: f.group.id,
        createUncertain: true,
      });
      f.unmount();
      f.remount();
      fireEvent.click(
        await screen.findByRole('button', { name: '重新读取目录' }),
      );
      await screen.findByRole('button', {
        name: '已核实原操作，重读目录并恢复写入',
      });
      expect(
        screen.queryByRole('button', { name: '批量添加 ASIN' }),
      ).toBeNull();
      expect(JSON.parse(window.localStorage.getItem(guardKey)!)).toMatchObject({
        phase: 'inspection',
      });
      fireEvent.click(
        screen.getByRole('button', {
          name: '已核实原操作，重读目录并恢复写入',
        }),
      );
      await waitFor(() =>
        expect(window.localStorage.getItem(guardKey)).toBeNull(),
      );
      expect(f.posts()).toHaveLength(1);
    },
  );

  it('persists the full 50-codepoint batch source ID across an unknown receipt and remount before explicit GET-only recovery', async () => {
    const f = fixture(
      '/api/',
      ['asin:read', 'asin:write'],
      false,
      fiftyPointGroupId,
    );
    f.mode('invalid');
    await openBatch();
    fireEvent.submit(fillBatch());
    await screen.findByRole('button', { name: '重新读取目录' });
    expect(JSON.parse(window.localStorage.getItem(guardKey)!)).toMatchObject({
      detailId: fiftyPointGroupId,
      createUncertain: true,
    });
    f.unmount();
    f.remount();
    fireEvent.click(
      await screen.findByRole('button', { name: '重新读取目录' }),
    );
    await screen.findByRole('button', {
      name: '已核实原操作，重读目录并恢复写入',
    });
    expect(
      f.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toContain(
      `${f.prefix}/variant-groups/${encodeURIComponent(fiftyPointGroupId)}`,
    );
    expect(f.posts()).toHaveLength(1);
    expect(JSON.parse(window.localStorage.getItem(guardKey)!)).toMatchObject({
      phase: 'inspection',
    });
  });

  it('protects one pending POST against repeated native submits and disabled close', async () => {
    const f = fixture();
    const reply = f.holdPost();
    await openBatch();
    const form = fillBatch();
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    const close = within(
      screen.getByRole('region', { name: '批量添加组内 ASIN' }),
    ).getByRole('button', { name: '关闭' });
    expect(close.hasAttribute('disabled')).toBe(true);
    fireEvent.click(close);
    expect(
      screen.getByRole('region', { name: '批量添加组内 ASIN' }),
    ).toBeTruthy();
    await act(async () => reply.resolve());
    await screen.findByRole('region', { name: '批量添加结果' });
    expect(f.posts()).toHaveLength(1);
  });

  it('treats the actual 120-second HTTP timeout as unknown and ignores a late receipt without repeating POST', async () => {
    const f = fixture();
    const reply = f.holdPost();
    await openBatch();
    const form = fillBatch();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.submit(form);
      for (let step = 0; step < 40; step++) await Promise.resolve();
    });
    expect(f.posts()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByRole('button', { name: '重新读取目录' })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(guardKey)!)).toMatchObject({
      phase: 'refresh',
      detailId: f.group.id,
      createUncertain: true,
    });
    await act(async () => reply.resolve());
    vi.useRealTimers();
    expect(screen.queryByRole('region', { name: '批量添加结果' })).toBeNull();
    f.unmount();
    f.remount();
    fireEvent.click(
      await screen.findByRole('button', { name: '重新读取目录' }),
    );
    await screen.findByRole('button', {
      name: '已核实原操作，重读目录并恢复写入',
    });
    expect(f.posts()).toHaveLength(1);
  });

  it('refuses a changed source group at the locked pre-submit reread before any POST or claim', async () => {
    const f = fixture();
    await openBatch();
    f.group.name = 'Renamed after form opened';
    fireEvent.submit(fillBatch());
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '记录已被更新，请关闭表单并重新打开。',
    );
    expect(f.posts()).toHaveLength(0);
    expect(window.localStorage.getItem(guardKey)).toBeNull();
  });

  it('revalidates permissions after a definite POST 403 and removes only its released claim without offering another batch', async () => {
    const f = fixture();
    const refresh = f.refreshReadOnly();
    f.mode('403');
    await openBatch();
    fireEvent.submit(fillBatch());
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(window.localStorage.getItem(guardKey)).toBeNull(),
    );
    expect(
      screen.queryByRole('region', { name: '批量添加组内 ASIN' }),
    ).toBeNull();
    expect(screen.queryByRole('region', { name: '批量添加结果' })).toBeNull();
    expect(screen.queryByRole('button', { name: '批量添加 ASIN' })).toBeNull();
    expect(f.group.children).toHaveLength(0);
    expect(f.posts()).toHaveLength(1);
  });

  it.each([
    { nextUser: 'other', nextSession: 'session-1' },
    { nextUser: 'operator', nextSession: 'session-2' },
  ])(
    'releases a queued old-owner submit without POST and cannot clear the new pending batch for $nextUser/$nextSession',
    async ({ nextUser, nextSession }) => {
      const first = deferred<void>();
      let lockCalls = 0;
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
          request: async (_name: string, work: () => unknown) => {
            if (++lockCalls === 1) await first.promise;
            return work();
          },
        },
      });
      const f = fixture();
      await openBatch();
      fireEvent.submit(fillBatch());
      await waitFor(() => expect(lockCalls).toBe(1));
      await f.identity(nextUser, ['asin:read', 'asin:write'], nextSession);
      const second = f.holdPost();
      await openBatch();
      fireEvent.submit(fillBatch('B000000003 B000000004'));
      await waitFor(() => expect(f.posts()).toHaveLength(1));
      await act(async () => first.resolve());
      expect(f.posts()).toHaveLength(1);
      expect(
        within(screen.getByRole('region', { name: '批量添加组内 ASIN' }))
          .getByRole('button', { name: '关闭' })
          .hasAttribute('disabled'),
      ).toBe(true);
      if (nextUser !== 'operator')
        expect(window.localStorage.getItem(guardKey)).toBeNull();
      expect(
        window.localStorage.getItem(catalogSafetyKey(nextUser, 'asin')),
      ).not.toBeNull();
      await act(async () => second.resolve());
      const result = within(
        await screen.findByRole('region', { name: '批量添加结果' }),
      );
      expect(result.getByText('B000000003')).toBeTruthy();
      expect(
        window.localStorage.getItem(catalogSafetyKey(nextUser, 'asin')),
      ).toBeNull();
    },
  );

  it('retains the original claim when permission is withdrawn during POST and remains guarded after restoration', async () => {
    const f = fixture();
    const reply = f.holdPost();
    await openBatch();
    fireEvent.submit(fillBatch());
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    await f.identity('operator', ['asin:read']);
    await screen.findByRole('button', { name: '重新读取目录' });
    expect(
      screen.queryByRole('region', { name: '批量添加组内 ASIN' }),
    ).toBeNull();
    await f.identity('operator', ['asin:read', 'asin:write']);
    await act(async () => reply.resolve());
    expect(JSON.parse(window.localStorage.getItem(guardKey)!)).toMatchObject({
      phase: 'refresh',
      createUncertain: true,
    });
    expect(screen.queryByRole('region', { name: '批量添加结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await screen.findByRole('button', {
      name: '已核实原操作，重读目录并恢复写入',
    });
    expect(f.posts()).toHaveLength(1);
  });

  it('does not let a late refresh 403 from a revoked batch deny the restored same-owner session or release its persisted claim', async () => {
    const f = fixture();
    const reads = f.holdRead();
    f.failReads(true, 403);
    await openBatch();
    fireEvent.submit(fillBatch());
    await screen.findByRole('button', { name: '重新读取目录' });
    await f.identity('operator', ['asin:read']);
    await f.identity('operator', ['asin:read', 'asin:write']);
    await act(async () => {
      reads.resolve();
      for (let step = 0; step < 40; step++) await Promise.resolve();
    });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(guardKey)!)).toMatchObject({
      phase: 'refresh',
      createUncertain: false,
    });
    expect(screen.queryByRole('region', { name: '批量添加结果' })).toBeNull();
    f.failReads(false);
    fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
    await waitFor(() =>
      expect(window.localStorage.getItem(guardKey)).toBeNull(),
    );
    expect(screen.queryByRole('region', { name: '批量添加结果' })).toBeNull();
    expect(f.posts()).toHaveLength(1);
  });

  it.each([false, true])(
    'does not publish late old-owner refresh data, results, notices or access-denial into the current owner scope (denied=%s)',
    async (denied) => {
      const f = fixture();
      if (denied) f.failReads(true, 403);
      const reads = f.holdRead();
      await openBatch();
      fireEvent.submit(fillBatch());
      await screen.findByRole('button', { name: '重新读取目录' });
      await f.identity('other');
      await screen.findAllByText('Other fixture');
      const replacement = {
        phase: 'inspection',
        operationId: 'other-operation',
      };
      const otherKey = catalogSafetyKey('other', 'asin');
      window.localStorage.setItem(otherKey, JSON.stringify(replacement));
      await act(async () => {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: otherKey,
            storageArea: window.localStorage,
            newValue: JSON.stringify(replacement),
          }),
        );
        reads.resolve();
      });
      await waitFor(() =>
        expect(
          f.runtime.queryClient.getQueryData<{ list: Array<{ name: string }> }>(
            ['asin', 'groups', { current: 1, pageSize: 10 }],
          )?.list[0].name,
        ).toBe('Other fixture'),
      );
      expect(screen.queryByRole('region', { name: '批量添加结果' })).toBeNull();
      expect(
        screen.queryByText('批量添加已核实：成功 1 个，失败 1 个。'),
      ).toBeNull();
      expect(window.localStorage.getItem(otherKey)).toBe(
        JSON.stringify(replacement),
      );
      expect(window.localStorage.getItem(guardKey)).not.toBeNull();
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.posts()).toHaveLength(1);
    },
  );

  it('retains a replacement cross-tab claim when the batch receipt arrives', async () => {
    const f = fixture();
    const reply = f.holdPost();
    await openBatch();
    fireEvent.submit(fillBatch());
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    const replacement = {
      phase: 'inspection',
      operationId: 'replacement-operation',
    };
    window.localStorage.setItem(guardKey, JSON.stringify(replacement));
    await act(async () => reply.resolve());
    await screen.findByRole('button', {
      name: '已核实原操作，重读目录并恢复写入',
    });
    expect(window.localStorage.getItem(guardKey)).toBe(
      JSON.stringify(replacement),
    );
    expect(screen.queryByRole('region', { name: '批量添加结果' })).toBeNull();
    expect(f.posts()).toHaveLength(1);
  });

  it('persists a page-unmount cancellation and never resends after return', async () => {
    const f = fixture();
    const reply = f.holdPost();
    await openBatch();
    fireEvent.submit(fillBatch());
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    f.unmount();
    await act(async () => reply.resolve());
    f.remount();
    await screen.findByRole('button', { name: '重新读取目录' });
    expect(JSON.parse(window.localStorage.getItem(guardKey)!)).toMatchObject({
      createUncertain: true,
    });
    expect(f.posts()).toHaveLength(1);
  });

  it.each([
    { permissions: ['asin:read'], competitor: false },
    { permissions: ['asin:read', 'asin:write'], competitor: true },
  ])(
    'does not expose the primary-only entry for $permissions / competitor=$competitor',
    async ({ permissions, competitor }) => {
      fixture('/api/', permissions, competitor);
      fireEvent.click(
        (await screen.findAllByRole('button', { name: '查看 ASIN' }))[0],
      );
      await screen.findAllByRole('region', {
        name: `${competitor ? '竞品 ASIN' : 'ASIN'}变体组详情`,
      });
      expect(
        screen.queryByRole('button', { name: '批量添加 ASIN' }),
      ).toBeNull();
    },
  );
});
