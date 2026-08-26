import { z } from 'zod';

import { resultSchema } from '../envelope';
import { monitorHistoryRecordSchema } from './monitor';

const sqlNumericAggregateSchema = z.union([
  z.number(),
  z.string().regex(/^\d+(?:\.\d+)?$/),
]);

const dashboardCountersSchema = z.object({
  totalGroups: z.number(),
  totalASINs: z.number(),
  brokenGroups: z.number(),
  brokenASINs: z.number(),
  todayChecks: z.number(),
  todayBroken: z.number(),
  normalGroups: z.number(),
  normalASINs: z.number(),
});

export const dashboardDataSchema = z.object({
  overview: dashboardCountersSchema.extend({
    overviewByCountry: z.record(z.string(), dashboardCountersSchema),
  }),
  realtimeAlerts: z.object({
    brokenGroups: z.array(z.record(z.string(), z.unknown())),
    brokenASINs: z.array(z.record(z.string(), z.unknown())),
  }),
  distribution: z.object({
    byCountry: z.array(
      z.object({
        country: z.string(),
        total: z.number(),
        broken: sqlNumericAggregateSchema,
        normal: z.number(),
      }),
    ),
  }),
  recentActivities: z.array(monitorHistoryRecordSchema),
});
export type DashboardData = z.infer<typeof dashboardDataSchema>;

export const dashboardResultSchema = resultSchema(dashboardDataSchema);
