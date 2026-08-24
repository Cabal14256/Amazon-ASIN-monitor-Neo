import { z } from 'zod';

import { resultSchema } from '../envelope';

export const analyticsCacheStatusSchema = z.object({
  prefixes: z.array(z.string()),
  lastClearedAt: z.string().nullable(),
});

export const opsQueueStatusSchema = z
  .object({
    counts: z.record(z.string(), z.number()),
    isPaused: z.boolean(),
    limiter: z.unknown(),
  })
  .passthrough();

export const opsOverviewSchema = z
  .object({
    processRole: z.string(),
    schedulerEnabled: z.boolean(),
    workerRegisteredQueues: z.array(z.string()),
    workerProcessorDetails: z.unknown(),
    cache: z.unknown(),
    analyticsCache: analyticsCacheStatusSchema,
    riskControl: z.unknown(),
    scheduler: z.unknown(),
    analyticsAgg: z.unknown(),
    queues: z.object({
      monitor: opsQueueStatusSchema,
      competitor: opsQueueStatusSchema,
    }),
  })
  .passthrough();

export const opsOverviewResultSchema = resultSchema(opsOverviewSchema);

export const clearAnalyticsCacheResultSchema = resultSchema(
  z.object({
    prefixes: z.array(z.string()),
    clearedAt: z.string(),
  }),
);

export const refreshAnalyticsRequestSchema = z.object({
  granularity: z.enum(['hour', 'day', 'month']).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});
export type RefreshAnalyticsRequest = z.infer<
  typeof refreshAnalyticsRequestSchema
>;

export const refreshAnalyticsResultSchema = resultSchema(z.unknown());
