import { useEffect, useMemo, useRef, useState } from 'react';
import { NeoChart } from '../../components/charts/neo-chart';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/field';
import {
  countryBarOption,
  countryPieOption,
  defaultDurationColors,
  durationPoints,
  PEAK_LABELS,
  rankingOption,
  timeTrendOption,
  type DurationMode,
  type DurationPoint,
  type PeakArea,
} from './analytics-chart-data';
import { hours, percent } from './analytics-data';

function ModeControl({
  label,
  mode,
  setMode,
}: {
  label: string;
  mode: DurationMode;
  setMode: (mode: DurationMode) => void;
}) {
  return (
    <Field label={label}>
      {(control) => (
        <select
          {...control}
          value={mode}
          onChange={(event) => setMode(event.target.value as DurationMode)}
          className="rounded-input border border-input bg-card px-4 py-2 text-sm"
        >
          <option value="hours">时长（小时）</option>
          <option value="percent">百分比</option>
        </select>
      )}
    </Field>
  );
}

function readableDurationPoints(
  rows: readonly Record<string, unknown>[],
  label: (row: Record<string, unknown>) => string,
): { points: DurationPoint[]; error?: string } {
  try {
    return { points: durationPoints(rows, label) };
  } catch {
    return { points: [], error: '时长统计缺少有效数据，请刷新该统计面板。' };
  }
}

