import type {
  BarSeriesOption,
  LineSeriesOption,
  PieSeriesOption,
} from 'echarts/charts';
import type {
  AriaComponentOption,
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption,
} from 'echarts/components';
import type { ComposeOption, EChartsCoreOption } from 'echarts/core';

/** This foundation handles flat options; multi-option containers need their own policy. */
export type NeoChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | AriaComponentOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
> & {
  textStyle?: EChartsCoreOption['textStyle'];
  baseOption?: never;
  options?: never;
  media?: never;
};

/** Keep the chart on the same CSS tokens as the rest of Neo. */
export function chartPalette(host: HTMLElement) {
  const style = getComputedStyle(host);
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    color: [
      token('--color-module-monitor', '#304ffe'),
      token('--color-module-analytics', '#a65e00'),
      token('--color-module-competitor', '#b4267d'),
      token('--color-module-tasks', '#c94726'),
      token('--color-status-success', '#176741'),
    ],
    textStyle: { color: token('--color-muted-foreground', '#666666') },
    backgroundColor: 'transparent',
  };
}

function duration(value: unknown, reduced: boolean) {
  return reduced
    ? 0
    : typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(400, value))
    : 300;
}

/** Policy also covers per-series overrides; never mutate the caller's data. */
export function prepareChartOption(
  option: NeoChartOption,
  host: HTMLElement,
  reduced: boolean,
): NeoChartOption {
  // Keep untyped callers inside the same boundary as the public TypeScript API.
  if (
    option.baseOption !== undefined ||
    option.options !== undefined ||
    option.media !== undefined
  )
    throw new Error('NeoChart 仅支持平铺图表配置');
  const palette = chartPalette(host);
  const series = option.series
    ? Array.isArray(option.series)
      ? option.series
      : [option.series]
    : [];
  const motion = (source: {
    animation?: unknown;
    animationDuration?: unknown;
    animationDurationUpdate?: unknown;
  }) => ({
    animation: reduced
      ? false
      : typeof source.animation === 'boolean'
      ? source.animation
      : true,
    animationDuration: duration(source.animationDuration, reduced),
    animationDurationUpdate: duration(source.animationDurationUpdate, reduced),
    animationDelay: 0,
    animationDelayUpdate: 0,
  });
  return {
    ...palette,
    ...option,
    textStyle: { ...palette.textStyle, ...option.textStyle },
    ...motion({
      animation: option.animation,
      animationDuration: option.animationDuration,
      animationDurationUpdate: option.animationDurationUpdate,
    }),
    aria: { enabled: true, ...option.aria },
    series: series.map((item) => ({
      ...item,
      ...motion({
        animation: item.animation ?? option.animation,
        animationDuration: item.animationDuration ?? option.animationDuration,
        animationDurationUpdate:
          item.animationDurationUpdate ?? option.animationDurationUpdate,
      }),
    })),
  };
}
