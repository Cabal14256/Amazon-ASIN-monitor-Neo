import { z } from 'zod';

import { resultSchema } from '../envelope';

/**
 * monitor 域契约（17 端点：监控历史查询 + 12 个统计 + 手动触发）。
 * 来源：server/src/controllers/monitorController.js、models/MonitorHistory.js
 * 实读（2026-08-24）。
 * 注意：
 * - sendAnalyticsResult 形态在信封外多一个顶层 `meta` 字段；
 * - 统计端点行形状宽松（passthrough），仅锁定已实读的关键字段；
 * - 列表在 skipCount 优化路径下 total 可能为 null。
 */

const dateTimeString = z.string();

/** mysql2 对 SUM/DECIMAL 聚合可能返回数字字符串。 */
const sqlNumericAggregateSchema = z.union([
  z.number(),
  z.string().regex(/^\d+(?:\.\d+)?$/),
]);

/** 监控历史记录（findAll / findById 归一化后，含驼峰别名） */
export const monitorHistoryRecordSchema = z
  .object({
    id: z.number(),
    variant_group_id: z.string().nullable().optional(),
    asin_id: z.string().nullable().optional(),
    asin: z.string().nullable().optional(),
    check_type: z.string().optional(), // 'GROUP' | 'ASIN' | ...
    country: z.string().optional(),
    is_broken: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
    check_time: dateTimeString.optional(),
    check_result: z.string().nullable().optional(),
    notification_sent: z
      .union([z.literal(0), z.literal(1), z.boolean()])
      .optional(),
    create_time: dateTimeString.optional(),
    variant_group_name: z.string().nullable().optional(),
    asin_name: z.string().nullable().optional(),
    asin_type: z.union([z.string(), z.number()]).nullable().optional(),
    // ── 驼峰别名 ──
    checkTime: dateTimeString.optional(),
    checkType: z.string().optional(),
    isBroken: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
    checkResult: z.string().nullable().optional(),
    notificationSent: z
      .union([z.literal(0), z.literal(1), z.boolean()])
      .optional(),
    variantGroupName: z.string().nullable().optional(),
    asinName: z.string().nullable().optional(),
    asinType: z.union([z.string(), z.number()]).nullable().optional(),
    createTime: dateTimeString.optional(),
  })
  .passthrough();
export type MonitorHistoryRecord = z.infer<typeof monitorHistoryRecordSchema>;

/** 时长指标行（getStatisticsByTime 等时间分组统计的公共字段） */
export const durationMetricsRowSchema = z
  .object({
    time_period: z.string().optional(),
    totalDurationHours: z.number().optional(),
    abnormalDurationHours: z.number().optional(),
    normalDurationHours: z.number().optional(),
    peakDurationHours: z.number().optional(),
    peakAbnormalDurationHours: z.number().optional(),
    lowDurationHours: z.number().optional(),
    lowAbnormalDurationHours: z.number().optional(),
    globalPeakRate: z.number().optional(),
    globalLowRate: z.number().optional(),
    ratioHigh: z.number().optional(),
    ratioLow: z.number().optional(),
    totalChecks: z.number().optional(),
    brokenCount: z.number().optional(),
    normalCount: z.number().optional(),
    totalAsinsDedup: z.number().optional(),
    brokenAsinsDedup: z.number().optional(),
    ratio_all_asin: z.number().optional(),
    ratio_all_time: z.number().optional(),
    total_asins: z.number().optional(),
    broken_asins: z.number().optional(),
    asin_broken_rate: z.number().optional(),
    normal_count: z.number().optional(),
  })
  .passthrough();
export type DurationMetricsRow = z.infer<typeof durationMetricsRowSchema>;

/** 分析结果 meta（includeMeta 时由 finalizeAnalyticsResult 附加） */
export const analyticsMetaSchema = z
  .object({
    source: z.string().optional(),
    cacheHit: z.boolean().optional(),
    generatedAt: z.string().optional(),
    lastUpdatedAt: z.string().optional(),
    busyFallback: z.boolean().optional(),
    busyReason: z.string().optional(),
  })
  .passthrough();
export type AnalyticsMeta = z.infer<typeof analyticsMetaSchema>;

