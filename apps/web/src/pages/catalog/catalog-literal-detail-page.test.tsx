// @vitest-environment jsdom
import {
  competitorGroupListResultSchema,
  variantGroupListResultSchema,
  type CurrentUserData,
} from '@asin-monitor/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
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
import { IdentityStore } from '../../auth/identity';
import {
  deferred,
  FakeSocket,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { createAppRouter } from '../../router';
import { createTransportRuntime } from '../../services/runtime';

// Chrome is unrelated to detail reads; CatalogPage, config, identity, router,
// typed service, schema and HttpClient all remain the real formal-main modules.
vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
const samples = [
  'group-normal',
  ' Source Ś ',
  ' ',
  '.',
  '..',
  'a/b',
  'a?b',
  'a#b',
  'a\\b',
  '中文🔎',
  '🔎'.repeat(50),
  'a%b',
  'a+b',
  'a=b',
  'a,b',
];
const dispose: Array<() => void> = [];
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  dispose.splice(0).forEach((close) => close());
  vi.restoreAllMocks();
  window.localStorage.clear();
});

async function fixture(
  domain: 'primary' | 'competitor',
  id: string,
  options: {
    permissions?: string[];
    identityUnavailable?: boolean;
    detailGate?: ReturnType<typeof deferred<Response>>;
  } = {},
) {
  const route = domain === 'primary' ? '/asin' : '/competitor-asin';
  const listPath =
    domain === 'primary'
      ? '/api/v1/variant-groups'
      : '/api/v1/competitor/variant-groups';
  const neoPath =
    domain === 'primary'
      ? '/api/v1/catalog/variant-groups/detail'
      : '/api/v1/competitor/catalog/variant-groups/detail';
  const child = {
    id: ' Literal child /?# ',
    asin: 'B000000242',
    country: 'US',
    parentId: id,
  };
  const listed = {
    id,
    name: 'Select literal catalog group',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    children: [],
  };
  const detail = {
    ...listed,
    name: 'Original literal detail',
    children: [child],
  };
  const list = {
    success: true,
    data: { list: [listed], total: 1, totalASINs: 1, current: 1, pageSize: 10 },
  };
  (domain === 'primary'
    ? variantGroupListResultSchema
    : competitorGroupListResultSchema
  ).parse(list);
  let current: CurrentUserData = {
    user: {
      id: 'reader-242',
      username: 'synthetic-reader-242',
      status: 'ACTIVE',
      force_password_change: false,
    },
    sessionId: 'session-242',
    roles: [],
    permissions: options.permissions ?? ['asin:read'],
    mustChangePassword: false,
    passwordExpired: false,
  };
  const reads: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    reads.push(url);
    if (url.pathname === '/api/v1/auth/current-user')
      return options.identityUnavailable
        ? jsonResponse(
            { success: false, errorMessage: 'Fixture identity unavailable' },
            503,
          )
        : jsonResponse({ success: true, data: current });
    if (url.pathname === listPath) return jsonResponse(list);
    if (url.pathname === neoPath) {
      expect(url.searchParams.getAll('groupId')).toEqual([id]);
      return options.detailGate
        ? options.detailGate.promise
        : jsonResponse({ success: true, data: detail });
    }
    // Preserve the current ordinary/padded healthy controls before implementation.
    if (url.pathname === `${listPath}/${encodeURIComponent(id)}`)
      return options.detailGate
        ? options.detailGate.promise
        : jsonResponse({ success: true, data: detail });
    throw new Error(`Unexpected synthetic catalog read ${url.pathname}`);
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
  await identity.ensure();
  const history = createMemoryHistory({ initialEntries: [route] });
  const router = createAppRouter(identity, history);
  router.update({
    context: { identity },
    isServer: false,
    origin: 'https://app.test',
  });
  await router.load();
  dispose.push(() => {
    identity.stop();
    runtime.dispose();
    history.destroy();
  });
  render(
    <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
      <QueryClientProvider client={runtime.queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return {
    reads,
    runtime,
    identity,
    detail,
    router,
    changeSession: () => {
      current = { ...current, sessionId: 'replacement-session-242' };
    },
  };
}

describe.each(['primary', 'competitor'] as const)(
  '%s actual catalog selection → typed detail read',
  (domain) => {
    it.each(samples)(
      'shows the original selected literal %j with its child ASIN',
      async (id) => {
        const f = await fixture(domain, id);
        await screen.findAllByText('Select literal catalog group');
        fireEvent.click(screen.getAllByRole('button', { name: /^查看$/ })[0]);
        const headings = await screen.findAllByRole('heading', {
          name: 'Original literal detail',
          level: 3,
        });
        expect(headings).toHaveLength(2);
        for (const heading of headings) {
          expect(heading.textContent).toBe('Original literal detail');
          const panel = heading.closest('[aria-label$="变体组详情"]');
          expect(panel).not.toBeNull();
          expect(
            await within(panel as HTMLElement).findByText('B000000242'),
          ).toBeTruthy();
        }
        const detailReads = f.reads.filter(
          (url) =>
            url.pathname.endsWith('/detail') ||
            url.pathname.includes('/variant-groups/'),
        );
        expect(detailReads).toHaveLength(1);
        const url = detailReads[0];
        expect(
          url.pathname.endsWith('/detail')
            ? url.searchParams.get('groupId')
            : decodeURIComponent(url.pathname.split('/').at(-1)!),
        ).toBe(id);
        expect(
          f.runtime.queryClient.getQueryData([
            domain === 'primary' ? 'asin' : 'competitor',
            'group',
            id,
          ]),
        ).toEqual(f.detail);
        expect(
          f.reads.every((url) => !url.pathname.includes('/api/api/')),
        ).toBe(true);
      },
    );
    it('denies reads when the actual current identity lacks asin:read', async () => {
      const f = await fixture(domain, 'Raw', { permissions: [] });
      await waitFor(() =>
        expect(f.router.state.location.pathname).toBe('/403'),
      );
      expect(
        f.reads.every((url) => url.pathname === '/api/v1/auth/current-user'),
      ).toBe(true);
    });
    it('does not read catalog data when actual identity verification fails', async () => {
      const f = await fixture(domain, 'Raw', { identityUnavailable: true });
      await screen.findByRole('heading', { name: '暂时无法验证登录状态' });
      expect(
        f.reads.every((url) => url.pathname === '/api/v1/auth/current-user'),
      ).toBe(true);
    });
    it('retires an old detail response when the verified session changes', async () => {
      const gate = deferred<Response>();
      const f = await fixture(domain, 'Raw', { detailGate: gate });
      await screen.findAllByText('Select literal catalog group');
      fireEvent.click(screen.getAllByRole('button', { name: /^查看$/ })[0]);
      await waitFor(() =>
        expect(
          f.reads.filter((url) => url.pathname.includes('/variant-groups/')),
        ).toHaveLength(1),
      );
      f.changeSession();
      await f.identity.refresh();
      gate.resolve(jsonResponse({ success: true, data: f.detail }));
      await waitFor(() =>
        expect(
          f.runtime.queryClient.getQueryData([
            domain === 'primary' ? 'asin' : 'competitor',
            'group',
            'Raw',
          ]),
        ).toBeUndefined(),
      );
      expect(
        screen.queryAllByRole('heading', {
          name: 'Original literal detail',
          level: 3,
        }),
      ).toHaveLength(0);
    });
  },
);
