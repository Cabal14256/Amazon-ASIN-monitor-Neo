import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  dataMigrationReportSchema,
  type DataMigrationReport,
} from '@asin-monitor/contracts';

import { DataMigrationError } from './errors';

export async function prepareDataMigrationReportDestination(
  reportPath: string,
): Promise<void> {
  const parentDirectory = dirname(reportPath);
  const probePath = `${reportPath}.${randomUUID()}.probe`;
  try {
    await mkdir(parentDirectory, { recursive: true });
    try {
      const destination = await lstat(reportPath);
      if (!destination.isFile()) {
        throw new DataMigrationError(
          'REPORT_DESTINATION_INVALID',
          'report.preflight',
          'migration report destination must be a regular file path',
        );
      }
    } catch (error) {
      if (error instanceof DataMigrationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(probePath, '', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error instanceof DataMigrationError) throw error;
    throw new DataMigrationError(
      'REPORT_DESTINATION_UNWRITABLE',
      'report.preflight',
      'migration report destination is not writable',
      error instanceof Error ? { cause: error } : undefined,
    );
  } finally {
    await rm(probePath, { force: true }).catch(() => undefined);
  }
}

export async function writeDataMigrationReport(
  report: DataMigrationReport,
  reportPath: string,
): Promise<void> {
  const validated = dataMigrationReportSchema.parse(report);
  const parentDirectory = dirname(reportPath);
  const temporaryPath = `${reportPath}.${randomUUID()}.tmp`;
  await mkdir(parentDirectory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, reportPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
