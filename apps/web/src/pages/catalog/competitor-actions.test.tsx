// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import { ApiError, HttpClient } from '../../lib/http';
import { jsonResponse, sessionFixture } from '../../lib/transport-fixtures';
import type { createTransportRuntime } from '../../services/runtime';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { CatalogActionPanel } from './catalog-actions';
import type { CatalogAction, CatalogConfig } from './catalog-types';
import { GroupRows } from './index';

const child = {
  id: 'child-1',
  asin: 'B00RIVAL00',
  name: 'Rival child',
  country: 'DE',
  brand: 'Rival',
  asinType: '2',
};
const group = {
  id: 'group-1',
  name: 'Rival group',
  country: 'DE',
  brand: 'Rival',
  updateTime: '2020-01-01T00:00:00.000Z',
  children: [child],
};
const target = {
  id: 'group-2',
  name: 'Target group',
  country: 'DE',
  brand: 'Other',
  updateTime: '2020-02-02T00:00:00.000Z',
  children: [],
};

afterEach(() => cleanup());

function actionFixture(action: CatalogAction) {
  const source = 'group' in action ? action.group : group;
  const request = vi.fn(
    async (...args: [string, { method?: string; json?: unknown }?]) => {
      void args;
      return { success: true, data: '删除成功' };
    },
  );
  const detail = vi.fn(async (_http: Pick<HttpClient, 'request'>, id: string) =>
    id === target.id ? target : source,
  );
  const list = vi.fn(async () => ({
    list: [group, target, { ...target, id: 'foreign', country: 'US' }],
    total: 3,
    current: 1,
    pageSize: 20,
  }));
  const config = { ...COMPETITOR_CATALOG, detail, list } as CatalogConfig;
  const saved = vi.fn(async () => undefined);
  const close = vi.fn();
  const denied = vi.fn();
  const uncertain = vi.fn();
  const writingChange = vi.fn();
  render(
    <CatalogActionPanel
      action={action}
      config={config}
      http={{ request } as unknown as Pick<HttpClient, 'request'>}
      saved={saved}
      close={close}
      denied={denied}
      uncertain={uncertain}
      writingChange={writingChange}
      runExclusive={async (work) => work()}
      beginWrite={() => ({
        phase: 'refresh',
        message: null,
        detailId: null,
        createUncertain: false,
      })}
      releaseWrite={vi.fn()}
    />,
  );
  return {
    request,
    detail,
    list,
    saved,
    close,
    denied,
    uncertain,
    writingChange,
  };
}

