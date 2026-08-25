import { z } from 'zod';

import { resultSchema } from '../envelope';

/** 数据库原始 SP-API 配置记录。 */
export const spApiConfigRecordSchema = z
  .object({
    id: z.number(),
    config_key: z.string(),
    config_value: z.string().nullable(),
    description: z.string().nullable().optional(),
    create_time: z.string().nullable().optional(),
    update_time: z.string().nullable().optional(),
  })
  .passthrough();
export type SpApiConfigRecord = z.infer<typeof spApiConfigRecordSchema>;

/** GET /sp-api-configs 的前端显示形态。 */
export const spApiDisplayConfigSchema = z.object({
  id: z.number().nullable(),
  configKey: z.string(),
  configValue: z.string(),
  displayValue: z.string(),
  hasValue: z.boolean(),
  description: z.string(),
  createTime: z.string().nullable(),
  updateTime: z.string().nullable(),
});
export type SpApiDisplayConfig = z.infer<typeof spApiDisplayConfigSchema>;

export const updateSpApiConfigItemSchema = z.object({
  configKey: z.string().min(1),
  configValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  description: z.string().optional(),
});
export const updateSpApiConfigsRequestSchema = z.object({
  configs: z.array(updateSpApiConfigItemSchema).min(1),
});
export type UpdateSpApiConfigsRequest = z.infer<
  typeof updateSpApiConfigsRequestSchema
>;

export const rateLimiterStatusQuerySchema = z.object({
  region: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.enum(['US', 'EU']))
    .optional(),
  operation: z.enum(['getCatalogItem', 'searchCatalogItems']).optional(),
});

export const rateLimitWindowSchema = z.object({
  used: z.number(),
  remaining: z.number(),
  limit: z.number(),
  windowMs: z.number(),
});

export const rateLimiterSnapshotSchema = z
  .object({
    mode: z.string(),
    lastMode: z.string(),
    redisAvailable: z.boolean(),
    name: z.string(),
    secondTokens: z.number().nullable(),
    minuteTokens: z.number(),
    hourTokens: z.number(),
    limits: z.object({
      second: z.number().nullable(),
      minute: z.number(),
      hour: z.number(),
    }),
    windows: z.record(z.string(), rateLimitWindowSchema),
    limitSource: z.string(),
    limitUpdatedAt: z.string().nullable(),
  })
  .passthrough();

export const rateLimiterStatusResultSchema = resultSchema(
  z.record(z.enum(['US', 'EU']), rateLimiterSnapshotSchema),
);

export const errorStatsQuerySchema = z.object({
  hours: z.coerce.number().optional(),
});

export const errorStatsBucketSchema = z
  .object({
    count: z.number(),
    lastOccurred: z.string().nullable(),
    recentWindow: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const errorStatsResultSchema = resultSchema(
  z.object({
    total: z.number(),
    recent: z.object({
      count: z.number(),
      hours: z.number(),
      byType: z.record(z.string(), z.number()),
      byRegion: z.record(z.string(), z.number()),
    }),
    byType: z.record(z.string(), errorStatsBucketSchema),
    byRegion: z.record(
      z.string(),
      z.record(z.string(), errorStatsBucketSchema),
    ),
    timeSeries: z.array(
      z
        .object({
          timestamp: z.string(),
          type: z.string(),
          region: z.string(),
        })
        .passthrough(),
    ),
  }),
);

export const spApiDisplayConfigListResultSchema = resultSchema(
  z.array(spApiDisplayConfigSchema),
);
export const spApiConfigResultSchema = resultSchema(spApiConfigRecordSchema);
export const updateSpApiConfigsResultSchema = resultSchema(
  z.array(spApiConfigRecordSchema),
);
