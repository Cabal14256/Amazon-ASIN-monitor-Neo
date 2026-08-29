import { describe, expect, it } from 'vitest';

import {
  dataMigrationEvidenceManifest,
  dataMigrationReportSchema,
} from '../src/dataMigration';

const digest = 'a'.repeat(64);

function database(logicalName: 'primary' | 'competitor') {
  const expected = dataMigrationEvidenceManifest[logicalName];
  return {
    logicalName,
    tables: expected.tables.map((table) => ({
      table,
      sourceRows: '1',
      targetRows: '1',
      sampledRows: 1,
      sourceSampleDigest: digest,
      targetSampleDigest: digest,
      durationMs: 12,
      status: 'passed' as const,
    })),
    businessQueries: expected.businessQueries.map((name) => ({
      name,
      sourceRows: '1',
      targetRows: '1',
      sourceDigest: digest,
      targetDigest: digest,
      status: 'passed' as const,
    })),
    durationMs: 20,
    status: 'passed' as const,
  };
}

function passedReportDatabases() {
  return [database('primary'), database('competitor')];
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
      databases: passedReportDatabases(),
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

  it('拒绝把计数、样本或业务摘要不一致的报告标为通过', () => {
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

    const mismatchedCounts = [database('primary'), database('competitor')];
    mismatchedCounts[0].tables[0].targetRows = '2';
    expect(
      dataMigrationReportSchema.safeParse({
        ...base,
        databases: mismatchedCounts,
      }).success,
    ).toBe(false);

    const missingSample = [database('primary'), database('competitor')];
    missingSample[0].tables[0].sampledRows = 0;
    expect(
      dataMigrationReportSchema.safeParse({
        ...base,
        databases: missingSample,
      }).success,
    ).toBe(false);

    const mismatchedQuery = [database('primary'), database('competitor')];
    mismatchedQuery[1].businessQueries[0].targetDigest = 'b'.repeat(64);
    expect(
      dataMigrationReportSchema.safeParse({
        ...base,
        databases: mismatchedQuery,
      }).success,
    ).toBe(false);
  });

  it('拒绝缺失或重复 25 表/7 查询证据的通过报告', () => {
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
    const incomplete = passedReportDatabases();
    incomplete[0].tables = incomplete[0].tables.slice(1);
    expect(
      dataMigrationReportSchema.safeParse({
        ...base,
        databases: incomplete,
      }).success,
    ).toBe(false);

    const duplicated = passedReportDatabases();
    duplicated[1].businessQueries = [
      duplicated[1].businessQueries[0],
      duplicated[1].businessQueries[0],
    ];
    expect(
      dataMigrationReportSchema.safeParse({
        ...base,
        databases: duplicated,
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
