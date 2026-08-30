import { describe, expect, it } from 'vitest';

import {
  timescaleAggregateEvidenceManifest,
  timescaleAggregateReportSchema,
} from '../src/timescaleAggregate';

const digest = 'a'.repeat(64);

function report() {
  return {
    schemaVersion: 1 as const,
    runId: '7c4fc890-922b-4d5d-8491-d435bd939ca2',
    strategy: 'legacy-cagg-window-reconciliation' as const,
    startedAt: '2026-08-30T15:00:00.000Z',
    finishedAt: '2026-08-30T15:00:01.000Z',
    window: {
      start: '2026-07-01 00:00:00',
      end: '2026-10-01 00:00:00',
      boundary: '[start,end)' as const,
      timezone: 'Asia/Shanghai' as const,
    },
    refreshRequested: true,
    checks: timescaleAggregateEvidenceManifest.map((check) => ({
      ...check,
      legacyRows: '2',
      caggRows: '2',
      legacyGroups: '2',
      caggGroups: '2',
      legacyGroupDigest: digest,
      caggGroupDigest: digest,
      legacyValueDigest: digest,
      caggValueDigest: digest,
      status: 'passed' as const,
    })),
    status: 'passed' as const,
  };
}

describe('timescaleAggregateReportSchema', () => {
  it('接受固定窗口内完整且仅含摘要的九组证据', () => {
    expect(timescaleAggregateReportSchema.parse(report()).checks).toHaveLength(
      9,
    );
  });

  it('拒绝缺组、乱序、摘要不一致和额外原始业务字段', () => {
    const missing = report();
    missing.checks = missing.checks.slice(1);
    expect(timescaleAggregateReportSchema.safeParse(missing).success).toBe(
      false,
    );

    const mismatched = report();
    mismatched.checks[0].caggValueDigest = 'b'.repeat(64);
    expect(timescaleAggregateReportSchema.safeParse(mismatched).success).toBe(
      false,
    );

    expect(
      timescaleAggregateReportSchema.safeParse({
        ...report(),
        rawRows: [{ asin: 'must-not-appear' }],
      }).success,
    ).toBe(false);
  });

  it('拒绝将未刷新或全空窗口标记为通过', () => {
    expect(
      timescaleAggregateReportSchema.safeParse({
        ...report(),
        refreshRequested: false,
      }).success,
    ).toBe(false);

    const empty = report();
    empty.checks = empty.checks.map((check) => ({
      ...check,
      legacyRows: '0',
      caggRows: '0',
      legacyGroups: '0',
      caggGroups: '0',
    }));
    expect(timescaleAggregateReportSchema.safeParse(empty).success).toBe(false);
  });

  it('失败报告只暴露机器错误码和作用域', () => {
    const failed = {
      ...report(),
      checks: [],
      status: 'failed' as const,
      failure: {
        code: 'AGGREGATE_RECONCILIATION_FAILED',
        scope: 'aggregate.reconciliation',
      },
    };
    expect(timescaleAggregateReportSchema.parse(failed).failure).toEqual(
      failed.failure,
    );
  });
});
