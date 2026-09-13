import { MonitorAnalyticsResultLimitError } from './monitor-abnormal-duration';
import { MonitorAnalyticsQueryError } from './monitor-analytics-query';
import {
  formatMonitorPeriod,
  getMonitorDurationBucketHours,
  parseMonitorDate,
  type MonitorGranularity,
  type MonitorSourceGranularity,
} from './monitor-calendar';
import {
  accumulateDurationMetrics,
  createDurationMetricsAccumulator,
  finalizeDurationMetrics,
  type DurationMetricsAccumulator,
} from './monitor-duration';
import type { MonitorDurationSourceRow } from './monitor-duration-groups';

export interface MonitorDurationStreamOptions<Row, Meta> {
  sourceGranularity: MonitorSourceGranularity;
  targetGranularity: MonitorGranularity;
  startTime?: string;
  endTime?: string;
  buildGroupKey: (period: string, row: Row) => string | null | undefined;
  buildGroupMeta: (period: string, row: Row) => Meta;
  /** Only for time-scoped keys and SQL ordered by source time. Completed target
   * periods can then be finalized before reading the next batch. */
  periodScoped?: boolean;
  maxStateEntries?: number;
  maxResults?: number;
}
function finishedGroup<Meta extends Record<string, unknown>>(
  meta: Meta,
  state: DurationMetricsAccumulator,
) {
  const metrics = finalizeDurationMetrics(state);
  return {
    ...meta,
    ...metrics,
    ratio_all_asin: metrics.ratioAllAsin,
    ratio_all_time: metrics.ratioAllTime,
    total_asins_dedup: metrics.totalAsinsDedup,
    broken_asins_dedup: metrics.brokenAsinsDedup,
  };
}

/** Incremental form of the Legacy duration grouping algorithm. Bounds apply to
 * live ASIN/group state and final rows, rather than rejecting a normal month of
 * source buckets merely because there are more than 50k input rows. */
export class MonitorDurationStream<
  Row extends MonitorDurationSourceRow,
  Meta extends Record<string, unknown>,
> {
  private readonly groups = new Map<
    string,
    { meta: Meta; state: DurationMetricsAccumulator }
  >();
  private readonly results: ReturnType<typeof finishedGroup<Meta>>[] = [];
  private readonly start: Date | null;
  private readonly end: Date | null;
  private readonly maximumState: number;
  private readonly maximumResults: number;
  private stateEntries = 0;
  private lastPeriod = '';
  private finished = false;
  constructor(
    private readonly options: MonitorDurationStreamOptions<Row, Meta>,
  ) {
    this.start = parseMonitorDate(options.startTime);
    this.end = parseMonitorDate(options.endTime);
    this.maximumState = options.maxStateEntries ?? 200_000;
    this.maximumResults = options.maxResults ?? 5000;
    if (
      !Number.isSafeInteger(this.maximumState) ||
      this.maximumState < 1 ||
      this.maximumState > 200_000 ||
      !Number.isSafeInteger(this.maximumResults) ||
      this.maximumResults < 1 ||
      this.maximumResults > 5000
    )
      throw new MonitorAnalyticsQueryError('input');
  }
  add(rows: readonly Row[]): void {
    if (this.finished) throw new MonitorAnalyticsQueryError('invalid-result');
    for (const row of rows) {
      const slot = String(row.slot_period || '').trim();
      if (!slot) continue;
      const hours = getMonitorDurationBucketHours(
        slot,
        this.options.sourceGranularity,
        this.start,
        this.end,
      );
      if (hours <= 0) continue;
      const period = formatMonitorPeriod(slot, this.options.targetGranularity);
      const key = this.options.buildGroupKey(period, row);
      if (!key) continue;
      if (this.options.periodScoped && period !== this.lastPeriod) {
        if (period < this.lastPeriod)
          throw new MonitorAnalyticsQueryError('invalid-result');
        this.flush();
        this.lastPeriod = period;
      }
      let group = this.groups.get(key);
      if (!group) {
        if (this.groups.size + this.results.length >= this.maximumResults)
          throw new MonitorAnalyticsResultLimitError();
        group = {
          meta: this.options.buildGroupMeta(period, row),
          state: createDurationMetricsAccumulator(),
        };
        this.groups.set(key, group);
      }
      const before = group.state.asinMetrics.size;
      accumulateDurationMetrics(group.state, row, hours);
      this.stateEntries += group.state.asinMetrics.size - before;
      if (this.stateEntries > this.maximumState)
        throw new MonitorAnalyticsResultLimitError();
      if (
        !Number.isSafeInteger(group.state.totalChecks) ||
        !Number.isSafeInteger(group.state.brokenCount)
      )
        throw new MonitorAnalyticsQueryError('invalid-result');
    }
  }
  private flush() {
    for (const { meta, state } of this.groups.values())
      this.results.push(finishedGroup(meta, state));
    this.groups.clear();
    this.stateEntries = 0;
  }
  finish() {
    if (!this.finished) {
      this.flush();
      this.finished = true;
    }
    return this.results;
  }
}
