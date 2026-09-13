import { z } from 'zod';
import {
  monitorStatisticsDataSchema,
  monthlyBreakdownDataSchema,
  peakHoursStatisticsSchema,
} from './monitor';

// Neo validates complete results before delivery and before accepting cached
// data. The existing loose Legacy schemas remain usable during migration.
const metric = z.number().finite().nonnegative();
const count = metric.int().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(1000);
const metrics = z
  .object({
    totalDurationHours: metric,
    abnormalDurationHours: metric,
    normalDurationHours: metric,
    peakDurationHours: metric,
    peakAbnormalDurationHours: metric,
    lowDurationHours: metric,
    lowAbnormalDurationHours: metric,
    totalChecks: count,
    brokenCount: count,
    totalAsinsDedup: count,
    brokenAsinsDedup: count,
    ratioAllAsin: metric,
    ratioAllTime: metric,
    globalPeakRate: metric,
    globalLowRate: metric,
    ratioHigh: metric,
    ratioLow: metric,
  })
  .passthrough();
const ranked = metrics.extend({
  total_checks: count,
  broken_count: count,
  normal_count: count,
});
const countRow = z
  .object({
    total_checks: count,
    broken_count: z.string().regex(/^\d+$/),
    normal_count: z.string().regex(/^\d+$/),
  })
  .passthrough();
const regionRow = metrics.extend({
  region: text,
  regionCode: text,
  timeRange: text,
});
const series = z
  .object({
    timePeriod: text,
    asinId: text.nullable(),
    asin: text.nullable(),
    country: text.nullable(),
    abnormalDuration: metric,
    totalDuration: metric,
    abnormalRatio: metric,
    brokenCount: count,
    totalChecks: count,
  })
  .passthrough();
const summary = z
  .object({
    key: text,
    asin: text,
    country: text,
    queryTimeRange: text,
    abnormalCount: count,
    averageAbnormalDuration: metric,
    minAbnormalDuration: metric,
    maxAbnormalDuration: metric,
    maxAbnormalTime: text,
  })
  .passthrough();

export const monitorAnalyticsDataSchemas = {
  statistics: monitorStatisticsDataSchema.extend({
    totalDurationHours: metric,
    abnormalDurationHours: metric,
    normalDurationHours: metric,
    ratioAllAsin: metric,
    ratioAllTime: metric,
  }),
  'by-time': z
    .array(
      metrics.extend({
        time_period: text,
        total_asins: count,
        broken_asins: count,
        asin_broken_rate: metric,
        normal_count: count,
      }),
    )
    .max(5000),
  'by-country': z.array(countRow.extend({ country: text })).max(5000),
  'by-variant-group': z
    .array(
      countRow.extend({
        variant_group_id: text.nullable(),
        variant_group_name: text.nullable(),
      }),
    )
    .max(100),
  'peak-hours': peakHoursStatisticsSchema,
  'analytics-monthly-breakdown': monthlyBreakdownDataSchema,
  'peak-mark-areas': z
    .array(
      z.object({
        name: z.enum(['US', 'UK', 'EU_OTHER']),
        color: text,
        areas: z
          .array(
            z.tuple([
              z.object({ name: text, xAxis: text }),
              z.object({ xAxis: text }),
            ]),
          )
          .max(15000),
      }),
    )
    .max(3),
  'all-countries-summary': metrics.extend({ timeRange: text }),
  'region-summary': z.array(regionRow).length(7),
  'period-summary': z.object({
    list: z
      .array(
        metrics.extend({
          timeRange: text,
          country: text,
          site: text,
          brand: text,
          hasTimeSlotDetails: z.literal(true),
        }),
      )
      .max(100),
    total: count,
    current: count.positive(),
    pageSize: count.positive().max(100),
  }),
  'period-summary/details': z
    .array(metrics.extend({ timeSlot: text }))
    .max(5000),
  'asin-by-country': z.array(ranked.extend({ country: text })).max(5000),
  'asin-by-variant-group': z
    .array(
      ranked.extend({
        variant_group_id: text.nullable(),
        variant_group_name: text.nullable(),
        country: text,
      }),
    )
    .max(100),
  'abnormal-duration-statistics': z.object({
    timeGranularity: z.enum(['hour', 'day', 'week']),
    data: z.array(series).max(50000),
    summary: z.array(summary).max(50000),
  }),
} as const;
