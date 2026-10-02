import { z } from 'zod';
import { resultSchema } from '../envelope';
import { triggerMonitorRequestSchema } from './monitor';

/** Neo submits an owned asynchronous task; the frozen Legacy runner response
 * in competitor.ts continues to describe the synchronous production entry. */
export const triggerCompetitorMonitorAsyncRequestSchema =
  triggerMonitorRequestSchema;
export const competitorMonitorJobSchema = z
  .object({
    taskId: z.string().uuid(),
    taskType: z.literal('competitor-monitor'),
    taskSubType: z.literal('competitor'),
    userId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]+$/u),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    countries: z
      .array(z.enum(['US', 'UK', 'DE', 'FR', 'IT', 'ES']))
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((job, context) => {
    const created = Date.parse(job.createdAt),
      expires = Date.parse(job.expiresAt);
    if (
      !Number.isFinite(created) ||
      !Number.isFinite(expires) ||
      new Set(job.countries).size !== job.countries.length ||
      new Date(created).toISOString() !== job.createdAt ||
      new Date(expires).toISOString() !== job.expiresAt ||
      expires <= created ||
      expires - created > 31_536_000_000
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '竞品监控任务身份无效',
      });
  });
export type CompetitorMonitorJob = z.infer<typeof competitorMonitorJobSchema>;
export const triggerCompetitorMonitorAsyncDataSchema = z
  .object({
    message: z.string(),
    queued: z.literal(true),
    jobId: z.string().uuid(),
    countries: competitorMonitorJobSchema.innerType().shape.countries,
  })
  .strict();
export const triggerCompetitorMonitorAsyncResultSchema = resultSchema(
  triggerCompetitorMonitorAsyncDataSchema,
);
