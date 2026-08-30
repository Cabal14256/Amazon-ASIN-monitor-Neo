import { z } from 'zod';

const decimalCountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const migrationStatusSchema = z.enum(['passed', 'failed']);

export const dataMigrationEvidenceManifest = Object.freeze({
  primary: Object.freeze({
    tables: Object.freeze([
      'variant_groups',
      'users',
      'roles',
      'permissions',
      'feishu_config',
      'sp_api_config',
      'backup_config',
      'asins',
      'monitor_history',
      'monitor_history_agg',
      'monitor_history_agg_dim',
      'monitor_history_agg_variant_group',
      'analytics_refresh_watermark',
      'monitor_history_status_interval',
      'password_history',
      'login_attempts',
      'user_status_history',
      'sessions',
      'user_roles',
      'role_permissions',
      'audit_logs',
    ]),
    businessQueries: Object.freeze([
      'asin_health_by_country',
      'variant_health_by_country',
      'history_by_country_and_type',
      'rbac_permissions_by_role',
      'analytics_rows_by_granularity',
    ]),
  }),
  competitor: Object.freeze({
    tables: Object.freeze([
      'competitor_variant_groups',
      'competitor_asins',
      'competitor_monitor_history',
      'competitor_feishu_config',
    ]),
    businessQueries: Object.freeze([
      'competitor_asin_health_by_country',
      'competitor_history_by_country_and_type',
    ]),
  }),
});

function isExactUniqueSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

export const dataMigrationTableReportSchema = z
  .object({
    table: z.string().regex(/^[a-z][a-z0-9_]*$/),
    sourceRows: decimalCountSchema,
    targetRows: decimalCountSchema,
    sampledRows: z.number().int().nonnegative().max(100),
    sourceSampleDigest: sha256Schema.nullable(),
    targetSampleDigest: sha256Schema.nullable(),
    durationMs: z.number().int().nonnegative(),
    status: migrationStatusSchema,
  })
  .strict();

export const dataMigrationQueryReportSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    sourceRows: decimalCountSchema,
    targetRows: decimalCountSchema,
    sourceDigest: sha256Schema,
    targetDigest: sha256Schema,
    status: migrationStatusSchema,
  })
  .strict();

export const dataMigrationDatabaseReportSchema = z
  .object({
    logicalName: z.enum(['primary', 'competitor']),
    tables: z.array(dataMigrationTableReportSchema).min(1),
    businessQueries: z.array(dataMigrationQueryReportSchema).min(1),
    durationMs: z.number().int().nonnegative(),
    status: migrationStatusSchema,
  })
  .strict();

export const dataMigrationFailureSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    scope: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  })
  .strict();

export const dataMigrationRunIdSchema = z.string().uuid();

export const dataMigrationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: dataMigrationRunIdSchema,
    strategy: z.literal('full-snapshot-cutover-sync'),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    batchSize: z.number().int().positive().max(1_000),
    sampleSize: z.number().int().nonnegative().max(100),
    targetResetAuthorized: z.boolean(),
    databases: z.array(dataMigrationDatabaseReportSchema).max(2),
    status: migrationStatusSchema,
    failure: dataMigrationFailureSchema.optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.status === 'passed') {
      if (!report.targetResetAuthorized) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'passed report requires explicit target reset authorization',
          path: ['targetResetAuthorized'],
        });
      }

      if (report.failure) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'passed report must not include failure',
          path: ['failure'],
        });
      }

      const logicalNames = report.databases.map(
        ({ logicalName }) => logicalName,
      );
      if (
        logicalNames.length !== 2 ||
        !logicalNames.includes('primary') ||
        !logicalNames.includes('competitor')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'passed report must contain primary and competitor databases',
          path: ['databases'],
        });
      }

      if (
        report.databases.some(
          (database) =>
            database.status !== 'passed' ||
            database.tables.some((table) => table.status !== 'passed') ||
            database.businessQueries.some((query) => query.status !== 'passed'),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'passed report contains a failed nested check',
          path: ['databases'],
        });
      }

      report.databases.forEach((database, databaseIndex) => {
        const expectedEvidence =
          dataMigrationEvidenceManifest[database.logicalName];
        if (
          !isExactUniqueSet(
            database.tables.map(({ table }) => table),
            expectedEvidence.tables,
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'passed database report requires the complete unique table evidence set',
            path: ['databases', databaseIndex, 'tables'],
          });
        }
        if (
          !isExactUniqueSet(
            database.businessQueries.map(({ name }) => name),
            expectedEvidence.businessQueries,
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'passed database report requires the complete unique business query evidence set',
            path: ['databases', databaseIndex, 'businessQueries'],
          });
        }
        database.tables.forEach((table, tableIndex) => {
          const sourceRows = BigInt(table.sourceRows);
          const sampleLimit = BigInt(report.sampleSize);
          const expectedSampledRows =
            sourceRows < sampleLimit ? Number(sourceRows) : report.sampleSize;
          if (table.sourceRows !== table.targetRows) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'passed table report requires equal row counts',
              path: ['databases', databaseIndex, 'tables', tableIndex],
            });
          }
          if (table.sourceSampleDigest !== table.targetSampleDigest) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'passed table report requires equal sample digests',
              path: ['databases', databaseIndex, 'tables', tableIndex],
            });
          }
          if (table.sampledRows !== expectedSampledRows) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'passed table report requires the configured sample count',
              path: [
                'databases',
                databaseIndex,
                'tables',
                tableIndex,
                'sampledRows',
              ],
            });
          }
          const expectsDigest = expectedSampledRows > 0;
          const hasBothDigests =
            table.sourceSampleDigest !== null &&
            table.targetSampleDigest !== null;
          if (expectsDigest !== hasBothDigests) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'configured sample count and digest presence must describe the same evidence',
              path: ['databases', databaseIndex, 'tables', tableIndex],
            });
          }
        });
        database.businessQueries.forEach((query, queryIndex) => {
          if (
            query.sourceRows !== query.targetRows ||
            query.sourceDigest !== query.targetDigest
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'passed business query report requires equal counts and digests',
              path: ['databases', databaseIndex, 'businessQueries', queryIndex],
            });
          }
        });
      });
    } else if (!report.failure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'failed report must include a failure code and scope',
        path: ['failure'],
      });
    }
  });

export type DataMigrationTableReport = z.infer<
  typeof dataMigrationTableReportSchema
>;
export type DataMigrationQueryReport = z.infer<
  typeof dataMigrationQueryReportSchema
>;
export type DataMigrationDatabaseReport = z.infer<
  typeof dataMigrationDatabaseReportSchema
>;
export type DataMigrationReport = z.infer<typeof dataMigrationReportSchema>;