/**
 * 分析端点信封：sendAnalyticsResult 在顶层附加 meta。
 * data 为 result?.data ?? result。
 */
export const analyticsResultSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean().optional(),
    errorMessage: z.string().optional(),
    errorCode: z.number().optional(),
    message: z.string().optional(),
    data: dataSchema.optional(),
    meta: analyticsMetaSchema.optional(),
  });

// ── 请求 ──

/** GET /monitor-history query（asin 支持逗号/空白分隔多值） */
export const monitorHistoryListQuerySchema = z.object({
  variantGroupId: z.string().optional(),
  asinId: z.string().optional(),
  asin: z.string().optional(),
  variantGroupName: z.string().optional(),
  asinName: z.string().optional(),
  asinType: z.string().optional(),
  country: z.string().optional(),
  checkType: z.string().optional(),
  isBroken: z.union([z.string(), z.number()]).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  current: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});
export type MonitorHistoryListQuery = z.infer<
  typeof monitorHistoryListQuerySchema
>;

/** 时间范围统计公共 query */
export const timeRangeQuerySchema = z.object({
  country: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});
export type TimeRangeQuery = z.infer<typeof timeRangeQuerySchema>;

/** GET /monitor-history/statistics/by-time query */
export const statisticsByTimeQuerySchema = timeRangeQuerySchema.extend({
  groupBy: z.enum(['hour', 'day', 'week', 'month']).optional(),
});
export type StatisticsByTimeQuery = z.infer<typeof statisticsByTimeQuerySchema>;

/** POST /monitor/trigger */
export const triggerMonitorRequestSchema = z.object({
  countries: z.array(z.string()).optional(),
});
export type TriggerMonitorRequest = z.infer<typeof triggerMonitorRequestSchema>;

/** 异常时长统计 query（asinIds/asinCodes 支持逗号分隔） */
export const abnormalDurationQuerySchema = z.object({
  asinIds: z.union([z.string(), z.array(z.string())]).optional(),
  asinCodes: z.union([z.string(), z.array(z.string())]).optional(),
  variantGroupId: z.string().optional(),
  country: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  includeSeries: z.union([z.string(), z.number()]).optional(),
  asinType: z.string().optional(),
  asinName: z.string().optional(),
  variantGroupName: z.string().optional(),
});
export type AbnormalDurationQuery = z.infer<typeof abnormalDurationQuerySchema>;

// ── 响应 data ──

/** GET /monitor-history data（skipCount 路径下 total 为 null） */
export const monitorHistoryListDataSchema = z.object({
  list: z.array(monitorHistoryRecordSchema),
  total: z.number().nullable(),
  current: z.number(),
  pageSize: z.number(),
});
export type MonitorHistoryListData = z.infer<
  typeof monitorHistoryListDataSchema
>;
export const monitorHistoryListResultSchema = resultSchema(
  monitorHistoryListDataSchema,
);

/** GET /monitor-history/:id data */
export const monitorHistoryDetailResultSchema = resultSchema(
  monitorHistoryRecordSchema,
);

/** GET /monitor-history/statistics data */
export const monitorStatisticsDataSchema = z
  .object({
    totalChecks: z.number(),
    brokenCount: sqlNumericAggregateSchema,
    normalCount: sqlNumericAggregateSchema,
    groupCount: z.number(),
    asinCount: z.number(),
    totalDurationHours: z.number().optional(),
    abnormalDurationHours: z.number().optional(),
    normalDurationHours: z.number().optional(),
    ratioAllAsin: z.number().optional(),
    ratioAllTime: z.number().optional(),
  })
  .passthrough();
export type MonitorStatisticsData = z.infer<typeof monitorStatisticsDataSchema>;
export const monitorStatisticsResultSchema = resultSchema(
  monitorStatisticsDataSchema,
);

/** 按时间分组统计（含 meta） */
export const statisticsByTimeResultSchema = analyticsResultSchema(
  z.array(durationMetricsRowSchema),
);

/** 按国家分组统计 */
export const statisticsByCountryResultSchema = resultSchema(
  z.array(
    z
      .object({
        country: z.string().optional(),
        total_checks: z.number().optional(),
        broken_count: z.number().optional(),
        totalChecks: z.number().optional(),
        brokenCount: z.number().optional(),
      })
      .passthrough(),
  ),
);

