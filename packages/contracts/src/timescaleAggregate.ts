import { z } from 'zod';

const decimalCountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const localBoundarySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
const statusSchema = z.enum(['passed', 'failed']);

export const timescaleAggregateEvidenceManifest = Object.freeze([
  {
    family: 'asin',
    granularity: 'hour',
    legacyRelation: 'monitor_history_agg',
    caggRelation: 'monitor_history_cagg_asin_hour',
  },
  {
    family: 'asin',
    granularity: 'day',
    legacyRelation: 'monitor_history_agg',
    caggRelation: 'monitor_history_cagg_asin_day',
  },
  {
    family: 'asin',
    granularity: 'month',
    legacyRelation: 'monitor_history_agg',
    caggRelation: 'monitor_history_cagg_asin_month',
  },
  {
    family: 'dimension',
    granularity: 'hour',
    legacyRelation: 'monitor_history_agg_dim',
    caggRelation: 'monitor_history_cagg_dim_hour',
  },
  {
    family: 'dimension',
    granularity: 'day',
    legacyRelation: 'monitor_history_agg_dim',
    caggRelation: 'monitor_history_cagg_dim_day',
  },
  {
    family: 'dimension',
    granularity: 'month',
    legacyRelation: 'monitor_history_agg_dim',
    caggRelation: 'monitor_history_cagg_dim_month',
  },
  {
    family: 'variant_group',
    granularity: 'hour',
    legacyRelation: 'monitor_history_agg_variant_group',
    caggRelation: 'monitor_history_cagg_variant_group_hour',
  },
  {
    family: 'variant_group',
    granularity: 'day',
    legacyRelation: 'monitor_history_agg_variant_group',
    caggRelation: 'monitor_history_cagg_variant_group_day',
  },
  {
    family: 'variant_group',
    granularity: 'month',
    legacyRelation: 'monitor_history_agg_variant_group',
    caggRelation: 'monitor_history_cagg_variant_group_month',
  },
] as const);

const aggregateCheckSchema = z
  .object({
    family: z.enum(['asin', 'dimension', 'variant_group']),
    granularity: z.enum(['hour', 'day', 'month']),
    legacyRelation: z.string().regex(/^[a-z][a-z0-9_]*$/),
    caggRelation: z.string().regex(/^[a-z][a-z0-9_]*$/),
    legacyRows: decimalCountSchema,
    caggRows: decimalCountSchema,
    legacyGroups: decimalCountSchema,
    caggGroups: decimalCountSchema,
    legacyGroupDigest: sha256Schema,
    caggGroupDigest: sha256Schema,
    legacyValueDigest: sha256Schema,
    caggValueDigest: sha256Schema,
    status: statusSchema,
  })
  .strict();

const aggregateFailureSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    scope: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  })
  .strict();

export const timescaleAggregateReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    strategy: z.literal('legacy-cagg-window-reconciliation'),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    window: z
      .object({
        start: localBoundarySchema,
        end: localBoundarySchema,
        boundary: z.literal('[start,end)'),
        timezone: z.literal('Asia/Shanghai'),
      })
      .strict(),
    refreshRequested: z.boolean(),
    checks: z.array(aggregateCheckSchema).max(9),
    status: statusSchema,
    failure: aggregateFailureSchema.optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.status === 'failed') {
      if (!report.failure) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'failed aggregate report requires a failure code and scope',
          path: ['failure'],
        });
      }
      return;
    }

    if (report.failure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'passed aggregate report must not include failure',
        path: ['failure'],
      });
    }
    if (!report.refreshRequested) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'passed aggregate report requires an in-run refresh',
        path: ['refreshRequested'],
      });
    }
    if (report.checks.length !== timescaleAggregateEvidenceManifest.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'passed aggregate report requires all nine checks',
        path: ['checks'],
      });
      return;
    }
    if (report.checks.every(({ legacyRows }) => legacyRows === '0')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'passed aggregate report requires non-empty legacy evidence',
        path: ['checks'],
      });
    }

    timescaleAggregateEvidenceManifest.forEach((expected, index) => {
      const check = report.checks[index];
      if (
        !check ||
        check.family !== expected.family ||
        check.granularity !== expected.granularity ||
        check.legacyRelation !== expected.legacyRelation ||
        check.caggRelation !== expected.caggRelation
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'aggregate evidence order or relation identity mismatch',
          path: ['checks', index],
        });
        return;
      }
      if (
        check.status !== 'passed' ||
        check.legacyRows !== check.caggRows ||
        check.legacyGroups !== check.caggGroups ||
        check.legacyGroupDigest !== check.caggGroupDigest ||
        check.legacyValueDigest !== check.caggValueDigest
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'passed aggregate report contains mismatched evidence',
          path: ['checks', index],
        });
      }
    });
  });

export type TimescaleAggregateCheck = z.infer<typeof aggregateCheckSchema>;
export type TimescaleAggregateReport = z.infer<
  typeof timescaleAggregateReportSchema
>;
