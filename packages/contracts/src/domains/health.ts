import { z } from 'zod';

const componentStatusSchema = z.enum(['ok', 'degraded', 'error']);

export const databaseHealthSchema = z
  .object({
    status: componentStatusSchema,
    connected: z.boolean(),
    pool: z.unknown().optional(),
    usagePercent: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const memoryHealthSchema = z.object({
  status: componentStatusSchema,
  heapUsed: z.number(),
  heapTotal: z.number(),
  heapLimit: z.number(),
  external: z.number(),
  rss: z.number(),
  usagePercent: z.string(),
  heapLimitUsagePercent: z.string(),
  thresholdPercent: z.string(),
});

/** /health 与 /api/v1/health 直接返回此对象，不使用 REST 信封。 */
export const healthSchema = z
  .object({
    status: componentStatusSchema,
    timestamp: z.string(),
    uptime: z.number().optional(),
    database: databaseHealthSchema.optional(),
    competitorDatabase: databaseHealthSchema.optional(),
    memory: memoryHealthSchema.optional(),
    rateLimiter: z.unknown().optional(),
    cache: z.unknown().optional(),
    errorStats: z.unknown().optional(),
    riskMetrics: z.unknown().optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type Health = z.infer<typeof healthSchema>;
