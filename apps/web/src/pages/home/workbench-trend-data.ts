import type { HomeWorkbenchDay } from '@asin-monitor/contracts';

/** Missing/unknown-only days are gaps; no line interpolates through them. */
export function workbenchTrendPoints(days: readonly HomeWorkbenchDay[]) {
  return days.map((day, index) => {
    const known = day.checks - day.unknownChecks;
    const ratio = known > 0 ? (day.brokenChecks / known) * 100 : null;
    return {
      ...day,
      ratio,
      x: 4 + index * (112 / 6),
      y: ratio === null ? null : 28 - (ratio * 24) / 100,
    };
  });
}
