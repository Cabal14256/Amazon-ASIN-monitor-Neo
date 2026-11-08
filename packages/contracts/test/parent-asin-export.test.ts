import { describe, expect, it } from 'vitest';
import {
  catalogExportJobDataSchema,
  parentAsinExportTaskRequestSchema,
} from '../src/domains/tasks';

describe('parent ASIN XLSX request and immutable queued identity', () => {
  const input = {
    exportType: 'parent-asin-query',
    params: {
      asins: ' b000000001, invalid\nB000000002\r\nb000000001',
      country: ' uk ',
    },
  };
  it('matches Legacy parsing while preserving order and duplicates', () => {
    const request = parentAsinExportTaskRequestSchema.parse(input);
    expect(request.params).toEqual({
      asins: ['B000000001', 'B000000002', 'B000000001'],
      country: 'UK',
    });
    const job = {
      ...request,
      taskId: '10000000-0000-4000-8000-000000000231',
      userId: 'owner',
      taskType: 'export',
      taskSubType: 'parent-asin-query',
      createdAt: '2026-11-07T00:00:00.000Z',
    };
    expect(catalogExportJobDataSchema.parse(job)).toEqual(job);
    expect(
      catalogExportJobDataSchema.safeParse({ ...job, taskSubType: 'asin' })
        .success,
    ).toBe(false);
  });
  it.each([
    { asins: 'invalid', country: 'US' },
    { asins: Array(1001).fill('B000000001').join(','), country: 'US' },
    { asins: 'B000000001', country: 'GB' },
    { asins: 'B000000001', country: 'US', layout: 'detailed' },
    { asins: ['B000000001'], country: 'US' },
    { asins: ' '.repeat(20001), country: 'US' },
  ])('rejects malformed or over-budget input before admission', (params) => {
    expect(
      parentAsinExportTaskRequestSchema.safeParse({ ...input, params }).success,
    ).toBe(false);
  });
});
