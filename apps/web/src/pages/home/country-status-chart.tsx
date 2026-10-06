import { useEffect, useMemo, useRef, useState } from 'react';
import type { NeoChartOption } from '../../components/charts/chart-option';
import { NeoChart } from '../../components/charts/neo-chart';
import { EmptyState } from '../../components/ui/feedback';
import type {
  CountryStatusData,
  CountryStatusRow,
} from './country-status-data';

// Same fallbacks as the current Neo status tokens in index.css.
const defaultColors = { normal: '#176741', broken: '#b32936' };
function countryStatusOption(
  rows: readonly CountryStatusRow[],
  colors: typeof defaultColors,
): NeoChartOption {
  return {
    animationDuration: 300,
    animationDurationUpdate: 300,
    aria: {
      label: {
        description:
          '各站点变体组状态。' +
          rows
            .map(
              (row) =>
                `${row.label}：正常 ${row.normal}，异常 ${row.broken}，共 ${row.total} 组`,
            )
            .join('；') +
          '。',
      },
    },
    grid: { left: 4, right: 16, top: 38, bottom: 12, containLabel: true },
    legend: { top: 0, selectedMode: false },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
    xAxis: { type: 'value', min: 0, minInterval: 1 },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((row) => row.label),
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: '正常',
        type: 'bar',
        stack: 'groups',
        barMaxWidth: 22,
        itemStyle: { color: colors.normal },
        data: rows.map((row) => row.normal),
      },
      {
        name: '异常',
        type: 'bar',
        stack: 'groups',
        barMaxWidth: 22,
        itemStyle: { color: colors.broken },
        data: rows.map((row) => row.broken),
      },
    ],
  };
}

function DrawableCountryStatus({ rows }: { rows: CountryStatusRow[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState(defaultColors);
  useEffect(() => {
    if (!host.current) return;
    const style = getComputedStyle(host.current);
    setColors({
      normal:
        style.getPropertyValue('--color-status-success').trim() ||
        defaultColors.normal,
      broken:
        style.getPropertyValue('--color-status-danger').trim() ||
        defaultColors.broken,
    });
  }, []);
  const option = useMemo(
    () => countryStatusOption(rows, colors),
    [rows, colors],
  );
  return (
    <div ref={host} className="mt-6 min-w-0">
      <NeoChart
        label="站点正常与异常变体组"
        option={option}
        height={Math.max(180, rows.length * 42 + 70)}
      />
      <ul aria-label="站点状态计数" className="mt-4 divide-y divide-border">
        {rows.map((row) => (
          <li
            key={row.country}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-sm first:pt-0 last:pb-0"
          >
            <span className="font-semibold">{row.label}</span>
            <span className="neo-mono text-xs text-muted-foreground">
              正常 {row.normal} · 异常 {row.broken}
            </span>
            <span className="neo-mono text-xs">共 {row.total} 组</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CountryStatusChart({ data }: { data: CountryStatusData }) {
  if (data.kind === 'ready') return <DrawableCountryStatus rows={data.rows} />;
  return (
    <div className="mt-6" role={data.kind === 'invalid' ? 'alert' : undefined}>
      <EmptyState
        title={data.kind === 'invalid' ? '站点状态暂不可用' : '暂无站点数据'}
        description={
          data.kind === 'invalid'
            ? data.message
            : '当前站点范围没有可展示的变体组状态。'
        }
      />
    </div>
  );
}