/** 按变体组分组统计 */
export const statisticsByVariantGroupResultSchema = resultSchema(
  z.array(
    z
      .object({
        variant_group_id: z.string().optional(),
        variant_group_name: z.string().nullable().optional(),
      })
      .passthrough(),
  ),
);

/** 高峰期统计（country 必填，400 校验） */
export const peakHoursStatisticsSchema = z
  .object({
    peakBroken: z.number(),
    peakTotal: z.number(),
    peakRate: z.number(),
    offPeakBroken: z.number(),
    offPeakTotal: z.number(),
    offPeakRate: z.number(),
    peakDurationHours: z.number(),
    peakAbnormalDurationHours: z.number(),
    peakDurationRate: z.number(),
    offPeakDurationHours: z.number(),
    offPeakAbnormalDurationHours: z.number(),
    offPeakDurationRate: z.number(),
  })
  .passthrough();
export type PeakHoursStatistics = z.infer<typeof peakHoursStatisticsSchema>;
export const peakHoursStatisticsResultSchema = resultSchema(
  peakHoursStatisticsSchema,
);

/** 月度异常时长明细（服务端衍生行） */
export const monthlyBreakdownResultSchema = resultSchema(
  z.array(durationMetricsRowSchema),
);

/** 高峰期标记区域 */
export const peakMarkAreasResultSchema = resultSchema(
  z.array(z.record(z.string(), z.unknown())),
);

/** 全部国家汇总对象（含 meta） */
export const allCountriesSummarySchema = z
  .object({
    timeRange: z.string(),
    totalDurationHours: z.number(),
    abnormalDurationHours: z.number(),
    normalDurationHours: z.number(),
    peakDurationHours: z.number(),
    peakAbnormalDurationHours: z.number(),
    lowDurationHours: z.number(),
    lowAbnormalDurationHours: z.number(),
    ratioAllAsin: z.number(),
    ratioAllTime: z.number(),
    globalPeakRate: z.number(),
    globalLowRate: z.number(),
    ratioHigh: z.number(),
    ratioLow: z.number(),
    totalChecks: z.number(),
    brokenCount: z.number(),
    totalAsinsDedup: z.number(),
    brokenAsinsDedup: z.number(),
  })
  .passthrough();
export type AllCountriesSummary = z.infer<typeof allCountriesSummarySchema>;
export const allCountriesSummaryResultSchema = analyticsResultSchema(
  allCountriesSummarySchema,
);

/** 区域汇总仍为区域行数组（含 meta）。 */
export const regionSummaryResultSchema = analyticsResultSchema(
  z.array(z.record(z.string(), z.unknown())),
);

/** 周期汇总（分页，含 meta） */
export const periodSummaryResultSchema = analyticsResultSchema(
  z
    .object({
      list: z.array(durationMetricsRowSchema),
      total: z.number(),
      current: z.number(),
      pageSize: z.number(),
    })
    .passthrough(),
);

/** 周期汇总时间槽明细（数组，含 meta） */
export const periodSummaryDetailsResultSchema = analyticsResultSchema(
  z.array(z.record(z.string(), z.unknown())),
);

/** 按国家/变体组的 ASIN 时长统计（含 meta） */
export const asinStatisticsByCountryResultSchema = analyticsResultSchema(
  z.array(z.record(z.string(), z.unknown())),
);
export const asinStatisticsByVariantGroupResultSchema = analyticsResultSchema(
  z.array(z.record(z.string(), z.unknown())),
);

/** 异常时长统计（结构随 includeSeries 变化，宽松对象） */
export const abnormalDurationResultSchema = resultSchema(
  z.record(z.string(), z.unknown()),
);

/** POST /monitor/trigger data */
export const triggerMonitorDataSchema = z.object({
  message: z.string(),
  queued: z.boolean(),
  jobId: z.union([z.string(), z.number()]).nullable(),
  countries: z.array(z.string()),
});
export type TriggerMonitorData = z.infer<typeof triggerMonitorDataSchema>;
export const triggerMonitorResultSchema = resultSchema(
  triggerMonitorDataSchema,
);
