import type { HomeWorkbenchDay } from '@asin-monitor/contracts';

import { workbenchTrendPoints } from './workbench-trend-data';

export function WorkbenchSparkline({
  days,
  name,
}: {
  days: HomeWorkbenchDay[];
  name: string;
}) {
  const points = workbenchTrendPoints(days);
  const segments: Array<Array<(typeof points)[number]>> = [];
  for (const point of points) {
    if (point.y === null) {
      if (segments.at(-1)?.length) segments.push([]);
      continue;
    }
    if (!segments.length) segments.push([]);
    segments.at(-1)!.push(point);
  }
  const description = points
    .map(
      (point) =>
        `${point.day}：${point.checks}次检查，${point.brokenChecks}次异常，${
          point.unknownChecks
        }次未知${
          point.ratio === null
            ? '，无有效趋势'
            : `，异常率${point.ratio.toFixed(1)}%`
        }`,
    )
    .join('；');
  if (points.every((point) => point.y === null))
    return (
      <span className="text-xs text-muted-foreground" title={description}>
        暂无有效检查
      </span>
    );
  return (
    <svg
      role="img"
      aria-label={`${name}近七日组检查异常率。${description}`}
      viewBox="0 0 120 32"
      className="h-8 w-32 text-status-danger"
    >
      <title>{description}</title>
      <path d="M4 28H116" stroke="currentColor" opacity=".15" fill="none" />
      {segments
        .filter((segment) => segment.length > 1)
        .map((segment, index) => (
          <path
            key={index}
            d={segment
              .map(
                (point, i) =>
                  `${i === 0 ? 'M' : 'L'}${point.x.toFixed(
                    2,
                  )} ${point.y!.toFixed(2)}`,
              )
              .join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        ))}
      {points
        .filter((point) => point.y !== null)
        .map((point) => (
          <circle
            key={point.day}
            cx={point.x}
            cy={point.y!}
            r="2"
            fill="currentColor"
          />
        ))}
    </svg>
  );
}
