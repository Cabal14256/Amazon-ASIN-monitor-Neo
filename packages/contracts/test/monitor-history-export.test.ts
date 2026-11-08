import { describe, expect, it } from 'vitest';
import {
  catalogExportJobDataSchema,
  monitorHistoryExportTaskRequestSchema,
} from '../src/domains/tasks';

describe('bounded monitor history export contract', () => {
  it('accepts country and Shanghai wall time without converting local time to host time', () => {
    const request = monitorHistoryExportTaskRequestSchema.parse({
      exportType: 'monitor-history',
      params: {
        country: 'EU',
        startTime: '2024-02-29',
        endTime: '2024-03-01 12:13:14.123',
      },
    });
    expect(request.params.startTime).toBe('2024-02-29');
    const job = {
      ...request,
      taskId: '10000000-0000-4000-8000-000000000174',
      userId: 'owner',
      taskType: 'export',
      taskSubType: 'monitor-history',
      createdAt: '2026-11-07T00:00:00.000Z',
    };
    expect(catalogExportJobDataSchema.parse(job)).toEqual(job);
    expect(
      catalogExportJobDataSchema.safeParse({ ...job, taskSubType: 'asin' })
        .success,
    ).toBe(false);
  });
  it('defaults to an unfiltered records export', () => {
    expect(
      monitorHistoryExportTaskRequestSchema.parse({
        exportType: 'monitor-history',
      }).params,
    ).toEqual({});
  });
  it.each([
    { startTime: '2025-02-29' },
    { startTime: '2024-13-01' },
    { endTime: '2024-01-01T00:00:00Z' },
    { startTime: '2024-01-01 24:00:00' },
    { startTime: '2024-01-01 00:00:00.123456' },
    { country: 'x'.repeat(11) },
    { country: 'US\n' },
    { exportType: 'statusChanges' },
    { pageSize: 10000 },
  ])('rejects malformed or unsupported filters before admission', (params) => {
    expect(
      monitorHistoryExportTaskRequestSchema.safeParse({
        exportType: 'monitor-history',
        params,
      }).success,
    ).toBe(false);
  });
});
