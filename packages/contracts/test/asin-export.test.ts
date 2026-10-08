import { describe, expect, it } from 'vitest';
import {
  asinExportArtifactSchema,
  asinExportJobDataSchema,
  asinExportTaskRequestSchema,
  createExportTaskRequestSchema,
} from '../src/domains/tasks';

const taskId = '10000000-0000-4000-8000-000000000166';

describe('first Neo ASIN export contract', () => {
  it('accepts bounded Legacy filters and defaults absent params', () => {
    expect(
      asinExportTaskRequestSchema.parse({ exportType: 'asin' }).params,
    ).toEqual({});
    expect(
      asinExportTaskRequestSchema.parse({
        exportType: 'asin',
        params: {
          keyword: 'a',
          country: 'US',
          variantStatus: 'BROKEN',
        },
      }).params,
    ).toEqual({ keyword: 'a', country: 'US', variantStatus: 'BROKEN' });
    expect(
      createExportTaskRequestSchema.parse({ exportType: 'monitor-history' })
        .exportType,
    ).toBe('monitor-history');
  });

  it('rejects oversized, control-character and unsupported filter input', () => {
    for (const params of [
      { keyword: 'x'.repeat(201) },
      { country: 'US\n' },
      { variantStatus: 'UNKNOWN' },
      { layout: 'unknown' },
      { unexpected: true },
    ])
      expect(
        asinExportTaskRequestSchema.safeParse({ exportType: 'asin', params })
          .success,
      ).toBe(false);
  });

  it.each(['task', 'detailed'] as const)(
    'retains the requested %s layout in the immutable job contract',
    (layout) => {
      const request = asinExportTaskRequestSchema.parse({
        exportType: 'asin',
        params: { layout },
      });
      expect(request.params).toEqual({ layout });
      expect(
        asinExportJobDataSchema.parse({
          taskId,
          taskType: 'export',
          taskSubType: 'asin',
          exportType: 'asin',
          userId: 'owner',
          createdAt: '2026-09-27T00:00:00.000Z',
          params: request.params,
        }).params,
      ).toEqual({ layout });
    },
  );

  it('accepts only a task-owned relative artifact and immutable ASIN job data', () => {
    const job = {
      taskId,
      taskType: 'export',
      taskSubType: 'asin',
      exportType: 'asin',
      userId: 'owner',
      createdAt: '2026-09-27T00:00:00.000Z',
      params: {},
    };
    expect(asinExportJobDataSchema.safeParse(job).success).toBe(true);
    expect(
      asinExportJobDataSchema.safeParse({
        ...job,
        taskSubType: 'monitor-history',
      }).success,
    ).toBe(false);
    const artifact = {
      taskId,
      key: `export-${taskId}.xlsx`,
      bytes: 100,
      sha256: 'a'.repeat(64),
    };
    expect(asinExportArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(
      asinExportArtifactSchema.safeParse({
        ...artifact,
        key: '../outside.xlsx',
      }).success,
    ).toBe(false);
    expect(
      asinExportArtifactSchema.safeParse({
        ...artifact,
        key: 'export-20000000-0000-4000-8000-000000000166.xlsx',
      }).success,
    ).toBe(false);
  });
});
