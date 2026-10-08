import type { MonitorAnalyticsData } from '@asin-monitor/contracts';
import type {
  DataZoomComponentOption,
  MarkAreaComponentOption,
} from 'echarts/components';
import type { NeoChartOption } from '../../components/charts/chart-option';
import { formatBeijing } from '../../lib/beijingTime';

export type DurationMode = 'hours' | 'percent';
export type PeakArea = MonitorAnalyticsData<'peak-mark-areas'>[number];
export interface DurationPoint {
  label: string;
  abnormal: number;
  normal: number;
  total: number;
  ratio: number;
}
export const defaultDurationColors = { normal: '#176741', abnormal: '#b32936' };

export const PEAK_LABELS = { US: '美国', UK: '英国', EU_OTHER: '欧洲其他站点' };
export function trendTimeLabel(value: unknown): string {
  const text = String(value ?? '').replace('T', ' ');
  return text.length >= 19 ? text.slice(0, 16) : text;
}
const grid = {
  left: 8,
  right: 20,
  top: 48,
  bottom: 68,
  outerBoundsMode: 'same',
  outerBoundsContain: 'all',
} as const;
const tooltip = {
  trigger: 'axis',
  renderMode: 'richText',
  confine: true,
} as const;
function durationTooltip(point: DurationPoint | undefined) {
  if (!point) return '';
  return `${point.label}\n异常 ${point.abnormal.toFixed(
    2,
  )} h (${point.ratio.toFixed(2)}%)\n正常 ${point.normal.toFixed(
    2,
  )} h\n总时长 ${point.total.toFixed(2)} h`;
}
const dataZoom: DataZoomComponentOption[] = [
  {
    type: 'slider',
    xAxisIndex: [0],
    start: 0,
    end: 100,
    height: 22,
    bottom: 8,
  },
  { type: 'inside', xAxisIndex: [0], start: 0, end: 100 },
];

