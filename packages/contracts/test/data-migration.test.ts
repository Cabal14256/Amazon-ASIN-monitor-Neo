import { describe, expect, it } from 'vitest';

import { dataMigrationReportSchema } from '../src/dataMigration';

const digest = 'a'.repeat(64);

function database(logicalName: 'primary' | 'competitor') {
  return {
    logicalName,
    tables: [
      {
        table:
          logicalName === 'primary' ? 'variant_groups' : 'competitor_asins',
        sourceRows: '1',
        targetRows: '1',
        sampledRows: 1,
        sourceSampleDigest: digest,
        targetSampleDigest: digest,
        durationMs: 12,
        status: 'passed' as const,
      },
    ],
    businessQueries: [
      {
        name: 'asin_health_by_country',
        sourceRows: '1',
        targetRows: '1',
        sourceDigest: digest,
        targetDigest: digest,
        status: 'passed' as const,
      },
    ],
    durationMs: 20,
    status: 'passed' as const,
  };
}

describe('dataMigrationReportSchema', () => {
  it('接受不含原始业务值的双库通过报告', () => {
    const report = dataMigrationReportSchema.parse({
      schemaVersion: 1,
      runId: '7c4fc890-922b-4d5d-8491-d435bd939ca2',
      strategy: 'full-snapshot-cutover-sync',
      startedAt: '2026-08-28T07:00:00.000Z',
      finishedAt: '2026-08-28T07:01:00.000Z',
      batchSize: 500,
      sampleSize: 20,
      targetResetAuthorized: true,
      databases: [database('primary'), database('competitor')],
      status: 'passed',
    });

    expect(report.status).toBe('passed');
  });

  it('拒绝缺库、失败子检查、非精确计数与额外敏感字段', () => {
    const base = {
      schemaVersion: 1,
      runId: '7c4fc890-922b-4d5d-8491-d435bd939ca2',
      strategy: 'full-snapshot-cutover-sync',
      startedAt: '2026-08-28T07:00:00.000Z',
      finishedAt: '2026-08-28T07:01:00.000Z',
      batchSize: 500,
      sampleSize: 20,
      targetResetAuthorized: true,
      status: 'passed',
    } as const;

    expect(
      dataMigrationReportSchema.safeParse({
        ...base,
        databases: [database('primary')],
      }).success,
    ).toBe(false);

    expect(
      dataMigrationReportSchema.safeParse({
        ...base,
        databases: [
          {
            ...database('primary'),
            tables: [
              {
                ...database('primary').tables[0],
                sourceRows: 1,
                password: 'must-never-appear',
              },
            ],
          },
          database('competitor'),
        ],
      }).success,
    ).toBe(false);
  });

  it('失败报告只需要机器错误码和作用域', () => {
    expect(
      dataMigrationReportSchema.parse({
        schemaVersion: 1,
        runId: '7c4fc890-922b-4d5d-8491-d435bd939ca2',
        strategy: 'full-snapshot-cutover-sync',
        startedAt: '2026-08-28T07:00:00.000Z',
        finishedAt: '2026-08-28T07:00:01.000Z',
        batchSize: 500,
        sampleSize: 20,
        targetResetAuthorized: false,
        databases: [],
        status: 'failed',
        failure: { code: 'SOURCE_SCHEMA_MISMATCH', scope: 'primary.schema' },
      }).failure,
    ).toEqual({ code: 'SOURCE_SCHEMA_MISMATCH', scope: 'primary.schema' });
  });
});
