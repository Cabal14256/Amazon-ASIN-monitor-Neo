import type { MonitorStatusIntervalData } from '@asin-monitor/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StatusIntervalTimeline } from './history-browser';

const data: MonitorStatusIntervalData = {
  coverage: 'complete',
  current: 1,
  pageSize: 50,
  total: 51,
  list: [
    {
      asinKey: 'B000000001',
      asinId: 'asin-1',
      asinCode: 'B000000001',
      asinName: 'Fixture item',
      country: 'US',
      variantGroupId: 'group-1',
      variantGroupName: 'Fixture group',
      intervalStart: '2026-09-01 06:00:00',
      intervalEnd: '2026-09-01 18:00:00',
      isBroken: true,
    },
  ],
};
function render(value = data, pending = false) {
  return renderToStaticMarkup(
    <StatusIntervalTimeline
      data={value}
      windowStart="2026-09-01 00:00:00"
      windowEnd="2026-09-02 00:00:00"
      pending={pending}
      changePage={vi.fn()}
    />,
  );
}
function button(html: string, text: string) {
  return html.match(new RegExp(`<button[^>]*>${text}</button>`))?.[0];
}

describe('status interval timeline', () => {
  it('positions an abnormal interval after the start of its time window', () => {
    const html = render();
    expect(html).toContain('relative h-3');
    expect(html).toContain('absolute h-full');
    expect(html).toContain('left:25%;width:50%');
    expect(html).toContain('异常');
  });
  it('shows the total and permits reading intervals beyond the first 50', () => {
    const html = render();
    expect(html).toContain('共 51 个区间');
    expect(button(html, '上一页区间')).toContain('disabled=""');
    expect(button(html, '下一页区间')).toBeTruthy();
    expect(button(html, '下一页区间')).not.toContain('disabled=""');
    const last = render({ ...data, current: 2 });
    expect(button(last, '上一页区间')).not.toContain('disabled=""');
    expect(button(last, '下一页区间')).toContain('disabled=""');
  });
  it('can return from a page emptied by a concurrent projection refresh', () => {
    const html = render({ ...data, current: 2, total: 1, list: [] });
    expect(html).toContain('暂无状态区间');
    expect(button(html, '上一页区间')).not.toContain('disabled=""');
    expect(button(render(data, true), '下一页区间')).toContain('disabled=""');
  });
  it('never displays interval records whose coverage is stale', () => {
    const html = render({ ...data, coverage: 'stale' });
    expect(html).toContain('状态区间尚未覆盖');
    expect(html).not.toContain('Fixture item');
    expect(button(html, '下一页区间')).toBeUndefined();
  });
});
