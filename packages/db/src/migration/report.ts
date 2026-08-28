import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  dataMigrationReportSchema,
  type DataMigrationReport,
} from '@asin-monitor/contracts';

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
