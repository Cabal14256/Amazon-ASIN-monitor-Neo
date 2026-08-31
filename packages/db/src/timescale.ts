/**
 * Read-model metadata for the P1-T4a continuous aggregates.
 *
 * These relations are deliberately not declared with `pgTable`: TimescaleDB
 * owns their materialization tables and application code must treat both the
 * CAGGs and the union projections as read-only.
 */
export const timescaleContinuousAggregateViewNames = [
  'monitor_history_cagg_asin_hour',
  'monitor_history_cagg_asin_day',
  'monitor_history_cagg_asin_month',
  'monitor_history_cagg_dim_hour',
  'monitor_history_cagg_dim_day',
  'monitor_history_cagg_dim_month',
  'monitor_history_cagg_variant_group_hour',
  'monitor_history_cagg_variant_group_day',
  'monitor_history_cagg_variant_group_month',
] as const;

export const timescaleAggregateProjectionViewNames = [
  'monitor_history_agg_v2',
  'monitor_history_agg_dim_v2',
  'monitor_history_agg_variant_group_v2',
] as const;

export type TimescaleAggregateGranularity = 'hour' | 'day' | 'month';

export interface TimescaleAsinAggregateReadRow {
  readonly granularity: TimescaleAggregateGranularity;
  readonly timeSlot: Date;
  readonly country: string;
  readonly asinKey: string;
  readonly checkCount: bigint;
  readonly brokenCount: bigint;
  readonly hasBroken: boolean;
  readonly hasPeak: boolean;
  readonly firstCheckTime: Date;
  readonly lastCheckTime: Date;
}

export interface TimescaleDimensionAggregateReadRow
  extends TimescaleAsinAggregateReadRow {
  readonly site: string;
  readonly brand: string;
}

export interface TimescaleVariantGroupAggregateReadRow
  extends TimescaleAsinAggregateReadRow {
  readonly variantGroupId: string;
  readonly variantGroupName: string;
}
