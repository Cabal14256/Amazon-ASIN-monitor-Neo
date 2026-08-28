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
import { runDataMigration } from './engine';
import { asDataMigrationError } from './errors';
import { createMigrationLogger, type MigrationLogger } from './logger';
import { writeDataMigrationReport } from './report';

const defaultReportPath = 'artifacts/data-migration/report.json';

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
  logger: MigrationLogger = createMigrationLogger(),
): Promise<number> {
  const runId = randomUUID();
  const startedAt = new Date();
  let config: DataMigrationConfig | undefined;
  let reportPath = resolve(cwd, defaultReportPath);
  try {
    loadDataMigrationEnvironmentFiles(cwd);
    reportPath = requestedReportPath(cwd);
    config = parseDataMigrationConfig(process.env, cwd);
    const report = await runDataMigration(config, logger, { runId, startedAt });
    await writeDataMigrationReport(report, reportPath);
    logger.info('data_migration.report_written', {
      runId,
      reportPath,
      status: report.status,
    });
    return 0;
  } catch (error) {
    const migrationError = asDataMigrationError(error);
    const report = failedReport(error, runId, startedAt, config);
    try {
      await writeDataMigrationReport(report, reportPath);
      logger.info('data_migration.report_written', {
        runId,
        reportPath,
        status: report.status,
      });
    } catch (reportError) {
      logger.error('data_migration.report_write_failed', {
        runId,
        error: reportError,
      });
    }
    logger.error('data_migration.cli_failed', {
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
