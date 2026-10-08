import { z } from 'zod';

/** Internal scheduled jobs have their own consumer and ledger. They must never
 * be parsed as a user's manual monitor task or exposed by public task routes. */
export const SCHEDULED_MONITOR_MAX_BATCHES = 1000;

const canonicalTime = z
  .string()
  .datetime()
  .refine((value) => {
    const timestamp = Date.parse(value);
    return (
      Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    );
  }, '定时监控时间必须为规范 UTC 时间');
const planShape = {
  domain: z.enum(['primary', 'competitor']),
  country: z.enum(['US', 'UK', 'DE', 'FR', 'ES', 'IT']),
  plannedSlot: canonicalTime.refine(
    (value) => Date.parse(value) % 60000 === 0,
    '计划 slot 必须按分钟对齐',
  ),
  intervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  batchConfig: z
    .object({
      batchIndex: z.number().int().nonnegative(),
      totalBatches: z.number().int().min(1).max(SCHEDULED_MONITOR_MAX_BATCHES),
    })
    .strict(),
};

function checkPlan(
  plan: z.infer<typeof planObject>,
  context: z.RefinementCtx,
): void {
  const { batchIndex, totalBatches } = plan.batchConfig;
  const scheduleSlot = Math.floor(
    Date.parse(plan.plannedSlot) / (plan.intervalMinutes * 60000),
  );
  if (
    batchIndex >= totalBatches ||
    batchIndex !== ((scheduleSlot % totalBatches) + totalBatches) % totalBatches
  )
    context.addIssue({ code: z.ZodIssueCode.custom, message: '计划批次无效' });
}
const planObject = z.object(planShape).strict();
export const scheduledMonitorPlanSchema = planObject.superRefine(checkPlan);
export type ScheduledMonitorPlan = z.infer<typeof scheduledMonitorPlanSchema>;

function jobId(plan: ScheduledMonitorPlan): string {
  const slot = plan.plannedSlot.slice(0, 16).replace(/[-:]/g, '');
  return `neo-${plan.domain}-monitor-scheduled-${slot}-${plan.country}-b${plan.batchConfig.batchIndex}of${plan.batchConfig.totalBatches}`;
}
/** The plan slot, rather than a retry or follow-up's enqueue time, fixes the ID. */
export function buildScheduledMonitorJobId(plan: ScheduledMonitorPlan): string {
  return jobId(scheduledMonitorPlanSchema.parse(plan));
}

export const scheduledMonitorJobSchema = z
  .object({
    ...planShape,
    version: z.literal(1),
    source: z.literal('scheduled'),
    taskType: z.literal('scheduled-monitor'),
    actor: z
      .object({
        kind: z.literal('system'),
        purpose: z.literal('scheduled-monitor'),
      })
      .strict(),
    taskId: z.string().uuid(),
    jobId: z.string().max(200),
    requestedAt: canonicalTime,
    createdAt: canonicalTime,
    expiresAt: canonicalTime,
  })
  .strict()
  .superRefine((job, context) => {
    checkPlan(job, context);
    if (
      job.jobId !== jobId(job) ||
      Date.parse(job.requestedAt) < Date.parse(job.plannedSlot) ||
      Date.parse(job.createdAt) < Date.parse(job.requestedAt) ||
      Date.parse(job.expiresAt) <= Date.parse(job.createdAt)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '定时监控任务身份无效',
      });
  });
export type ScheduledMonitorJob = z.infer<typeof scheduledMonitorJobSchema>;
