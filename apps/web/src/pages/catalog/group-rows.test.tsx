import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { IdentityStore } from '../../auth/identity';
import type { createTransportRuntime } from '../../services/runtime';
import { ASIN_CATALOG } from '../asin/config';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { GroupRows } from './index';

describe('ASIN table', () => {
  it('shows primary single-item controls only with their matching permission', () => {
    const group = {
      id: 'first',
      name: 'Alpha',
      country: 'US',
      site: 'amazon.com',
      brand: 'Brand',
      children: [{ id: 'child-1', asin: 'B00TEST', country: 'US' }],
    };
    const queryClient = new QueryClient();
    queryClient.setQueryData(['asin', 'group', group.id], group);
    const runtime = {
      http: { request: () => undefined },
    } as unknown as ReturnType<typeof createTransportRuntime>;
    const render = (canWrite: boolean, canDelete: boolean) =>
      renderToStaticMarkup(
        <AuthContext.Provider
          value={{
            runtime,
            identity: {} as IdentityStore,
            announce: () => undefined,
          }}
        >
          <QueryClientProvider client={queryClient}>
            <GroupRows
              config={ASIN_CATALOG}
              groups={[group]}
              selectedId="first"
              onSelect={() => undefined}
              canWrite={canWrite}
              canDelete={canDelete}
            />
          </QueryClientProvider>
        </AuthContext.Provider>,
      );
    const writer = render(true, false);
    expect(writer).toContain('编辑变体组');
    expect(writer).toContain('添加 ASIN');
    expect(writer).toContain('移动');
    expect(writer).not.toContain('删除变体组');
    const deleter = render(false, true);
    expect(deleter).toContain('删除变体组');
    expect(deleter).toContain('删除');
    expect(deleter).not.toContain('编辑变体组');
  });
  it('renders every server page row without local pagination or filtering', () => {
    const html = renderToStaticMarkup(
      <GroupRows
        config={ASIN_CATALOG}
        groups={[
          {
            id: 'first',
            name: 'Alpha',
            country: 'US',
            site: 'amazon.com',
            brand: 'Brand A',
            isBroken: 1,
            children: [],
          },
          {
            id: 'second',
            name: 'Beta',
            country: 'DE',
            site: 'amazon.de',
            brand: 'Brand B',
            isBroken: 0,
            children: [],
          },
        ]}
        selectedId={null}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('<table');
    expect(html).toContain('站点 / 品牌');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(html).toContain('异常');
    expect(html).toContain('正常');
  });
  it('uses competitor display status and omits main-only site/source fields', () => {
    const html = renderToStaticMarkup(
      <GroupRows
        config={COMPETITOR_CATALOG}
        groups={[
          {
            id: 'competitor-1',
            name: 'Rival group',
            country: 'DE',
            brand: 'Rival',
            site: 'must-not-render',
            statusSource: 'MANUAL',
            is_broken: 1,
            isBroken: 0,
            children: [],
          },
        ]}
        selectedId={null}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('国家 / 品牌');
    expect(html).toContain('Rival group');
    expect(html).toContain('正常');
    expect(html).not.toContain('must-not-render');
    expect(html).not.toContain('人工标记');
  });
});