/** A chart zoom never removes source rows; keyboard users can read all values here. */
function DurationRows({
  points,
  label,
}: {
  points: readonly DurationPoint[];
  label: string;
}) {
  const [selection, setSelection] = useState<{
    source: readonly DurationPoint[];
    page: number;
  } | null>(null);
  const pages = Math.max(1, Math.ceil(points.length / 50));
  const current =
    selection?.source === points ? Math.min(selection.page, pages) : 1;
  return (
    <details className="mt-5 rounded-control border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        {label} · 全部 {points.length} 项
      </summary>
      <div className="mt-3 overflow-x-auto">
        <table
          aria-label={label}
          className="w-full min-w-[36rem] text-left text-xs"
        >
          <thead>
            <tr>
              {[
                '对象 / 时间',
                '异常时长',
                '正常时长',
                '总时长',
                '异常时长占比',
              ].map((title) => (
                <th key={title} scope="col" className="p-2">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points
              .slice((current - 1) * 50, current * 50)
              .map((point, index) => (
                <tr
                  key={`${point.label}-${index}`}
                  className="border-t border-border"
                >
                  <th scope="row" className="p-2 font-medium">
                    {point.label}
                  </th>
                  <td className="p-2">{hours(point.abnormal)}</td>
                  <td className="p-2">{hours(point.normal)}</td>
                  <td className="p-2">{hours(point.total)}</td>
                  <td className="p-2">{percent(point.ratio)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span>
            第 {current} / {pages} 页
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="small"
              disabled={current <= 1}
              onClick={() =>
                setSelection({ source: points, page: current - 1 })
              }
            >
              上一页明细
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={current >= pages}
              onClick={() =>
                setSelection({ source: points, page: current + 1 })
              }
            >
              下一页明细
            </Button>
          </div>
        </div>
      )}
    </details>
  );
}

export function AnalyticsTrendChart({
  rows,
  label,
  rowLabel,
  peaks = [],
  initialMode = 'percent',
}: {
  rows: readonly Record<string, unknown>[];
  label: string;
  rowLabel: (row: Record<string, unknown>) => string;
  peaks?: readonly PeakArea[];
  initialMode?: DurationMode;
}) {
  const [mode, setMode] = useState<DurationMode>(initialMode);
  const [hidden, setHidden] = useState<Set<PeakArea['name']>>(new Set());
  const { points, error } = useMemo(
    () => readableDurationPoints(rows, rowLabel),
    [rows, rowLabel],
  );
  const option = useMemo(
    () =>
      timeTrendOption(
        points,
        mode,
        peaks.filter((peak) => !hidden.has(peak.name)),
      ),
    [points, mode, peaks, hidden],
  );
  return (
    <div className="min-w-0">
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <ModeControl label={`${label}单位`} mode={mode} setMode={setMode} />
        {peaks.map((peak) => (
          <label
            key={peak.name}
            className="flex min-h-10 items-center gap-2 text-sm"
          >
            <input
              type="checkbox"
              checked={!hidden.has(peak.name)}
              onChange={(event) =>
                setHidden((previous) => {
                  const next = new Set(previous);
                  if (event.target.checked) next.delete(peak.name);
                  else next.add(peak.name);
                  return next;
                })
              }
            />
            {PEAK_LABELS[peak.name]}高峰
          </label>
        ))}
      </div>
      <NeoChart
        label={label}
        option={option}
        empty={rows.length === 0}
        error={error}
        height={360}
      />
      {!error && (
        <p className="mt-2 text-xs text-muted-foreground">
          完整展示 {points.length}{' '}
          个时间槽；拖动下方缩放条或滚动缩放可查看局部。
        </p>
      )}
      {!error && <DurationRows points={points} label={`${label}数据明细`} />}
    </div>
  );
}

export function AnalyticsCountryCharts({
  rows,
}: {
  rows: readonly Record<string, unknown>[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState(defaultDurationColors);
  useEffect(() => {
    if (!host.current) return;
    const style = getComputedStyle(host.current);
    setColors({
      normal:
        style.getPropertyValue('--color-status-success').trim() ||
        defaultDurationColors.normal,
      abnormal:
        style.getPropertyValue('--color-status-danger').trim() ||
        defaultDurationColors.abnormal,
    });
  }, []);
  const [barMode, setBarMode] = useState<DurationMode>('hours');
  const [pieMode, setPieMode] = useState<DurationMode>('hours');
  const { points, error } = useMemo(
    () => readableDurationPoints(rows, (row) => String(row.country)),
    [rows],
  );
  const allNormal =
    points.length > 0 && points.every((point) => point.abnormal === 0);
  return (
    <div ref={host} className="min-w-0 space-y-6">
      <div>
        <ModeControl
          label="国家柱状图单位"
          mode={barMode}
          setMode={setBarMode}
        />
        <NeoChart
          label="各国家正常与异常时长"
          option={countryBarOption(points, barMode, colors)}
          empty={!rows.length}
          error={error}
          height={320}
        />
      </div>
      <div>
        <ModeControl label="国家饼图单位" mode={pieMode} setMode={setPieMode} />
        {allNormal && (
          <p role="status" className="mt-3 text-sm">
            当前范围各国异常时长均为 0，饼图不绘制虚构扇区。
          </p>
        )}
        <NeoChart
          label="各国家异常时长分布"
          option={countryPieOption(points, pieMode)}
          empty={!rows.length}
          error={error}
          height={320}
        />
      </div>
      {!error && <DurationRows points={points} label="国家时长数据明细" />}
    </div>
  );
}

export function AnalyticsRankingChart({
  rows,
}: {
  rows: readonly Record<string, unknown>[];
}) {
  const [mode, setMode] = useState<DurationMode>('hours');
  const { points, error } = useMemo(
    () =>
      readableDurationPoints(
        rows,
        (row) =>
          `${row.variant_group_name ?? row.variant_group_id ?? '未记录'} (${
            row.country ?? '未记录'
          })`,
      ),
    [rows],
  );
  return (
    <div className="mb-5 min-w-0">
      <ModeControl label="变体组排行单位" mode={mode} setMode={setMode} />
      <NeoChart
        label="变体组异常时长排行"
        option={rankingOption(points, mode)}
        empty={!rows.length}
        error={error}
        height={400}
      />
      {!error && <DurationRows points={points} label="变体组时长数据明细" />}
    </div>
  );
}

export function AnalyticsPeakIntervals({ area }: { area: PeakArea }) {
  const [selection, setSelection] = useState<{
    source: PeakArea;
    page: number;
  } | null>(null);
  const pages = Math.max(1, Math.ceil(area.areas.length / 50));
  const page = selection?.source === area ? Math.min(selection.page, pages) : 1;
  return (
    <div>
      <ol
        className="mt-3 grid gap-2 sm:grid-cols-2"
        aria-label={`${PEAK_LABELS[area.name]}高峰时段`}
      >
        {area.areas.slice((page - 1) * 50, page * 50).map(([start, end]) => (
          <li
            key={`${start.xAxis}-${end.xAxis}`}
            className="neo-mono rounded-control bg-muted px-3 py-2 text-xs"
          >
            {start.xAxis} 至 {end.xAxis}
          </li>
        ))}
      </ol>
      {pages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span>
            第 {page} / {pages} 页 · 共 {area.areas.length} 个高峰时段
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="small"
              disabled={page <= 1}
              onClick={() => setSelection({ source: area, page: page - 1 })}
            >
              上一页高峰
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={page >= pages}
              onClick={() => setSelection({ source: area, page: page + 1 })}
            >
              下一页高峰
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
