// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import { HttpClient } from '../../lib/http';
import { jsonResponse, sessionFixture } from '../../lib/transport-fixtures';
import { createTransportRuntime } from '../../services/runtime';
import { ASIN_CATALOG } from '../asin/config';
import { CatalogActionPanel } from './catalog-actions';
import { catalogSafetyKey } from './catalog-safety-gate';
import { CatalogPage } from './index';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
const child = {
  id: ' Child α ',
  asin: 'B000000001',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
};
const group = {
  id: ' Source Ś ',
  name: 'Source group',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  children: [child],
};
const target = {
  ...group,
  id: ' Cible 目标 ',
  name: 'Target group',
  children: [],
};
const clients: HttpClient[] = [];
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
beforeEach(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, work: () => unknown) => work() },
  });
});
afterEach(() => {
  cleanup();
  for (const http of clients.splice(0)) http.close();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks();
});
const listData = (row = group) => ({
  list: [row],
  total: 1,
  totalASINs: 1,
  current: 1,
  pageSize: 10,
});
const prefixFor = (base: string) =>
  base.includes('/gateway/') ? '/gateway/api/v1' : '/api/v1';

function pageFixture(base: string, id: string) {
  const source = { ...group, id };
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    jsonResponse({
      success: true,
      data: new URL(String(input)).pathname.endsWith('/variant-groups')
        ? listData(source)
        : source,
    }),
  );
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test/',
    baseURL: base,
    session: sessionFixture().store,
    fetch: fetcher,
  });
  runtime.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  runtimes.push(runtime);
  const state = {
    status: 'authenticated' as const,
    identity: {
      user: {
        id: 'operator',
        username: 'operator',
        status: 'ACTIVE' as const,
        force_password_change: false,
      },
      roles: [],
      permissions: ['asin:read', 'asin:write', 'asin:delete'],
      mustChangePassword: false,
      passwordExpired: false,
    },
  };
  const identity = {
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    refresh: async () => state,
  } as unknown as IdentityStore;
  const element = () => (
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <CatalogPage config={ASIN_CATALOG} />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  let view = render(element());
  return {
    fetcher,
    runtime,
    unmount: () => view.unmount(),
    remount: () => {
      view = render(element());
    },
  };
}

