import { randomUUID } from 'node:crypto';

import {
  timescaleAggregateReportSchema,
  type TimescaleAggregateReport,
} from '@asin-monitor/contracts';

import {
  loadDataMigrationEnvironmentFiles,
  resolveDataMigrationWorkspaceRoot,
} from '../migration/config';
import { asDataMigrationError } from '../migration/errors';
import {
  createMigrationLogger,
  type MigrationLogger,
} from '../migration/logger';
import { prepareDataMigrationReportDestination } from '../migration/report';
import {
  parseTimescaleAggregateConfig,
  type TimescaleAggregateConfig,
} from './config';
import {
  runTimescaleAggregateGate,
  type TimescaleAggregateRunMetadata,
} from './engine';
import { writeTimescaleAggregateReport } from './report';

export interface TimescaleAggregateCliDependencies {
  readonly runGate?: (
    config: TimescaleAggregateConfig,
    logger: MigrationLogger,
    metadata: TimescaleAggregateRunMetadata,
  ) => Promise<TimescaleAggregateReport>;
  readonly prepareReportDestination?: (reportPath: string) => Promise<void>;
  readonly writeReport?: (
    report: TimescaleAggregateReport,
    reportPath: string,
  ) => Promise<void>;
}

function failedReport(
  error: unknown,
  runId: string,
  startedAt: Date,
  config?: TimescaleAggregateConfig,
): TimescaleAggregateReport {
  const aggregateError = asDataMigrationError(error, 'aggregate');
  return timescaleAggregateReportSchema.parse({
    schemaVersion: 1,
    runId,
    strategy: 'legacy-cagg-window-reconciliation',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    window: {
      start: config?.windowStart ?? '1970-01-01 00:00:00',
      end: config?.windowEnd ?? '1970-02-01 00:00:00',
      boundary: '[start,end)',
      timezone: 'Asia/Shanghai',
    },
    refreshRequested: config?.refresh ?? false,
    checks: [],
    status: 'failed',
    failure: {
      code: aggregateError.code,
      scope: aggregateError.scope,
    },
  });
}

export async function runTimescaleAggregateCli(
  workspaceRoot = resolveDataMigrationWorkspaceRoot(),
  logger?: MigrationLogger,
  dependencies: TimescaleAggregateCliDependencies = {},
): Promise<number> {
  const runId = randomUUID();
  const startedAt = new Date();
  let config: TimescaleAggregateConfig | undefined;
  let activeLogger = logger;
  let reportPath = `${workspaceRoot}/artifacts/timescale-aggregate/report.json`;
  const runGate = dependencies.runGate ?? runTimescaleAggregateGate;
  const prepareReport =
    dependencies.prepareReportDestination ??
    prepareDataMigrationReportDestination;
  const writeReport = dependencies.writeReport ?? writeTimescaleAggregateReport;
  try {
    loadDataMigrationEnvironmentFiles(workspaceRoot);
    activeLogger ??= createMigrationLogger();
    config = parseTimescaleAggregateConfig(process.env, workspaceRoot);
    reportPath = config.reportPath;
    await prepareReport(reportPath);
    const report = await runGate(config, activeLogger, { runId, startedAt });
    await writeReport(report, reportPath);
    activeLogger.info('timescale_aggregate.report_written', {
      reportDestination: 'timescale-aggregate-report',
      runId,
      status: report.status,
    });
    return report.status === 'passed' ? 0 : 1;
  } catch (error) {
    activeLogger ??= createMigrationLogger();
    const aggregateError = asDataMigrationError(error, 'aggregate');
    const report = failedReport(error, runId, startedAt, config);
    try {
      await writeReport(report, reportPath);
    } catch {
      activeLogger.error('timescale_aggregate.report_write_failed', {
        code: 'REPORT_WRITE_FAILED',
        runId,
      });
    }
    activeLogger.error('timescale_aggregate.cli_failed', {
      code: aggregateError.code,
      scope: aggregateError.scope,
      error: aggregateError,
      runId,
    });
    return 1;
  }
}

if (require.main === module) {
  void runTimescaleAggregateCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
