import { describe, expect, it } from 'vitest';
import {
  countryBarOption,
  countryPieOption,
  durationPoints,
  rankingOption,
  timeTrendOption,
  trendTimeLabel,
  type PeakArea,
} from './analytics-chart-data';

const points = durationPoints(
  [
    {
      country: 'US',
      abnormalDurationHours: 2,
      normalDurationHours: 6,
      totalDurationHours: 8,
    },
    {
      country: 'UK',
      abnormalDurationHours: 6,
      normalDurationHours: 6,
      totalDurationHours: 12,
    },
    {
      country: 'DE',
      abnormalDurationHours: 0,
      normalDurationHours: 0,
      totalDurationHours: 0,
    },
  ],
  (row) => String(row.country),
);

describe('Legacy-compatible Analytics chart semantics', () => {
  it('uses real hours, per-country total duration for bars and all-country abnormal duration for pie percentages', () => {
    const hours = countryBarOption(points, 'hours').series;
    expect(hours).toMatchObject([{ data: [2, 6, 0] }, { data: [6, 6, 0] }]);
    const percent = countryBarOption(points, 'percent');
    expect(percent.series).toMatchObject([
      { data: [25, 50, 0] },
      { data: [75, 50, 0] },
    ]);
    expect(countryPieOption(points, 'percent').series).toMatchObject([
      {
        data: [
          { name: 'US', value: 25 },
          { name: 'UK', value: 75 },
          { name: 'DE', value: 0 },
        ],
        stillShowZeroSum: false,
      },
    ]);
    expect(rankingOption(points, 'percent').series).toMatchObject([
      { data: [25, 50, 0] },
    ]);
  });

  it('keeps all 5000 trend slots and every ranking source row while zooming', () => {
    const full = Array.from({ length: 5000 }, (_, index) => ({
      ...points[0],
      label: String(index).padStart(4, '0'),
    }));
    const trend = timeTrendOption(full, 'hours');
    expect(trend.xAxis).toMatchObject({
      data: full.map((point) => point.label),
    });
    expect(trend.series).toMatchObject([{ data: Array(5000).fill(2) }]);
    expect(trend.dataZoom).toMatchObject([
      { start: 0, end: 100 },
      { start: 0, end: 100 },
    ]);
    const ranking = rankingOption(full.slice(0, 100), 'hours');
    expect(ranking.series).toMatchObject([{ data: Array(100).fill(2) }]);
    expect(ranking.yAxis).toMatchObject({
      data: full.slice(0, 100).map((point) => point.label),
    });
  });

  it('uses Shanghai instants and minute boundaries on a sparse time axis, without expanding to the next day label', () => {
    const times = [
      '2026-09-01T00:00:00',
      '2026-09-01T12:00:00',
      '2026-09-02T00:00:00',
    ];
    const rows = times.map((time) => ({
      ...points[0],
      label: trendTimeLabel(time),
    }));
    const peaks: PeakArea[] = [
      {
        name: 'US',
        color: '#abc',
        areas: [
          [
            { name: 'US', xAxis: '2026-08-31 23:00' },
            { xAxis: '2026-09-01 01:00' },
          ],
          [
            { name: 'US', xAxis: '2026-09-01 02:00' },
            { xAxis: '2026-09-01 05:30' },
          ],
          [
            { name: 'US', xAxis: '2026-09-01 23:00' },
            { xAxis: '2026-09-02 03:00' },
          ],
          [
            { name: 'US', xAxis: '2026-09-02 01:00' },
            { xAxis: '2026-09-02 03:00' },
          ],
        ],
      },
    ];
    expect(timeTrendOption(rows, 'percent', peaks).series).toMatchObject([
      {
        data: times.map((time) => [Date.parse(`${time}+08:00`), 25]),
        markArea: {
          data: [
            [
              { name: '美国', xAxis: Date.parse('2026-09-01T00:00+08:00') },
              { xAxis: Date.parse('2026-09-01T01:00+08:00') },
            ],
            [
              { name: '美国', xAxis: Date.parse('2026-09-01T02:00+08:00') },
              { xAxis: Date.parse('2026-09-01T05:30+08:00') },
            ],
            [
              { name: '美国', xAxis: Date.parse('2026-09-01T23:00+08:00') },
              { xAxis: Date.parse('2026-09-02T00:00+08:00') },
            ],
          ],
        },
      },
    ]);
    expect(timeTrendOption(rows, 'percent', []).series).toMatchObject([
      { data: times.map((time) => [Date.parse(`${time}+08:00`), 25]) },
    ]);
    expect(JSON.stringify(timeTrendOption(rows, 'percent', []))).not.toContain(
      'markArea',
    );
  });

  it('allows four-decimal rounding noise but rejects contradictory duration totals', () => {
    expect(
      durationPoints(
        [
          {
            abnormalDurationHours: 0.3333,
            normalDurationHours: 0.6666,
            totalDurationHours: 1,
          },
        ],
        () => 'rounded',
      ),
    ).toHaveLength(1);
    for (const row of [
      {
        abnormalDurationHours: 2,
        normalDurationHours: 0,
        totalDurationHours: 1,
      },
      {
        abnormalDurationHours: 1,
        normalDurationHours: 2,
        totalDurationHours: 2,
      },
    ])
      expect(() => durationPoints([row], () => 'contradiction')).toThrow(
        '不一致',
      );
  });

  it('preserves the server percentage before hour rounding and uses normal plus abnormal hours for country stacks', () => {
    const rounded = durationPoints(
      [
        {
          abnormalDurationHours: 0.0001,
          normalDurationHours: 0.0001,
          totalDurationHours: 0.0001,
          ratioAllTime: 50,
        },
      ],
      () => 'small',
    );
    expect(rounded[0].ratio).toBe(50);
    expect(countryBarOption(rounded, 'percent').series).toMatchObject([
      { data: [50] },
      { data: [50] },
    ]);
    expect(rankingOption(rounded, 'percent').series).toMatchObject([
      { data: [50] },
    ]);
    expect(() =>
      durationPoints(
        [
          {
            abnormalDurationHours: 1,
            normalDurationHours: 1,
            totalDurationHours: 2,
            ratioAllTime: 150,
          },
        ],
        () => 'invalid rate',
      ),
    ).toThrow('占比统计不一致');
  });

  it('keeps true zero values and rejects missing, negative or non-finite duration metrics', () => {
    expect(
      durationPoints([{ abnormalDuration: 0, totalDuration: 0 }], () => 'zero'),
    ).toEqual([{ label: 'zero', abnormal: 0, normal: 0, total: 0, ratio: 0 }]);
    for (const row of [
      { total_checks: 9, broken_count: 3 },
      { abnormalDurationHours: -1, totalDurationHours: 2 },
      { abnormalDurationHours: Number.NaN, totalDurationHours: 2 },
      {
        abnormalDurationHours: 1,
        totalDurationHours: Number.POSITIVE_INFINITY,
      },
    ])
      expect(() => durationPoints([row], () => 'invalid')).toThrow('实际时长');
  });
});
