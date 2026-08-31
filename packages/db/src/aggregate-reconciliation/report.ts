import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  timescaleAggregateReportSchema,
  type TimescaleAggregateReport,
} from '@asin-monitor/contracts';

export async function writeTimescaleAggregateReport(
  report: TimescaleAggregateReport,
  reportPath: string,
): Promise<void> {
  const validated = timescaleAggregateReportSchema.parse(report);
  const temporaryPath = `${reportPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(reportPath), { recursive: true });
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
