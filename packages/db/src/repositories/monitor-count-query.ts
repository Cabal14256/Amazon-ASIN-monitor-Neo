import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { MonitorAnalyticsResultLimitError } from '../domain/monitor-abnormal-duration';
import {
  MonitorAnalyticsQueryError,
  validateMonitorAnalyticsQuery,
  type MonitorAnalyticsQuery,
} from '../domain/monitor-analytics-query';
import {
  getMonitorDurationBucketHours,
  parseMonitorDate,
} from '../domain/monitor-calendar';
import {
  accumulateDurationMetrics,
  createDurationMetricsAccumulator,
  finalizeDurationMetrics,
} from '../domain/monitor-duration';
import { monitorAggregateCoverageSelect } from './monitor-aggregate-coverage';
import {
  consumeMonitorAnalyticsRows,
  isMonitorAggregateDefinitionFailure,
} from './monitor-analytics-cursor';
import {
  monitorAggregateSourceSelect,
  monitorCountStatisticsSelect,
  monitorRawDurationSourceSelect,
} from './monitor-analytics-sql';
import type { MonitorDurationQueryOptions } from './monitor-duration-query';

function count(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new MonitorAnalyticsQueryError('invalid-result');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new MonitorAnalyticsQueryError('invalid-result');
  return number;
}
/** COUNT is a JSON number in mysql2; SUM(INT) remains a decimal string. */
export async function readMonitorCountQuery(
  db: Db,
  query: MonitorAnalyticsQuery,
  ensureOpen: () => void,
) {
  validateMonitorAnalyticsQuery(query);
  if (!['by-country', 'by-variant-group'].includes(query.operation))
    throw new MonitorAnalyticsQueryError('input');
  const rows: Record<string, unknown>[] = [];
  await consumeMonitorAnalyticsRows(
    db,
    monitorCountStatisticsSelect(query),
    (batch) => {
      for (const row of batch) {
        rows.push({
          ...row,
          total_checks: count(row.total_checks),
          broken_count: String(count(row.broken_count)),
          normal_count: String(count(row.normal_count)),
        });
        if (rows.length > 5000) throw new MonitorAnalyticsResultLimitError();
      }
    },
    ensureOpen,
    5001,
  );
  return rows;
}

/** Peak-hour results use the Legacy JavaScript duration calculation on BOTH
 * raw and aggregate buckets. Do not apply the SQL-summary rounding path. */
export async function readMonitorPeakQuery(
  db: Db,
  query: MonitorAnalyticsQuery,
  ensureOpen: () => void,
  options: MonitorDurationQueryOptions,
) {
  validateMonitorAnalyticsQuery(query);
  if (query.operation !== 'peak-hours')
    throw new MonitorAnalyticsQueryError('input');
  const start = parseMonitorDate(query.startTime),
    end = parseMonitorDate(query.endTime);
  const read = async (aggregate: boolean) => {
    const state = createDurationMetricsAccumulator();
    let peakBroken = 0,
      peakTotal = 0,
      offPeakBroken = 0,
      offPeakTotal = 0;
    let covered = !aggregate;
    const source = aggregate
      ? sql`WITH coverage AS MATERIALIZED (${monitorAggregateCoverageSelect(
          query,
          'asin',
          'hour',
        )})
      SELECT coverage.covered, buckets.* FROM coverage LEFT JOIN LATERAL (
        SELECT source.* FROM (${monitorAggregateSourceSelect(
          query,
          'asin',
          'hour',
        )}) source
        WHERE (SELECT covered FROM coverage)
      ) buckets ON coverage.covered ORDER BY buckets.time_slot,buckets.country,buckets.asin_key`
      : monitorRawDurationSourceSelect(query, 'dim', 'hour');
    if (query.checkType !== 'GROUP')
      await consumeMonitorAnalyticsRows(
        db,
        source,
        (batch) => {
          for (const row of batch) {
            if (aggregate) {
              if (typeof row.covered !== 'boolean')
                throw new MonitorAnalyticsQueryError('invalid-result');
              covered = row.covered;
              if (!covered || row.slot_period === null) continue;
            }
            if (typeof row.slot_period !== 'string')
              throw new MonitorAnalyticsQueryError('invalid-result');
            const hours = getMonitorDurationBucketHours(
              row.slot_period,
              'hour',
              start,
              end,
            );
            if (hours <= 0) continue;
            const checks = count(row.total_checks),
              broken = count(row.broken_count);
            if (Number(row.has_peak) === 1) {
              peakTotal += checks;
              peakBroken += broken;
            } else {
              offPeakTotal += checks;
              offPeakBroken += broken;
            }
            count(peakTotal);
            count(peakBroken);
            count(offPeakTotal);
            count(offPeakBroken);
            // Peak output contains no ASIN-dedup fields: do not retain an unused
            // ASIN map for a query that can be accumulated in constant memory.
            accumulateDurationMetrics(
              state,
              {
                total_checks: checks,
                broken_count: broken,
                has_peak: Number(row.has_peak),
              },
              hours,
            );
          }
        },
        ensureOpen,
      );
    if (!covered) return null;
    const metrics = finalizeDurationMetrics(state);
    return {
      peakBroken,
      peakTotal,
      peakRate: peakTotal > 0 ? (peakBroken / peakTotal) * 100 : 0,
      offPeakBroken,
      offPeakTotal,
      offPeakRate: offPeakTotal > 0 ? (offPeakBroken / offPeakTotal) * 100 : 0,
      peakAbnormalDurationHours: metrics.peakAbnormalDurationHours,
      peakDurationHours: metrics.peakDurationHours,
      peakDurationRate: metrics.ratioHigh,
      offPeakAbnormalDurationHours: metrics.lowAbnormalDurationHours,
      offPeakDurationHours: metrics.lowDurationHours,
      offPeakDurationRate: metrics.ratioLow,
    };
  };
  ensureOpen();
  if (options.aggregateEnabled && query.checkType !== 'GROUP') {
    try {
      const fast = await read(true);
      if (fast !== null) return fast;
      options.onAggregateFallback('coverage');
    } catch (error) {
      if (!isMonitorAggregateDefinitionFailure(error)) throw error;
      options.onAggregateFallback('definition');
    }
  }
  return (await read(false))!;
}
