// @vitest-environment jsdom
import {
  neoBatchDeleteVariantGroupsRequestSchema,
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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import { IdentityStore } from '../../auth/identity';
import { RouteGate } from '../../auth/route-gate';
import {
  FakeSocket,
  jsonResponse,
  sessionFixture,
} from '../../lib/transport-fixtures';
import { batchDeleteVariantGroups } from '../../services/asin';
import { batchDeleteCompetitorGroups } from '../../services/competitor-asin';
import { createTransportRuntime } from '../../services/runtime';
import { ASIN_CATALOG } from '../asin/config';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { readCatalogSafetyGate } from './catalog-safety-gate';
import { CatalogPage } from './index';

vi.mock('../../components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const domains = ['asin', 'competitor'] as const;
const configs = { asin: ASIN_CATALOG, competitor: COMPETITOR_CATALOG };
const services = {
  asin: batchDeleteVariantGroups,
  competitor: batchDeleteCompetitorGroups,
};
const owner = 'literal-211-owner';
const sessionId = 'literal-211-session';
const user: CurrentUserData = {
  user: {
    id: owner,
    username: 'synthetic-literal-fixture',
    status: 'ACTIVE',
    force_password_change: false,
  },
  sessionId,
  permissions: ['asin:read', 'asin:write', 'asin:delete'],
  roles: [],
  mustChangePassword: false,
  passwordExpired: false,
};
const rawIds = [
  ' Source Ś ',
  'Source Ś',
  '\u00a0组😀\u00a0',
  ' ',
  ` ${'😀'.repeat(48)} `,
];
const invalidIds = [
  { label: 'empty', id: '' },
  { label: 'C0', id: 'bad\u0000id' },
  { label: 'C1', id: 'bad\u0081id' },
  { label: 'DEL', id: 'bad\u007fid' },
  { label: 'high-surrogate', id: 'bad\ud800id' },
  { label: 'low-surrogate', id: 'bad\udc00id' },
  { label: '51-codepoints', id: '😀'.repeat(51) },
];
const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, work: () => unknown) => {
        const result = (tails.get(name) ?? Promise.resolve()).then(work);
        tails.set(
          name,
          result.catch(() => undefined),
        );
        return result;
      },
    },
  });
});

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'locks');
});

async function fixture(
  domain: (typeof domains)[number],
  ids: string[] = rawIds,
  mount = true,
) {
  const groupsPath =
    domain === 'asin'
      ? '/api/v1/variant-groups'
      : '/api/v1/competitor/variant-groups';
  const taskId = `literal-delete-${domain}`;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/auth/current-user' && init?.method === 'GET')
      return jsonResponse({ success: true, data: user });
    if (url.pathname === groupsPath && init?.method === 'GET')
      return jsonResponse({
        success: true,
        data: {
          list: ids.map((id, index) => ({
            id,
            name: `Literal group ${index}`,
            country: 'US',
            site: 'amazon.com',
            brand: 'Synthetic',
            children: [],
          })),
          total: ids.length,
          current: Number(url.searchParams.get('current') || 1),
          pageSize: 10,
        },
      });
    if (
      url.pathname === `${groupsPath}/batch-delete` &&
      init?.method === 'POST'
    ) {
      const request = neoBatchDeleteVariantGroupsRequestSchema.safeParse(
        JSON.parse(String(init.body)),
      );
      if (!request.success)
        return jsonResponse(
          {
            success: false,
            errorCode: 400,
            errorMessage: 'Invalid literal targets',
          },
          400,
        );
      return jsonResponse({
        success: true,
        data: {
          mode: 'async',
          taskId,
          status: 'pending',
          totalRequested:
            (request.data.groupIds?.length ?? 0) +
            (request.data.asinIds?.length ?? 0),
        },
      });
    }
    if (url.pathname === `/api/v1/tasks/${taskId}` && init?.method === 'GET')
      return jsonResponse({
        success: true,
        data: {
          taskId,
          taskType: 'batch-delete',
          taskSubType:
            domain === 'asin'
              ? 'variant-group-delete'
              : 'competitor-variant-group-delete',
          title: '批量删除',
          status: 'processing',
          progress: 10,
          message: 'Synthetic processing fixture',
          error: null,
          createdAt: null,
          updatedAt: null,
          startedAt: null,
          completedAt: null,
          cancelRequestedAt: null,
          cancelledAt: null,
          canCancel: false,
          filename: null,
          downloadUrl: null,
          result: null,
        },
      });
    throw new Error(
      `Unexpected literal fixture request: ${init?.method} ${url.pathname}`,
    );
  });
  const runtime = createTransportRuntime({
    baseURL: '/api/',
    pageOrigin: 'https://app.test/',
    session: sessionFixture().store,
    socket: () => new FakeSocket(),
    fetch: fetcher,
  });
  runtime.queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  const identity = new IdentityStore(runtime);
  const history = createMemoryHistory({
    initialEntries: [domain === 'asin' ? '/asin' : '/competitor-asin'],
  });
  disposers.push(() => {
    identity.stop();
    runtime.dispose();
    history.destroy();
  });
  expect(await identity.ensure()).toEqual({
    status: 'authenticated',
    identity: user,
  });
  if (mount) {
    const rootRoute = createRootRoute({ component: Outlet });
    const catalogRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: domain === 'asin' ? '/asin' : '/competitor-asin',
      component: () => (
        <RouteGate>
          <CatalogPage config={configs[domain]} />
        </RouteGate>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([catalogRoute]),
      history,
      isServer: false,
    });
    router.update({ origin: 'https://app.test' });
    await router.load();
    render(
      <AuthContext.Provider value={{ runtime, identity, announce: vi.fn() }}>
        <QueryClientProvider client={runtime.queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AuthContext.Provider>,
    );
  }
  return {
    runtime,
    groupsPath,
    taskId,
    service: services[domain],
    mutations: () =>
      fetcher.mock.calls.filter((call) => call[1]?.method === 'POST'),
  };
}