describe('mounted primary canonical record IDs with actual transport', () => {
  it.each(['/api/', 'https://app.test/gateway/api/'])(
    'retains parent and selected target raw IDs through shared preflight and writes with %s',
    async (base) => {
      for (const type of ['create-asin', 'move-asin'] as const) {
        const fetcher = vi.fn<typeof fetch>(async (input, options) => {
          const path = new URL(String(input)).pathname;
          return jsonResponse({
            success: true,
            data:
              options?.method && options.method !== 'GET'
                ? child
                : path.endsWith(encodeURIComponent(group.id))
                ? group
                : path.endsWith(encodeURIComponent(target.id))
                ? target
                : { list: [group, target], total: 2, current: 1, pageSize: 20 },
          });
        });
        const http = new HttpClient({
          baseURL: base,
          pageOrigin: 'https://app.test/',
          session: sessionFixture().store,
          fetch: fetcher,
        });
        clients.push(http);
        const saved = vi.fn(async () => undefined);
        const claimed = vi.fn(() => ({
          phase: 'refresh' as const,
          message: null,
          detailId: group.id,
          createUncertain: false,
        }));
        const view = render(
          <CatalogActionPanel
            action={
              type === 'move-asin' ? { type, group, child } : { type, group }
            }
            config={ASIN_CATALOG}
            http={http}
            saved={saved}
            close={vi.fn()}
            denied={vi.fn()}
            writingChange={vi.fn()}
            uncertain={vi.fn()}
            runExclusive={async (work) => work()}
            beginWrite={claimed}
            releaseWrite={vi.fn()}
          />,
        );
        if (type === 'create-asin')
          fireEvent.change(screen.getByRole('textbox', { name: /^ASIN/ }), {
            target: { value: child.asin },
          });
        else {
          fireEvent.click(screen.getByRole('button', { name: '查找目标组' }));
          fireEvent.click(
            await screen.findByRole('button', { name: /Target group/ }),
          );
        }
        fireEvent.click(
          screen.getByRole('button', {
            name: type === 'move-asin' ? '确认移动' : '保存',
          }),
        );
        await waitFor(() => expect(saved).toHaveBeenCalledOnce());
        expect(claimed).toHaveBeenCalledOnce();
        const mutation = fetcher.mock.calls.find(
          (call) => call[1]?.method === 'POST',
        )!;
        expect(new URL(String(mutation[0])).pathname).toBe(
          type === 'move-asin'
            ? `${prefixFor(base)}/asins/${encodeURIComponent(child.id)}/move`
            : `${prefixFor(base)}/asins`,
        );
        expect(JSON.parse(String(mutation[1]?.body))).toMatchObject(
          type === 'move-asin'
            ? { targetGroupId: target.id }
            : { parentId: group.id },
        );
        expect(
          fetcher.mock.calls.some(
            ([input]) =>
              new URL(String(input)).pathname ===
              `${prefixFor(base)}/variant-groups/${encodeURIComponent(
                group.id,
              )}`,
          ),
        ).toBe(true);
        if (type === 'move-asin')
          expect(
            fetcher.mock.calls.some(
              ([input]) =>
                new URL(String(input)).pathname ===
                `${prefixFor(base)}/variant-groups/${encodeURIComponent(
                  target.id,
                )}`,
            ),
          ).toBe(true);
        expect(
          fetcher.mock.calls.every(
            ([input]) => !String(input).includes('/api/api/'),
          ),
        ).toBe(true);
        view.unmount();
      }
    },
  );

  it.each(['/api/', 'https://app.test/gateway/api/'])(
    'retains a persisted 50-codepoint write guard through page loads and reads its original detail ID with %s',
    async (base) => {
      const id = ` ${'😀'.repeat(48)} `;
      const gate = {
        phase: 'refresh',
        message: null,
        detailId: id,
        createUncertain: false,
        operationId: 'canonical-operation',
      };
      const key = catalogSafetyKey('operator', 'asin');
      window.localStorage.setItem(key, JSON.stringify(gate));
      const f = pageFixture(base, id);
      await screen.findByRole('button', { name: '重新读取目录' });
      expect(window.localStorage.getItem(key)).toBe(JSON.stringify(gate));
      expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
      f.unmount();
      f.remount();
      await screen.findByRole('button', { name: '重新读取目录' });
      expect(window.localStorage.getItem(key)).toBe(JSON.stringify(gate));
      fireEvent.click(screen.getByRole('button', { name: '重新读取目录' }));
      await screen.findByRole('button', { name: '新建变体组' });
      expect(window.localStorage.getItem(key)).toBeNull();
      const detail = f.fetcher.mock.calls.find(
        ([input]) =>
          new URL(String(input)).pathname ===
          `${prefixFor(base)}/variant-groups/${encodeURIComponent(id)}`,
      );
      expect(detail).toBeTruthy();
      expect(
        decodeURIComponent(
          new URL(String(detail![0])).pathname.split('/').at(-1)!,
        ),
      ).toBe(id);
      expect(
        f.fetcher.mock.calls.every(
          ([, options]) => !options?.method || options.method === 'GET',
        ),
      ).toBe(true);
    },
  );

  it('refuses a malicious persisted control ID before a detail request while retaining the pending write guard', async () => {
    const id = 'group\n-with-control';
    const gate = {
      phase: 'refresh',
      message: null,
      detailId: id,
      createUncertain: false,
    };
    const key = catalogSafetyKey('operator', 'asin');
    window.localStorage.setItem(key, JSON.stringify(gate));
    const f = pageFixture('/api/', id);
    fireEvent.click(
      await screen.findByRole('button', { name: '重新读取目录' }),
    );
    await waitFor(() => expect(f.fetcher).toHaveBeenCalled());
    expect(
      f.fetcher.mock.calls.every(
        ([input]) =>
          new URL(String(input)).pathname === '/api/v1/variant-groups',
      ),
    ).toBe(true);
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(gate));
    expect(screen.queryByRole('button', { name: '新建变体组' })).toBeNull();
  });
});
