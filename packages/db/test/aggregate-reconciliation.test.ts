import { describe, expect, it, vi } from 'vitest';

import {
  timescaleAggregateEvidenceManifest,
  timescaleAggregateReportSchema,
  type TimescaleAggregateReport,
} from '@asin-monitor/contracts';

import { runTimescaleAggregateCli } from '../src/aggregate-reconciliation/cli';
import {
  parseTimescaleAggregateConfig,
  validateTimescaleAggregateConfig,
} from '../src/aggregate-reconciliation/config';
import type { MigrationLogger } from '../src/migration/logger';

const digest = 'a'.repeat(64);
const logger: MigrationLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function passedReport(): TimescaleAggregateReport {
  return timescaleAggregateReportSchema.parse({
    schemaVersion: 1,
    runId: '7c4fc890-922b-4d5d-8491-d435bd939ca2',
    strategy: 'legacy-cagg-window-reconciliation',
    startedAt: '2026-08-30T15:00:00.000Z',
    finishedAt: '2026-08-30T15:00:01.000Z',
    window: {
      start: '2026-07-01 00:00:00',
      end: '2026-10-01 00:00:00',
      boundary: '[start,end)',
      timezone: 'Asia/Shanghai',
    },
    refreshRequested: true,
    coverage: {
      scope: 'all-migrated-aggregate-history',
      rowsOutsideWindow: '0',
    },
    checks: timescaleAggregateEvidenceManifest.map((evidence) => ({
      ...evidence,
      legacyRows: '1',
      caggRows: '1',
      legacyGroups: '1',
      caggGroups: '1',
      legacyGroupDigest: digest,
      caggGroupDigest: digest,
      legacyValueDigest: digest,
      caggValueDigest: digest,
      status: 'passed',
    })),
    status: 'passed',
  });
}

describe('Timescale aggregate gate config and CLI', () => {
  it('只接受显式、有效且不超过十年的月边界窗口', () => {
    const config = parseTimescaleAggregateConfig(
      {
        DATABASE_URL: 'postgresql://db.example/asin_monitor',
        TIMESCALE_AGG_WINDOW_START: '2026-07-01 00:00:00',
        TIMESCALE_AGG_WINDOW_END: '2026-10-01 00:00:00',
        TIMESCALE_AGG_REFRESH: 'yes',
        TIMESCALE_AGG_PAGE_SIZE: '500',
      },
      'D:/workspace',
    );
    expect(config).toMatchObject({
      windowStart: '2026-07-01 00:00:00',
      windowEnd: '2026-10-01 00:00:00',
      refresh: true,
      pageSize: 500,
    });
    expect(config.reportPath.replaceAll('\\', '/')).toMatch(
      /D:\/workspace\/artifacts\/timescale-aggregate\/report\.json$/,
    );

    for (const [windowStart, windowEnd] of [
      ['2026-07-02 00:00:00', '2026-10-01 00:00:00'],
      ['2026-07-01 00:00:00', '2026-06-01 00:00:00'],
      ['2026-07-01 00:00:00', '2037-01-01 00:00:00'],
      ['2026-02-30 00:00:00', '2026-10-01 00:00:00'],
    ]) {
      expect(() =>
        validateTimescaleAggregateConfig({
          ...config,
          windowStart,
          windowEnd,
        }),
      ).toThrow();
    }
  });

  it('对拍不一致写机器报告并返回非零，完全一致返回零', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://db.example/asin_monitor');
    vi.stubEnv('TIMESCALE_AGG_WINDOW_START', '2026-07-01 00:00:00');
    vi.stubEnv('TIMESCALE_AGG_WINDOW_END', '2026-10-01 00:00:00');
    const written: TimescaleAggregateReport[] = [];
    const passed = passedReport();
    const failed = timescaleAggregateReportSchema.parse({
      ...passed,
      status: 'failed',
      failure: {
        code: 'AGGREGATE_RECONCILIATION_MISMATCH',
        scope: 'aggregate.reconciliation',
      },
    });
    const dependencies = {
      prepareReportDestination: vi.fn(async () => undefined),
      writeReport: vi.fn(async (report: TimescaleAggregateReport) => {
        written.push(report);
      }),
    };

    expect(
      await runTimescaleAggregateCli('D:/workspace', logger, {
        ...dependencies,
        runGate: vi.fn(async () => failed),
      }),
    ).toBe(1);
    expect(written.at(-1)?.failure?.code).toBe(
      'AGGREGATE_RECONCILIATION_MISMATCH',
    );

    expect(
      await runTimescaleAggregateCli('D:/workspace', logger, {
        ...dependencies,
        runGate: vi.fn(async () => passed),
      }),
    ).toBe(0);
    vi.unstubAllEnvs();
  });
});
