import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  dataMigrationReportSchema,
  type DataMigrationReport,
} from '@asin-monitor/contracts';

import {
  loadDataMigrationEnvironmentFiles,
  parseDataMigrationConfig,
  type DataMigrationConfig,
} from './config';
import { runDataMigration, type DataMigrationRunMetadata } from './engine';
import { DataMigrationError, asDataMigrationError } from './errors';
import { createMigrationLogger, type MigrationLogger } from './logger';
import {
  prepareDataMigrationReportDestination,
  writeDataMigrationReport,
} from './report';

const defaultReportPath = 'artifacts/data-migration/report.json';

export interface DataMigrationCliDependencies {
  readonly runMigration?: (
    config: DataMigrationConfig,
    logger: MigrationLogger,
    metadata: DataMigrationRunMetadata,
  ) => Promise<DataMigrationReport>;
  readonly prepareReportDestination?: (reportPath: string) => Promise<void>;
  readonly writeReport?: (
    report: DataMigrationReport,
    reportPath: string,
  ) => Promise<void>;
}

function requestedReportPath(cwd: string): string {
  return resolve(
    cwd,
    process.env.MIGRATION_REPORT_PATH?.trim() || defaultReportPath,
  );
}

function failedReport(
  error: unknown,
  runId: string,
  startedAt: Date,
  config?: DataMigrationConfig,
): DataMigrationReport {
  const migrationError = asDataMigrationError(error);
  return dataMigrationReportSchema.parse({
    schemaVersion: 1,
    runId,
    strategy: 'full-snapshot-cutover-sync',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    batchSize: config?.batchSize ?? 500,
    sampleSize: config?.sampleSize ?? 20,
    targetResetAuthorized: config?.allowTargetReset ?? false,
    databases: [],
    status: 'failed',
    failure: {
      code: migrationError.code,
      scope: migrationError.scope,
    },
  });
}

export async function runDataMigrationCli(
  cwd = process.cwd(),
  logger?: MigrationLogger,
  dependencies: DataMigrationCliDependencies = {},
): Promise<number> {
  const runId = randomUUID();
  const startedAt = new Date();
  let config: DataMigrationConfig | undefined;
  let reportPath = resolve(cwd, defaultReportPath);
  let activeLogger = logger;
  const runMigration = dependencies.runMigration ?? runDataMigration;
  const prepareReportDestination =
    dependencies.prepareReportDestination ??
    prepareDataMigrationReportDestination;
  const writeReport = dependencies.writeReport ?? writeDataMigrationReport;
  try {
    loadDataMigrationEnvironmentFiles(cwd);
    activeLogger ??= createMigrationLogger();
    reportPath = requestedReportPath(cwd);
    config = parseDataMigrationConfig(process.env, cwd);
    await prepareReportDestination(reportPath);
    const report = await runMigration(config, activeLogger, {
      runId,
      startedAt,
    });
    try {
      await writeReport(report, reportPath);
    } catch (error) {
      throw new DataMigrationError(
        'POST_COMMIT_REPORT_WRITE_FAILED',
        'report.write',
        'both target databases committed but the success report could not be written; verify both targets before rerunning',
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    activeLogger.info('data_migration.report_written', {
      runId,
      reportDestination: 'data-migration-report',
      status: report.status,
    });
    return 0;
  } catch (error) {
    activeLogger ??= createMigrationLogger();
    const migrationError = asDataMigrationError(error);
    const report = failedReport(error, runId, startedAt, config);
    try {
      await writeReport(report, reportPath);
      activeLogger.info('data_migration.report_written', {
        runId,
        reportDestination: 'data-migration-report',
        status: report.status,
      });
    } catch {
      activeLogger.error('data_migration.report_write_failed', {
        runId,
        code: 'REPORT_WRITE_FAILED',
      });
    }
    activeLogger.error('data_migration.cli_failed', {
      runId,
      code: migrationError.code,
      scope: migrationError.scope,
      error: migrationError,
    });
    return 1;
  }
}

if (require.main === module) {
  void runDataMigrationCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
