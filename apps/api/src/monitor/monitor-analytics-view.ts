import type { MonthlyBreakdownData } from '@asin-monitor/contracts';
import {
  addMonitorGranularity,
  buildMonitorSlotTexts,
  floorMonitorDate,
  formatMonitorPeriod,
  formatMonitorSqlDate,
  type SqlMetricValue,
} from '@asin-monitor/db';

const numeric = (value: SqlMetricValue) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const pad2 = (value: number) => String(value).padStart(2, '0');

export function normalizeMonitorMonth(monthToken?: string, now = new Date()) {
  const fallback = formatMonitorPeriod(now, 'month');
  const match = /^(\d{4})-(\d{2})$/.exec(monthToken || '');
  const year = Number(match?.[1]) || Number(fallback.slice(0, 4));
  const month = Math.min(
    12,
    Math.max(1, Number(match?.[2]) || Number(fallback.slice(5, 7))),
  );
  return {
    year,
    month,
    token: `${year}-${pad2(month)}`,
    days: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

/** The controller's monthly view always queries daily source buckets, even when
 * the ordinary by-time query would use hours for a range shorter than 31 days. */
export function resolveMonitorMonthlyRange(
  params: { month?: string; startTime?: string; endTime?: string },
  now = new Date(),
) {
  const month = normalizeMonitorMonth(
    params.month || (params.startTime || '').slice(0, 7),
    now,
  );
  return {
    month: month.token,
    startTime: params.startTime || `${month.token}-01 00:00:00`,
    endTime: params.endTime || `${month.token}-${pad2(month.days)} 23:59:59`,
    sourceGranularity: 'day' as const,
    groupBy: 'day' as const,
  };
}

export interface MonitorMonthlySourceRow {
  time_period?: string | null;
  abnormalDurationHours?: SqlMetricValue;
  abnormal_duration_hours?: SqlMetricValue;
  totalDurationHours?: SqlMetricValue;
  total_duration_hours?: SqlMetricValue;
  ratioAllTime?: SqlMetricValue;
  ratio_all_time?: SqlMetricValue;
}

export function buildMonitorMonthlyBreakdown(
  statistics: readonly MonitorMonthlySourceRow[] = [],
  monthToken?: string,
  now = new Date(),
): MonthlyBreakdownData {
  const month = normalizeMonitorMonth(monthToken, now);
  const rowMap = new Map<string, MonitorMonthlySourceRow>();
  for (const item of statistics) {
    const dateKey = String(item?.time_period || '').slice(0, 10);
    if (dateKey) rowMap.set(dateKey, item);
  }
  const rows: MonthlyBreakdownData['rows'] = [];
  let abnormalDurationTotal = 0,
    totalDurationTotal = 0;
  for (let day = 1; day <= month.days; day++) {
    const date = `${month.token}-${pad2(day)}`;
    const stat = rowMap.get(date);
    const abnormalDurationHours = numeric(
      stat?.abnormalDurationHours ?? stat?.abnormal_duration_hours,
    );
    const totalDurationHours = numeric(
      stat?.totalDurationHours ?? stat?.total_duration_hours,
    );
    const ratio =
      totalDurationHours > 0
        ? (abnormalDurationHours / totalDurationHours) * 100
        : numeric(stat?.ratioAllTime ?? stat?.ratio_all_time);
    abnormalDurationTotal += abnormalDurationHours;
    totalDurationTotal += totalDurationHours;
    rows.push({
      date,
      day,
      abnormalDurationHours,
      totalDurationHours,
      abnormalDurationRate: Number.isFinite(ratio) ? ratio : 0,
    });
  }
  const averageRatio =
    totalDurationTotal > 0
      ? (abnormalDurationTotal / totalDurationTotal) * 100
      : 0;
  return {
    month: month.token,
    rows,
    summary: {
      abnormalDurationTotal,
      totalDurationTotal,
      averageRatio: Number.isFinite(averageRatio) ? averageRatio : 0,
    },
  };
}

type PeakRegionCode = 'US' | 'UK' | 'EU_OTHER';
export interface MonitorPeakMarkArea {
  name: PeakRegionCode;
  color: string;
  areas: [{ name: string; xAxis: string }, { xAxis: string }][];
}

// These are the Legacy chart mark hours. The history/CAGG SQL applies an extra
// +8 hours before classifying checks; it intentionally does not use this table.
const chartRegions: Record<
  PeakRegionCode,
  { color: string; hours: readonly (readonly [number, number])[] }
> = {
  US: {
    color: 'rgba(255, 152, 0, 0.15)',
    hours: [
      [2, 6],
      [9, 12],
    ],
  },
  UK: {
    color: 'rgba(156, 39, 176, 0.15)',
    hours: [
      [22, 24],
      [0, 2],
      [3, 6],
    ],
  },
  EU_OTHER: {
    color: 'rgba(33, 150, 243, 0.15)',
    hours: [
      [20, 24],
      [2, 5],
    ],
  },
};

export function buildMonitorPeakMarkAreas({
  groupBy = 'hour',
  country = '',
  startTime,
  endTime,
}: {
  groupBy?: string;
  country?: string;
  startTime: string;
  endTime: string;
}): MonitorPeakMarkArea[] {
  if (groupBy !== 'hour') return [];
  const start = floorMonitorDate(startTime, 'day'),
    end = floorMonitorDate(endTime, 'day');
  if (!start || !end) return [];
  const regions: PeakRegionCode[] = !country
    ? ['US', 'UK', 'EU_OTHER']
    : country === 'US' || country === 'UK'
    ? [country]
    : ['DE', 'FR', 'ES', 'IT'].includes(country)
    ? ['EU_OTHER']
    : [];
  if (!regions.length) return [];
  const days = buildMonitorSlotTexts(
    formatMonitorSqlDate(start),
    formatMonitorSqlDate(end),
    'day',
  );
  if (days === null)
    throw new RangeError('Monitor peak mark range exceeds limit');
  if (!days.length) return [];
  return regions.map((name) => ({
    name,
    color: chartRegions[name].color,
    areas: days.flatMap((day) =>
      chartRegions[name].hours.map(
        ([from, to]): MonitorPeakMarkArea['areas'][number] => [
          {
            name: `${name}高峰期`,
            xAxis: formatMonitorSqlDate(
              addMonitorGranularity(day, 'hour', from)!,
            ).slice(0, 16),
          },
          {
            xAxis: formatMonitorSqlDate(
              addMonitorGranularity(day, 'hour', to)!,
            ).slice(0, 16),
          },
        ],
      ),
    ),
  }));
}
