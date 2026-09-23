import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ASIN_CATALOG } from '../asin/config';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { GroupRows } from './index';

describe('ASIN table', () => {
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
