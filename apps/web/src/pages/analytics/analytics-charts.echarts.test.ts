import { describe, expect, it } from 'vitest';
import { init } from '../../components/charts/echarts-runtime';
import {
  countryBarOption,
  countryPieOption,
  rankingOption,
  timeTrendOption,
  type DurationPoint,
} from './analytics-chart-data';

const countries: DurationPoint[] = [
  { label: 'US', abnormal: 2, normal: 6, total: 8, ratio: 25 },
  { label: 'UK', abnormal: 6, normal: 6, total: 12, ratio: 50 },
];
describe('real registered ECharts Analytics rendering', () => {
  it('renders a Shanghai time trend, minute-accurate peak backgrounds and working full-range zoom as SVG', () => {
    const chart = init(null, undefined, {
      renderer: 'svg',
      ssr: true,
      width: 960,
      height: 400,
    });
    try {
      chart.setOption({
        ...timeTrendOption(
          [
            { ...countries[0], label: '2026-09-01 00:00' },
            { ...countries[0], label: '2026-09-01 12:00' },
            { ...countries[0], label: '2026-09-02 00:00' },
          ],
          'percent',
          [
            {
              name: 'US',
              color: '#c157e7',
              areas: [
                [
                  { name: 'US', xAxis: '2026-09-01 02:00' },
                  { xAxis: '2026-09-01 05:30' },
                ],
              ],
            },
          ],
        ),
        animation: false,
      });
      const svg = chart.renderToSVGString();
      expect(svg).toContain('<svg');
      expect(svg).toContain('<path');
      expect(svg).toContain('fill="#c157e7"');
      expect(svg).not.toContain('NaN');
      expect(chart.getOption()).toMatchObject({
        xAxis: [{ type: 'time' }],
        dataZoom: [
          { start: 0, end: 100 },
          { start: 0, end: 100 },
        ],
        series: [
          {
            data: [
              [Date.parse('2026-09-01T00:00+08:00'), 25],
              [Date.parse('2026-09-01T12:00+08:00'), 25],
              [Date.parse('2026-09-02T00:00+08:00'), 25],
            ],
            markArea: {
              data: [
                [
                  { xAxis: Date.parse('2026-09-01T02:00+08:00') },
                  { xAxis: Date.parse('2026-09-01T05:30+08:00') },
                ],
              ],
            },
          },
        ],
      });
      chart.dispatchAction({ type: 'dataZoom', start: 25, end: 75 });
      expect(chart.getOption()).toMatchObject({
        dataZoom: [
          { start: 25, end: 75 },
          { start: 25, end: 75 },
        ],
        series: [{ data: expect.any(Array) }],
      });
      expect(chart.renderToSVGString()).not.toContain('NaN');
    } finally {
      chart.dispose();
    }
  });

  it('renders country stacked bars, distribution pie and all ranking source rows through the actual renderer', () => {
    const options = [
      countryBarOption(countries, 'percent'),
      countryPieOption(countries, 'percent'),
      rankingOption(
        Array.from({ length: 50 }, (_, index) => ({
          ...countries[0],
          label: `Group ${index}`,
        })),
        'hours',
      ),
    ];
    for (const option of options) {
      const chart = init(null, undefined, {
        renderer: 'svg',
        ssr: true,
        width: 960,
        height: 400,
      });
      try {
        chart.setOption({ ...option, animation: false });
        const svg = chart.renderToSVGString();
        expect(svg).toContain('<svg');
        expect(svg).toContain('<path');
        expect(svg).not.toContain('NaN');
        expect(chart.getOption()).toMatchObject({ series: option.series });
      } finally {
        chart.dispose();
      }
    }
  });
});