async function confirm(expectedIds: string[]) {
  fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
  const panel = screen.getByRole('alert', { name: '确认批量删除' });
  expect(
    [...panel.querySelectorAll('li')].map((node) => node.textContent),
  ).toEqual(expectedIds.map((id) => JSON.stringify(id)));
  fireEvent.click(screen.getByRole('button', { name: '确认批量删除' }));
}

describe('literal batch-delete IDs through actual identity, selection and typed HTTP', () => {
  it.each(
    domains.flatMap((domain) =>
      [
        {
          label: 'padded and trimmed neighbours',
          ids: [' Source Ś ', 'Source Ś'],
        },
        {
          label: 'consecutive and pure whitespace',
          ids: ['  ', '\u00a0 \u00a0'],
        },
        {
          label: 'quotes, backslashes and Unicode',
          ids: ['Quote"\\Ś', '\u00a0组😀\u00a0'],
        },
      ].map((value) => ({ domain, ...value })),
    ),
  )(
    'displays unambiguous $domain $label in actual destructive confirmation without changing HTTP targets',
    async ({ domain, ids }) => {
      const f = await fixture(domain, ids);
      const select = await screen.findByRole('button', {
        name: '选择本页可删除组',
      });
      await waitFor(() => expect(select).toHaveProperty('disabled', false));
      fireEvent.click(select);
      for (let index = 0; index < ids.length; index++) {
        const controls = screen.getAllByRole('checkbox', {
          name: (_name, element) =>
            element.getAttribute('aria-label') ===
            `选择变体组 Literal group ${index}，ID ${JSON.stringify(
              ids[index],
            )}`,
        });
        expect(
          controls.every((control) => (control as HTMLInputElement).checked),
        ).toBe(true);
      }
      fireEvent.click(screen.getByRole('button', { name: '批量删除所选组' }));
      const panel = screen.getByRole('alert', { name: '确认批量删除' });
      const targets = [...panel.querySelectorAll('li')];
      expect(targets.map((node) => node.textContent)).toEqual(
        ids.map((id) => JSON.stringify(id)),
      );
      expect(
        targets.every((node) => node.classList.contains('whitespace-pre-wrap')),
      ).toBe(true);
      expect(f.mutations()).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: '确认批量删除' }));
      await waitFor(() => expect(f.mutations()).toHaveLength(1));
      expect(JSON.parse(String(f.mutations()[0][1]?.body))).toEqual({
        groupIds: ids,
        useAsync: true,
      });
      await screen.findByText(`任务 ID：${f.taskId}`);
      expect(readCatalogSafetyGate(localStorage, owner, domain)).toMatchObject({
        state: 'task',
        groupIds: ids,
        taskId: f.taskId,
      });
    },
  );

  it.each(domains)(
    'selects only the original padded %s group while its trimmed neighbour remains unselected',
    async (domain) => {
      const f = await fixture(domain);
      const checkboxes = await screen.findAllByRole('checkbox', {
        name: `选择变体组 Literal group 0，ID ${JSON.stringify(rawIds[0])}`,
      });
      await waitFor(() =>
        expect(
          checkboxes.every(
            (checkbox) => !(checkbox as HTMLInputElement).disabled,
          ),
        ).toBe(true),
      );
      fireEvent.click(checkboxes[0]);
      const neighbour = screen.getAllByRole('checkbox', {
        name: `选择变体组 Literal group 1，ID ${JSON.stringify(rawIds[1])}`,
      });
      expect(
        neighbour.every((checkbox) => !(checkbox as HTMLInputElement).checked),
      ).toBe(true);
      await confirm([rawIds[0]]);
      await waitFor(() => expect(f.mutations()).toHaveLength(1));
      const [request, init] = f.mutations()[0]!;
      expect(new URL(String(request)).pathname).toBe(
        `${f.groupsPath}/batch-delete`,
      );
      expect(String(request)).not.toContain('/api/api/');
      expect(JSON.parse(String(init?.body))).toEqual({
        groupIds: [rawIds[0]],
        useAsync: true,
      });
      expect(init?.credentials).toBe('include');
      await screen.findByText(`任务 ID：${f.taskId}`);
      expect(readCatalogSafetyGate(localStorage, owner, domain)).toMatchObject({
        state: 'task',
        groupIds: [rawIds[0]],
        taskId: f.taskId,
      });
    },
  );

  it.each(domains)(
    'preserves SP, NBSP, pure-space and exactly 50 codepoints through %s current-page selection',
    async (domain) => {
      const f = await fixture(domain);
      const select = await screen.findByRole('button', {
        name: '选择本页可删除组',
      });
      await waitFor(() => expect(select).toHaveProperty('disabled', false));
      fireEvent.click(select);
      expect(screen.getByText(/已选择 5 组/)).toBeTruthy();
      await confirm(rawIds);
      await waitFor(() => expect(f.mutations()).toHaveLength(1));
      expect(JSON.parse(String(f.mutations()[0][1]?.body))).toEqual({
        groupIds: rawIds,
        useAsync: true,
      });
      await screen.findByText(`任务 ID：${f.taskId}`);
      expect(readCatalogSafetyGate(localStorage, owner, domain)).toMatchObject({
        state: 'task',
        groupIds: rawIds,
        taskId: f.taskId,
      });
    },
  );

  it.each(domains)(
    'keeps padded group and direct-ASIN arrays unchanged in the real %s typed service',
    async (domain) => {
      const f = await fixture(domain, [], false);
      const input = {
        groupIds: rawIds,
        asinIds: [' Direct Ś ', '\u00a0ASIN😀\u00a0'],
        useAsync: true,
      };
      expect(await f.service(f.runtime.http, input)).toEqual({
        mode: 'async',
        taskId: f.taskId,
        status: 'pending',
      });
      expect(f.mutations()).toHaveLength(1);
      expect(JSON.parse(String(f.mutations()[0][1]?.body))).toEqual(input);
    },
  );

  it.each(domains)(
    'admits a nonempty pure-space ID as the sole %s target without Legacy trimming',
    async (domain) => {
      const f = await fixture(domain, [], false);
      expect(
        await f.service(f.runtime.http, { groupIds: [' '], useAsync: true }),
      ).toMatchObject({ taskId: f.taskId });
      expect(f.mutations()).toHaveLength(1);
      expect(JSON.parse(String(f.mutations()[0][1]?.body))).toEqual({
        groupIds: [' '],
        useAsync: true,
      });
    },
  );

  it.each(domains)(
    'keeps the healthy ordinary-Unicode %s typed transport control',
    async (domain) => {
      const f = await fixture(domain, [], false);
      const input = { groupIds: ['Grüp-1', '组😀'], useAsync: true };
      expect(await f.service(f.runtime.http, input)).toMatchObject({
        taskId: f.taskId,
      });
      expect(f.mutations()).toHaveLength(1);
      expect(JSON.parse(String(f.mutations()[0][1]?.body))).toEqual(input);
    },
  );

  it.each(domains)(
    'does not select unsafe %s IDs or submit them with the one healthy page target',
    async (domain) => {
      const ids = [...invalidIds.map((value) => value.id), 'Healthy'];
      const f = await fixture(domain, ids);
      for (let index = 0; index < invalidIds.length; index++) {
        const controls = await screen.findAllByRole('checkbox', {
          name: `选择变体组 Literal group ${index}，ID ${JSON.stringify(
            ids[index],
          )}`,
        });
        expect(
          controls.every((control) => (control as HTMLInputElement).disabled),
        ).toBe(true);
      }
      const select = screen.getByRole('button', { name: '选择本页可删除组' });
      await waitFor(() => expect(select).toHaveProperty('disabled', false));
      fireEvent.click(select);
      expect(screen.getByText(/已选择 1 组/)).toBeTruthy();
      await confirm(['Healthy']);
      await waitFor(() => expect(f.mutations()).toHaveLength(1));
      expect(JSON.parse(String(f.mutations()[0][1]?.body))).toEqual({
        groupIds: ['Healthy'],
        useAsync: true,
      });
    },
  );

  it.each(
    domains.flatMap((domain) =>
      invalidIds.map((value) => ({ domain, ...value })),
    ),
  )('rejects $domain $label before any typed POST', async ({ domain, id }) => {
    const f = await fixture(domain, [], false);
    await expect(
      f.service(f.runtime.http, { groupIds: [id] }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.mutations()).toHaveLength(0);
  });

  it.each(domains)(
    'retains the collective 1000-target %s bound before transport',
    async (domain) => {
      const f = await fixture(domain, [], false);
      await expect(
        f.service(f.runtime.http, {
          groupIds: Array.from({ length: 500 }, (_, index) => `group-${index}`),
          asinIds: Array.from({ length: 501 }, (_, index) => `asin-${index}`),
        }),
      ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
      expect(f.mutations()).toHaveLength(0);
    },
  );
});
