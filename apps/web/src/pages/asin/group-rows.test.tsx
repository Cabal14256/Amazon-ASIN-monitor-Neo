import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GroupRows } from './index';

describe('ASIN table', () => {
  it('renders every server page row without local pagination or filtering', () => {
    const html = renderToStaticMarkup(
      <GroupRows
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
});