describe('competitor catalog single-item controls', () => {
  it('sends the preflight target version and reports a later server lock conflict without success or uncertainty', async () => {
    const f = actionFixture({ type: 'move-asin', group, child });
    f.request.mockRejectedValue(
      new ApiError('HTTP', '竞品目标记录已变化，请刷新后重试', 409),
    );
    fireEvent.click(screen.getByRole('button', { name: '查找目标组' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Target group/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: '确认移动' }));
    await screen.findByRole('alert');
    expect(f.request.mock.calls[0][1]?.json).toMatchObject({
      expectedTargetSnapshot: {
        id: target.id,
        name: target.name,
        country: target.country,
        brand: target.brand,
        updateTime: target.updateTime,
      },
    });
    expect(screen.getByRole('alert').textContent).toContain('目标状态已变化');
    expect(f.saved).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.uncertain).not.toHaveBeenCalled();
  });
  it.each(['/api/', 'https://app.test/api/'])(
    'preserves canonical whitespace and non-ASCII IDs across the mounted move and actual %s HttpClient',
    async (baseURL) => {
      const original = { ...group, id: ' Source Şöurce ' };
      const originalChild = { ...child, id: ' Child α ' };
      original.children = [originalChild];
      const destination = { ...target, id: ' Gróup cible ' };
      const fetcher = vi.fn<typeof fetch>(async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (options?.method === 'POST')
          return jsonResponse({
            success: true,
            data: { ...originalChild, variantGroupId: destination.id },
          });
        if (path.endsWith(`/${encodeURIComponent(original.id)}`))
          return jsonResponse({ success: true, data: original });
        if (path.endsWith(`/${encodeURIComponent(destination.id)}`))
          return jsonResponse({ success: true, data: destination });
        return jsonResponse({
          success: true,
          data: {
            list: [original, destination],
            total: 2,
            current: 1,
            pageSize: 20,
          },
        });
      });
      const http = new HttpClient({
        baseURL,
        pageOrigin: 'https://app.test',
        session: sessionFixture().store,
        fetch: fetcher,
      });
      const saved = vi.fn(async () => undefined);
      try {
        render(
          <CatalogActionPanel
            action={{
              type: 'move-asin',
              group: original,
              child: originalChild,
            }}
            config={COMPETITOR_CATALOG}
            http={http}
            saved={saved}
            close={vi.fn()}
            denied={vi.fn()}
            uncertain={vi.fn()}
            writingChange={vi.fn()}
            runExclusive={async (work) => work()}
            beginWrite={() => ({
              phase: 'refresh',
              message: null,
              detailId: null,
              createUncertain: false,
            })}
            releaseWrite={vi.fn()}
          />,
        );
        fireEvent.click(screen.getByRole('button', { name: '查找目标组' }));
        fireEvent.click(
          await screen.findByRole('button', { name: /Target group/ }),
        );
        fireEvent.click(screen.getByRole('button', { name: '确认移动' }));
        await waitFor(() => expect(saved).toHaveBeenCalledOnce());
        const urls = fetcher.mock.calls.map((call) => String(call[0]));
        expect(urls).toContain(
          `https://app.test/api/v1/competitor/variant-groups/${encodeURIComponent(
            original.id,
          )}`,
        );
        expect(urls).toContain(
          `https://app.test/api/v1/competitor/variant-groups/${encodeURIComponent(
            destination.id,
          )}`,
        );
        expect(urls.some((url) => url.includes('/api/api/'))).toBe(false);
        const mutation = fetcher.mock.calls.find(
          (call) => call[1]?.method === 'POST',
        )!;
        expect(String(mutation[0])).toBe(
          `https://app.test/api/v1/competitor/asins/${encodeURIComponent(
            originalChild.id,
          )}/move`,
        );
        expect(JSON.parse(String(mutation[1]?.body))).toMatchObject({
          targetGroupId: destination.id,
          expectedSourceGroup: original.id,
          expectedTargetSnapshot: {
            id: destination.id,
            name: destination.name,
            country: destination.country,
            brand: destination.brand,
            updateTime: destination.updateTime,
          },
        });
      } finally {
        cleanup();
        http.close();
      }
    },
  );
  it('sends the confirmed parent after a matching preflight and reports a server lock conflict without claiming success', async () => {
    const original = { ...group, name: '\n ', brand: '' };
    const f = actionFixture({ type: 'create-asin', group: original });
    f.request.mockRejectedValue(
      new ApiError('HTTP', '竞品记录已变化，请刷新后重试', 409),
    );
    fireEvent.change(screen.getAllByLabelText(/^ASIN/)[0], {
      target: { value: child.asin },
    });
    fireEvent.change(screen.getByLabelText(/^品牌/), {
      target: { value: 'Own brand' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('alert');
    expect(f.detail).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0][1]?.json).toMatchObject({
      parentId: original.id,
      brand: 'Own brand',
      expectedParent: {
        name: original.name,
        country: original.country,
        brand: original.brand,
        updateTime: original.updateTime,
      },
    });
    expect(screen.getByRole('alert').textContent).toContain('目标状态已变化');
    expect(f.saved).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.uncertain).not.toHaveBeenCalled();
    expect(f.denied).not.toHaveBeenCalled();
  });
  it.each(['edit-group', 'delete-group'] as const)(
    'preserves persisted whitespace in the mounted %s request',
    async (type) => {
      const original = { ...group, name: '\n ', country: '', brand: '' };
      const f = actionFixture({ type, group: original });
      if (type === 'edit-group') {
        fireEvent.change(screen.getByLabelText(/^变体组名称/), {
          target: { value: 'Repaired group' },
        });
        fireEvent.change(screen.getByLabelText(/^国家代码/), {
          target: { value: 'US' },
        });
        fireEvent.change(screen.getByLabelText(/^品牌/), {
          target: { value: 'Repaired brand' },
        });
      }
      fireEvent.click(
        screen.getByRole('button', {
          name: type === 'edit-group' ? '保存' : '确认删除',
        }),
      );
      await waitFor(() => expect(f.saved).toHaveBeenCalledOnce());
      expect(f.request.mock.calls[0][1]?.json).toMatchObject({
        expectedSource: {
          name: original.name,
          country: '',
          brand: '',
          updateTime: original.updateTime,
        },
      });
    },
  );
  it('accepts a competitor identifier beyond the primary ten-character domain', async () => {
    const f = actionFixture({ type: 'create-asin', group });
    const input = screen.getAllByLabelText(/^ASIN/)[0];
    expect(input).toHaveProperty('maxLength', 40);
    fireEvent.change(input, { target: { value: 'retail-code-2026' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(f.saved).toHaveBeenCalledOnce());
    expect(f.request.mock.calls[0][1]?.json).toMatchObject({
      asin: 'RETAIL-CODE-2026',
    });
  });
  it('keeps the shared detail read-only without write/delete grants', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const config = {
      ...COMPETITOR_CATALOG,
      detail: vi.fn(async () => group),
    } as CatalogConfig;
    const runtime = {
      http: { request: vi.fn() },
    } as unknown as ReturnType<typeof createTransportRuntime>;
    const view = (canWrite: boolean, canDelete: boolean) => (
      <AuthContext.Provider
        value={{
          runtime,
          identity: {} as IdentityStore,
          announce: vi.fn(),
        }}
      >
        <QueryClientProvider client={queryClient}>
          <GroupRows
            groups={[group]}
            config={config}
            selectedId={group.id}
            onSelect={vi.fn()}
            canWrite={canWrite}
            canDelete={canDelete}
          />
        </QueryClientProvider>
      </AuthContext.Provider>
    );
    const page = render(view(false, false));
    await screen.findAllByText('B00RIVAL00');
    expect(screen.queryByRole('button', { name: '编辑变体组' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除变体组' })).toBeNull();
    page.rerender(view(true, false));
    expect(screen.getAllByRole('button', { name: '编辑变体组' })).toHaveLength(
      2,
    );
    expect(screen.getAllByRole('button', { name: '添加 ASIN' })).toHaveLength(
      2,
    );
    expect(screen.getAllByRole('button', { name: '移动' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '删除变体组' })).toBeNull();
    expect(screen.queryByRole('button', { name: '开启飞书通知' })).toBeNull();
    expect(screen.queryByRole('button', { name: '标记人工异常' })).toBeNull();
    page.rerender(view(false, true));
    expect(screen.getAllByRole('button', { name: '删除变体组' })).toHaveLength(
      2,
    );
    expect(screen.queryByRole('button', { name: '编辑变体组' })).toBeNull();
    queryClient.clear();
  });

  it.each([
    {
      action: { type: 'create-group' } as const,
      method: 'POST',
      path: '/api/v1/competitor/variant-groups',
    },
    {
      action: { type: 'edit-group', group } as const,
      method: 'PUT',
      path: '/api/v1/competitor/variant-groups/group-1',
    },
    {
      action: { type: 'delete-group', group } as const,
      method: 'DELETE',
      path: '/api/v1/competitor/variant-groups/group-1',
    },
    {
      action: { type: 'create-asin', group } as const,
      method: 'POST',
      path: '/api/v1/competitor/asins',
    },
    {
      action: { type: 'edit-asin', group, child } as const,
      method: 'PUT',
      path: '/api/v1/competitor/asins/child-1',
    },
    {
      action: { type: 'move-asin', group, child } as const,
      method: 'POST',
      path: '/api/v1/competitor/asins/child-1/move',
    },
    {
      action: { type: 'delete-asin', group, child } as const,
      method: 'DELETE',
      path: '/api/v1/competitor/asins/child-1',
    },
  ])(
    'submits $action.type through the competitor API',
    async ({ action, method, path }) => {
      const f = actionFixture(action);
      expect(screen.queryByLabelText('站点')).toBeNull();
      expect(screen.queryByText('人工标记原因')).toBeNull();
      if (action.type === 'create-group') {
        fireEvent.change(screen.getByLabelText(/^变体组名称/), {
          target: { value: group.name },
        });
        fireEvent.change(screen.getByLabelText(/^国家代码/), {
          target: { value: 'de' },
        });
        fireEvent.change(screen.getByLabelText(/^品牌/), {
          target: { value: group.brand },
        });
      }
      if (action.type === 'create-asin') {
        fireEvent.change(screen.getAllByLabelText(/^ASIN/)[0], {
          target: { value: child.asin.toLowerCase() },
        });
      }
      if (action.type === 'create-asin' || action.type === 'edit-asin') {
        expect(screen.getByLabelText(/^国家代码/)).toHaveProperty(
          'disabled',
          true,
        );
        expect(screen.getByLabelText(/^国家代码/)).toHaveProperty(
          'value',
          'DE',
        );
      }
      if (action.type === 'move-asin') {
        fireEvent.click(screen.getByRole('button', { name: '查找目标组' }));
        await screen.findByRole('button', { name: /Target group/ });
        expect(f.list).toHaveBeenCalledWith(expect.anything(), {
          keyword: undefined,
          country: 'DE',
          current: 1,
          pageSize: 20,
        });
        expect(screen.queryByRole('button', { name: /foreign/ })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Target group/ }));
      }
      fireEvent.click(
        screen.getByRole('button', {
          name:
            action.type === 'move-asin'
              ? '确认移动'
              : action.type.startsWith('delete')
              ? '确认删除'
              : '保存',
        }),
      );
      await waitFor(() => expect(f.saved).toHaveBeenCalledOnce());
      expect(f.request).toHaveBeenCalledOnce();
      expect(f.request.mock.calls[0][0]).toBe(path);
      expect(f.request.mock.calls[0][1]).toMatchObject({ method });
      const options = f.request.mock.calls[0][1] as {
        json?: Record<string, unknown>;
      };
      if (options.json) expect(options.json).not.toHaveProperty('site');
      if (action.type === 'create-asin')
        expect(options.json).toMatchObject({
          asin: child.asin,
          country: 'DE',
          parentId: group.id,
          expectedParent: {
            name: group.name,
            country: group.country,
            brand: group.brand,
            updateTime: group.updateTime,
          },
        });
      if (action.type === 'edit-group' || action.type === 'delete-group')
        expect(options.json).toMatchObject({
          expectedSource: {
            name: group.name,
            country: group.country,
            brand: group.brand,
          },
        });
      if (action.type === 'delete-group')
        expect(options.json).toMatchObject({ expectedChildIds: [child.id] });
      if (action.type === 'edit-asin' || action.type === 'delete-asin')
        expect(options.json).toMatchObject({
          expectedSource: {
            variantGroupId: group.id,
            asin: child.asin,
            country: child.country,
            brand: child.brand,
          },
        });
      if (action.type === 'move-asin') {
        expect(options.json).toEqual({
          targetGroupId: target.id,
          expectedSourceGroup: group.id,
          expectedTargetSnapshot: {
            id: target.id,
            name: target.name,
            country: target.country,
            brand: target.brand,
            updateTime: target.updateTime,
          },
        });
        expect(f.detail).toHaveBeenCalledWith(expect.anything(), target.id);
      }
      expect(f.close).toHaveBeenCalledOnce();
    },
  );

  it('does not claim success after cancellation or a rejected write', async () => {
    const cancel = actionFixture({ type: 'delete-group', group });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(cancel.close).toHaveBeenCalledOnce();
    expect(cancel.request).not.toHaveBeenCalled();
    cleanup();
    const failed = actionFixture({ type: 'edit-group', group });
    failed.request.mockRejectedValue(
      new ApiError('HTTP', 'private payload', 403),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(failed.denied).toHaveBeenCalledOnce());
    expect(failed.saved).not.toHaveBeenCalled();
    expect(failed.close).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')?.textContent ?? '').not.toContain(
      'private payload',
    );
  });

  it.each([
    [
      'unconfirmed response',
      new ApiError('HTTP', '写入结果未确认，请刷新数据后再操作', 503),
    ],
    ['cancelled dispatched request', new ApiError('CANCELLED', '请求已取消')],
  ])('keeps the safety gate after %s', async (_reason, error) => {
    const f = actionFixture({ type: 'delete-asin', group, child });
    f.request.mockRejectedValue(error);
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() =>
      expect(f.uncertain).toHaveBeenCalledWith(
        { type: 'delete-asin', group, child },
        expect.objectContaining({ phase: 'refresh' }),
      ),
    );
    expect(f.saved).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });
});
