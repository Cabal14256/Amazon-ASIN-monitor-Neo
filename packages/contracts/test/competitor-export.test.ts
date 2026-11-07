import { describe, expect, it } from 'vitest';
import {
  catalogExportJobDataSchema,
  competitorAsinExportTaskRequestSchema,
  competitorVariantGroupExportTaskRequestSchema,
} from '../src/domains/tasks';
describe('competitor catalog export identity', () => {
  it.each(['competitor-asin', 'competitor-variant-group'] as const)(
    'accepts only bounded immutable %s jobs',
    (exportType) => {
      const schema =
        exportType === 'competitor-asin'
          ? competitorAsinExportTaskRequestSchema
          : competitorVariantGroupExportTaskRequestSchema;
      expect(schema.parse({ exportType }).params).toEqual({});
      const job = {
        taskId: '10000000-0000-4000-8000-000000000230',
        taskType: 'export',
        taskSubType: exportType,
        exportType,
        userId: 'owner',
        createdAt: '2026-09-27T00:00:00.000Z',
        params: { keyword: ' Raw ', country: 'us', variantStatus: 'BROKEN' },
      };
      expect(catalogExportJobDataSchema.parse(job)).toEqual(job);
      for (const patch of [
        { taskSubType: 'asin' },
        { userId: '' },
        { taskId: '../file' },
        { params: { layout: 'detailed' } },
        { params: { keyword: 'x'.repeat(201) } },
        { params: { country: 'US\n' } },
      ])
        expect(
          catalogExportJobDataSchema.safeParse({ ...job, ...patch }).success,
        ).toBe(false);
    },
  );
});
