import type {
  MonitorHistoryListQuery,
  MonitorStatisticsQuery,
  PeakHoursStatisticsQuery,
} from '@asin-monitor/contracts';

export const HISTORY_STATISTICS_SCOPES = {
  statistics:
    '汇总按变体组 ID、ASIN ID、国家、检查类型和时间范围计算；名称、ASIN 代码、ASIN 类型、异常状态及分页不参与统计。',
  peakHours:
    '高低峰按所选国家、检查类型和时间范围计算，覆盖该范围内全部监控对象；变体组 ID、ASIN ID、名称、ASIN 代码、ASIN 类型、异常状态及分页不参与统计。',
} as const;

const STATISTICS_FIELDS = [
  'variantGroupId',
  'asinId',
  'country',
  'checkType',
  'startTime',
  'endTime',
] as const;
const PEAK_FIELDS = ['checkType', 'startTime', 'endTime'] as const;

/** Separate API scopes from record filters; preserve opaque IDs and Shanghai wall clocks. */
export function historyStatisticsQueries(query: MonitorHistoryListQuery): {
  statistics: MonitorStatisticsQuery;
  peakHours: PeakHoursStatisticsQuery | null;
} {
  const statistics: MonitorStatisticsQuery = {};
  for (const key of STATISTICS_FIELDS) {
    const value = query[key];
    if (value !== undefined && value !== '') statistics[key] = value;
  }
  const peakHours: PeakHoursStatisticsQuery | null = statistics.country
    ? { country: statistics.country }
    : null;
  if (peakHours) {
    for (const key of PEAK_FIELDS) {
      const value = statistics[key];
      if (value !== undefined) peakHours[key] = value;
    }
  }
  return { statistics, peakHours };
}