export function trendTimeStamp(label: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(label))
    return null;
  const local =
    label.length === 10 ? `${label}T00:00:00` : label.replace(' ', 'T');
  const timestamp = Date.parse(`${local}+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Inputs have already passed the complete REST contract; do not infer counts as hours. */
export function durationPoints(
  rows: readonly Record<string, unknown>[],
  label: (row: Record<string, unknown>) => string,
): DurationPoint[] {
  return rows.map((row) => {
    const abnormal = row.abnormalDurationHours ?? row.abnormalDuration;
    const total = row.totalDurationHours ?? row.totalDuration;
    if (
      typeof abnormal !== 'number' ||
      !Number.isFinite(abnormal) ||
      abnormal < 0 ||
      typeof total !== 'number' ||
      !Number.isFinite(total) ||
      total < 0
    )
      throw new Error('时长统计缺少有效的实际时长');
    const normal = row.normalDurationHours ?? Math.max(0, total - abnormal);
    if (typeof normal !== 'number' || !Number.isFinite(normal) || normal < 0)
      throw new Error('时长统计缺少有效的正常时长');
    // Neo duration SQL/domain independently rounds hours to four decimals.
    // Allow two rounding units plus ordinary floating-point accumulation noise.
    const tolerance =
      0.0002 + Math.max(total, abnormal, normal) * Number.EPSILON * 8;
    if (
      abnormal > total + tolerance ||
      Math.abs(normal + abnormal - total) > tolerance
    )
      throw new Error('异常、正常与总时长统计不一致');
    // SQL computes ratioAllTime before rounding the returned hour fields.
    // Preserve its ratio so small valid durations do not change percentage.
    const ratio =
      row.ratioAllTime ??
      row.abnormalDurationRate ??
      row.abnormalRatio ??
      (total > 0 ? (abnormal / total) * 100 : 0);
    if (
      typeof ratio !== 'number' ||
      !Number.isFinite(ratio) ||
      ratio < 0 ||
      ratio > 100
    )
      throw new Error('异常时长占比统计不一致');
    return {
      label: label(row),
      abnormal,
      normal,
      total,
      ratio,
    };
  });
}

export function timeTrendOption(
  points: readonly DurationPoint[],
  mode: DurationMode,
  peaks: readonly PeakArea[] = [],
): NeoChartOption {
  const timestamps = points.map((point) => trendTimeStamp(point.label));
  const timed =
    timestamps.length > 0 && timestamps.every((time) => time !== null);
  const startTime = timed ? Math.min(...(timestamps as number[])) : 0;
  const endTime = timed ? Math.max(...(timestamps as number[])) : 0;
  const markAreas: NonNullable<MarkAreaComponentOption['data']> = [];
  for (const peak of timed ? peaks : [])
    for (const [start, end] of peak.areas) {
      const fromTime = trendTimeStamp(start.xAxis);
      const toTime = trendTimeStamp(end.xAxis);
      if (fromTime === null || toTime === null) continue;
      const from = Math.max(startTime, fromTime);
      const to = Math.min(endTime, toTime);
      if (from >= to) continue;
      markAreas.push([
        {
          name: PEAK_LABELS[peak.name],
          xAxis: from,
          itemStyle: { color: peak.color },
        },
        { xAxis: to },
      ]);
    }
  return {
    grid,
    tooltip: {
      ...tooltip,
      formatter: (params) =>
        durationTooltip(
          points[(Array.isArray(params) ? params[0] : params).dataIndex],
        ),
    },
    dataZoom: [...dataZoom],
    aria: {
      label: {
        description: `完整范围异常趋势，共 ${points.length} 个时间槽，可缩放并查看分页明细。`,
      },
    },
    xAxis: timed
      ? {
          type: 'time',
          min: startTime,
          max: endTime,
          axisLabel: {
            formatter: (value) => formatBeijing(value, 'MM-DD HH:mm'),
          },
        }
      : {
          type: 'category',
          boundaryGap: false,
          data: points.map((point) => point.label),
        },
    yAxis: {
      type: 'value',
      min: 0,
      ...(mode === 'percent' ? { max: 100 } : {}),
      name: mode === 'percent' ? '异常时长占比 (%)' : '异常时长 (小时)',
    },
    series: [
      {
        type: 'line',
        name: mode === 'percent' ? '异常时长占比' : '异常时长',
        data: points.map((point, index) => {
          const value = mode === 'percent' ? point.ratio : point.abnormal;
          return timed ? [timestamps[index] as number, value] : value;
        }),
        showSymbol: points.length <= 60,
        connectNulls: false,
        ...(markAreas.length
          ? {
              markArea: {
                silent: true,
                label: { show: false },
                data: markAreas,
              },
            }
          : {}),
      },
    ],
  };
}

export function countryBarOption(
  points: readonly DurationPoint[],
  mode: DurationMode,
  colors = defaultDurationColors,
): NeoChartOption {
  const values = (key: 'normal' | 'abnormal') =>
    points.map((point) =>
      mode === 'percent'
        ? point.normal + point.abnormal > 0
          ? (point[key] / (point.normal + point.abnormal)) * 100
          : 0
        : point[key],
    );
  return {
    grid,
    tooltip: {
      ...tooltip,
      formatter: (params) =>
        durationTooltip(
          points[(Array.isArray(params) ? params[0] : params).dataIndex],
        ),
    },
    legend: { top: 4 },
    xAxis: { type: 'category', data: points.map((point) => point.label) },
    yAxis: {
      type: 'value',
      min: 0,
      ...(mode === 'percent' ? { max: 100 } : {}),
      name: mode === 'percent' ? '时长占比 (%)' : '时长 (小时)',
    },
    series: [
      {
        type: 'bar',
        name: '异常',
        stack: 'duration',
        data: values('abnormal'),
        itemStyle: { color: colors.abnormal },
        barMaxWidth: 40,
      },
      {
        type: 'bar',
        name: '正常',
        stack: 'duration',
        data: values('normal'),
        itemStyle: { color: colors.normal },
        barMaxWidth: 40,
      },
    ],
  };
}

export function countryPieOption(
  points: readonly DurationPoint[],
  mode: DurationMode,
): NeoChartOption {
  const total = points.reduce((sum, point) => sum + point.abnormal, 0);
  return {
    tooltip: {
      trigger: 'item',
      renderMode: 'richText',
      confine: true,
      formatter: (params) => {
        const point =
          points[(Array.isArray(params) ? params[0] : params).dataIndex];
        return point
          ? `${point.label}\n异常 ${point.abnormal.toFixed(2)} h\n占全部异常 ${
              total > 0 ? ((point.abnormal / total) * 100).toFixed(2) : '0.00'
            }%`
          : '';
      },
    },
    legend: { type: 'scroll', bottom: 0 },
    series: [
      {
        type: 'pie',
        name:
          mode === 'percent' ? '各国异常时长分布 (%)' : '各国异常时长 (小时)',
        radius: ['35%', '65%'],
        center: ['50%', '43%'],
        stillShowZeroSum: false,
        label: { formatter: mode === 'percent' ? '{b}: {d}%' : '{b}: {c} h' },
        data: points.map((point) => ({
          name: point.label,
          value:
            mode === 'percent'
              ? total > 0
                ? (point.abnormal / total) * 100
                : 0
              : point.abnormal,
        })),
      },
    ],
  };
}

export function rankingOption(
  points: readonly DurationPoint[],
  mode: DurationMode,
): NeoChartOption {
  return {
    grid: {
      left: 8,
      right: 58,
      top: 36,
      bottom: 12,
      outerBoundsMode: 'same',
      outerBoundsContain: 'all',
    },
    tooltip: {
      ...tooltip,
      formatter: (params) =>
        durationTooltip(
          points[(Array.isArray(params) ? params[0] : params).dataIndex],
        ),
    },
    dataZoom:
      points.length > 12
        ? [
            {
              type: 'slider',
              yAxisIndex: [0],
              start: 0,
              end: Math.min(100, (12 / points.length) * 100),
              right: 6,
              width: 16,
            },
            {
              type: 'inside',
              yAxisIndex: [0],
              start: 0,
              end: Math.min(100, (12 / points.length) * 100),
            },
          ]
        : [],
    xAxis: {
      type: 'value',
      min: 0,
      ...(mode === 'percent' ? { max: 100 } : {}),
      name: mode === 'percent' ? '异常时长占比 (%)' : '异常时长 (小时)',
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: points.map((point) => point.label),
      axisLabel: { width: 160, overflow: 'truncate' },
    },
    series: [
      {
        type: 'bar',
        name: mode === 'percent' ? '异常时长占比' : '异常时长',
        data: points.map((point) =>
          mode === 'percent' ? point.ratio : point.abnormal,
        ),
        barMaxWidth: 22,
      },
    ],
  };
}
